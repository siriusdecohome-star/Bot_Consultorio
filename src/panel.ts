import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { DateTime } from "luxon";
import { config, ROOT } from "./config.js";
import type { Store, TurnMetric } from "./services/store.js";
import type { Notifier } from "./services/notifier.js";
import { localKey, toLocal, TZ, type Clock } from "./services/time.js";

/**
 * API del panel de gestión del consultorio: citas del día, conversaciones,
 * derivaciones, leads y métricas. Protegida con usuario y contraseña (PANEL_PASSWORD).
 */

// --- Acceso al panel ---
// Con PANEL_PASSWORD: pantalla de ingreso que deja una cookie firmada (HMAC) por 12 h.
// También acepta autenticación básica (útil para scripts). Sin contraseña: solo desde esta PC.
const COOKIE = "panel_sesion";
const SESSION_H = 12;

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const sign = (payload: string) => createHmac("sha256", `panel:${config.panel.password}`).update(payload).digest("base64url");

export function checkCredentials(user: unknown, pass: unknown): boolean {
  return typeof user === "string" && typeof pass === "string" && !!config.panel.password &&
    safeEq(user, config.panel.user) && safeEq(pass, config.panel.password);
}

export function sessionCookie(secure: boolean): string {
  const exp = Date.now() + SESSION_H * 3600_000;
  const value = `${exp}.${sign(String(exp))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_H * 3600}${secure ? "; Secure" : ""}`;
}
export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

function validSession(req: Request): boolean {
  const raw = (req.header("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return false;
  const [exp, sig] = raw.split(".");
  return !!exp && !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp));
}

export function isAuthed(req: Request): boolean {
  if (!config.panel.password) return !(req.header("cf-connecting-ip") || req.header("x-forwarded-for"));
  if (validSession(req)) return true;
  const [scheme, value] = (req.header("authorization") ?? "").split(" ");
  if (scheme === "Basic" && value) {
    const [user, given] = Buffer.from(value, "base64").toString().split(/:(.*)/s);
    return checkCredentials(user, given);
  }
  return false;
}

/** Middleware para la API: 401 en JSON si no hay sesión. */
export function panelAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthed(req)) return next();
  if (!config.panel.password && (req.header("cf-connecting-ip") || req.header("x-forwarded-for"))) {
    return res.status(403).json({ error: "Panel deshabilitado desde internet: defina PANEL_PASSWORD en el .env." });
  }
  return res.status(401).json({ error: "Sesión vencida: vuelva a ingresar." });
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const p95 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
};

