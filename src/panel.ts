import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import { DateTime } from "luxon";
import { ROOT } from "./config.js";
import { isSecure, type AuthBackend, type Membership, type PanelUser } from "./auth.js";
import { withClinic } from "./clinics/context.js";
import type { ClinicRuntime } from "./clinics/registry.js";
import type { Store, TurnMetric } from "./services/store.js";
import { localKey, toLocal, TZ, type Clock } from "./services/time.js";

/**
 * API del panel de gestión del consultorio: citas del día, conversaciones,
 * derivaciones, leads y métricas. Requiere sesión (ver auth.ts) y trabaja sobre
 * UNA clínica por pedido (?clinic=…), que tiene que ser una de las del usuario.
 */

type PanelRequest = Request & { user?: PanelUser; membership?: Membership; runtime?: ClinicRuntime; store?: Store };

export interface PanelOptions {
  auth: AuthBackend;
  runtimes: Map<string, ClinicRuntime>;
  clock: Clock;
  /** Base para el usuario y la clínica: con Supabase, con el token del usuario (RLS). */
  storeFor: (user: PanelUser, clinicId: string) => Store;
}

/** Middleware: exige sesión. Devuelve 401 en JSON si no hay. */
export function requireSession(auth: AuthBackend) {
  return async (req: PanelRequest, res: Response, next: NextFunction) => {
    try {
      const r = await auth.fromRequest(req, isSecure(req));
      if (!r) return res.status(401).json({ error: "Sesión vencida: vuelva a ingresar." });
      if (r.setCookie) res.setHeader("Set-Cookie", r.setCookie);
      req.user = r.user;
      next();
    } catch (err) {
      console.error("[panel] sesión:", err);
      res.status(500).json({ error: "No se pudo validar la sesión" });
    }
  };
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

export function createPanelRouter(opts: PanelOptions): Router {
  const { clock } = opts;
  const r = Router();
  r.use(requireSession(opts.auth));

  /** Quién es el usuario y en qué clínicas trabaja (para el selector del panel). */
  r.get("/me", (req: PanelRequest, res) => {
    const u = req.user!;
    res.json({
      email: u.email,
      clinics: u.memberships
        .filter((m) => opts.runtimes.has(m.clinicId))
        .map((m) => ({ id: m.clinicId, name: opts.runtimes.get(m.clinicId)!.profile.name, role: m.role })),
    });
  });

  // El resto de las rutas trabaja sobre una clínica del usuario (por defecto, la primera).
  r.use((req: PanelRequest, res, next) => {
    const u = req.user!;
    const wanted = typeof req.query.clinic === "string" ? req.query.clinic : u.memberships[0]?.clinicId;
    const m = u.memberships.find((x) => x.clinicId === wanted);
    const rt = m ? opts.runtimes.get(m.clinicId) : undefined;
    if (!m || !rt) return res.status(403).json({ error: "No tiene acceso a esa clínica." });
    req.membership = m;
    req.runtime = rt;
    req.store = opts.storeFor(u, m.clinicId);
    // Zona horaria y conocimiento de la clínica elegida durante todo el pedido.
    withClinic(rt.profile, next);
  });

  r.get("/summary", async (req: PanelRequest, res) => {
    const store = req.store!;
    const isAdmin = req.membership!.role === "admin";
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
        // Costos: solo el admin (la base también lo impide con RLS).
        isAdmin ? store.listMetrics() : Promise.resolve([] as TurnMetric[]),
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
        clinic: { id: req.runtime!.profile.id, name: req.runtime!.profile.name },
        role: req.membership!.role,
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
        metrics: !isAdmin ? null : {
          provider: use[0] ? `${use[0].provider} · ${use[0].model}` : "sin datos",
          turns: use.length,
          medianLatencyMs: median(lat),
          p95LatencyMs: p95(lat),
          avgCostPerConversation: convCosts.length ? convCosts.reduce((s, x) => s + x, 0) / convCosts.length : 0,
          avgCostPerTurn: use.length ? use.reduce((s, m) => s + m.costUsd, 0) / use.length : 0,
        },
        tests: isAdmin ? readTestReports() : [],
      });
    } catch (err) {
      console.error("[panel]", err);
      res.status(500).json({ error: "No se pudo armar el resumen" });
    }
  });

  r.get("/conversation/:id", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
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
  r.post("/conversation/:id/reply", async (req: PanelRequest, res) => {
    const store = req.store!;
    const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 1000) : "";
    if (!text) return res.status(400).json({ error: "Mensaje vacío" });
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    const p = await store.getPatient(c.patientId);
    if (!p) return res.status(404).json({ error: "Paciente no encontrado" });
    try {
      const how = await req.runtime!.notifier.send(c.channel, p.phone, { text: `👩‍⚕️ *Equipo de recepción:* ${text}` });
      c.messages.push({ role: "human", text, at: clock().toISOString() });
      await store.saveConversation(c);
      res.json({ ok: true, how });
    } catch (err) {
      res.status(502).json({ error: `No se pudo enviar: ${(err as Error).message}` });
    }
  });

  /** Marca la derivación como resuelta; opcionalmente devuelve la conversación al bot. */
  r.post("/handoff/:id/resolve", async (req: PanelRequest, res) => {
    const store = req.store!;
    const h = (await store.listHandoffs()).find((x) => x.id === req.params.id);
    if (!h) return res.status(404).json({ error: "No existe" });
    await store.updateHandoff(h.id, { status: "resuelta" });
    if (req.body?.returnToBot) {
      const c = await store.getConversation(h.conversationId);
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
