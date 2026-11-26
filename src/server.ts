import express, { type Request, type Response } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { config, ROOT } from "./config.js";
import { createProvider } from "./llm/index.js";
import { createServices } from "./services/factory.js";
import { seedCalendar } from "./data/seed.js";
import { localKey, systemClock, toLocal, TZ } from "./services/time.js";
import { WebOutbox } from "./services/notifier.js";
import type { WhatsAppSender } from "./channels/whatsappClient.js";
import { createPanelRouter } from "./panel.js";
import { clearCookie, createAuth, isSecure } from "./auth.js";
import { buildRuntimes, lineByPhoneNumberId, loadClinics, type ClinicRuntime } from "./clinics/registry.js";
import { cloudLines, hasWhatsApp, lineById, simulatedLines } from "./clinics/lines.js";
import { withClinic } from "./clinics/context.js";
import { SupabaseStore } from "./services/supabaseStore.js";
import { closeIdleConversations } from "./bot/conversationState.js";
import { receiveMessage } from "./channels/inbound.js";
import { DemoLimitError, DemoService, isTempClinic } from "./demo/tempClinics.js";
import { MockProvider } from "./llm/mock.js";

/**
 * Servidor HTTP: simulador web, webhook de WhatsApp, panel del consultorio y su API.
 * Multiempresa: cada clínica tiene su motor, su agenda, sus avisos y sus recordatorios
 * (ver clinics/registry.ts); las rutas reciben la clínica con ?clinic= o en el cuerpo.
 */
const provider = await createProvider();
const services = await createServices();

