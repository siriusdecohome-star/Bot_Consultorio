import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { config, ROOT } from "./config.js";
import { BotEngine } from "./bot/engine.js";
import { createProvider } from "./llm/index.js";
import { createServices } from "./services/factory.js";
import { seedCalendar } from "./data/seed.js";
import { clinic } from "./data/knowledge.js";
import { localKey, systemClock, toLocal, TZ } from "./services/time.js";
import { ChannelNotifier, WebOutbox } from "./services/notifier.js";
import { followupMessage, ReminderService } from "./bot/reminders.js";
import type { WhatsAppSender } from "./channels/whatsappClient.js";
import { checkCredentials, clearCookie, createPanelRouter, isAuthed, sessionCookie } from "./panel.js";

/**
 * Servidor HTTP: sirve el simulador web y la API que usa.
 * El simulador es solo otro canal: traduce el chat web a IncomingMessage
 * y muestra lo que devuelve el mismo motor que usará WhatsApp.
 */
const provider = await createProvider();
const services = await createServices();
if (services.calendarKind === "memoria") await seedCalendar(services.calendar, systemClock);
const bot = new BotEngine(provider, services.store, services.calendar);

const app = express();
// Se guarda el cuerpo crudo: la firma de Meta se calcula sobre los bytes exactos recibidos.
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; },
}));
app.use(express.static(path.join(ROOT, "public")));

// --- Canal WhatsApp (etapa 4): se activa si el .env tiene token e id del número ---
const wa = config.whatsapp;
let whatsappStatus = "desactivado (falta WHATSAPP_VERIFY_TOKEN)";
let waSender: WhatsAppSender | null = null;
if (wa.verifyToken) {
  const { WhatsAppCloudClient } = await import("./channels/whatsappClient.js");
  const { createWhatsAppRouter } = await import("./channels/whatsappWebhook.js");
  const canSend = Boolean(wa.token && wa.phoneNumberId);
  // Sin token igual se monta el webhook: Meta puede verificarlo, y los mensajes
  // entrantes se registran en la terminal aunque todavía no se puedan responder.
  const sender: WhatsAppSender = canSend ? new WhatsAppCloudClient() : {
    async sendText(to: string) { console.log(`[whatsapp] (sin WHATSAPP_TOKEN) no se pudo responder a ${to.slice(0, 4)}•••`); },
    async sendButtons(to: string) { console.log(`[whatsapp] (sin WHATSAPP_TOKEN) no se pudo responder a ${to.slice(0, 4)}•••`); },
    async sendTemplate() {},
    async markReadAndTyping() {},
  };
  if (canSend) waSender = sender;
  app.use("/webhook/whatsapp", createWhatsAppRouter({ bot, sender, verifyToken: wa.verifyToken, appSecret: wa.appSecret }));
  whatsappStatus = [
    "webhook en /webhook/whatsapp",
    canSend ? "envío activo" : "⚠ sin WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID: recibe pero no responde",
    wa.appSecret ? "" : "⚠ sin WHATSAPP_APP_SECRET: no se valida la firma",
  ].filter(Boolean).join(" · ");
}

// --- Recordatorios y seguimiento (etapa 5) ---
const outbox = new WebOutbox();
const notifier = new ChannelNotifier({ whatsapp: waSender, web: outbox });
const reminders = new ReminderService(services.store, notifier, systemClock);

// --- Panel de gestión (etapa 6): página y API protegidas ---
app.use("/api/panel", createPanelRouter({ store: services.store, clock: systemClock, notifier }));
app.get(["/panel", "/panel/"], (req, res) =>
  res.sendFile(path.join(ROOT, "private", isAuthed(req) ? "panel.html" : "login.html")));
