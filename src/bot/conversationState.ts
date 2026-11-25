import type { CloseReason, Conversation, Store } from "../services/store.js";

/**
 * Estado de una conversación en la bandeja. Se calcula a partir de los datos
 * guardados (no se guarda aparte), así la bandeja, los contadores, el resumen
 * y la exportación siempre coinciden.
 *
 * Prioridad: cerrada > esperando > pausada > persona > bot.
 * - esperando: el bot no responde (derivada a una persona o en pausa) y el último
 *   mensaje del paciente todavía no tiene respuesta de recepción.
 */
export type ConvState = "esperando" | "bot" | "persona" | "pausada" | "cerrada";

/** Filtros de la bandeja. «activas» = todo lo que no está pausado ni cerrado. */
export type InboxFilter = "activas" | ConvState | "todas";

export const INBOX_FILTERS: InboxFilter[] = ["activas", "esperando", "bot", "persona", "pausada", "cerrada", "todas"];

export const STATE_LABEL: Record<ConvState, string> = {
  esperando: "Espera respuesta",
  bot: "Con el bot",
  persona: "Con una persona",
  pausada: "Pausada",
  cerrada: "Cerrada",
};

export const CLOSE_REASON_LABEL: Record<CloseReason, string> = {
  inactividad: "por inactividad",
  turno_confirmado: "turno confirmado",
  turno_cancelado: "turno cancelado",
  manual: "cerrada a mano",
};

/**
 * La conversación espera que una persona del equipo responda:
 * - derivada: el último mensaje del paciente es posterior al último de recepción
 *   (el aviso «le paso con una persona» del bot no cuenta como respuesta);
 * - en pausa: el último mensaje del paciente no tiene ninguna respuesta (ni del bot
 *   antes de la pausa ni de recepción).
 */
export function waitingForHuman(c: Conversation): boolean {
  if (c.closedAt || !(c.handedOff || c.botPaused)) return false;
  const lastPatient = c.messages.findLastIndex((m) => m.role === "patient");
  if (lastPatient < 0) return false;
  const lastHuman = c.messages.findLastIndex((m) => m.role === "human");
  if (c.handedOff) return lastPatient > lastHuman;
  const lastReply = c.messages.findLastIndex((m) => m.role === "human" || m.role === "bot");
  return lastPatient > lastReply;
}

export function conversationState(c: Conversation): ConvState {
  if (c.closedAt) return "cerrada";
  if (waitingForHuman(c)) return "esperando";
  if (c.botPaused) return "pausada";
  if (c.handedOff) return "persona";
  return "bot";
}

export function matchesFilter(state: ConvState, filter: InboxFilter): boolean {
  if (filter === "todas") return true;
  if (filter === "activas") return state === "esperando" || state === "bot" || state === "persona";
  return state === filter;
}

/** Contadores de cada filtro (los mismos que usan la pestaña, el resumen y la bandeja). */
export function inboxCounts(states: ConvState[]): Record<InboxFilter, number> {
  const out = Object.fromEntries(INBOX_FILTERS.map((f) => [f, 0])) as Record<InboxFilter, number>;
  for (const s of states) for (const f of INBOX_FILTERS) if (matchesFilter(s, f)) out[f]++;
  return out;
}

/** Último mensaje con fecha (para la inactividad y el orden de la bandeja). */
export const lastActivity = (c: Conversation) => c.messages.at(-1)?.at ?? c.updatedAt;

/**
 * Cierra la conversación. Si estaba con una persona, la libera: cerrada no espera
 * respuesta de nadie. Devuelve true si cambió algo (para saber si hay que guardar).
 */
export function closeConversation(c: Conversation, reason: CloseReason, at: string, by?: string): boolean {
  if (c.closedAt) return false;
  c.closedAt = at;
  c.closedReason = reason;
  c.handedOff = false;
  c.botPaused = false;
  c.assignedTo = null;
  const who = by ? `${by} cerró la conversación` : `Conversación cerrada (${CLOSE_REASON_LABEL[reason]})`;
  c.messages.push({ role: "system", text: `${who}.`, at });
  return true;
}

/** Reabre una conversación cerrada (el paciente volvió a escribir o recepción la reabre). */
export function reopenConversation(c: Conversation, at: string, why = "El paciente volvió a escribir: conversación reabierta."): boolean {
  if (!c.closedAt) return false;
  c.closedAt = null;
  c.closedReason = null;
  c.messages.push({ role: "system", text: why, at });
  return true;
}

/**
 * Cierra las conversaciones sin movimiento hace `hours` horas. No cierra las que
 * esperan respuesta de recepción (quedarían escondidas) ni las pausadas a mano.
 * Las derivaciones abiertas de las que se cierran pasan a resueltas.
 */
export async function closeIdleConversations(store: Store, now: Date, hours: number): Promise<number> {
  const limit = now.getTime() - hours * 3_600_000;
  let closed = 0;
  const convs = await store.listConversations();
  const handoffs = await store.listHandoffs();
  for (const c of convs) {
    if (c.channel === "test") continue;
    const state = conversationState(c);
    if (state !== "bot" && state !== "persona") continue;
    if (new Date(lastActivity(c)).getTime() > limit) continue;
    if (!c.messages.some((m) => m.role === "patient")) continue;
    closeConversation(c, "inactividad", now.toISOString());
    await store.saveConversation(c);
    for (const h of handoffs.filter((x) => x.conversationId === c.id && x.status === "abierta")) {
      await store.updateHandoff(h.id, { status: "resuelta" });
    }
    closed++;
  }
  return closed;
}
