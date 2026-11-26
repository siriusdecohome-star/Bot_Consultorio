import { config } from "../config.js";
import type { WhatsAppSender } from "../channels/whatsappClient.js";
import { WhatsAppApiError } from "../channels/whatsappClient.js";
import type { Channel } from "./store.js";

/**
 * Envío de mensajes por iniciativa del bot (recordatorios, seguimiento).
 * Cada canal decide cómo: WhatsApp por la API de Meta, el simulador web
 * con una bandeja que la página consulta cada pocos segundos.
 */

export interface OutboundMessage {
  text: string;
  /** Botones de respuesta rápida (máx. 3, títulos de hasta 20 caracteres) */
  buttons?: string[];
  /** Plantilla de respaldo si WhatsApp no permite texto libre (ventana de 24 h cerrada) */
  template?: { name: string; params: string[] };
}

export interface Notifier {
  /** `lineId`: línea de WhatsApp por la que sale (la última por la que escribió el paciente). */
  send(channel: Channel, userId: string, msg: OutboundMessage, lineId?: string | null): Promise<"enviado" | "plantilla" | "omitido">;
}

/** Bandeja de salida del simulador web: la página la lee con GET /api/outbox. */
export class WebOutbox {
  private boxes = new Map<string, OutboundMessage[]>();
  push(userId: string, msg: OutboundMessage) {
    const list = this.boxes.get(userId) ?? [];
    list.push(msg);
    this.boxes.set(userId, list);
  }
  take(userId: string): OutboundMessage[] {
    const list = this.boxes.get(userId) ?? [];
    this.boxes.delete(userId);
    return list;
  }
}

export class ChannelNotifier implements Notifier {
  constructor(private deps: {
    /** Un cliente fijo, o uno por línea. */
    whatsapp?: WhatsAppSender | ((lineId: string | null | undefined) => WhatsAppSender | null) | null;
    web?: WebOutbox | null;
    /** Prefijo de la bandeja web: separa las sesiones del simulador de cada clínica. */
    webPrefix?: string;
    log?: (m: string) => void;
  }) {}

  async send(channel: Channel, userId: string, msg: OutboundMessage, lineId?: string | null) {
    const log = this.deps.log ?? ((m: string) => console.log(`[avisos] ${m}`));
    if (channel === "web" && this.deps.web) {
      this.deps.web.push(`${this.deps.webPrefix ?? ""}${userId}`, msg);
      return "enviado" as const;
    }
    const w = this.deps.whatsapp;
    const wa = typeof w === "function" ? w(lineId) : w;
    if (channel === "whatsapp" && wa) {
      const to = userId.replace(/^\+/, "");
      try {
        if (msg.buttons?.length) {
          await wa.sendButtons(to, msg.text, msg.buttons.map((t, i) => ({ id: `b${i}`, title: t })));
        } else {
          await wa.sendText(to, msg.text);
        }
        return "enviado" as const;
      } catch (err) {
        // 131047: pasaron más de 24 h desde el último mensaje del paciente → solo plantillas aprobadas.
        if (err instanceof WhatsAppApiError && err.code === 131047 && msg.template) {
          await wa.sendTemplate(to, msg.template.name, config.whatsapp.templateLang, msg.template.params);
          log(`ventana de 24 h cerrada: se usó la plantilla «${msg.template.name}»`);
          return "plantilla" as const;
        }
        throw err;
      }
    }
    log(`canal ${channel} sin envío activo: mensaje omitido`);
    return "omitido" as const;
  }
}
