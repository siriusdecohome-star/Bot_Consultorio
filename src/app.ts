import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { DateTime } from "luxon";
import { config, ROOT } from "./config.js";
import { createProvider } from "./llm/index.js";
import { createServices } from "./services/factory.js";
import { seedCalendar } from "./data/seed.js";
import { localKey, systemClock, toLocal, TZ } from "./services/time.js";
import type { WhatsAppSender } from "./channels/whatsappClient.js";
import { createPanelRouter } from "./panel.js";
import { clearCookie, createAuth, isSecure } from "./auth.js";
import { buildRuntimes, lineByPhoneNumberId, loadClinics, type ClinicRuntime } from "./clinics/registry.js";
import { ClinicDirectory } from "./clinics/directory.js";
import { cloudLines, hasWhatsApp, lineById, simulatedLines } from "./clinics/lines.js";
import type { ClinicProfile } from "./clinics/types.js";
import { withClinic } from "./clinics/context.js";
import { SupabaseStore } from "./services/supabaseStore.js";
import { MemoryShared, SupabaseShared, type SharedState } from "./services/shared.js";
import { closeIdleConversations } from "./bot/conversationState.js";
import { receiveMessage } from "./channels/inbound.js";
import { DemoLimitError, DemoService, isTempClinic } from "./demo/tempClinics.js";
import { MockProvider } from "./llm/mock.js";

/**
 * Aplicación HTTP: simulador web, webhook de WhatsApp, panel del consultorio y su API.
 * La usan el servidor local (src/server.ts, con sus temporizadores) y la función de
 * Vercel (api/index.ts), donde el trabajo periódico lo dispara el cron de Supabase
 * llamando a POST /api/cron/tick.
 * Multiempresa: cada clínica tiene su motor, su agenda, sus avisos y sus recordatorios
 * (ver clinics/registry.ts); las rutas reciben la clínica con ?clinic= o en el cuerpo.
 */
export interface AppOptions {
  /** Función sin servidor (Vercel): sin temporizadores y con trabajo diferido por waitUntil. */
  serverless?: boolean;
  /** Para que el webhook termine su trabajo después de responder (waitUntil de Vercel). */
  defer?: (work: Promise<unknown>) => void;
}

