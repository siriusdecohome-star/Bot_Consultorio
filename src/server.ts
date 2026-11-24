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
import { buildRuntimes, loadClinics, runtimeByPhoneNumberId, type ClinicRuntime } from "./clinics/registry.js";
import { withClinic } from "./clinics/context.js";
import { SupabaseStore } from "./services/supabaseStore.js";

/**
 * Servidor HTTP: simulador web, webhook de WhatsApp, panel del consultorio y su API.
 * Multiempresa: cada clínica tiene su motor, su agenda, sus avisos y sus recordatorios
 * (ver clinics/registry.ts); las rutas reciben la clínica con ?clinic= o en el cuerpo.
 */
const provider = await createProvider();
const services = await createServices();
const clinics = await loadClinics(services);

const wa = config.whatsapp;
const canSendWhatsApp = Boolean(wa.token);
const outbox = new WebOutbox();
const { WhatsAppCloudClient } = await import("./channels/whatsappClient.js");
const runtimes = buildRuntimes({
  services, clinics, provider, clock: systemClock, outbox,
  whatsappFor: (phoneNumberId) => (canSendWhatsApp ? new WhatsAppCloudClient(wa.token, phoneNumberId) : null),
});
const primary = [...runtimes.values()].find((r) => r.profile.primary) ?? [...runtimes.values()][0]!;

// Agenda en memoria: cada clínica arranca con algunos turnos ocupados de ejemplo.
if (services.calendarKind === "memoria") {
  for (const rt of runtimes.values()) {
    await withClinic(rt.profile, () => seedCalendar(rt.calendar, systemClock, rt.profile.primary ? "a" : "b"));
  }
}
// Base en memoria (entorno de pruebas): 30 días de datos ficticios para que el panel tenga contenido.
if (services.storeKind === "memoria" && process.env.DEMO_DATA !== "false") {
  const { loadDemoMemory } = await import("./data/loadDemo.js");
  for (const rt of runtimes.values()) await loadDemoMemory(rt.store, rt.calendar, rt.profile, systemClock());
}

const auth = createAuth(services.storeKind);

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
    route: (phoneNumberId) => {
      const rt = runtimeByPhoneNumberId(runtimes, phoneNumberId);
      return rt ? { bot: rt.bot, sender: rt.whatsapp ?? noToken } : null;
    },
  }));
  const withNumber = [...runtimes.values()].filter((r) => r.profile.whatsappPhoneNumberId).map((r) => r.profile.name);
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
    clinics: [...runtimes.values()].map((r) => ({ id: r.profile.id, name: r.profile.name, whatsapp: Boolean(r.profile.whatsappPhoneNumberId) })),
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
  const { sessionId, text, source } = req.body ?? {};
  if (!validSession(sessionId)) return res.status(400).json({ error: "Sesión inválida" });
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Mensaje vacío" });
  if (JSON.stringify(req.body).length > 20_000) return res.status(413).json({ error: "Pedido demasiado grande" });
  if (text.length > 600) return res.status(400).json({ error: "El mensaje es demasiado largo (máx. 600 caracteres)." });
  if (!allowed(req.ip ?? "?")) {
    return res.status(429).json({ error: "Demasiados mensajes seguidos. Espere unos minutos y vuelva a intentar." });
  }
  try {
    const r = await rt.bot.handle({
      channel: "web",
      userId: sessionId,
      text: text.trim(),
      source: typeof source === "string" && source ? source.slice(0, 40) : null,
    });
    res.json({
      messages: r.messages,
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
    const byEvent = new Map(appts.map((a) => [a.calendarEventId, a]));
    res.json({
      from: start.toISODate(),
      today: toLocal(systemClock()).toISODate(),
      now: localKey(toLocal(systemClock())),
      hours: rt.profile.knowledge.hours,
      events: events.map((e) => {
        const a = byEvent.get(e.id);
        return {
          id: e.id,
          start: localKey(DateTime.fromISO(e.start)),
          end: localKey(DateTime.fromISO(e.end)),
          // "bot" = reservado desde el chat; "ocupado" = cualquier otro evento (ejemplos, agenda manual)
          kind: a && !a.id.startsWith("demo_") ? "bot" : "ocupado",
          title: a ? `${a.treatment}` : "Ocupado",
          patient: a && !a.id.startsWith("demo_") ? a.patientName : null,
        };
      }),
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