// Producción: no arranca con una configuración insegura o incompleta.
if (config.isProduction) {
  const problems = [
    services.storeKind !== "supabase" && "falta Supabase (en producción no se usa la base en memoria)",
    !config.panel.sessionSecret && "falta PANEL_SESSION_SECRET (sin ella las sesiones se pierden al reiniciar)",
    !config.supabase.publishableKey && "falta SUPABASE_PUBLISHABLE_KEY (login del panel)",
    config.whatsapp.verifyToken && !config.whatsapp.appSecret && "falta WHATSAPP_APP_SECRET (sin ella no se valida la firma de Meta)",
    provider.notice && `IA: ${provider.notice}`,
  ].filter(Boolean);
  if (problems.length) {
    console.error(`No se puede iniciar en producción:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
}
const clinics = await loadClinics(services);

const wa = config.whatsapp;
const canSendWhatsApp = Boolean(wa.token);
const outbox = new WebOutbox();
const { WhatsAppCloudClient } = await import("./channels/whatsappClient.js");
const auth = createAuth(services.storeKind);
// Demo pública: clínicas temporales por visita (las que ya existían en la base se cargan como el resto).
const fallback = new MockProvider("tope de IA de la demo");
const runtimes = new Map<string, ClinicRuntime>();
const demo = new DemoService({
  services, runtimes, provider, fallback, clock: systemClock, outbox, auth,
  template: clinics.find((c) => c.primary && !isTempClinic(c)) ?? clinics[0]!,
});
for (const [id, rt] of buildRuntimes({
  services, clinics, provider, clock: systemClock, outbox,
  whatsappFor: (phoneNumberId) => (canSendWhatsApp ? new WhatsAppCloudClient(wa.token, phoneNumberId) : null),
  aiBudgetFor: (p) => demo.budgetFor(p), fallbackProvider: fallback,
})) runtimes.set(id, rt);
const primary = [...runtimes.values()].find((r) => r.profile.primary && !isTempClinic(r.profile)) ?? [...runtimes.values()][0]!;

// Agenda en memoria: cada clínica arranca con algunos turnos ocupados de ejemplo.
if (services.calendarKind === "memoria") {
  for (const rt of runtimes.values()) {
    if (isTempClinic(rt.profile)) continue;
    await withClinic(rt.profile, () => seedCalendar(rt.calendar, systemClock, rt.profile.primary ? "a" : "b"));
  }
}
// Base en memoria (entorno de pruebas): 30 días de datos ficticios para que el panel tenga contenido.
if (services.storeKind === "memoria" && process.env.DEMO_DATA !== "false" && !config.isProduction) {
  const { loadDemoMemory } = await import("./data/loadDemo.js");
  const { loadExampleDocument } = await import("./data/loadDemo.js");
  for (const rt of runtimes.values()) await loadDemoMemory(rt.store, rt.calendar, rt.profile, systemClock());
  await loadExampleDocument(primary.store);
}

const app = express();
// Documentos de la zona de aprendizaje: llegan en base64, con un límite mayor (8 MB de archivo).
app.use("/api/panel/documents", express.json({ limit: "12mb" }));
// Se guarda el cuerpo crudo: la firma de Meta se calcula sobre los bytes exactos recibidos.
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; },
}));
app.use(express.static(path.join(ROOT, "public")));

/** Clínica pedida en la URL o el cuerpo; sin indicar, la principal. */
function runtimeFor(req: Request): ClinicRuntime | null {
  const id = (typeof req.query.clinic === "string" && req.query.clinic) || (typeof req.body?.clinic === "string" && req.body.clinic) || primary.profile.id;
  return runtimes.get(id) ?? null;
}
/** Envuelve una ruta del simulador: resuelve la clínica y corre dentro de su contexto. */
const clinicRoute = (fn: (rt: ClinicRuntime, req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response) => {
    const rt = runtimeFor(req);
    if (!rt) return res.status(404).json({ error: "Clínica desconocida" });
    return withClinic(rt.profile, () => fn(rt, req, res));
  };

// --- Canal WhatsApp: el webhook elige la clínica por el número que recibió el mensaje ---
let whatsappStatus = "desactivado (falta WHATSAPP_VERIFY_TOKEN)";
if (wa.verifyToken) {
  const { createWhatsAppRouter } = await import("./channels/whatsappWebhook.js");
  // Sin token igual se monta el webhook: Meta puede verificarlo, y los mensajes
  // entrantes se registran en la terminal aunque todavía no se puedan responder.
  const noToken: WhatsAppSender = {
    async sendText(to: string) { console.log(`[whatsapp] (sin WHATSAPP_TOKEN) no se pudo responder a ${to.slice(0, 4)}•••`); },
    async sendButtons(to: string) { console.log(`[whatsapp] (sin WHATSAPP_TOKEN) no se pudo responder a ${to.slice(0, 4)}•••`); },
    async sendTemplate() {},
    async markReadAndTyping() {},
  };
  app.use("/webhook/whatsapp", createWhatsAppRouter({
    verifyToken: wa.verifyToken,
    appSecret: wa.appSecret,
    // La clínica y la línea salen del número que recibió el mensaje; la respuesta sale por esa misma línea.
    route: (phoneNumberId) => {
      const hit = lineByPhoneNumberId(runtimes, phoneNumberId);
      return hit ? { bot: hit.rt.bot, sender: hit.rt.senders.get(hit.line.id) ?? noToken, lineId: hit.line.id } : null;
    },
  }));
  const withNumber = [...runtimes.values()].flatMap((r) => cloudLines(r.profile).map((l) => `${r.profile.name} (${l.name})`));
  whatsappStatus = [
    "webhook en /webhook/whatsapp",
    withNumber.length ? `números asignados: ${withNumber.join(", ")}` : "⚠ ninguna clínica tiene número asignado",
    canSendWhatsApp ? "envío activo" : "⚠ sin WHATSAPP_TOKEN: recibe pero no responde",
    wa.appSecret ? "" : "⚠ sin WHATSAPP_APP_SECRET: no se valida la firma",
  ].filter(Boolean).join(" · ");
}

// --- Panel del consultorio: página y API protegidas con sesión (Supabase Auth o usuarios de prueba) ---
const storeFor = services.storeKind === "supabase"
  ? (user: { accessToken?: string }, clinicId: string) =>
      SupabaseStore.asUser(config.supabase.url, config.supabase.publishableKey, user.accessToken ?? "", clinicId)
  : (_user: unknown, clinicId: string) => services.store.forClinic(clinicId);
app.use("/api/panel", createPanelRouter({ auth, runtimes, clock: systemClock, storeFor }));

app.get(["/panel", "/panel/"], async (req, res) => {
  const session = await auth.fromRequest(req, isSecure(req)).catch(() => null);
  if (session?.setCookie) res.setHeader("Set-Cookie", session.setCookie);
  res.sendFile(path.join(ROOT, "private", session ? "panel.html" : "login.html"));
});
app.post("/panel/login", express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
  // Freno simple contra intentos repetidos: 10 por IP cada 10 minutos.
  if (!allowedLogin(req.ip ?? "?")) return res.redirect(303, "/panel?error=intentos");
  const email = typeof req.body?.email === "string" ? req.body.email : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const r = email && password ? await auth.login(email, password, isSecure(req)).catch(() => null) : null;
  if (!r?.setCookie) return res.redirect(303, "/panel?error=1");
  res.setHeader("Set-Cookie", r.setCookie);
  res.redirect(303, "/panel");
});
app.post("/panel/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearCookie);
  res.redirect(303, "/panel");
});
// --- Demo pública: «Entrar al demo» crea una clínica temporal y entra como admin, sin contraseña ---
app.get(["/demo", "/demo/"], (_req, res) => res.sendFile(path.join(ROOT, "public", "demo.html")));
app.get("/api/demo/status", (_req, res) => res.json({ enabled: demo.enabled, hours: config.demo.hours }));
app.post("/api/demo/start", async (req, res) => {
  try {
    // Detrás del túnel o de la plataforma, la IP real del visitante viene en un encabezado.
    const ip = req.header("cf-connecting-ip") ?? req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? req.ip ?? "?";
    const { clinicId, session } = await demo.start(ip, isSecure(req));
    if (session.setCookie) res.setHeader("Set-Cookie", session.setCookie);
    res.json({ ok: true, clinicId, panel: `/panel?recorrido=1#bandeja` });
  } catch (err) {
    if (err instanceof DemoLimitError) return res.status(429).json({ error: err.message });
    console.error("[demo]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/panel/:file", async (req, res) => {
  const file = String(req.params.file);
  const isPublic = file === "panel.css"; // la hoja de estilos la usa también la pantalla de ingreso
  if (!/^[a-z0-9-]+\.(js|css)$/.test(file)) return res.sendStatus(404);
  if (!isPublic && !(await auth.fromRequest(req, isSecure(req)).catch(() => null))) return res.sendStatus(404);
  res.sendFile(path.join(ROOT, "private", file));
});
const loginHits = new Map<string, number[]>();
function allowedLogin(ip: string) {
  const now = Date.now();
  const list = (loginHits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  list.push(now);
  loginHits.set(ip, list);
  return list.length <= 10;
}

// --- Recordatorios y seguimiento: cada clínica con su zona horaria y su número ---
let remindersStatus = "desactivados (REMINDERS_ENABLED=false)";
if (config.reminders.enabled) {
  const tick = async () => {
    for (const rt of runtimes.values()) {
      try {
        const r = await rt.reminders.sweep();
        const expired = await rt.waitlist.sweep();
        const n = r.reminder24 + r.reminder2 + r.followups + r.reactivations + expired;
        if (n || r.errors.length) {
          console.log(`[recordatorios · ${rt.profile.id}] 24 h: ${r.reminder24} · 2 h: ${r.reminder2} · seguimientos: ${r.followups} · reactivaciones: ${r.reactivations} · ofertas vencidas: ${expired}${r.errors.length ? ` · errores: ${r.errors.join("; ")}` : ""}`);
        }
      } catch (err) {
        console.error(`[recordatorios · ${rt.profile.id}]`, (err as Error).message);
      }
    }
  };
  setInterval(tick, config.reminders.intervalSec * 1000);
  setTimeout(tick, 5000);
  remindersStatus = `cada ${config.reminders.intervalSec} s · seguimiento de leads a las ${config.reminders.followupAfterHours} h`;
}

// --- Cierre automático de conversaciones sin movimiento (se reabren si el paciente vuelve a escribir) ---
const closeIdle = async () => {
  // Clínicas temporales vencidas de la demo pública: se borran con todos sus datos.
  const gone = await demo.cleanup().catch((err) => { console.error("[demo]", (err as Error).message); return 0; });
  if (gone) console.log(`[demo] ${gone} clínica(s) temporal(es) vencida(s) borrada(s)`);
  for (const rt of runtimes.values()) {
    try {
      const n = await closeIdleConversations(rt.store, new Date(), config.inbox.idleHours);
      if (n) console.log(`[bandeja · ${rt.profile.id}] ${n} conversación(es) cerrada(s) por inactividad`);
    } catch (err) {
      console.error(`[bandeja · ${rt.profile.id}]`, (err as Error).message);
    }
  }
};
setInterval(closeIdle, 5 * 60_000);
setTimeout(closeIdle, 8000);

const validSession = (s: unknown): s is string => typeof s === "string" && /^web:[a-z0-9-]{4,40}$/i.test(s);

// El simulador consulta esta bandeja para mostrar los mensajes que el bot envía por su cuenta.
app.get("/api/outbox", clinicRoute((rt, req, res) => {
  if (!validSession(req.query.sessionId)) return res.status(400).json({ error: "Sesión inválida" });
  res.json({ messages: outbox.take(`${rt.profile.id}|${req.query.sessionId}`) });
}));

/** Demo: dispara ya el recordatorio del próximo turno de esta sesión web (para el video). */
app.post("/api/demo/remind", clinicRoute(async (rt, req, res) => {
  const { sessionId, kind } = req.body ?? {};
  if (!validSession(sessionId)) return res.status(400).json({ error: "Sesión inválida" });
  const patient = await rt.store.getOrCreatePatient(sessionId, "web");
  const next = (await rt.store.listAppointments({
    patientId: patient.id, from: new Date().toISOString(), status: ["confirmada", "pendiente"],
  }))[0];
  if (!next) return res.status(404).json({ error: "Esta conversación no tiene turnos próximos. Reserve uno primero." });
  await rt.reminders.remindNow(next.id, kind === "reminder2" ? "reminder2" : "reminder24");
  res.json({ ok: true });
}));

/** Demo: dispara ya el seguimiento de lead de esta sesión web. */
app.post("/api/demo/followup", clinicRoute(async (rt, req, res) => {
  const { sessionId } = req.body ?? {};
  if (!validSession(sessionId)) return res.status(400).json({ error: "Sesión inválida" });
  const patient = await rt.store.getOrCreatePatient(sessionId, "web", "promo-noviembre");
  const conv = await rt.store.getOrCreateConversation(patient, "web");
  conv.privacyShown = true;
  await rt.reminders.followupNow(conv, "web", sessionId, patient.name);
  res.json({ ok: true });
}));

// --- Límite de uso por IP: protege el saldo de la API si se comparte la demo en público ---
const WINDOW_MS = 10 * 60 * 1000;
const MAX_MSGS = Number(process.env.WEB_MAX_MSGS_PER_10MIN ?? 40);
const hits = new Map<string, number[]>();
function allowed(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_MSGS) return false;
  list.push(now);
  hits.set(ip, list);
  return true;
}

app.get("/api/config", clinicRoute((rt, _req, res) => {
  res.json({
    clinicId: rt.profile.id,
    clinic: rt.profile.name,
    // Las clínicas temporales de otros visitantes no se listan.
    clinics: [...runtimes.values()].filter((r) => !isTempClinic(r.profile) || r.profile.id === rt.profile.id)
      .map((r) => ({ id: r.profile.id, name: r.profile.name, whatsapp: hasWhatsApp(r.profile) })),
    // Líneas simuladas de esta clínica: el simulador escribe como si fuera a uno de esos números.
    lines: simulatedLines(rt.profile).map((l) => ({ id: l.id, name: l.name, area: l.area, professional: rt.profile.professionals.find((p) => p.id === l.professionalId)?.name ?? null })),
    demo: isTempClinic(rt.profile),
    provider: rt.bot.providerName,
    store: services.storeKind,
    calendar: services.calendarKind,
    timezone: TZ(),
  });
}));

app.post("/api/session", (_req, res) => {
  // Cada sesión web es un "paciente" distinto, identificado como web:<id> (y separado por clínica).
  res.json({ sessionId: `web:${randomUUID().slice(0, 8)}` });
});

app.post("/api/chat", clinicRoute(async (rt, req, res) => {
  const { sessionId, text, source, line } = req.body ?? {};
  // Línea simulada elegida en el simulador (por defecto, la primera). Las reales solo entran por el webhook.
  const chosen = typeof line === "string" ? lineById(rt.profile, line) : null;
  if (line && (!chosen || chosen.kind !== "simulada" || !chosen.active)) return res.status(400).json({ error: "Línea inválida" });
  const lineId = (chosen ?? simulatedLines(rt.profile)[0])?.id ?? null;
  if (!validSession(sessionId)) return res.status(400).json({ error: "Sesión inválida" });
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Mensaje vacío" });
  if (JSON.stringify(req.body).length > 20_000) return res.status(413).json({ error: "Pedido demasiado grande" });
  if (text.length > 600) return res.status(400).json({ error: "El mensaje es demasiado largo (máx. 600 caracteres)." });
  if (!allowed(req.ip ?? "?")) {
    return res.status(429).json({ error: "Demasiados mensajes seguidos. Espere unos minutos y vuelva a intentar." });
  }
  try {
    // Misma entrada que el webhook de WhatsApp (channels/inbound.ts); solo cambia el canal.
    const r = await receiveMessage(rt.bot, {
      channel: "web", from: sessionId, text: text.trim(), source: typeof source === "string" && source ? source.slice(0, 40) : null, lineId,
    });
    res.json({
      messages: r.messages,
      interactive: r.interactive ?? null,
      handedOff: r.handedOff,
      metric: r.metric ?? null,
      // `when` = horario afectado, para que la agenda salte a esa semana y lo resalte.
      tools: r.toolCalls.map((c) => {
        const o = c.output as any;
        const when = o?.ok ? (o.cita?.inicio ?? o.nueva?.inicio ?? null) : null;
        const freed = o?.ok ? (o.cancelada?.inicio ?? o.anterior?.inicio ?? null) : null;
        return { name: c.name, ms: Math.round(c.ms), when, freed };
      }),
    });
  } catch (err) {
    console.error("[/api/chat]", err);
    res.status(500).json({ error: "Error interno" });
  }
}));

/**
 * Agenda de la semana de una clínica para el panel lateral. Devuelve horas locales
 * ya formateadas, así el navegador no hace cálculos de zona horaria.
 */
app.get("/api/agenda", clinicRoute(async (rt, req, res) => {
  try {
    const start = typeof req.query.from === "string"
      ? DateTime.fromISO(req.query.from, { zone: TZ() }).startOf("day")
      : toLocal(systemClock()).startOf("week");
    const end = start.plus({ days: 6 });
    const [events, appts] = await Promise.all([
      rt.calendar.listEvents(start, end),
      rt.store.listAppointments({ from: start.toUTC().toISO()!, to: end.toUTC().toISO()!, status: ["confirmada", "pendiente"] }),
    ]);
    // Turnos de todos los profesionales (agenda interna y Google) + eventos de Google cargados a mano.
    const linked = new Set(appts.map((a) => a.calendarEventId).filter(Boolean));
    const profName = (id: string | null) => rt.profile.professionals.find((p) => p.id === id)?.name ?? null;
    res.json({
      from: start.toISODate(),
      today: toLocal(systemClock()).toISODate(),
      now: localKey(toLocal(systemClock())),
      hours: rt.profile.knowledge.hours,
      events: [
        ...appts.map((a) => ({
          id: a.id,
          start: localKey(toLocal(a.start)),
          end: localKey(toLocal(a.end)),
          // "bot" = reservado desde el chat; "ocupado" = cualquier otro turno (ejemplos, agenda manual)
          kind: a.id.startsWith("demo_") ? "ocupado" : "bot",
          title: a.treatment,
          patient: a.id.startsWith("demo_") ? null : a.patientName,
          professional: profName(a.professionalId),
        })),
        ...events.filter((e) => !linked.has(e.id)).map((e) => ({
          id: e.id, start: localKey(DateTime.fromISO(e.start)), end: localKey(DateTime.fromISO(e.end)),
          kind: "ocupado", title: "Ocupado", patient: null, professional: profName(e.tags?.professional ?? rt.profile.professionals.find((p) => p.calendar === "google")?.id ?? null),
        })),
      ],
    });
  } catch (err) {
    console.error("[/api/agenda]", err);
    res.status(500).json({ error: "No se pudo leer la agenda" });
  }
}));

app.listen(config.port, () => {
  console.log(`Simulador listo en http://localhost:${config.port}`);
  console.log(`IA: ${primary.bot.providerName} · base: ${services.storeKind} · agenda: ${services.calendarKind}`);
  console.log(`Clínicas: ${[...runtimes.values()].map((r) => `${r.profile.name} (${r.profile.id}, ${r.profile.timezone})`).join(" · ")}`);
  console.log(`WhatsApp: ${whatsappStatus}`);
  console.log(`Recordatorios: ${remindersStatus}`);
  console.log(`Panel: http://localhost:${config.port}/panel (usuarios de ${auth.kind === "supabase" ? "Supabase Auth" : "prueba"}; contraseñas en el .env, ver npm run seed:users)`);
});
