import { kb, privacyLine, privacyNotice } from "../data/knowledge.js";
import { withClinic } from "../clinics/context.js";
import type { ClinicProfile } from "../clinics/types.js";
import { config } from "../config.js";
import type { LlmProvider, ToolCallLog } from "../llm/types.js";
import type { CalendarService } from "../services/calendar.js";
import type { Channel, ChatMessage, Store, TurnMetric } from "../services/store.js";
import { human, toLocal, type Clock, systemClock } from "../services/time.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { makeExecutor, toolDefs, type ToolContext } from "./tools.js";
import type { WaitlistService } from "./waitlist.js";
import type { Patient } from "../services/store.js";
import { withinOpeningHours } from "../services/calendar.js";

export interface IncomingMessage {
  channel: Channel;
  /** Teléfono (WhatsApp) o id de sesión (simulador web). */
  userId: string;
  text: string;
  /** Origen del lead, p. ej. "promo-noviembre" (viene en el link de la promo). */
  source?: string | null;
  /** Nombre del perfil de WhatsApp, para saludar (puede no ser el nombre real). */
  profileName?: string | null;
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
  /** Lista de espera de la clínica: recibe los horarios liberados y las respuestas a sus ofertas. */
  waitlist?: WaitlistService;

  constructor(
    private provider: LlmProvider,
    private store: Store,
    private calendar: CalendarService,
    private clock: Clock = systemClock,
    /** Clínica que atiende este motor (multiempresa). Sin clínica: la clínica por defecto. */
    readonly clinic?: ClinicProfile,
  ) {}

  /**
   * Prompt de sistema de la clínica. Se arma en cada turno a partir del conocimiento
   * actual: si el consultorio edita precios u horarios, el cambio rige desde el
   * siguiente mensaje. Mientras no cambie, el texto es idéntico y la caché se aprovecha.
   */
  private get system(): string {
    return buildSystemPrompt(kb());
  }

  get providerName() {
    const base = `${this.provider.name}:${this.provider.model}`;
    return this.provider.notice ? `${base} (${this.provider.notice})` : base;
  }

