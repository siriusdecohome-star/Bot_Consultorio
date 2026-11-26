import type { BotEngine, BotReply } from "../bot/engine.js";
import type { Channel } from "../services/store.js";
import type { WhatsAppSender } from "./whatsappClient.js";

/**
 * Entrada ÚNICA de mensajes de pacientes. El webhook de WhatsApp y el simulador web
 * llaman a esta función: mismo motor, mismas herramientas y misma base; solo cambia el
 * canal (de dónde llega el mensaje y por dónde sale la respuesta).
 * - WhatsApp: el remitente es el número del paciente y la respuesta sale por la Cloud API.
 * - Simulador: el remitente es la sesión del navegador y la respuesta vuelve en el pedido;
 *   los avisos que el bot envía por su cuenta (recordatorios, ofertas) llegan por su bandeja.
 * Así, lo que se prueba en el simulador es exactamente lo que pasa por WhatsApp.
 */
export interface InboundMessage {
  channel: Channel;
  /** Número de WhatsApp («+549…») o sesión del simulador («web:…»). */
  from: string;
  text: string;
  /** Nombre del perfil de WhatsApp (el simulador no lo tiene). */
  profileName?: string | null;
  /** Origen del lead (link de la promo). */
  source?: string | null;
}

export function receiveMessage(bot: BotEngine, m: InboundMessage): Promise<BotReply> {
  return bot.handle({ channel: m.channel, userId: m.from, text: m.text, source: m.source ?? null, profileName: m.profileName ?? null });
}

/** Envía por WhatsApp las respuestas del motor (el último mensaje con su menú de botones o lista, si tiene). */
export async function deliverWhatsApp(sender: WhatsAppSender, to: string, reply: BotReply): Promise<void> {
  for (const [i, text] of reply.messages.entries()) {
    const ui = i === reply.messages.length - 1 ? reply.interactive : undefined;
    if (ui?.buttons?.length) await sender.sendButtons(to, text, ui.buttons.map((t, j) => ({ id: `menu${j}`, title: t })));
    else if (ui?.list && sender.sendList) await sender.sendList(to, text, ui.list.button, ui.list.rows);
    else if (ui?.list) await sender.sendText(to, `${text}\n\n${ui.list.rows.map((r, j) => `${j + 1}. ${r.title}`).join("\n")}`);
    else await sender.sendText(to, text);
  }
}
