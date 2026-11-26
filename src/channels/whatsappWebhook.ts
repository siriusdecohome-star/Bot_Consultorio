import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { BotEngine } from "../bot/engine.js";
import type { WhatsAppSender } from "./whatsappClient.js";
import { deliverWhatsApp, receiveMessage } from "./inbound.js";

/**
 * Adaptador del canal WhatsApp: traduce los avisos (webhooks) de Meta a
 * IncomingMessage para el motor, y envía de vuelta sus respuestas.
 */

export interface InboundWhatsApp {
  id: string;
  from: string; // wa_id del paciente, p. ej. "5491122334455"
  name: string | null;
  text: string | null; // null = tipo no soportado (audio, imagen…)
  type: string;
  /** Si viene de un link de promo con texto predefinido, p. ej. "#promo-noviembre" */
  source: string | null;
  /** Número del consultorio que recibió el mensaje (multiempresa: define la clínica). */
  phoneNumberId: string | null;
}

/** Valida la firma X-Hub-Signature-256: confirma que el aviso lo mandó Meta y no un tercero. */
export function validSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(header.slice(7), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Extrae los mensajes entrantes del aviso. Ignora estados (enviado, entregado, leído). */
export function parseWebhook(body: any): InboundWhatsApp[] {
  const out: InboundWhatsApp[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      if (change?.field !== "messages" || !v?.messages) continue;
      const phoneNumberId: string | null = v.metadata?.phone_number_id ?? null;
      const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages) {
        let text: string | null = null;
        if (m.type === "text") text = m.text?.body ?? null;
        else if (m.type === "button") text = m.button?.text ?? null; // botón de plantilla
        else if (m.type === "interactive") {
          text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
        }
        const tag = text?.match(/#([a-z0-9-]{3,40})/i)?.[1] ?? null;
        out.push({ id: m.id, from: m.from, name: names.get(m.from) ?? null, text, type: m.type, source: tag, phoneNumberId });
      }
    }
  }
  return out;
}

/** Motor y cliente de envío de la clínica dueña de un número. */
export interface WhatsAppTarget {
  bot: BotEngine;
  sender: WhatsAppSender;
  /** Línea que recibió el mensaje: la conversación queda asociada y la respuesta sale por ella. */
  lineId?: string | null;
}

export interface WebhookOptions {
  /**
   * Multiempresa y multilínea: devuelve la clínica y la línea según el número que recibió el mensaje.
   * null = número desconocido (se ignora el mensaje).
   */
  route?: (phoneNumberId: string | null) => WhatsAppTarget | null | Promise<WhatsAppTarget | null>;
  /**
   * Marca un mensaje como procesado: true la primera vez, false si es un reintento de Meta.
   * Por defecto, en memoria; con varias instancias (Vercel), en la base (services/shared.ts).
   */
  claim?: (messageId: string) => Promise<boolean>;
  /**
   * Trabajo que sigue después de responder 200 a Meta. En un servidor común basta con no
   * esperarlo; en Vercel hay que pasarlo a waitUntil para que la función no se congele.
   */
  defer?: (work: Promise<unknown>) => void;
  /** Una sola clínica (pruebas): se usa para cualquier número. */
  bot?: BotEngine;
  sender?: WhatsAppSender;
  verifyToken: string;
  appSecret: string;
  log?: (msg: string) => void;
}

type RawRequest = Request & { rawBody?: Buffer };

export function createWhatsAppRouter(opts: WebhookOptions): Router {
  const log = opts.log ?? ((m) => console.log(`[whatsapp] ${m}`));
  const resolve = async (phoneNumberId: string | null): Promise<WhatsAppTarget | null> =>
    opts.route ? opts.route(phoneNumberId) : opts.bot && opts.sender ? { bot: opts.bot, sender: opts.sender } : null;
  const router = Router();

  // Meta reintenta los avisos si no respondemos rápido: evitamos procesar dos veces el mismo mensaje.
  const seen = new Map<string, number>();
  const claim = opts.claim ?? (async (id: string) => {
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > 60 * 60 * 1000) seen.delete(k);
    if (seen.has(id)) return false;
    seen.set(id, now);
    return true;
  });
  const defer = opts.defer ?? ((work: Promise<unknown>) => void work);

  // Mensajes del mismo paciente se procesan en orden, uno por vez.
  const chains = new Map<string, Promise<void>>();
  const enqueue = (key: string, job: () => Promise<void>) => {
    const next = (chains.get(key) ?? Promise.resolve()).then(job, job);
    chains.set(key, next.catch(() => undefined));
    return next;
  };

  // 1) Verificación del webhook: Meta llama con GET al configurarlo.
  router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && opts.verifyToken && token === opts.verifyToken) {
      log("webhook verificado por Meta");
      return res.status(200).type("text/plain").send(String(challenge ?? ""));
    }
    log("verificación rechazada: el token no coincide con WHATSAPP_VERIFY_TOKEN");
    return res.sendStatus(403);
  });

  // 2) Avisos entrantes: se responde 200 de inmediato y se procesa después.
  router.post("/", (req: RawRequest, res) => {
    if (opts.appSecret && !validSignature(req.rawBody ?? Buffer.alloc(0), req.header("x-hub-signature-256"), opts.appSecret)) {
      log("aviso con firma inválida: descartado");
      return res.sendStatus(401);
    }
    res.sendStatus(200);

    for (const m of parseWebhook(req.body)) {
      defer((async () => {
        // Reintento de Meta: ya se respondió. Si la base no responde, se atiende igual (mejor un duplicado que un silencio).
        const first = await claim(m.id).catch((err) => { log(`no se pudo verificar si ${m.id} era repetido: ${(err as Error).message}`); return true; });
        if (!first) return;
        const target = await resolve(m.phoneNumberId);
        if (!target) {
          log(`mensaje para un número sin clínica asignada (${m.phoneNumberId ?? "?"}): ignorado`);
          return;
        }
        await enqueue(`${m.phoneNumberId}:${m.from}`, () => handle(m, target));
      })().catch((err) => log(`error procesando ${m.id}: ${(err as Error).message}`)));
    }
  });

  async function handle(m: InboundWhatsApp, { bot, sender, lineId }: WhatsAppTarget) {
    await sender.markReadAndTyping(m.id);
    if (m.text === null) {
      await sender.sendText(m.from, "Por ahora solo puedo leer mensajes de texto. ¿Me escribe su consulta, por favor? 🙏");
      return;
    }
    log(`← ${mask(m.from)}: ${m.text.slice(0, 80)}`);
    // Misma entrada que el simulador (channels/inbound.ts); solo cambia el canal.
    const reply = await receiveMessage(bot, { channel: "whatsapp", from: `+${m.from}`, text: m.text, source: m.source, profileName: m.name, lineId: lineId ?? null });
    await deliverWhatsApp(sender, m.from, reply);
    const ms = reply.metric ? `${reply.metric.latencyMs} ms` : "";
    log(`→ ${mask(m.from)}: ${reply.messages.length} mensaje(s) ${ms}`);
  }

  return router;
}

/** En los registros no se muestra el número completo del paciente. */
const mask = (n: string) => `${n.slice(0, 4)}•••${n.slice(-3)}`;