export function createPanelRouter(opts: { store: Store; clock: Clock; notifier: Notifier }): Router {
  const { store, clock, notifier } = opts;
  const r = Router();
  r.use(panelAuth);

  r.get("/summary", async (req, res) => {
    try {
      const now = toLocal(clock());
      const day = typeof req.query.date === "string" ? DateTime.fromISO(req.query.date, { zone: TZ() }) : now;
      const from = day.startOf("day");
      const to = from.plus({ days: 1 });

      const [dayAppts, upcoming, convs, handoffs, metrics] = await Promise.all([
        store.listAppointments({ from: from.toUTC().toISO()!, to: to.toUTC().toISO()! }),
        store.listAppointments({ from: now.toUTC().toISO()!, to: now.plus({ days: 7 }).toUTC().toISO()!, status: ["confirmada", "pendiente"] }),
        store.listConversations(),
        store.listHandoffs(),
        store.listMetrics(),
      ]);

      const patients = new Map<string, Awaited<ReturnType<Store["getPatient"]>>>();
      for (const id of new Set([...convs.map((c) => c.patientId), ...dayAppts.map((a) => a.patientId)])) {
        patients.set(id, await store.getPatient(id));
      }

      // Leads: llegaron por una promo y nunca reservaron
      const withAppt = new Set((await store.listAppointments()).map((a) => a.patientId));
      const leads = convs
        .filter((c) => patients.get(c.patientId)?.source && !withAppt.has(c.patientId))
        .map((c) => {
          const p = patients.get(c.patientId)!;
          const lastPatient = [...c.messages].reverse().find((m) => m.role === "patient");
          return {
            conversationId: c.id, name: p.name, phone: mask(p.phone), channel: c.channel, source: p.source,
            lastContact: lastPatient?.at ?? c.updatedAt,
            followupSent: c.messages.some((m) => m.meta?.kind === "followup"),
          };
        })
        .sort((a, b) => b.lastContact.localeCompare(a.lastContact))
        .slice(0, 50);

      // Métricas por conversación (costo total y tiempo de respuesta)
      const real = metrics.filter((m) => m.provider !== "mock");
      const use = real.length ? real : metrics;
      const byConv = new Map<string, TurnMetric[]>();
      for (const m of use) byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m]);
      const convCosts = [...byConv.values()].map((ms) => ms.reduce((s, m) => s + m.costUsd, 0));
      const lat = use.map((m) => m.latencyMs);

      const active = dayAppts.filter((a) => ["confirmada", "pendiente"].includes(a.status));
      res.json({
        date: from.toISODate(),
        now: localKey(now),
        kpis: {
          appointmentsToday: active.length,
          confirmedToday: active.filter((a) => a.confirmedByPatient).length,
          cancelledToday: dayAppts.filter((a) => a.status === "cancelada").length,
          next7Days: upcoming.length,
          openHandoffs: handoffs.filter((h) => h.status === "abierta").length,
          leadsWithoutAppointment: leads.length,
          conversations: convs.length,
        },
        appointments: dayAppts.map((a) => ({
          id: a.id,
          time: toLocal(a.start).toFormat("HH:mm"),
          patient: a.patientName,
          phone: mask(patients.get(a.patientId)?.phone ?? ""),
          channel: patients.get(a.patientId)?.channel ?? "",
          treatment: a.treatment,
          status: a.status,
          confirmed: a.confirmedByPatient,
          reminder24: a.reminder24Sent,
          reminder2: a.reminder2Sent,
        })),
        handoffs: handoffs
          .map((h) => {
            const p = patients.get(h.patientId);
            return { ...h, patient: p?.name ?? mask(p?.phone ?? ""), channel: convs.find((c) => c.id === h.conversationId)?.channel ?? "" };
          })
          .sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === "abierta" ? -1 : 1))
          .slice(0, 50),
        conversations: convs
          .map((c) => {
            const p = patients.get(c.patientId);
            const last = c.messages.at(-1);
            return {
              id: c.id, patient: p?.name ?? null, phone: mask(p?.phone ?? ""), channel: c.channel,
              messages: c.messages.length, lastText: last?.text.slice(0, 90) ?? "", lastAt: last?.at ?? c.updatedAt,
              handedOff: c.handedOff, source: p?.source ?? null,
            };
          })
          .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
          .slice(0, 60),
        leads,
        metrics: {
          provider: use[0] ? `${use[0].provider} · ${use[0].model}` : "sin datos",
          turns: use.length,
          medianLatencyMs: median(lat),
          p95LatencyMs: p95(lat),
          avgCostPerConversation: convCosts.length ? convCosts.reduce((s, x) => s + x, 0) / convCosts.length : 0,
          avgCostPerTurn: use.length ? use.reduce((s, m) => s + m.costUsd, 0) / use.length : 0,
        },
        tests: readTestReports(),
      });
    } catch (err) {
      console.error("[panel]", err);
      res.status(500).json({ error: "No se pudo armar el resumen" });
    }
  });

  r.get("/conversation/:id", async (req, res) => {
    const c = (await store.listConversations()).find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "No existe" });
    const p = await store.getPatient(c.patientId);
    const appts = await store.listAppointments({ patientId: c.patientId });
    res.json({
      id: c.id, channel: c.channel, handedOff: c.handedOff,
      patient: { name: p?.name ?? null, phone: mask(p?.phone ?? ""), source: p?.source ?? null },
      appointments: appts.map((a) => ({ id: a.id, when: toLocal(a.start).setLocale("es").toFormat("ccc dd/MM HH:mm"), treatment: a.treatment, status: a.status, confirmed: a.confirmedByPatient })),
      messages: c.messages,
    });
  });

  /** Una persona del equipo responde al paciente desde el panel (por su mismo canal). */
  r.post("/conversation/:id/reply", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 1000) : "";
    if (!text) return res.status(400).json({ error: "Mensaje vacío" });
    const c = (await store.listConversations()).find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "No existe" });
    const p = await store.getPatient(c.patientId);
    if (!p) return res.status(404).json({ error: "Paciente no encontrado" });
    try {
      const how = await notifier.send(c.channel, p.phone, { text: `👩‍⚕️ *Equipo de recepción:* ${text}` });
      c.messages.push({ role: "human", text, at: clock().toISOString() });
      await store.saveConversation(c);
      res.json({ ok: true, how });
    } catch (err) {
      res.status(502).json({ error: `No se pudo enviar: ${(err as Error).message}` });
    }
  });

  /** Marca la derivación como resuelta; opcionalmente devuelve la conversación al bot. */
  r.post("/handoff/:id/resolve", async (req, res) => {
    const h = (await store.listHandoffs()).find((x) => x.id === req.params.id);
    if (!h) return res.status(404).json({ error: "No existe" });
    await store.updateHandoff(h.id, { status: "resuelta" });
    if (req.body?.returnToBot) {
      const c = (await store.listConversations()).find((x) => x.id === h.conversationId);
      if (c) {
        c.handedOff = false;
        c.messages.push({ role: "system", text: "Derivación resuelta desde el panel: la conversación vuelve al asistente.", at: clock().toISOString() });
        await store.saveConversation(c);
      }
    }
    res.json({ ok: true });
  });

  return r;
}

/** En el panel no se muestra el teléfono completo. */
function mask(phone: string) {
  if (!phone) return "";
  if (phone.startsWith("web:")) return "Simulador web";
  return `${phone.slice(0, 5)}•••${phone.slice(-3)}`;
}

function readTestReports() {
  const out: unknown[] = [];
  for (const f of ["test-results.json", "test-results-claude.json", "test-results-openai.json"]) {
    const p = path.join(ROOT, "reports", f);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      out.push({
        runAt: j.runAt, provider: `${j.provider} · ${j.model}`, passed: j.passed, total: j.total,
        avgTurnMs: Math.round(j.avgTurnMs), p95Ms: Math.round(j.p95Ms), avgCostUsd: j.avgCostUsd,
        cases: j.results.map((r: any) => ({ name: r.name, expected: r.expected, passed: r.passed, details: r.details, turns: r.turns.length, avgTurnMs: r.avgTurnMs, costUsd: r.costUsd })),
      });
    } catch {}
  }
  return out;
}
