import { kb, privacyLine, privacyNotice } from "../data/knowledge.js";
import { withClinic } from "../clinics/context.js";
import type { ClinicProfile } from "../clinics/types.js";
import { config } from "../config.js";
import type { LlmProvider, ToolCallLog } from "../llm/types.js";
import type { CalendarService } from "../services/calendar.js";
import type { Channel, ChatMessage, CloseReason, Conversation, Store, TurnMetric } from "../services/store.js";
import { human, toLocal, type Clock, systemClock } from "../services/time.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { makeExecutor, toolDefs, type ToolContext } from "./tools.js";
import type { WaitlistService } from "./waitlist.js";
import { withinOpeningHours } from "../services/calendar.js";
import { closeConversation, reopenConversation } from "./conversationState.js";
import { activeMenu, isMenuRequest, matchMenuOption, menuInteractive, type Interactive } from "./menu.js";

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
  /** Botones o lista interactiva que acompañan al ÚLTIMO mensaje (menú inicial). */
  interactive?: Interactive;
  conversationId: string;
  handedOff: boolean;
  metric?: TurnMetric;
  toolCalls: ToolCallLog[];
}

/** Herramientas que dejan un turno resuelto: la conversación se cierra sola. */
function bookingOutcome(calls: ToolCallLog[]): CloseReason | null {
  let r: CloseReason | null = null;
  for (const c of calls) {
    if (!(c.output as { ok?: boolean } | null)?.ok) continue;
    if (c.name === "crear_cita" || c.name === "reprogramar_cita" || c.name === "confirmar_asistencia") r = "turno_confirmado";
    if (c.name === "cancelar_cita") r = "turno_cancelado";
  }
  return r;
}

/**
 * Motor único del bot. Los canales (WhatsApp, simulador web, consola, pruebas)
 * solo traducen su formato a IncomingMessage y envían los mensajes devueltos.
 */
