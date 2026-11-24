import { config } from "../config.js";

/**
 * Cliente mínimo de la WhatsApp Cloud API (Graph API de Meta) con fetch nativo:
 * no hace falta un SDK para 3 llamadas, y así no sumamos dependencias.
 */

export interface WhatsAppSender {
  sendText(to: string, text: string): Promise<void>;
  /** Botones de respuesta rápida (máx. 3). Solo dentro de la ventana de 24 h. */
  sendButtons(to: string, text: string, buttons: Array<{ id: string; title: string }>): Promise<void>;
  /** Plantilla aprobada: única forma de escribir primero fuera de la ventana de 24 h. */
  sendTemplate(to: string, name: string, lang: string, bodyParams?: string[]): Promise<void>;
  /** Marca el mensaje como leído y muestra "escribiendo…" mientras el bot piensa. */
  markReadAndTyping(messageId: string): Promise<void>;
}

export class WhatsAppApiError extends Error {
  constructor(public status: number, public code: number | undefined, message: string) {
    super(message);
  }
}

/**
 * Formatos alternativos de un mismo número. Con números de Argentina (549…) y
 * México (521…), el número que llega en el webhook a veces no coincide con el
 * que Meta acepta para enviar al destinatario de prueba (error 131030).
 * Probamos el número tal cual y, si falla por eso, la variante sin el dígito móvil.
 */
export function phoneVariants(waId: string): string[] {
  const out = [waId];
  if (/^549\d{10}$/.test(waId)) out.push(`54${waId.slice(3)}`);
  if (/^521\d{10}$/.test(waId)) out.push(`52${waId.slice(3)}`);
  return out;
}

export class WhatsAppCloudClient implements WhatsAppSender {
  /** Recuerda qué variante funcionó para cada número. */
  private resolved = new Map<string, string>();

  constructor(
    private token = config.whatsapp.token,
    private phoneNumberId = config.whatsapp.phoneNumberId,
    private version = config.whatsapp.graphVersion,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async post(body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchFn(`https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      throw new WhatsAppApiError(res.status, data?.error?.code, data?.error?.message ?? `HTTP ${res.status}`);
    }
    return data;
  }

  /** Envía probando las variantes del número solo si Meta responde 131030 (destinatario no permitido). */
  private async toRecipient(waId: string, payload: Record<string, unknown>) {
    const known = this.resolved.get(waId);
    const candidates = known ? [known] : phoneVariants(waId);
    let lastErr: unknown;
    for (const to of candidates) {
      try {
        await this.post({ recipient_type: "individual", to, ...payload });
        this.resolved.set(waId, to);
        return;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof WhatsAppApiError && err.code === 131030)) throw err;
      }
    }
    throw lastErr;
  }

  async sendText(to: string, text: string) {
    await this.toRecipient(to, { type: "text", text: { body: text.slice(0, 4096), preview_url: false } });
  }

  async sendButtons(to: string, text: string, buttons: Array<{ id: string; title: string }>) {
    await this.toRecipient(to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: text.slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })),
        },
      },
    });
  }

  async sendTemplate(to: string, name: string, lang: string, bodyParams: string[] = []) {
    await this.toRecipient(to, {
      type: "template",
      template: {
        name,
        language: { code: lang },
        ...(bodyParams.length
          ? { components: [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: t })) }] }
          : {}),
      },
    });
  }

  async markReadAndTyping(messageId: string) {
    try {
      await this.post({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });
    } catch {
      // Es cosmético: si la versión de la API no lo soporta, el bot sigue funcionando.
    }
  }

  /** Para npm run check: valida token e id del número sin enviar nada. */
  async describeNumber(): Promise<{ display_phone_number?: string; verified_name?: string }> {
    const res = await this.fetchFn(
      `https://graph.facebook.com/${this.version}/${this.phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new WhatsAppApiError(res.status, data?.error?.code, data?.error?.message ?? `HTTP ${res.status}`);
    return data;
  }
}
