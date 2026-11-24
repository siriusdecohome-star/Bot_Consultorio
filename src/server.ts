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
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(ROOT, "public")));

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
  if (typeof sessionId !== "string" || !/^web:[a-z0-9-]{4,40}$/i.test(sessionId)) {
    return res.status(400).json({ error: "Sesión inválida" });
  }
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Mensaje vacío" });
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
});