export interface App {
  app: Express;
  /** Recordatorios, seguimientos, lista de espera, cierre por inactividad y demos vencidas. */
  tick(): Promise<string[]>;
  /** Solo recordatorios y lista de espera (el servidor local los corre cada minuto). */
  sweepReminders(): Promise<string[]>;
  /** Cierre por inactividad, demos vencidas y limpieza del estado compartido. */
  housekeeping(): Promise<string[]>;
  info: { provider: string; store: string; calendar: string; clinics: string; whatsapp: string };
}

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const provider = await createProvider();
  const services = await createServices();

  // Producción: no arranca con una configuración insegura o incompleta.
  if (config.isProduction) {
    const problems = [
      services.storeKind !== "supabase" && "falta Supabase (en producción no se usa la base en memoria)",
      !config.panel.sessionSecret && "falta PANEL_SESSION_SECRET (sin ella las sesiones se pierden al reiniciar)",
      !config.supabase.publishableKey && "falta SUPABASE_PUBLISHABLE_KEY (login del panel)",
      config.whatsapp.verifyToken && !config.whatsapp.appSecret && "falta WHATSAPP_APP_SECRET (sin ella no se valida la firma de Meta)",
      opts.serverless && !config.cron.secret && "falta CRON_SECRET (el cron de Supabase llama a /api/cron/tick con esa clave)",
      provider.notice && `IA: ${provider.notice}`,
    ].filter(Boolean);
    if (problems.length) throw new Error(`No se puede iniciar en producción:\n- ${problems.join("\n- ")}`);
  }
  const clinics = await loadClinics(services);

  const wa = config.whatsapp;
  const canSendWhatsApp = Boolean(wa.token);
  // Estado común a todas las instancias: en Vercel, en la base (services/shared.ts).
  const shared: SharedState = services.storeKind === "supabase" ? new SupabaseShared((services.store as SupabaseStore).client) : new MemoryShared();
  const outbox = shared.outbox;
  const { WhatsAppCloudClient } = await import("./channels/whatsappClient.js");
  const auth = createAuth(services.storeKind);
  // Demo pública: clínicas temporales por visita (las que ya existían en la base se cargan como el resto).
  const fallback = new MockProvider("tope de IA de la demo");
  const runtimes = new Map<string, ClinicRuntime>();
  const demo = new DemoService({
    services, runtimes, provider, fallback, clock: systemClock, outbox, auth,
    template: clinics.find((c) => c.primary && !isTempClinic(c)) ?? clinics[0]!,
  });
  const build = (list: ClinicProfile[], setDefault = false) => buildRuntimes({
    services, clinics: list, provider, clock: systemClock, outbox, setDefault,
    whatsappFor: (phoneNumberId) => (canSendWhatsApp ? new WhatsAppCloudClient(wa.token, phoneNumberId) : null),
    aiBudgetFor: (p) => demo.budgetFor(p), fallbackProvider: fallback,
  });
  for (const [id, rt] of build(clinics, true)) runtimes.set(id, rt);
  const directory = new ClinicDirectory(runtimes, { services, clock: systemClock, ttlMs: Number(process.env.CLINIC_CACHE_MS) || undefined, build: (p) => build([p]).get(p.id)! });
  const primaryId = ([...runtimes.values()].find((r) => r.profile.primary && !isTempClinic(r.profile)) ?? [...runtimes.values()][0]!).profile.id;

  // Agenda en memoria: cada clínica arranca con algunos turnos ocupados de ejemplo.
  if (services.calendarKind === "memoria") {
    for (const rt of runtimes.values()) {
      if (isTempClinic(rt.profile)) continue;
      await withClinic(rt.profile, () => seedCalendar(rt.calendar, systemClock, rt.profile.primary ? "a" : "b"));
    }
  }
  // Base en memoria (entorno de pruebas): 30 días de datos ficticios para que el panel tenga contenido.
  if (services.storeKind === "memoria" && process.env.DEMO_DATA !== "false" && !config.isProduction) {
    const { loadDemoMemory, loadExampleDocument } = await import("./data/loadDemo.js");
    for (const rt of runtimes.values()) await loadDemoMemory(rt.store, rt.calendar, rt.profile, systemClock());
    await loadExampleDocument(runtimes.get(primaryId)!.store);
  }

  const app = express();
  app.set("trust proxy", true);
  // Documentos de la zona de aprendizaje: llegan en base64 (en Vercel el cuerpo tiene un máximo de 4,5 MB).
  app.use("/api/panel/documents", express.json({ limit: "12mb" }));
  // Se guarda el cuerpo crudo: la firma de Meta se calcula sobre los bytes exactos recibidos.
  app.use(express.json({
    limit: "1mb",
    verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; },
  }));
  app.use(express.static(path.join(ROOT, "public")));

  /**
   * IP real del visitante, para los límites. En Vercel la pone la plataforma (x-real-ip) y no se
   * confía en encabezados que el cliente podría inventar; detrás del túnel de Cloudflare, cf-connecting-ip.
   */
  const clientIp = (req: Request) =>
    (process.env.VERCEL ? req.header("x-real-ip") : req.header("cf-connecting-ip")) ?? req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? req.ip ?? "?";

  /** Clínica pedida en la URL o el cuerpo; sin indicar, la principal. */
  const runtimeFor = (req: Request): Promise<ClinicRuntime | null> => {
    const id = (typeof req.query.clinic === "string" && req.query.clinic) || (typeof req.body?.clinic === "string" && req.body.clinic) || primaryId;
    return directory.get(id);
  };
  /** Envuelve una ruta del simulador: resuelve la clínica y corre dentro de su contexto. */
  const clinicRoute = (fn: (rt: ClinicRuntime, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const rt = await runtimeFor(req).catch(() => null);
      if (!rt) return res.status(404).json({ error: "Clínica desconocida" });
      return withClinic(rt.profile, () => fn(rt, req, res));
    };

  // --- Canal WhatsApp: el webhook elige la clínica y la línea por el número que recibió el mensaje ---
  let whatsappStatus = "desactivado (falta WHATSAPP_VERIFY_TOKEN)";
  if (wa.verifyToken) {
    const { createWhatsAppRouter } = await import("./channels/whatsappWebhook.js");
    // Sin token igual se monta el webhook: Meta puede verificarlo, y los mensajes
    // entrantes se registran aunque todavía no se puedan responder.
    const noToken: WhatsAppSender = {
      async sendText(to: string) { console.log(`[whatsapp] (sin WHATSAPP_TOKEN) no se pudo responder a ${to.slice(0, 4)}•••`); },
      async sendButtons(to: string) { console.log(`[whatsapp] (sin WHATSAPP_TOKEN) no se pudo responder a ${to.slice(0, 4)}•••`); },
      async sendTemplate() {},
      async markReadAndTyping() {},
    };
    app.use("/webhook/whatsapp", createWhatsAppRouter({
      verifyToken: wa.verifyToken,
      appSecret: wa.appSecret,
      claim: (id) => shared.claimMessage(id),
      defer: opts.defer,
      // La respuesta sale por la misma línea que recibió el mensaje.
      route: async (phoneNumberId) => {
        const found = lineByPhoneNumberId(runtimes, phoneNumberId);
        const rt = found ? await directory.get(found.rt.profile.id) : null; // con los datos al día
        const line = rt ? lineById(rt.profile, found!.line.id) : null;
        return rt && line ? { bot: rt.bot, sender: rt.senders.get(line.id) ?? noToken, lineId: line.id } : null;
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
  app.use("/api/panel", createPanelRouter({ auth, runtimes, resolve: (id) => directory.get(id), clock: systemClock, storeFor }));

  app.get(["/panel", "/panel/"], async (req, res) => {
    const session = await auth.fromRequest(req, isSecure(req)).catch(() => null);
    if (session?.setCookie) res.setHeader("Set-Cookie", session.setCookie);
    res.sendFile(path.join(ROOT, "private", session ? "panel.html" : "login.html"));
  });
  app.post("/panel/login", express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
    // Freno simple contra intentos repetidos: 10 por IP cada 10 minutos.
    if (!(await shared.hit(`login:${clientIp(req)}`, 10 * 60_000, 10).catch(() => true))) return res.redirect(303, "/panel?error=intentos");
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
      const { clinicId, session } = await demo.start(clientIp(req), isSecure(req));
      if (session.setCookie) res.setHeader("Set-Cookie", session.setCookie);
      res.json({ ok: true, clinicId, panel: `/panel?recorrido=1#bandeja` });
    } catch (err) {
      if (err instanceof DemoLimitError) return res.status(429).json({ error: err.message });
      console.error("[demo]", err);
      res.status(500).json({ error: "No se pudo abrir la demo. Probá de nuevo en un momento." });
    }
  });

  app.get("/panel/:file", async (req, res) => {
    const file = String(req.params.file);
    const isPublic = file === "panel.css"; // la hoja de estilos la usa también la pantalla de ingreso
    if (!/^[a-z0-9-]+\.(js|css)$/.test(file)) return res.sendStatus(404);
    if (!isPublic && !(await auth.fromRequest(req, isSecure(req)).catch(() => null))) return res.sendStatus(404);
    res.sendFile(path.join(ROOT, "private", file));
  });

  // --- Trabajo periódico: recordatorios, seguimientos, lista de espera, inactividad y demos vencidas ---
  const sweepReminders = async () => {
    const log: string[] = [];
    if (!config.reminders.enabled) return log;
    for (const rt of runtimes.values()) {
      try {
        const r = await rt.reminders.sweep();
        const expired = await rt.waitlist.sweep();
        const n = r.reminder24 + r.reminder2 + r.followups + r.reactivations + expired;
        if (n || r.errors.length) {
          log.push(`[recordatorios · ${rt.profile.id}] 24 h: ${r.reminder24} · 2 h: ${r.reminder2} · seguimientos: ${r.followups} · reactivaciones: ${r.reactivations} · ofertas vencidas: ${expired}${r.errors.length ? ` · errores: ${r.errors.join("; ")}` : ""}`);
        }
      } catch (err) {
        log.push(`[recordatorios · ${rt.profile.id}] error: ${(err as Error).message}`);
      }
    }
    return log;
  };
  const housekeeping = async () => {
    const log: string[] = [];
    // Clínicas temporales vencidas de la demo pública: se borran con todos sus datos.
    const gone = await demo.cleanup().catch((err) => { log.push(`[demo] error: ${(err as Error).message}`); return 0; });
    if (gone) log.push(`[demo] ${gone} clínica(s) temporal(es) vencida(s) borrada(s)`);
    // Conversaciones sin movimiento: se cierran (se reabren si el paciente vuelve a escribir).
    for (const rt of runtimes.values()) {
      try {
        const n = await closeIdleConversations(rt.store, new Date(), config.inbox.idleHours);
        if (n) log.push(`[bandeja · ${rt.profile.id}] ${n} conversación(es) cerrada(s) por inactividad`);
      } catch (err) {
        log.push(`[bandeja · ${rt.profile.id}] error: ${(err as Error).message}`);
      }
    }
    await shared.purgeOld(new Date()).catch((err) => log.push(`[estado compartido] error: ${(err as Error).message}`));
    return log;
  };
  const tick = async () => {
    await directory.refreshAll(); // las clínicas al día, incluidas las creadas en otra instancia
    return [...(await housekeeping()), ...(await sweepReminders())];
  };

  /**
   * Cron de Supabase (pg_cron + pg_net) cada 5 minutos → POST /api/cron/tick con
   * «Authorization: Bearer CRON_SECRET». Sin CRON_SECRET la ruta no existe.
   */
  app.post("/api/cron/tick", async (req, res) => {
    const want = config.cron.secret;
    const got = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.sendStatus(404);
    const t0 = Date.now();
    try {
      const log = await tick();
      for (const l of log) console.log(l);
      res.json({ ok: true, ms: Date.now() - t0, log });
    } catch (err) {
      console.error("[cron]", err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  const validSession = (s: unknown): s is string => typeof s === "string" && /^web:[a-z0-9-]{4,40}$/i.test(s);

  // El simulador consulta esta bandeja para mostrar los mensajes que el bot envía por su cuenta.
  app.get("/api/outbox", clinicRoute(async (rt, req, res) => {
    if (!validSession(req.query.sessionId)) return res.status(400).json({ error: "Sesión inválida" });
    res.json({ messages: await outbox.take(`${rt.profile.id}|${req.query.sessionId}`) });
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
  const MAX_MSGS = Number(process.env.WEB_MAX_MSGS_PER_10MIN ?? 40);

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
    if (!(await shared.hit(`chat:${clientIp(req)}`, 10 * 60_000, MAX_MSGS).catch(() => true))) {
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

  return {
    app, tick, sweepReminders, housekeeping,
    info: {
      provider: runtimes.get(primaryId)!.bot.providerName,
      store: services.storeKind,
      calendar: services.calendarKind,
      clinics: [...runtimes.values()].map((r) => `${r.profile.name} (${r.profile.id}, ${r.profile.timezone})`).join(" · "),
      whatsapp: whatsappStatus,
    },
  };
}
