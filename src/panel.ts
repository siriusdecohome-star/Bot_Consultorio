import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import { DateTime } from "luxon";
import { config, ROOT } from "./config.js";
import { isSecure, type AuthBackend, type Membership, type PanelUser } from "./auth.js";
import { withClinic } from "./clinics/context.js";
import type { ClinicRuntime } from "./clinics/registry.js";
import type { Appointment, Conversation, Patient, Store, TurnMetric } from "./services/store.js";
import type { ClinicKnowledge } from "./clinics/types.js";
import { buildCosts, buildStats, isSimulated } from "./analytics.js";
import {
  CLOSE_REASON_LABEL, closeConversation, conversationState, inboxCounts, INBOX_FILTERS, lastActivity, matchesFilter,
  reopenConversation, STATE_LABEL, type InboxFilter,
} from "./bot/conversationState.js";
import { renamePatient } from "./bot/tools.js";
import { validateMenu } from "./bot/menu.js";
import { affectedAppointments, notifyAffected, validateException } from "./bot/exceptions.js";
import { professionalById, treatmentIdOf } from "./services/availability.js";
import type { Professional } from "./clinics/types.js";
import { docKind, MAX_DOC_BYTES, toChunks } from "./documents.js";
import { toCsv, type Cell } from "./csv.js";
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

      const [dayAppts, upcoming, convs, handoffs, metrics, patients, waitlist, allAppts] = await Promise.all([
        store.listAppointments({ from: from.toUTC().toISO()!, to: to.toUTC().toISO()! }),
        store.listAppointments({ from: now.toUTC().toISO()!, to: now.plus({ days: 7 }).toUTC().toISO()!, status: ["confirmada", "pendiente"] }),
        store.listConversations(),
        store.listHandoffs(),
        // Costos: solo el admin (la base también lo impide con RLS).
        isAdmin ? store.listMetrics() : Promise.resolve([] as TurnMetric[]),
        store.listPatients(),
        store.listWaitlist(["esperando", "ofrecido"]),
        store.listAppointments(),
      ]);
      const byId = new Map(patients.map((p) => [p.id, p]));
      const inbox = convs.filter((c) => c.channel !== "test");
      const convById = new Map(inbox.map((c) => [c.id, c]));
      const convOf = (patientId: string) => inbox.find((c) => c.patientId === patientId)?.id ?? null;
      const states = new Map(inbox.map((c) => [c.id, conversationState(c)]));
      const counts = inboxCounts([...states.values()]);

      // Lo urgente: conversaciones que esperan respuesta (la más antigua primero).
      const openByConv = new Map(handoffs.filter((h) => h.status === "abierta").map((h) => [h.conversationId, h]));
      const waiting = inbox
        .filter((c) => states.get(c.id) === "esperando")
        .map((c) => {
          const p = byId.get(c.patientId);
          const lastPatient = c.messages.findLast((m) => m.role === "patient");
          return {
            id: c.id, patient: displayName(p), phone: mask(p?.contactPhone ?? p?.phone ?? ""), channel: c.channel,
            lastText: lastPatient?.text.slice(0, 120) ?? "", since: lastPatient?.at ?? lastActivity(c),
            reason: openByConv.get(c.id)?.reason ?? (c.botPaused ? "pausada" : null),
          };
        })
        .sort((a, b) => a.since.localeCompare(b.since));

      // Derivaciones abiertas: solo las de conversaciones que siguen con una persona (mismo criterio que la bandeja).
      const openHandoffs = handoffs
        .filter((h) => h.status === "abierta" && convById.has(h.conversationId) && !convById.get(h.conversationId)!.closedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      // Leads: llegaron por una promo y nunca reservaron
      const withAppt = new Set(allAppts.map((a) => a.patientId));
      const leads = inbox
        .filter((c) => byId.get(c.patientId)?.source && !withAppt.has(c.patientId))
        .map((c) => {
          const p = byId.get(c.patientId)!;
          const lastPatient = c.messages.findLast((m) => m.role === "patient");
          return {
            conversationId: c.id, name: displayName(p), phone: mask(p.contactPhone ?? p.phone), channel: c.channel, source: p.source,
            lastContact: lastPatient?.at ?? c.updatedAt,
            followupSent: c.messages.some((m) => m.meta?.kind === "followup"),
          };
        })
        .sort((a, b) => b.lastContact.localeCompare(a.lastContact))
        .slice(0, 50);

      // Rendimiento: con mediciones reales si las hay; si no, las estimadas de los datos de ejemplo (y se avisa).
      const measured = metrics.filter((m) => !isSimulated(m) && m.provider !== "mock");
      const estimated = !measured.length && metrics.some(isSimulated);
      const use = measured.length ? measured : metrics.filter(isSimulated);
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
        counts,
        kpis: {
          waiting: counts.esperando,
          // Todas las citas del día que no se cancelaron (incluye las que ya pasaron): coincide con la lista.
          appointmentsToday: dayAppts.filter((a) => a.status !== "cancelada" && a.status !== "reprogramada").length,
          upcomingToday: active.filter((a) => a.start > clock().toISOString()).length,
          unconfirmedToday: active.filter((a) => !a.confirmedByPatient && a.start > clock().toISOString()).length,
          confirmedToday: active.filter((a) => a.confirmedByPatient).length,
          cancelledToday: dayAppts.filter((a) => a.status === "cancelada").length,
          next7Days: upcoming.length,
          openHandoffs: openHandoffs.length,
          waitlist: waitlist.length,
          offersPending: waitlist.filter((w) => w.status === "ofrecido").length,
          leadsWithoutAppointment: leads.length,
        },
        waiting,
        appointments: dayAppts.filter((a) => a.status !== "reprogramada").map((a) => ({
          id: a.id,
          start: a.start,
          end: a.end,
          patientId: a.patientId,
          conversationId: convOf(a.patientId),
          patient: displayName(byId.get(a.patientId)) ?? a.patientName,
          phone: mask(byId.get(a.patientId)?.contactPhone ?? byId.get(a.patientId)?.phone ?? ""),
          channel: byId.get(a.patientId)?.channel ?? "",
          treatment: a.treatment,
          status: a.status,
          confirmed: a.confirmedByPatient,
          reminder24: a.reminder24Sent,
          reminder2: a.reminder2Sent,
        })),
        handoffs: openHandoffs.slice(0, 30).map((h) => {
          const p = byId.get(h.patientId);
          return { ...h, patient: displayName(p) ?? mask(p?.phone ?? ""), channel: convById.get(h.conversationId)?.channel ?? "" };
        }),
        leads,
        metrics: !isAdmin ? null : {
          provider: use[0] ? `${use[0].provider} · ${use[0].model.replace(" (simulado)", "")}` : "sin datos",
          estimated,
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

  /** Detalle de una conversación: mensajes, estado, ficha del paciente y sus turnos. */
  r.get("/conversation/:id", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    const [p, appts, handoffs] = await Promise.all([
      store.getPatient(c.patientId), store.listAppointments({ patientId: c.patientId }), store.listHandoffs(),
    ]);
    const state = conversationState(c);
    res.json({
      id: c.id, channel: c.channel, state, stateLabel: STATE_LABEL[state],
      handedOff: c.handedOff, botPaused: c.botPaused, assignedTo: c.assignedTo,
      closedAt: c.closedAt, closedReason: c.closedReason ? CLOSE_REASON_LABEL[c.closedReason] : null,
      patient: patientCard(p),
      appointments: appts.filter((a) => a.status !== "reprogramada").map(apptView),
      handoffs: handoffs.filter((h) => h.conversationId === c.id && h.status === "abierta"),
      messages: c.messages,
    });
  });

  /** Una persona del equipo toma la conversación: el bot deja de responder y queda una derivación abierta. */
  async function takeOver(store: Store, c: Conversation, by: string, at: string) {
    if (!(await store.listHandoffs()).some((h) => h.conversationId === c.id && h.status === "abierta")) {
      await store.createHandoff({ conversationId: c.id, patientId: c.patientId, reason: "tomada_desde_panel", summary: `Tomada desde el panel por ${by}.` });
    }
    c.handedOff = true;
    c.assignedTo = by;
    c.messages.push({ role: "system", text: `${by} tomó la conversación: el asistente deja de responder.`, at });
  }
  async function resolveHandoffs(store: Store, conversationId: string) {
    for (const h of (await store.listHandoffs()).filter((x) => x.conversationId === conversationId && x.status === "abierta")) {
      await store.updateHandoff(h.id, { status: "resuelta" });
    }
  }

  /**
   * Una persona del equipo responde al paciente desde el panel (por su mismo canal).
   * Si el bot estaba atendiendo, responder equivale a tomar la conversación (así no contestan los dos).
   * Si estaba cerrada, se reabre.
   */
  r.post("/conversation/:id/reply", async (req: PanelRequest, res) => {
    const store = req.store!;
    const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 1000) : "";
    if (!text) return res.status(400).json({ error: "Mensaje vacío" });
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    const p = await store.getPatient(c.patientId);
    if (!p) return res.status(404).json({ error: "Paciente no encontrado" });
    const by = req.user!.email;
    try {
      // Pacientes de ejemplo: el teléfono es ficticio, el mensaje se guarda sin enviarse.
      const how = p.id.startsWith("demo_") ? "omitido" : await req.runtime!.notifier.send(c.channel, p.phone, { text: `👩‍⚕️ *Recepción:* ${text}` });
      const at = clock().toISOString();
      reopenConversation(c, at, `${by} reabrió la conversación.`);
      if (!c.handedOff && !c.botPaused) await takeOver(store, c, by, at);
      else c.assignedTo ??= by; // quien responde queda a cargo
      c.messages.push({ role: "human", text, at, by });
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
        c.assignedTo = null;
        c.messages.push({ role: "system", text: "Derivación resuelta desde el panel: la conversación vuelve al asistente.", at: clock().toISOString() });
        await store.saveConversation(c);
      }
    }
    res.json({ ok: true });
  });

  // ===================================================================
  // Conversaciones: bandeja con estado, traspaso a una persona y pausa del bot
  // ===================================================================

  /** Bandeja: conversaciones del filtro pedido (por defecto, las activas) y los contadores de cada filtro. */
  r.get("/conversations", async (req: PanelRequest, res) => {
    const store = req.store!;
    const wanted = String(req.query.filtro ?? req.query.estado ?? "activas") as InboxFilter;
    const filter: InboxFilter = INBOX_FILTERS.includes(wanted) ? wanted : "activas";
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const [convs, patients] = await Promise.all([store.listConversations(), store.listPatients()]);
    const byId = new Map(patients.map((p) => [p.id, p]));
    const all = convs
      .filter((c) => c.channel !== "test")
      .map((c) => {
        const p = byId.get(c.patientId);
        const state = conversationState(c);
        const last = c.messages.findLast((m) => m.role !== "system");
        return {
          id: c.id, patientId: c.patientId, patient: displayName(p), phone: mask(p?.contactPhone ?? p?.phone ?? ""),
          channel: c.channel, source: p?.source ?? null, tags: p?.tags ?? [],
          state, waiting: state === "esperando", assignedTo: c.assignedTo,
          closedReason: c.closedReason ? CLOSE_REASON_LABEL[c.closedReason] : null,
          lastText: last?.text.slice(0, 120) ?? "", lastRole: last?.role ?? null, lastAt: lastActivity(c),
        };
      })
      .filter((c) => !q || `${c.patient ?? ""} ${c.phone} ${c.lastText} ${c.tags.join(" ")}`.toLowerCase().includes(q));
    const list = all
      .filter((c) => matchesFilter(c.state, filter))
      .sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.lastAt.localeCompare(a.lastAt));
    res.json({ filter, counts: inboxCounts(all.map((c) => c.state)), conversations: list.slice(0, 300) });
  });

  /** Contadores de la bandeja (pestaña y resumen): mismos criterios que la lista. */
  r.get("/inbox/counts", async (req: PanelRequest, res) => {
    const convs = (await req.store!.listConversations()).filter((c) => c.channel !== "test");
    res.json({ counts: inboxCounts(convs.map(conversationState)) });
  });

  r.post("/conversation/:id/takeover", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    const at = clock().toISOString();
    reopenConversation(c, at, `${req.user!.email} reabrió la conversación.`);
    await takeOver(store, c, req.user!.email, at);
    await store.saveConversation(c);
    res.json({ ok: true });
  });

  /** Devuelve la conversación al bot y cierra las derivaciones abiertas. */
  r.post("/conversation/:id/release", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    await resolveHandoffs(store, c.id);
    c.handedOff = false;
    c.botPaused = false;
    c.assignedTo = null;
    c.messages.push({ role: "system", text: `${req.user!.email} devolvió la conversación al asistente.`, at: clock().toISOString() });
    await store.saveConversation(c);
    res.json({ ok: true });
  });

  /** Pausa (o reanuda) el bot en una conversación sin derivarla: no responde nada mientras esté en pausa. */
  r.post("/conversation/:id/pause", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    const at = clock().toISOString();
    c.botPaused = Boolean(req.body?.paused);
    if (c.botPaused) reopenConversation(c, at, `${req.user!.email} reabrió la conversación.`);
    c.messages.push({ role: "system", text: `${req.user!.email} ${c.botPaused ? "pausó" : "reanudó"} el asistente en esta conversación.`, at });
    await store.saveConversation(c);
    res.json({ ok: true, botPaused: c.botPaused });
  });

  /** Cierra la conversación a mano (las derivaciones abiertas pasan a resueltas). Se reabre si el paciente escribe. */
  r.post("/conversation/:id/close", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    if (closeConversation(c, "manual", clock().toISOString(), req.user!.email)) {
      await resolveHandoffs(store, c.id);
      await store.saveConversation(c);
    }
    res.json({ ok: true });
  });

  r.post("/conversation/:id/reopen", async (req: PanelRequest, res) => {
    const store = req.store!;
    const c = await store.getConversation(String(req.params.id));
    if (!c) return res.status(404).json({ error: "No existe" });
    if (reopenConversation(c, clock().toISOString(), `${req.user!.email} reabrió la conversación.`)) await store.saveConversation(c);
    res.json({ ok: true });
  });

  // ===================================================================
  // Agenda de la semana y cambios de estado de los turnos
  // ===================================================================

  /** Agenda de una semana (o de un día con ?days=1), con los datos para los filtros y el panel lateral. */
  r.get("/agenda", async (req: PanelRequest, res) => {
    const store = req.store!;
    const days = req.query.days === "1" ? 1 : 7;
    const now = toLocal(clock());
    const start = typeof req.query.from === "string"
      ? DateTime.fromISO(req.query.from, { zone: TZ() }).startOf("day")
      : days === 1 ? now.startOf("day") : now.startOf("week");
    const end = start.plus({ days });
    const [appts, patients, convs] = await Promise.all([
      store.listAppointments({ from: start.toUTC().toISO()!, to: end.toUTC().toISO()! }),
      store.listPatients(),
      store.listConversations(),
    ]);
    const byId = new Map(patients.map((p) => [p.id, p]));
    const k = req.runtime!.profile.knowledge;
    res.json({
      from: start.toISODate(),
      days,
      today: now.toISODate(),
      now: localKey(now),
      hours: k.hours,
      slotMinutes: req.runtime!.profile.slotMinutes,
      treatments: k.treatments.map((t) => t.name),
      professionals: req.runtime!.profile.professionals.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty, color: p.color, hours: p.hours, active: p.active, calendar: p.calendar })),
      exceptions: (await store.listExceptions()).filter((e) => e.toDate >= start.toISODate()! && e.fromDate <= end.toISODate()!),
      appointments: appts.filter((a) => a.status !== "reprogramada").map((a) => {
        const p = byId.get(a.patientId);
        return {
          ...apptView(a),
          date: toLocal(a.start).toISODate(), time: toLocal(a.start).toFormat("HH:mm"), endTime: toLocal(a.end).toFormat("HH:mm"),
          patientId: a.patientId, patient: displayName(p) ?? a.patientName, phone: mask(p?.contactPhone ?? p?.phone ?? ""),
          channel: p?.channel ?? "", conversationId: convs.find((c) => c.patientId === a.patientId && c.channel !== "test")?.id ?? null,
          reminder24: a.reminder24Sent, reminder2: a.reminder2Sent,
        };
      }),
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
      // El horario liberado se ofrece a la lista de espera.
      const offered = await req.runtime!.waitlist.onSlotFreed(localKey(toLocal(a.start)), a.professionalId).catch(() => null);
      return res.json({ ok: true, offeredTo: offered?.patientName ?? null });
    } else {
      await store.updateAppointment(a.id, { status: status as "asistio" | "ausente" | "confirmada" });
    }
    res.json({ ok: true });
  });

  // ===================================================================
  // Profesionales y excepciones de agenda
  // ===================================================================

  const professionalView = (p: Professional) => ({ ...p });

  r.get("/professionals", async (req: PanelRequest, res) => {
    const k = req.runtime!.profile.knowledge;
    const exceptions = await req.store!.listExceptions();
    const now = clock();
    const withAffected = [];
    for (const e of exceptions) {
      const affected = await affectedAppointments(req.store!, e, now);
      withAffected.push({ ...e, affected: affected.length, past: e.toDate < toLocal(now).toISODate()! });
    }
    res.json({
      professionals: req.runtime!.profile.professionals.map(professionalView),
      treatments: k.treatments.map((t) => ({ id: treatmentIdOf(t), name: t.name, specialty: t.specialty ?? "", duration: t.duration })),
      exceptions: withAffected,
      canEdit: req.membership!.role === "admin",
    });
  });

  /** Alta o edición de un profesional (admin). El cambio rige para el bot desde el mensaje siguiente. */
  r.put("/professionals/:id", async (req: PanelRequest, res) => {
    if (req.membership!.role !== "admin") return res.status(403).json({ error: "Solo el admin edita los profesionales." });
    const rt = req.runtime!;
    const id = String(req.params.id);
    const body = { ...(req.body ?? {}), id };
    const problem = validateProfessional(body, rt.profile.knowledge.treatments.map(treatmentIdOf), rt.profile.professionals.filter((p) => p.id !== id));
    if (problem) return res.status(400).json({ error: problem });
    const p: Professional = {
      id, name: body.name.trim(), specialty: body.specialty.trim(), color: body.color, hours: body.hours,
      treatments: body.treatments.map((t: any) => ({ id: t.id, minutes: Number(t.minutes) })), calendar: body.calendar, active: body.active !== false,
    };
    try {
      await req.store!.saveProfessional(p);
    } catch (err) {
      return res.status(403).json({ error: (err as Error).message });
    }
    const list = rt.profile.professionals;
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = p;
    else list.push(p);
    res.json({ ok: true, professional: p });
  });

  /** Carga una excepción y devuelve los turnos que quedan afectados. */
  r.post("/exceptions", async (req: PanelRequest, res) => {
    const rt = req.runtime!;
    const b = req.body ?? {};
    const problem = validateException(b, rt.profile.professionals.map((p) => p.id));
    if (problem) return res.status(400).json({ error: problem });
    const e = await req.store!.addException({
      professionalId: b.professionalId, kind: b.kind, fromDate: b.fromDate, toDate: b.kind === "rango" ? b.toDate : b.fromDate,
      fromTime: b.kind === "franja" ? b.fromTime : null, toTime: b.kind === "franja" ? b.toTime : null,
      reason: String(b.reason).trim(), createdBy: req.user!.email,
    });
    const affected = await affectedAppointments(req.store!, e, clock());
    res.json({ ok: true, exception: e, affected: await affectedView(req.store!, affected) });
  });

  r.get("/exceptions/:id/affected", async (req: PanelRequest, res) => {
    const e = (await req.store!.listExceptions()).find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: "No existe" });
    res.json({ exception: e, affected: await affectedView(req.store!, await affectedAppointments(req.store!, e, clock())) });
  });

  /** Avisa por el bot a los pacientes afectados (con botones Reprogramar / Cancelar turno). */
  r.post("/exceptions/:id/notify", async (req: PanelRequest, res) => {
    const e = (await req.store!.listExceptions()).find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: "No existe" });
    const r2 = await notifyAffected(req.store!, req.runtime!.notifier, e, clock);
    res.json({ ok: true, ...r2 });
  });

  r.delete("/exceptions/:id", async (req: PanelRequest, res) => {
    await req.store!.deleteException(String(req.params.id));
    res.json({ ok: true });
  });

  // ===================================================================
  // Lista de espera y reactivación de pacientes
  // ===================================================================

  r.get("/waitlist", async (req: PanelRequest, res) => {
    const list = await req.store!.listWaitlist(["esperando", "ofrecido", "aceptado"]);
    res.json({ entries: list.reverse().slice(0, 100), offerMinutes: config.waitlist.offerMinutes });
  });

  r.post("/waitlist/:id/cancel", async (req: PanelRequest, res) => {
    try {
      await req.store!.updateWaitlist(String(req.params.id), { status: "cancelado" });
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: "No existe" });
    }
  });

  r.get("/reactivation", async (req: PanelRequest, res) => {
    const list = await req.runtime!.reminders.reactivationCandidates();
    res.json({
      months: config.reactivation.months,
      candidates: list.map((c) => ({
        patientId: c.patient.id, name: c.patient.name, phone: mask(c.patient.phone), channel: c.patient.channel,
        lastVisit: toLocal(c.lastVisit).toISODate(), lastTreatment: c.lastTreatment, monthsAgo: c.monthsAgo, lastInvitation: c.lastInvitation,
      })),
    });
  });

  r.post("/reactivation/:patientId", async (req: PanelRequest, res) => {
    try {
      const ok = await req.runtime!.reminders.reactivateNow(String(req.params.patientId));
      if (!ok) return res.status(404).json({ error: "Ese paciente no está para reactivar" });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: `No se pudo enviar: ${(err as Error).message}` });
    }
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
        const conv = convs.find((c) => c.patientId === p.id && c.channel !== "test");
        const lastPatientMsg = conv?.messages.findLast((m) => m.role === "patient")?.at;
        const next = mine.filter((a) => a.start >= now && ["confirmada", "pendiente"].includes(a.status))[0];
        const lastVisit = mine.filter((a) => a.start < now && a.status !== "cancelada").at(-1);
        return {
          id: p.id, name: displayName(p), profileName: p.profileName, phone: mask(p.contactPhone ?? p.phone), channel: p.channel,
          source: p.source, tags: p.tags, createdAt: p.createdAt,
          type: mine.length ? "paciente" : "consulta",
          appointments: mine.length,
          cancelled: mine.filter((a) => a.status === "cancelada").length,
          nextAppointment: next?.start ?? null,
          lastVisit: lastVisit?.start ?? null,
          lastContact: lastPatientMsg ?? p.createdAt,
          conversationId: conv?.id ?? null,
        };
      })
      .filter((p) => tipo === "todos" || p.type === tipo)
      .filter((p) => !q || `${p.name ?? ""} ${p.phone} ${p.source ?? ""} ${p.tags.join(" ")}`.toLowerCase().includes(q))
      .sort((a, b) => b.lastContact.localeCompare(a.lastContact));
    res.json({ patients: list });
  });

  /** Ficha del paciente: datos editables, turnos, conversaciones y lista de espera. */
  r.get("/patient/:id", async (req: PanelRequest, res) => {
    const store = req.store!;
    const p = await store.getPatient(String(req.params.id));
    if (!p) return res.status(404).json({ error: "No existe" });
    const [appts, convs, waitlist] = await Promise.all([
      store.listAppointments({ patientId: p.id }), store.listConversations(), store.listWaitlist(["esperando", "ofrecido"]),
    ]);
    res.json({
      patient: patientCard(p),
      appointments: appts.filter((a) => a.status !== "reprogramada").map(apptView),
      conversations: convs.filter((c) => c.patientId === p.id && c.channel !== "test").map((c) => {
        const state = conversationState(c);
        return { id: c.id, channel: c.channel, state, stateLabel: STATE_LABEL[state], lastAt: lastActivity(c) };
      }),
      waitlist: waitlist.filter((w) => w.patientId === p.id),
    });
  });

  /** Edita la ficha. El nombre real se propaga a los turnos y a la lista de espera. */
  r.put("/patient/:id", async (req: PanelRequest, res) => {
    const store = req.store!;
    const p = await store.getPatient(String(req.params.id));
    if (!p) return res.status(404).json({ error: "No existe" });
    const parsed = parsePatientPatch(req.body ?? {});
    if (typeof parsed === "string") return res.status(400).json({ error: parsed });
    try {
      const { name, ...rest } = parsed;
      if (name !== undefined && name !== p.name) {
        if (name) await renamePatient(store, p.id, name);
        else await store.updatePatient(p.id, { name: null });
      }
      if (Object.keys(rest).length) await store.updatePatient(p.id, rest);
      res.json({ ok: true, patient: patientCard(await store.getPatient(p.id)) });
    } catch (err) {
      res.status(500).json({ error: `No se pudo guardar: ${(err as Error).message}` });
    }
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
      res.json({ messages: reply.messages, interactive: reply.interactive ?? null, tools: reply.toolCalls.map((t) => t.name), metric: reply.metric ?? null });
    } catch (err) {
      console.error("[panel] probador:", err);
      res.status(500).json({ error: "El asistente no pudo responder" });
    }
  });

  // ===================================================================
  // Exportar listados y métricas a CSV (Excel en español)
  // ===================================================================

  r.get("/export/:kind", async (req: PanelRequest, res) => {
    const store = req.store!;
    const kind = String(req.params.kind);
    const tz = TZ();
    const fdt = (iso: string | null | undefined) => (iso ? DateTime.fromISO(iso, { zone: "utc" }).setZone(tz).toFormat("yyyy-MM-dd HH:mm") : "");
    const phone = (p: string | undefined) => (!p ? "" : p.startsWith("web:") ? "Simulador web" : p);
    const CH: Record<string, string> = { whatsapp: "WhatsApp", web: "Simulador", cli: "Consola", test: "Prueba" };
    let headers: string[] = [];
    let rows: Cell[][] = [];

    if (kind === "turnos") {
      const from = typeof req.query.from === "string" ? DateTime.fromISO(req.query.from, { zone: tz }) : toLocal(clock()).minus({ days: 30 }).startOf("day");
      const to = typeof req.query.to === "string" ? DateTime.fromISO(req.query.to, { zone: tz }).endOf("day") : toLocal(clock()).plus({ days: 30 }).endOf("day");
      const [appts, patients] = await Promise.all([store.listAppointments({ from: from.toUTC().toISO()!, to: to.toUTC().toISO()! }), store.listPatients()]);
      const byId = new Map(patients.map((p) => [p.id, p]));
      headers = ["Fecha", "Hora", "Paciente", "Teléfono", "Canal", "Tratamiento", "Estado", "Confirmó", "Recordatorio 24 h", "Recordatorio 2 h", "Reservado", "Cancelado"];
      rows = appts.map((a) => {
        const p = byId.get(a.patientId);
        const s = toLocal(a.start);
        return [s.toISODate(), s.toFormat("HH:mm"), displayName(p) ?? a.patientName, phone(p?.contactPhone ?? p?.phone), CH[p?.channel ?? ""] ?? p?.channel, a.treatment, a.status,
          a.confirmedByPatient, a.reminder24Sent, a.reminder2Sent, fdt(a.createdAt), fdt(a.cancelledAt)];
      });
    } else if (kind === "pacientes") {
      const [patients, appts, convs] = await Promise.all([store.listPatients(), store.listAppointments(), store.listConversations()]);
      const now = clock().toISOString();
      headers = ["Paciente", "Teléfono", "Canal", "Origen", "Etiquetas", "Tipo", "Turnos", "Cancelados", "Próximo turno", "Última visita", "Último contacto", "Alta"];
      rows = patients.filter((p) => p.channel !== "test").map((p) => {
        const mine = appts.filter((a) => a.patientId === p.id && a.status !== "reprogramada");
        const next = mine.find((a) => a.start >= now && ["confirmada", "pendiente"].includes(a.status));
        const last = mine.filter((a) => a.start < now && a.status !== "cancelada").at(-1);
        const conv = convs.find((c) => c.patientId === p.id);
        const lastMsg = conv?.messages.findLast((m) => m.role === "patient")?.at;
        return [displayName(p) ?? "", phone(p.contactPhone ?? p.phone), CH[p.channel] ?? p.channel, p.source ?? "", p.tags.join(", "), mine.length ? "Con turno" : "Consulta",
          mine.length, mine.filter((a) => a.status === "cancelada").length, fdt(next?.start), fdt(last?.start), fdt(lastMsg ?? p.createdAt), fdt(p.createdAt)];
      });
    } else if (kind === "conversaciones") {
      const [convs, patients, handoffs] = await Promise.all([store.listConversations(), store.listPatients(), store.listHandoffs()]);
      const byId = new Map(patients.map((p) => [p.id, p]));
      headers = ["Paciente", "Teléfono", "Canal", "Origen", "Estado", "Atiende", "Mensajes", "Derivaciones", "Primer mensaje", "Último mensaje", "Último texto"];
      rows = convs.filter((c) => c.channel !== "test").map((c) => {
        const p = byId.get(c.patientId);
        return [displayName(p) ?? "", phone(p?.contactPhone ?? p?.phone), CH[c.channel] ?? c.channel, p?.source ?? "", STATE_LABEL[conversationState(c)], c.assignedTo ?? "",
          c.messages.length, handoffs.filter((h) => h.conversationId === c.id).length, fdt(c.messages[0]?.at ?? c.createdAt),
          fdt(c.messages.at(-1)?.at ?? c.updatedAt), (c.messages.at(-1)?.text ?? "").replace(/\s+/g, " ").slice(0, 200)];
      });
    } else if (kind === "lista-espera") {
      const list = await store.listWaitlist();
      headers = ["Paciente", "Tratamiento", "Desde", "Hasta", "Franja", "Estado", "Horario ofrecido", "Horarios rechazados", "Anotado"];
      rows = list.map((e) => [e.patientName, e.treatment, e.fromDate, e.toDate, e.franja, e.status, e.offeredSlot?.replace("T", " ") ?? "",
        e.declinedSlots.map((s) => s.replace("T", " ")).join(", "), fdt(e.createdAt)]);
    } else if (kind === "estadisticas") {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 365);
      const [patients, conversations, appointments, handoffs] = await Promise.all([store.listPatients(), store.listConversations(), store.listAppointments(), store.listHandoffs()]);
      const notTest = <T extends { channel: string }>(x: T) => x.channel !== "test";
      const s = buildStats({ tz, now: clock(), days, patients: patients.filter(notTest), conversations: conversations.filter(notTest), appointments, handoffs });
      headers = ["Día", "Consultas", "Pacientes nuevos", "Turnos agendados", "Turnos cancelados"];
      rows = s.daily.map((d) => [d.date, d.consultas, d.pacientesNuevos, d.turnosAgendados, d.turnosCancelados]);
      rows.push(["Total", s.totals.consultas, s.totals.pacientesNuevos, s.totals.turnosAgendados, s.totals.turnosCancelados]);
      rows.push([]);
      rows.push(["Conversión (nuevos con turno)", s.conversion.tasa, `${s.conversion.conTurno} de ${s.conversion.pacientesNuevos}`]);
      rows.push(["Resueltas por el bot", s.resolucion.bot, `de ${s.resolucion.total}`]);
      rows.push(["Traspasadas a una persona", s.resolucion.traspasadas, `de ${s.resolucion.total}`]);
      for (const t of s.tratamientos) rows.push([`Tratamiento: ${t.name}`, t.count]);
    } else if (kind === "costos") {
      if (req.membership!.role !== "admin") return res.status(403).json({ error: "Solo el admin ve los costos." });
      const c = buildCosts(await store.listMetrics(), tz, clock());
      headers = ["Mes", "Conversaciones", "Mensajes", "Tokens de entrada", "Tokens de salida", "Tokens de caché", "Costo USD", "Costo por conversación USD"];
      rows = c.months.map((m) => [m.month, m.conversations, m.turns, m.inputTokens, m.outputTokens, m.cacheReadTokens, m.costUsd, m.costPerConversation]);
      rows.push([]);
      rows.push([`Proyección ${c.currentMonth.month}`, c.currentMonth.projectedConversations, "", "", "", "", c.currentMonth.projectedCost, ""]);
    } else {
      return res.status(404).json({ error: "Exportación desconocida" });
    }

    const name = `${req.runtime!.profile.id}-${kind}-${toLocal(clock()).toISODate()}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(toCsv(headers, rows));
  });

  return r;
}

/** Nombre para mostrar: el real; si no se sabe, el del perfil de WhatsApp. */
function displayName(p: Patient | null | undefined): string | null {
  return p?.name ?? p?.profileName ?? null;
}

/** Datos de la ficha del paciente (el teléfono del canal va enmascarado; el de contacto es editable). */
function patientCard(p: Patient | null) {
  if (!p) return null;
  return {
    id: p.id, name: p.name, profileName: p.profileName, displayName: displayName(p),
    channelId: mask(p.phone), contactPhone: p.contactPhone ?? "", notes: p.notes, tags: p.tags,
    source: p.source, channel: p.channel, createdAt: p.createdAt,
  };
}

const apptView = (a: Appointment) => ({
  id: a.id, start: a.start, end: a.end, treatment: a.treatment, status: a.status, confirmed: a.confirmedByPatient,
  professionalId: a.professionalId, professional: professionalById(a.professionalId)?.name ?? null,
});

/** Valida lo editado en la ficha. Devuelve el cambio limpio o el problema. */
export function parsePatientPatch(b: any): { name?: string | null; contactPhone?: string | null; notes?: string; tags?: string[] } | string {
  const out: { name?: string | null; contactPhone?: string | null; notes?: string; tags?: string[] } = {};
  if (b.name !== undefined) {
    if (b.name !== null && typeof b.name !== "string") return "Nombre inválido";
    const n = (b.name ?? "").replace(/\s+/g, " ").trim();
    if (n && (n.length < 2 || n.length > 80)) return "El nombre debe tener entre 2 y 80 caracteres";
    out.name = n || null;
  }
  if (b.contactPhone !== undefined) {
    const t = String(b.contactPhone ?? "").trim();
    if (t && !/^\+?[0-9][0-9 ()-]{5,22}$/.test(t)) return "Teléfono inválido: use solo números, espacios, guiones y el + inicial";
    out.contactPhone = t || null;
  }
  if (b.notes !== undefined) {
    if (typeof b.notes !== "string" || b.notes.length > 2000) return "Las notas admiten hasta 2000 caracteres";
    out.notes = b.notes.trim();
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) return "Etiquetas inválidas";
    const tags = [...new Set(b.tags.map((t: unknown) => String(t).replace(/\s+/g, " ").trim()).filter(Boolean))] as string[];
    if (tags.length > 12) return "Hasta 12 etiquetas por paciente";
    if (tags.some((t) => t.length > 24)) return "Cada etiqueta admite hasta 24 caracteres";
    out.tags = tags;
  }
  return out;
}

/** Turnos afectados con el nombre y el teléfono enmascarado del paciente. */
async function affectedView(store: Store, list: Appointment[]) {
  const out = [];
  for (const a of list) {
    const p = await store.getPatient(a.patientId);
    out.push({ ...apptView(a), patient: displayName(p) ?? a.patientName, phone: mask(p?.contactPhone ?? p?.phone ?? ""), channel: p?.channel ?? "" });
  }
  return out;
}

/** Validación de un profesional editado en el panel. */
export function validateProfessional(p: any, treatmentIds: string[], others: Professional[]): string | null {
  if (!/^[a-z0-9-]{2,40}$/.test(p.id ?? "")) return "Id inválido";
  if (typeof p.name !== "string" || p.name.trim().length < 3 || p.name.length > 80) return "Indique el nombre del profesional";
  if (typeof p.specialty !== "string" || !p.specialty.trim() || p.specialty.length > 80) return "Indique la especialidad";
  if (!/^#[0-9a-f]{6}$/i.test(p.color ?? "")) return "Color inválido";
  if (p.calendar !== "google" && p.calendar !== "interno") return "Calendario inválido";
  if (p.calendar === "google" && others.some((o) => o.calendar === "google")) return "En esta demo solo un profesional usa Google Calendar; el resto, la agenda interna.";
  if (!Array.isArray(p.hours)) return "Horario inválido";
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const h of p.hours) {
    if (!(h?.weekday >= 1 && h.weekday <= 7) || !Array.isArray(h.blocks)) return "Horario inválido";
    for (const b of h.blocks) if (!Array.isArray(b) || !hm.test(b[0]) || !hm.test(b[1]) || b[0] >= b[1]) return "Cada bloque va de HH:mm a HH:mm (inicio antes que fin)";
  }
  if (!Array.isArray(p.treatments) || !p.treatments.length) return "Elija al menos un tratamiento";
  for (const t of p.treatments) {
    if (!treatmentIds.includes(t?.id)) return "Tratamiento desconocido";
    const m = Number(t.minutes);
    if (!Number.isInteger(m) || m < 10 || m > 240) return "La duración va de 10 a 240 minutos";
  }
  return null;
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
  return validateMenu(k.menu);
}
