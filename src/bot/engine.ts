import { privacyNotice } from "../data/knowledge.js";
import type { LlmProvider, ToolCallLog } from "../llm/types.js";
import type { CalendarService } from "../services/calendar.js";
import type { Channel, Store, TurnMetric } from "../services/store.js";
import { toLocal, type Clock, systemClock } from "../services/time.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { makeExecutor, toolDefs } from "./tools.js";
import { withinOpeningHours } from "../services/calendar.js";

export interface IncomingMessage {
  channel: Channel;
  /** Teléfono (WhatsApp) o id de sesión (simulador web). */
  userId: string;
  text: string;
  /** Origen del lead, p. ej. "promo-noviembre" (viene en el link de la promo). */
  source?: string | null;
}

export interface BotReply {
  /** Mensajes a enviar en orden (el aviso de privacidad va primero la primera vez). */
  messages: string[];
  conversationId: string;
  handedOff: boolean;
  metric?: TurnMetric;
  toolCalls: ToolCallLog[];
}

/**
 * Motor único del bot. Los canales (WhatsApp, simulador web, consola, pruebas)
 * solo traducen su formato a IncomingMessage y envían los mensajes devueltos.
 */
export class BotEngine {
  private system = buildSystemPrompt();

  constructor(
    private provider: LlmProvider,
    private store: Store,
    private calendar: CalendarService,
    private clock: Clock = systemClock,
  ) {}

  get providerName() {
    return `${this.provider.name}:${this.provider.model}`;
  }

  async handle(msg: IncomingMessage): Promise<BotReply> {
    let patient = await this.store.getOrCreatePatient(msg.userId, msg.channel, msg.source ?? null);
    const conv = await this.store.getOrCreateConversation(patient, msg.channel);
    const at = this.clock().toISOString();
    conv.messages.push({ role: "patient", text: msg.text, at });

    const out: string[] = [];
    if (!conv.privacyShown) {
      out.push(privacyNotice);
      conv.privacyShown = true;
    }

    // Conversación tomada por una persona: el bot no interviene.
    if (conv.handedOff) {
      const reply = "Su mensaje fue recibido. Una persona del equipo le responderá a la brevedad. 🙌";
      const lastBot = [...conv.messages].reverse().find((m) => m.role === "bot");
      if (lastBot?.text !== reply) out.push(reply);
      for (const t of out) conv.messages.push({ role: "bot", text: t, at });
      await this.store.saveConversation(conv);
      return { messages: out, conversationId: conv.id, handedOff: true, toolCalls: [] };
    }

    // Si cambió el proveedor (p. ej. de mock a Claude), el historial nativo no es compatible: se reinicia.
    if (conv.llmProvider !== this.provider.name) {
      conv.llmState = [];
      conv.llmProvider = this.provider.name;
    }

    const ctx = { store: this.store, calendar: this.calendar, clock: this.clock, patient, conversation: conv };
    const execute = makeExecutor(ctx);
    const now = toLocal(this.clock());
    const open = withinOpeningHours(now.set({ second: 0, millisecond: 0 }));
    const turnContext = [
      "[Nota de contexto del sistema, no la mencione]",
      `Fecha y hora actual en el consultorio: ${now.setLocale("es").toFormat("cccc dd/MM/yyyy HH:mm")} (${now.toISODate()}).`,
      `Consultorio ${open ? "ABIERTO" : "CERRADO"} en este momento.`,
      `Canal: ${msg.channel}. Teléfono del paciente: ${patient.phone}.`,
      `Nombre registrado: ${ctx.patient.name ?? "desconocido"}.`,
      patient.source ? `Llegó por: ${patient.source}.` : "",
    ].filter(Boolean).join("\n");

    const t0 = performance.now();
    let text: string;
    let toolCalls: ToolCallLog[] = [];
    let metric: TurnMetric | undefined;
    try {
      const r = await this.provider.runTurn({
        system: this.system,
        state: conv.llmState,
        userText: msg.text,
        turnContext,
        tools: toolDefs,
        executeTool: execute,
      });
      text = r.text || "Disculpe, ¿podría repetirme su consulta?";
      toolCalls = r.toolCalls;
      conv.llmState = r.state;
      metric = {
        conversationId: conv.id,
        provider: this.provider.name,
        model: this.provider.model,
        latencyMs: Math.round(performance.now() - t0),
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        cacheReadTokens: r.usage.cacheReadTokens,
        costUsd: r.usage.costUsd,
        modelCalls: r.modelCalls,
        tools: r.toolCalls.map((c) => c.name),
        at,
      };
      await this.store.logMetric(metric);
    } catch (err) {
      console.error("[engine] error del proveedor:", err);
      text = "Disculpe, estoy con una demora técnica. ¿Puede escribirme nuevamente en unos minutos? Si es urgente, escriba «persona».";
    }

    out.push(text);
    for (const t of out) conv.messages.push({ role: "bot", text: t, at: this.clock().toISOString() });
    await this.store.saveConversation(conv);
    patient = ctx.patient;
    return { messages: out, conversationId: conv.id, handedOff: conv.handedOff, metric, toolCalls };
  }
}