export class BotEngine {
  /** Lista de espera de la clínica: recibe los horarios liberados y las respuestas a sus ofertas. */
  waitlist?: WaitlistService;
  /**
   * Tope de IA (demo pública): antes de cada mensaje se consulta; si no queda cupo, ese
   * mensaje lo responde `fallback` (el modo sin IA) y la conversación sigue sin cortes.
   */
  aiBudget?: () => Promise<boolean>;
  fallback?: LlmProvider;

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
   * Respuestas a botones que no necesitan IA: confirmar asistencia, la oferta de la
   * lista de espera y "más adelante". Son instantáneas y no tienen costo.
   * Cancelar o cambiar pasan al modelo, que usa las herramientas.
   */
  private async quickReply(pending: ChatMessage["meta"], text: string, ctx: ToolContext): Promise<{ text: string; close?: CloseReason } | null> {
    const patientId = ctx.patient.id;
    const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N} ]/gu, "").trim();
    if (pending?.kind === "waitlist_offer" && pending.waitlistId && pending.slot) {
      const accept = /^(lo tomo|si lo tomo|si|si por favor|quiero|lo quiero|dale|ok|reservalo|si reservalo|perfecto)$/.test(t);
      const decline = /^(no gracias|no|ahora no|paso|no puedo)$/.test(t);
      if (accept || decline) return this.answerWaitlistOffer(pending.waitlistId, pending.slot, accept, ctx, pending.professionalId ?? null);
    }
    if (pending?.appointmentId && pending.kind !== "reschedule_request" && /^(confirmo|confirmar|si confirmo|si|confirmado|si voy|voy|ahi estare)$/.test(t)) {
      const a = await this.store.getAppointment(pending.appointmentId);
      if (!a || a.patientId !== patientId || !["confirmada", "pendiente"].includes(a.status)) return null;
      await this.store.updateAppointment(a.id, { confirmedByPatient: true, status: "confirmada" });
      const name = a.patientName.split(/\s+/)[0];
      return { text: `¡Gracias, ${name}! ✅ Su asistencia quedó confirmada para el *${human(toLocal(a.start))}*. ¡Lo esperamos!`, close: "turno_confirmado" };
    }
    if (pending?.kind === "post_visit" && /^(todo bien|bien|muy bien|excelente|perfecto|gracias)$/.test(t)) {
      return { text: "¡Qué bueno! 😊 Gracias por contarnos. Cuando necesite un control, escríbame y le busco un turno." };
    }
    if ((pending?.kind === "followup" || pending?.kind === "reactivation") && /^(mas adelante|despues|ahora no|no gracias|no)$/.test(t)) {
      return { text: "¡Perfecto! Cuando quiera, escríbame y le busco un turno. 😊" };
    }
    return null;
  }

  /** «Lo tomo» reserva el horario ofrecido (si sigue libre); «No, gracias» lo pasa a la siguiente persona. */
  private async answerWaitlistOffer(entryId: string, slot: string, accept: boolean, ctx: ToolContext, professionalId: string | null): Promise<{ text: string; close?: CloseReason }> {
    const entry = (await this.store.listWaitlist()).find((e) => e.id === entryId);
    if (!entry || entry.patientId !== ctx.patient.id) return { text: "No encuentro esa oferta. ¿Quiere que le busque otro horario?" };
    if (entry.status !== "ofrecido" || entry.offeredSlot !== slot) {
      return {
        text: entry.status === "aceptado"
          ? "Ese turno ya quedó reservado a su nombre. 😊"
          : "Disculpe, esa oferta ya venció y el horario se ofreció a otra persona. Sigue en la lista de espera: si se libera otro, le aviso. ¿Prefiere que le busque otro horario ahora?",
      };
    }
    if (!accept) {
      await this.waitlist?.decline(entryId, slot, professionalId);
      return { text: "Entendido. Sigue en la lista de espera: si se libera otro horario que le sirva, le aviso por aquí. 😊" };
    }
    const r = (await makeExecutor(ctx)("crear_cita", {
      nombre_completo: ctx.patient.name ?? entry.patientName, tratamiento: entry.treatment, inicio: slot, ...(professionalId ? { profesional_id: professionalId } : {}),
    })) as any;
    if (!r.ok) {
      await this.waitlist?.decline(entryId, slot, professionalId);
      return { text: "¡Uy! Ese horario se ocupó hace un momento. Sigue en la lista de espera y le aviso apenas se libere otro. ¿Quiere que le busque otras opciones ahora?" };
    }
    await this.store.updateWaitlist(entryId, { status: "aceptado" });
    const name = (ctx.patient.name ?? entry.patientName).split(/\s+/)[0];
    return {
      text: `¡Listo, ${name}! ✅ Le reservé el turno:\n\n📅 *${r.cita.cuando}*\n🦷 ${r.cita.tratamiento}${r.cita.profesional ? `\n👩‍⚕️ ${r.cita.profesional}` : ""}\n📍 ${kb().address}\n\nLe enviaré un recordatorio el día anterior.`,
      close: "turno_confirmado",
    };
  }

  async handle(msg: IncomingMessage): Promise<BotReply> {
    return withClinic(this.clinic, () => this.handleInClinic(msg));
  }

  /** Guarda las respuestas del bot y, si el turno quedó resuelto, cierra la conversación. */
  private async finish(conv: Conversation, out: string[], close: CloseReason | null, options?: string[]) {
    const at = this.clock().toISOString();
    out.forEach((text, i) => conv.messages.push({ role: "bot", text, at, ...(options && i === out.length - 1 ? { options } : {}) }));
    if (close && !conv.handedOff && !conv.botPaused) closeConversation(conv, close, at);
    await this.store.saveConversation(conv);
  }

  private async handleInClinic(msg: IncomingMessage): Promise<BotReply> {
    let patient = await this.store.getOrCreatePatient(msg.userId, msg.channel, msg.source ?? null);
    // El nombre del perfil de WhatsApp se guarda aparte: no se confunde con el nombre real.
    const profileName = msg.profileName?.trim().slice(0, 80) || null;
    if (profileName && patient.profileName !== profileName) patient = await this.store.updatePatient(patient.id, { profileName });
    const conv = await this.store.getOrCreateConversation(patient, msg.channel);
    const at = this.clock().toISOString();
    conv.messages.push({ role: "patient", text: msg.text, at });
    // El paciente volvió a escribir en una conversación cerrada: se reabre.
    reopenConversation(conv, at);

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
      await this.finish(conv, out, null);
      return { messages: out, conversationId: conv.id, handedOff: true, toolCalls: [] };
    }

    // Respuesta a un aviso que mandó el bot (recordatorio o seguimiento).
    const lastBot = [...conv.messages].slice(0, -1).reverse().find((m) => m.role === "bot");
    const pending = lastBot?.meta;
    const ctx: ToolContext = {
      store: this.store, calendar: this.calendar, clock: this.clock, patient, conversation: conv,
      // Un turno cancelado o movido libera su horario: se ofrece a la lista de espera.
      onSlotFreed: (slot, professionalId) => {
        void this.waitlist?.onSlotFreed(slot, professionalId).catch((err) => console.error("[lista de espera]", (err as Error).message));
      },
    };
    const quick = await this.quickReply(pending, msg.text, ctx);
    if (quick) {
      out.push(quick.text);
      await this.finish(conv, out, quick.close ?? null);
      return { messages: out, conversationId: conv.id, handedOff: false, toolCalls: [] };
    }

    // Menú inicial: un saludo solo (o «menú») recibe las opciones sin pasar por la IA.
    const menu = activeMenu(kb());
    const option = menu ? matchMenuOption(menu, msg.text, lastBot?.options) : null;
    if (menu && !option && !pending && isMenuRequest(msg.text)) {
      const first = (patient.name ?? profileName)?.split(/\s+/)[0];
      const hello = firstTurn ? `¡Hola${first ? `, ${first}` : ""}! 👋 Soy el asistente virtual de *${kb().name}*.` : "";
      const privacy = firstTurn && config.privacyMode === "inline" ? privacyLine : "";
      out.push([hello, menu.intro, privacy].filter(Boolean).join("\n\n"));
      const interactive = menuInteractive(menu);
      await this.finish(conv, out, null, menu.options.map((o) => o.label));
      return { messages: out, interactive, conversationId: conv.id, handedOff: false, toolCalls: [] };
    }
    if (option?.kind === "respuesta") {
      out.push(option.text);
      await this.finish(conv, out, null);
      return { messages: out, conversationId: conv.id, handedOff: false, toolCalls: [] };
    }
    // Opción «consulta»: el bot la recibe como si el paciente la hubiera escrito.
    const userText = option ? option.text : msg.text;

    let reminderNote = "";
    if (pending?.kind === "reschedule_request" && pending.appointmentId) {
      const a = await this.store.getAppointment(pending.appointmentId);
      if (a) reminderNote = `El último mensaje del bot pidió REPROGRAMAR el turno id ${a.id} (${human(toLocal(a.start))}, ${a.treatment}) porque el profesional no va a atender ese día (${pending.reason ?? "ausencia"}). Si quiere reprogramar: busque horarios con buscar_horarios_disponibles (mismo profesional o «cualquiera» de la especialidad) y use reprogramar_cita. Si prefiere cancelar: cancelar_cita.`;
    } else if (pending?.appointmentId) {
      const a = await this.store.getAppointment(pending.appointmentId);
      if (a) reminderNote = `El último mensaje del bot fue un RECORDATORIO del turno id ${a.id} (${human(toLocal(a.start))}, ${a.treatment}). Si el paciente quiere cancelar o cambiar el horario, se refiere a ese turno.`;
    } else if (pending?.kind === "followup") {
      reminderNote = "El último mensaje del bot fue un SEGUIMIENTO de la promoción: el paciente no había agendado. Si acepta, ofrézcale horarios concretos.";
    } else if (pending?.kind === "reactivation") {
      reminderNote = "El último mensaje del bot fue una invitación a un CONTROL: el paciente no viene hace meses. Si acepta, ofrézcale horarios concretos para una consulta de control.";
    } else if (pending?.kind === "waitlist_offer" && pending.slot) {
      reminderNote = `El último mensaje del bot ofreció el horario liberado ${pending.slot} de la LISTA DE ESPERA. Si el paciente lo quiere, resérvelo con crear_cita.`;
    }

    // Proveedor de este mensaje: el configurado, salvo que se haya agotado el tope de IA de la demo.
    const provider = this.fallback && this.aiBudget && this.provider.name !== this.fallback.name && !(await this.aiBudget().catch(() => false))
      ? this.fallback
      : this.provider;
    // Si cambió el proveedor (p. ej. de mock a Claude), el historial nativo no es compatible: se reinicia.
    if (conv.llmProvider !== provider.name) {
      conv.llmState = [];
      conv.llmProvider = provider.name;
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
      profileName ? `Nombre de perfil de WhatsApp (no confirmado): ${profileName}.` : "",
      option ? `El paciente eligió la opción «${option.label}» del menú.` : "",
      firstTurn
        ? `PRIMER MENSAJE de la conversación: salude${profileName ? " por el nombre de pila del perfil" : ""}, preséntese en una oración y responda lo que pidió.` +
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
      const r = await provider.runTurn({
        system: this.system,
        state: conv.llmState,
        userText,
        turnContext,
        tools: toolDefs,
        executeTool: execute,
      });
      text = r.text || "Disculpe, ¿podría repetirme su consulta?";
      toolCalls = r.toolCalls;
      conv.llmState = r.state;
      metric = {
        conversationId: conv.id,
        provider: provider.name,
        model: provider.model,
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
    await this.finish(conv, out, bookingOutcome(toolCalls));
    return { messages: out, conversationId: conv.id, handedOff: conv.handedOff, metric, toolCalls };
  }
}