app.post("/panel/login", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
  // Freno simple contra intentos repetidos: 10 por IP cada 10 minutos.
  if (!allowedLogin(req.ip ?? "?")) return res.redirect(303, "/panel?error=intentos");
  if (!checkCredentials(req.body?.user, req.body?.password)) return res.redirect(303, "/panel?error=1");
  const secure = req.protocol === "https" || req.header("x-forwarded-proto") === "https" || Boolean(req.header("cf-connecting-ip"));
  res.setHeader("Set-Cookie", sessionCookie(secure));
  res.redirect(303, "/panel");
});
app.post("/panel/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearCookie);
  res.redirect(303, "/panel");
});
app.get("/panel/:file", (req, res) => {
  const file = String(req.params.file);
  const isPublic = file === "panel.css"; // la hoja de estilos la usa también la pantalla de ingreso
  if (!/^[a-z0-9-]+\.(js|css)$/.test(file) || (!isPublic && !isAuthed(req))) return res.sendStatus(404);
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
let remindersStatus = "desactivados (REMINDERS_ENABLED=false)";
if (config.reminders.enabled) {
  const tick = async () => {
    try {
      const r = await reminders.sweep();
      const n = r.reminder24 + r.reminder2 + r.followups;
      if (n || r.errors.length) {
        console.log(`[recordatorios] 24 h: ${r.reminder24} · 2 h: ${r.reminder2} · seguimientos: ${r.followups}${r.errors.length ? ` · errores: ${r.errors.join("; ")}` : ""}`);
      }
    } catch (err) {
      console.error("[recordatorios]", (err as Error).message);
    }
  };
  setInterval(tick, config.reminders.intervalSec * 1000);
  setTimeout(tick, 5000);
  remindersStatus = `cada ${config.reminders.intervalSec} s · seguimiento de leads a las ${config.reminders.followupAfterHours} h`;
}

const validSession = (s: unknown): s is string => typeof s === "string" && /^web:[a-z0-9-]{4,40}$/i.test(s);

// El simulador consulta esta bandeja para mostrar los mensajes que el bot envía por su cuenta.
app.get("/api/outbox", (req, res) => {
  if (!validSession(req.query.sessionId)) return res.status(400).json({ error: "Sesión inválida" });
  res.json({ messages: outbox.take(req.query.sessionId) });
});

/** Demo: dispara ya el recordatorio del próximo turno de esta sesión web (para el video). */
app.post("/api/demo/remind", async (req, res) => {
  const { sessionId, kind } = req.body ?? {};
  if (!validSession(sessionId)) return res.status(400).json({ error: "Sesión inválida" });
  const patient = await services.store.getOrCreatePatient(sessionId, "web");
  const next = (await services.store.listAppointments({
    patientId: patient.id, from: new Date().toISOString(), status: ["confirmada", "pendiente"],
  }))[0];
  if (!next) return res.status(404).json({ error: "Esta conversación no tiene turnos próximos. Reserve uno primero." });
  await reminders.remindNow(next.id, kind === "reminder2" ? "reminder2" : "reminder24");
  res.json({ ok: true });
});

/** Demo: dispara ya el seguimiento de lead de esta sesión web. */
app.post("/api/demo/followup", async (req, res) => {
  const { sessionId } = req.body ?? {};
  if (!validSession(sessionId)) return res.status(400).json({ error: "Sesión inválida" });
  const patient = await services.store.getOrCreatePatient(sessionId, "web", "promo-noviembre");
  const msg = followupMessage(patient.name);
  const conv = await services.store.getOrCreateConversation(patient, "web");
  outbox.push(sessionId, msg);
  conv.messages.push({ role: "bot", text: msg.text, at: new Date().toISOString(), meta: { kind: "followup" } });
  conv.privacyShown = true;
  await services.store.saveConversation(conv);
  res.json({ ok: true });
});

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

app.get("/api/config", (_req, res) => {
  res.json({
    clinic: clinic.name,
    provider: bot.providerName,
    store: services.storeKind,
    calendar: services.calendarKind,
    timezone: TZ(),
  });
});

app.post("/api/session", (_req, res) => {
  // Cada sesión web es un "paciente" distinto, identificado como web:<id>.
  res.json({ sessionId: `web:${randomUUID().slice(0, 8)}` });
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, text, source } = req.body ?? {};
  if (!validSession(sessionId)) {
    return res.status(400).json({ error: "Sesión inválida" });
  }
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Mensaje vacío" });
  if (JSON.stringify(req.body).length > 20_000) return res.status(413).json({ error: "Pedido demasiado grande" });
  if (text.length > 600) return res.status(400).json({ error: "El mensaje es demasiado largo (máx. 600 caracteres)." });
  if (!allowed(req.ip ?? "?")) {
    return res.status(429).json({ error: "Demasiados mensajes seguidos. Espere unos minutos y vuelva a intentar." });
  }
  try {
    const r = await bot.handle({
      channel: "web",
      userId: sessionId,
      text: text.trim(),
      source: typeof source === "string" && source ? source.slice(0, 40) : null,
    });
    res.json({
      messages: r.messages,
      handedOff: r.handedOff,
      metric: r.metric ?? null,
      // `when` = horario afectado, para que el panel salte a esa semana y lo resalte.
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
});

/**
 * Agenda de la semana para el panel lateral. Devuelve horas locales del consultorio
 * ya formateadas, así el navegador no hace cálculos de zona horaria.
 */
app.get("/api/agenda", async (req, res) => {
  try {
    const start = typeof req.query.from === "string"
      ? DateTime.fromISO(req.query.from, { zone: TZ() }).startOf("day")
      : toLocal(systemClock()).startOf("week");
    const end = start.plus({ days: 6 });
    const [events, appts] = await Promise.all([
      services.calendar.listEvents(start, end),
      services.store.listAppointments({ from: start.toUTC().toISO()!, to: end.toUTC().toISO()!, status: ["confirmada", "pendiente"] }),
    ]);
    const byEvent = new Map(appts.map((a) => [a.calendarEventId, a]));
    res.json({
      from: start.toISODate(),
      today: toLocal(systemClock()).toISODate(),
      now: localKey(toLocal(systemClock())),
      hours: clinic.hours,
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
});

app.listen(config.port, () => {
  console.log(`Simulador listo en http://localhost:${config.port}`);
  console.log(`IA: ${bot.providerName} · base: ${services.storeKind} · agenda: ${services.calendarKind} · zona: ${TZ()}`);
  console.log(`WhatsApp: ${whatsappStatus}`);
  console.log(`Recordatorios: ${remindersStatus}`);
  console.log(`Panel: http://localhost:${config.port}/panel ${config.panel.password ? `(usuario «${config.panel.user}», contraseña en PANEL_PASSWORD)` : "(solo desde esta PC: sin PANEL_PASSWORD)"}`);
});