  /**
   * Respuestas a botones que no necesitan IA: confirmar asistencia y "más adelante".
   * Son instantáneas y no tienen costo. Cancelar o cambiar pasan al modelo, que usa las herramientas.
   */
  private async quickReply(pending: ChatMessage["meta"], text: string, ctx: ToolContext): Promise<string | null> {
    const patientId = ctx.patient.id;
    const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N} ]/gu, "").trim();
    if (pending?.kind === "waitlist_offer" && pending.waitlistId && pending.slot) {
      const accept = /^(lo tomo|si lo tomo|si|si por favor|quiero|lo quiero|dale|ok|reservalo|si reservalo|perfecto)$/.test(t);
      const decline = /^(no gracias|no|ahora no|paso|no puedo)$/.test(t);
      if (accept || decline) return this.answerWaitlistOffer(pending.waitlistId, pending.slot, accept, ctx);
    }
    if (pending?.appointmentId && /^(confirmo|confirmar|si confirmo|si|confirmado|si voy|voy|ahi estare)$/.test(t)) {
      const a = await this.store.getAppointment(pending.appointmentId);
      if (!a || a.patientId !== patientId || !["confirmada", "pendiente"].includes(a.status)) return null;
      await this.store.updateAppointment(a.id, { confirmedByPatient: true, status: "confirmada" });
      const name = a.patientName.replace(/\s*\(demo\)/i, "").split(/\s+/)[0];
      return `¡Gracias, ${name}! ✅ Su asistencia quedó confirmada para el *${human(toLocal(a.start))}*. ¡Lo esperamos!`;
    }
    if ((pending?.kind === "followup" || pending?.kind === "reactivation") && /^(mas adelante|despues|ahora no|no gracias|no)$/.test(t)) {
      return "¡Perfecto! Cuando quiera, escríbame y le busco un turno. 😊";
    }
    return null;
  }

  /** «Lo tomo» reserva el horario ofrecido (si sigue libre); «No, gracias» lo pasa a la siguiente persona. */
  private async answerWaitlistOffer(entryId: string, slot: string, accept: boolean, ctx: ToolContext): Promise<string> {
    const entry = (await this.store.listWaitlist()).find((e) => e.id === entryId);
    if (!entry || entry.patientId !== ctx.patient.id) return "No encuentro esa oferta. ¿Quiere que le busque otro horario?";
    if (entry.status !== "ofrecido" || entry.offeredSlot !== slot) {
      return entry.status === "aceptado"
        ? "Ese turno ya quedó reservado a su nombre. 😊"
        : "Disculpe, esa oferta ya venció y el horario se ofreció a otra persona. Sigue en la lista de espera: si se libera otro, le aviso. ¿Prefiere que le busque otro horario ahora?";
    }
    if (!accept) {
      await this.waitlist?.decline(entryId, slot);
      return "Entendido. Sigue en la lista de espera: si se libera otro horario que le sirva, le aviso por aquí. 😊";
    }
    const r = (await makeExecutor(ctx)("crear_cita", { nombre_completo: ctx.patient.name ?? entry.patientName, tratamiento: entry.treatment, inicio: slot })) as any;
    if (!r.ok) {
      await this.waitlist?.decline(entryId, slot);
      return "¡Uy! Ese horario se ocupó hace un momento. Sigue en la lista de espera y le aviso apenas se libere otro. ¿Quiere que le busque otras opciones ahora?";
    }
    await this.store.updateWaitlist(entryId, { status: "aceptado" });
    const name = (ctx.patient.name ?? entry.patientName).replace(/\s*\(demo\)/i, "").split(/\s+/)[0];
    return `¡Listo, ${name}! ✅ Le reservé el turno:\n\n📅 *${r.cita.cuando}*\n🦷 ${r.cita.tratamiento}\n📍 ${kb().address.replace(" (dirección ficticia)", "")}\n\nLe enviaré un recordatorio el día anterior.`;
  }

  async handle(msg: IncomingMessage): Promise<BotReply> {
    return withClinic(this.clinic, () => this.handleInClinic(msg));
  }

  private async handleInClinic(msg: IncomingMessage): Promise<BotReply> {
    let patient = await this.store.getOrCreatePatient(msg.userId, msg.channel, msg.source ?? null);
    const conv = await this.store.getOrCreateConversation(patient, msg.channel);
    const at = this.clock().toISOString();
    conv.messages.push({ role: "patient", text: msg.text, at });

    // Bot en pausa desde el panel: el mensaje queda registrado y no se responde nada.
    if (conv.botPaused) {
      await this.store.saveConversation(conv);
      return { messages: [], conversationId: conv.id, handedOff: conv.handedOff, toolCalls: [] };
    }

    const out: string[] = [];
    // Primer mensaje de la conversación: el asistente saluda, se presenta y menciona
    // la privacidad en una línea (modo "inline"). "separate" = mensaje aparte; "off" = sin aviso.
    const firstTurn = !conv.privacyShown;
    if (firstTurn && config.privacyMode === "separate") out.push(privacyNotice());
    conv.privacyShown = true;

    // Conversación tomada por una persona: el bot no interviene.
    if (conv.handedOff) {
      const reply = "Su mensaje fue recibido. Una persona del equipo le responderá a la brevedad. 🙌";
      const lastBot = [...conv.messages].reverse().find((m) => m.role === "bot");
      if (lastBot?.text !== reply) out.push(reply);
      for (const t of out) conv.messages.push({ role: "bot", text: t, at });
      await this.store.saveConversation(conv);
      return { messages: out, conversationId: conv.id, handedOff: true, toolCalls: [] };
    }

    // Respuesta a un aviso que mandó el bot (recordatorio o seguimiento).
    const lastBot = [...conv.messages].slice(0, -1).reverse().find((m) => m.role === "bot");
    const pending = lastBot?.meta;
    const ctx: ToolContext = {
      store: this.store, calendar: this.calendar, clock: this.clock, patient, conversation: conv,
      // Un turno cancelado o movido libera su horario: se ofrece a la lista de espera.
      onSlotFreed: (slot) => {
        void this.waitlist?.onSlotFreed(slot).catch((err) => console.error("[lista de espera]", (err as Error).message));
      },
    };
    const quick = await this.quickReply(pending, msg.text, ctx);
    if (quick) {
      out.push(quick);
      for (const t of out) conv.messages.push({ role: "bot", text: t, at });
      await this.store.saveConversation(conv);
      return { messages: out, conversationId: conv.id, handedOff: false, toolCalls: [] };
    }
    let reminderNote = "";
    if (pending?.appointmentId) {
      const a = await this.store.getAppointment(pending.appointmentId);
      if (a) reminderNote = `El último mensaje del bot fue un RECORDATORIO del turno id ${a.id} (${human(toLocal(a.start))}, ${a.treatment}). Si el paciente quiere cancelar o cambiar el horario, se refiere a ese turno.`;
    } else if (pending?.kind === "followup") {
      reminderNote = "El último mensaje del bot fue un SEGUIMIENTO de la promoción: el paciente no había agendado. Si acepta, ofrézcale horarios concretos.";
    } else if (pending?.kind === "reactivation") {
      reminderNote = "El último mensaje del bot fue una invitación a un CONTROL: el paciente no viene hace meses. Si acepta, ofrézcale horarios concretos para una consulta de control.";
    } else if (pending?.kind === "waitlist_offer" && pending.slot) {
      reminderNote = `El último mensaje del bot ofreció el horario liberado ${pending.slot} de la LISTA DE ESPERA. Si el paciente lo quiere, resérvelo con crear_cita.`;
    }

    // Si cambió el proveedor (p. ej. de mock a Claude), el historial nativo no es compatible: se reinicia.
    if (conv.llmProvider !== this.provider.name) {
      conv.llmState = [];
      conv.llmProvider = this.provider.name;
    }

    const execute = makeExecutor(ctx);
    const now = toLocal(this.clock());
    const open = withinOpeningHours(now.set({ second: 0, millisecond: 0 }));
    const turnContext = [
      "[Nota de contexto del sistema, no la mencione]",
      `Fecha y hora actual en el consultorio: ${now.setLocale("es").toFormat("cccc dd/MM/yyyy HH:mm")} (${now.toISODate()}).`,
      `Consultorio ${open ? "ABIERTO" : "CERRADO"} en este momento.`,
      `Canal: ${msg.channel}. Teléfono del paciente: ${patient.phone}.`,
      `Nombre registrado: ${ctx.patient.name ?? "desconocido"}.`,
      msg.profileName ? `Nombre de perfil de WhatsApp (no confirmado): ${msg.profileName}.` : "",
      firstTurn
        ? `PRIMER MENSAJE de la conversación: salude${msg.profileName ? " por el nombre de pila del perfil" : ""}, preséntese en una oración y responda lo que pidió.` +
          (config.privacyMode === "inline" ? ` Cierre con esta línea exacta: «${privacyLine}»` : "")
        : "",
      patient.source ? `Llegó por: ${patient.source}.` : "",
      reminderNote,
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
