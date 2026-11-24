import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import { DateTime } from "luxon";
import { ROOT } from "./config.js";
import { isSecure, type AuthBackend, type Membership, type PanelUser } from "./auth.js";
import { withClinic } from "./clinics/context.js";
import type { ClinicRuntime } from "./clinics/registry.js";
import type { Store, TurnMetric } from "./services/store.js";
import type { ClinicKnowledge } from "./clinics/types.js";
import { buildCosts, buildStats, conversationStatus, waitingForHuman } from "./analytics.js";
import { docKind, MAX_DOC_BYTES, toChunks } from "./documents.js";
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
      id: c.id, channel: c.channel, handedOff: c.handedOff, botPaused: c.botPaused, status: conversationStatus(c),
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

  // ===================================================================
  // Conversaciones: bandeja con estado, traspaso a una persona y pausa del bot
  // ===================================================================

  r.get("/conversations", async (req: PanelRequest, res) => {
    const store = req.store!;
    const estado = typeof req.query.estado === "string" ? req.query.estado : "todas";
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const [convs, patients] = await Promise.all([store.listConversations(), store.listPatients()]);
    const byId = new Map(patients.map((p) => [p.id, p]));
    const list = convs
      .filter((c) => c.channel !== "test")
      .map((c) => {
        const p = byId.get(c.patientId);
        const last = c.messages.at(-1);
        return {
          id: c.id, patient: p?.name ?? null, phone: mask(p?.phone ?? ""), channel: c.channel, source: p?.source ?? null,
          status: conversationStatus(c), waiting: waitingForHuman(c),
          messages: c.messages.length, lastText: last?.text.slice(0, 120) ?? "", lastRole: last?.role ?? null, lastAt: last?.at ?? c.updatedAt,
        };
      })
      .filter((c) => estado === "todas" || (estado === "esperando" ? c.waiting : c.status === estado))
      .filter((c) => !q || `${c.patient ?? ""} ${c.phone} ${c.lastText}`.toLowerCase().includes(q))
      .sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.lastAt.localeCompare(a.lastAt));
    res.json({ conversations: list.slice(0, 200) });
  });

  /** Una persona toma la conversación: el bot deja de contestar y queda una derivación abierta. */
  r.post("/conversation/:id/takeover", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    if (!(await store.listHandoffs()).some((h) => h.conversationId === c.id && h.status === "abierta")) {
      await store.createHandoff({ conversationId: c.id, patientId: c.patientId, reason: "tomada_desde_panel", summary: `Tomada desde el panel por ${req.user!.email}.` });
    }
    c.handedOff = true;
    c.messages.push({ role: "system", text: `${req.user!.email} tomó la conversación: el asistente deja de responder.`, at: clock().toISOString() });
    await store.saveConversation(c);
    res.json({ ok: true });
  });

  /** Devuelve la conversación al bot y cierra las derivaciones abiertas. */
  r.post("/conversation/:id/release", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    for (const h of (await store.listHandoffs()).filter((x) => x.conversationId === c.id && x.status === "abierta")) {
      await store.updateHandoff(h.id, { status: "resuelta" });
    }
    c.handedOff = false;
    c.botPaused = false;
    c.messages.push({ role: "system", text: `${req.user!.email} devolvió la conversación al asistente.`, at: clock().toISOString() });
    await store.saveConversation(c);
    res.json({ ok: true });
  });

  /** Pausa (o reanuda) el bot en una conversación sin derivarla: no responde nada mientras esté en pausa. */
  r.post("/conversation/:id/pause", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    c.botPaused = Boolean(req.body?.paused);
    c.messages.push({ role: "system", text: `${req.user!.email} ${c.botPaused ? "pausó" : "reanudó"} el asistente en esta conversación.`, at: clock().toISOString() });
    await store.saveConversation(c);
    res.json({ ok: true, botPaused: c.botPaused });
  });

  // ===================================================================
  // Agenda de la semana y cambios de estado de los turnos
  // ===================================================================

  r.get("/agenda", async (req: PanelRequest, res) => {
    const store = req.store!;
    const start = typeof req.query.from === "string"
      ? DateTime.fromISO(req.query.from, { zone: TZ() }).startOf("day")
      : toLocal(clock()).startOf("week");
    const end = start.plus({ days: 7 });
    const [appts, patients] = await Promise.all([
      store.listAppointments({ from: start.toUTC().toISO()!, to: end.toUTC().toISO()! }),
      store.listPatients(),
    ]);
    const byId = new Map(patients.map((p) => [p.id, p]));
    res.json({
      from: start.toISODate(),
      today: toLocal(clock()).toISODate(),
      hours: req.runtime!.profile.knowledge.hours,
      appointments: appts.filter((a) => a.status !== "reprogramada").map((a) => ({
        id: a.id, date: toLocal(a.start).toISODate(), time: toLocal(a.start).toFormat("HH:mm"), end: toLocal(a.end).toFormat("HH:mm"),
        patient: a.patientName, phone: mask(byId.get(a.patientId)?.phone ?? ""), channel: byId.get(a.patientId)?.channel ?? "",
        treatment: a.treatment, status: a.status, confirmed: a.confirmedByPatient, demo: a.id.startsWith("demo_"),
      })),
    });
  });

  r.post("/appointment/:id/status", async (req: PanelRequest, res) => {
    const store = req.store!;
    const status = String(req.body?.status ?? "");
    if (!["asistio", "ausente", "cancelada", "confirmada"].includes(status)) return res.status(400).json({ error: "Estado inválido" });
    const a = await store.getAppointment(String(req.params.id));
    if (!a) return res.status(404).json({ error: "No existe" });
    if (status === "cancelada") {
      if (a.status === "cancelada") return res.json({ ok: true });
      // Se libera el horario en el calendario igual que cuando cancela el paciente.
      if (a.calendarEventId) await req.runtime!.calendar.deleteEvent(a.calendarEventId);
      await store.updateAppointment(a.id, { status: "cancelada", cancelledAt: clock().toISOString() });
    } else {
      await store.updateAppointment(a.id, { status: status as "asistio" | "ausente" | "confirmada" });
    }
    res.json({ ok: true });
  });

  // ===================================================================
  // Pacientes y consultas (leads)
  // ===================================================================

  r.get("/patients", async (req: PanelRequest, res) => {
    const store = req.store!;
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const tipo = typeof req.query.tipo === "string" ? req.query.tipo : "todos";
    const [patients, appts, convs] = await Promise.all([store.listPatients(), store.listAppointments(), store.listConversations()]);
    const now = clock().toISOString();
    const list = patients
      .filter((p) => p.channel !== "test")
      .map((p) => {
        const mine = appts.filter((a) => a.patientId === p.id && a.status !== "reprogramada");
        const conv = convs.find((c) => c.patientId === p.id);
        const lastPatientMsg = conv ? [...conv.messages].reverse().find((m) => m.role === "patient")?.at : undefined;
        const next = mine.filter((a) => a.start >= now && ["confirmada", "pendiente"].includes(a.status))[0];
        const lastVisit = mine.filter((a) => a.start < now && a.status !== "cancelada").at(-1);
        return {
          id: p.id, name: p.name, phone: mask(p.phone), channel: p.channel, source: p.source, createdAt: p.createdAt,
          type: mine.length ? "paciente" : "consulta",
          appointments: mine.length,
          cancelled: mine.filter((a) => a.status === "cancelada").length,
          nextAppointment: next ? toLocal(next.start).setLocale("es").toFormat("ccc dd/MM HH:mm") : null,
          lastVisit: lastVisit ? toLocal(lastVisit.start).toISODate() : null,
          lastContact: lastPatientMsg ?? p.createdAt,
          conversationId: conv?.id ?? null,
        };
      })
      .filter((p) => tipo === "todos" || p.type === tipo)
      .filter((p) => !q || `${p.name ?? ""} ${p.phone} ${p.source ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => b.lastContact.localeCompare(a.lastContact));
    res.json({ patients: list });
  });

  // ===================================================================
  // Estadísticas y costos
  // ===================================================================

  r.get("/stats", async (req: PanelRequest, res) => {
    const store = req.store!;
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
    const [patients, conversations, appointments, handoffs] = await Promise.all([
      store.listPatients(), store.listConversations(), store.listAppointments(), store.listHandoffs(),
    ]);
    const notTest = <T extends { channel: string }>(x: T) => x.channel !== "test";
    res.json(buildStats({
      tz: TZ(), now: clock(), days,
      patients: patients.filter(notTest), conversations: conversations.filter(notTest), appointments, handoffs,
    }));
  });

  r.get("/costs", async (req: PanelRequest, res) => {
    if (req.membership!.role !== "admin") return res.status(403).json({ error: "Solo el admin ve los costos." });
    res.json({ ...buildCosts(await req.store!.listMetrics(), TZ(), clock()), provider: req.runtime!.bot.providerName });
  });

  // ===================================================================
  // Zona de aprendizaje (admin): conocimiento, documentos y probador
  // ===================================================================

  const adminOnly = (req: PanelRequest, res: Response) => {
    if (req.membership!.role === "admin") return true;
    res.status(403).json({ error: "Solo el admin edita lo que sabe el asistente." });
    return false;
  };

  r.get("/knowledge", (req: PanelRequest, res) => {
    res.json({ knowledge: req.runtime!.profile.knowledge, canEdit: req.membership!.role === "admin" });
  });

  r.put("/knowledge", async (req: PanelRequest, res) => {
    if (!adminOnly(req, res)) return;
    const problem = validateKnowledge(req.body?.knowledge);
    if (problem) return res.status(400).json({ error: problem });
    const k = req.body.knowledge as ClinicKnowledge;
    try {
      await req.store!.updateKnowledge(k);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }
    // El motor arma el prompt con este objeto en cada mensaje: el cambio rige desde ya.
    req.runtime!.profile.knowledge = k;
    res.json({ ok: true });
  });

  r.get("/documents", async (req: PanelRequest, res) => {
    res.json({ documents: await req.store!.listDocuments(), canEdit: req.membership!.role === "admin" });
  });

  r.post("/documents", async (req: PanelRequest, res) => {
    if (!adminOnly(req, res)) return;
    const name = String(req.body?.name ?? "").slice(0, 120);
    const mime = String(req.body?.mime ?? "");
    const kind = docKind(name, mime);
    if (!name || !kind) return res.status(400).json({ error: "Formato no soportado: suba un PDF, un Word (.docx) o un texto (.txt/.md)." });
    const buf = Buffer.from(String(req.body?.dataBase64 ?? ""), "base64");
    if (!buf.length) return res.status(400).json({ error: "Archivo vacío" });
    if (buf.length > MAX_DOC_BYTES) return res.status(413).json({ error: "El archivo supera los 8 MB." });
    try {
      const chunks = await toChunks(buf, kind);
      if (!chunks.length) return res.status(400).json({ error: "No se pudo leer texto del archivo (¿es un PDF escaneado como imagen?)." });
      const doc = await req.store!.addDocument({ name, mime: mime || kind, sizeBytes: buf.length }, chunks);
      res.json({ ok: true, document: doc });
    } catch (err) {
      console.error("[panel] documento:", err);
      res.status(400).json({ error: `No se pudo procesar el archivo: ${(err as Error).message}` });
    }
  });

  r.delete("/documents/:id", async (req: PanelRequest, res) => {
    if (!adminOnly(req, res)) return;
    await req.store!.deleteDocument(String(req.params.id));
    res.json({ ok: true });
  });

  /** Busca en los documentos tal como lo haría el bot (para revisar qué encuentra). */
  r.get("/documents/search", async (req: PanelRequest, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    res.json({ results: q ? await req.store!.searchDocuments(q, 5) : [] });
  });

  /**
   * Probador: conversa con el bot de esta clínica, con el conocimiento y los documentos
   * actuales. Usa el canal "test", que no cuenta en la bandeja ni en las estadísticas.
   */
  r.post("/tester", async (req: PanelRequest, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 600) : "";
    const session = typeof req.body?.session === "string" && /^[a-z0-9-]{4,40}$/i.test(req.body.session) ? req.body.session : "";
    if (!text || !session) return res.status(400).json({ error: "Falta el mensaje o la sesión" });
    try {
      const reply = await req.runtime!.bot.handle({ channel: "test", userId: `probador:${session}`, text });
      res.json({ messages: reply.messages, tools: reply.toolCalls.map((t) => t.name), metric: reply.metric ?? null });
    } catch (err) {
      console.error("[panel] probador:", err);
      res.status(500).json({ error: "El asistente no pudo responder" });
    }
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

/** Validación básica del conocimiento editado en el panel (forma y horarios HH:mm). */
export function validateKnowledge(k: any): string | null {
  if (!k || typeof k !== "object") return "Falta el conocimiento";
  for (const f of ["name", "address", "hoursText", "payments", "insurance", "cancellationPolicy", "emergencies"]) {
    if (typeof k[f] !== "string" || !k[f].trim()) return `Falta el campo «${f}»`;
    if (k[f].length > 2000) return `El campo «${f}» es demasiado largo`;
  }
  if (!Array.isArray(k.treatments) || !k.treatments.length) return "Cargue al menos un tratamiento";
  for (const t of k.treatments) if (!t?.name?.trim() || typeof t.price !== "string") return "Cada tratamiento necesita nombre y precio";
  if (!Array.isArray(k.hours)) return "Horarios inválidos";
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const h of k.hours) {
    if (!(h?.weekday >= 1 && h.weekday <= 7) || !Array.isArray(h.blocks)) return "Horarios inválidos";
    for (const b of h.blocks) if (!Array.isArray(b) || !hm.test(b[0]) || !hm.test(b[1]) || b[0] >= b[1]) return "Cada bloque de horario va de HH:mm a HH:mm (inicio antes que fin)";
  }
  if (k.faq !== undefined && (!Array.isArray(k.faq) || k.faq.some((f: any) => !f?.q?.trim() || !f?.a?.trim()))) return "Cada pregunta frecuente necesita pregunta y respuesta";
  if (k.tone !== undefined && (typeof k.tone !== "string" || k.tone.length > 1000)) return "El tono es demasiado largo";
  if (!k.promo || typeof k.promo.name !== "string" || typeof k.promo.detail !== "string") return "Promoción inválida";
  if (!Array.isArray(k.professionals)) return "Profesionales inválidos";
  return null;
}
