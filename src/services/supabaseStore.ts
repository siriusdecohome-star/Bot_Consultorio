import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  SlotTakenError,
  type Appointment, type AppointmentStatus, type Channel, type Conversation, type Handoff, type Patient,
  type Store, type TurnMetric,
} from "./store.js";

let seq = 0;
const newId = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    if (res.error.code === "23505" && res.error.message.includes("no_double_booking")) throw new SlotTakenError();
    throw new Error(`Supabase: ${res.error.message}`);
  }
  return res.data;
}

// --- ConversiÃ³n fila â†” objeto (snake_case en la base, camelCase en el cÃ³digo) ---
const toPatient = (r: any): Patient => ({
  id: r.id, phone: r.phone, name: r.name, channel: r.channel, source: r.source, createdAt: r.created_at,
});
const toConv = (r: any): Conversation => ({
  id: r.id, patientId: r.patient_id, channel: r.channel, llmProvider: r.llm_provider, llmState: r.llm_state,
  messages: r.messages, privacyShown: r.privacy_shown, handedOff: r.handed_off,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toAppt = (r: any): Appointment => ({
  id: r.id, patientId: r.patient_id, patientName: r.patient_name, treatment: r.treatment,
  start: new Date(r.start_at).toISOString(), end: new Date(r.end_at).toISOString(), status: r.status,
  calendarEventId: r.calendar_event_id, confirmedByPatient: r.confirmed_by_patient,
  reminder24Sent: r.reminder24_sent, reminder2Sent: r.reminder2_sent, createdAt: r.created_at,
});
const apptPatch = (p: Partial<Appointment>) => {
  const m: Record<string, unknown> = {};
  if (p.patientName !== undefined) m.patient_name = p.patientName;
  if (p.treatment !== undefined) m.treatment = p.treatment;
  if (p.start !== undefined) m.start_at = p.start;
  if (p.end !== undefined) m.end_at = p.end;
  if (p.status !== undefined) m.status = p.status;
  if (p.calendarEventId !== undefined) m.calendar_event_id = p.calendarEventId;
  if (p.confirmedByPatient !== undefined) m.confirmed_by_patient = p.confirmedByPatient;
  if (p.reminder24Sent !== undefined) m.reminder24_sent = p.reminder24Sent;
  if (p.reminder2Sent !== undefined) m.reminder2_sent = p.reminder2Sent;
  return m;
};
const toHandoff = (r: any): Handoff => ({
  id: r.id, conversationId: r.conversation_id, patientId: r.patient_id, reason: r.reason,
  summary: r.summary, status: r.status, createdAt: r.created_at,
});

/** Persistencia en Supabase (PostgreSQL). Usa la clave secreta: solo backend. */
export class SupabaseStore implements Store {
  private db: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.db = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async getOrCreatePatient(phone: string, channel: Channel, source: string | null = null) {
    const found = check(await this.db.from("patients").select("*").eq("phone", phone).maybeSingle());
    if (found) return toPatient(found);
    const row = check(await this.db.from("patients")
      .upsert({ id: newId("pac"), phone, channel, source }, { onConflict: "phone", ignoreDuplicates: false })
      .select().single());
    return toPatient(row);
  }
  async updatePatient(id: string, patch: Partial<Pick<Patient, "name" | "source">>) {
    return toPatient(check(await this.db.from("patients").update(patch).eq("id", id).select().single()));
  }
  async getPatient(id: string) {
    const r = check(await this.db.from("patients").select("*").eq("id", id).maybeSingle());
    return r ? toPatient(r) : null;
  }

  async getOrCreateConversation(patient: Patient, channel: Channel) {
    const found = check(await this.db.from("conversations").select("*")
      .eq("patient_id", patient.id).eq("channel", channel).maybeSingle());
    if (found) return toConv(found);
    const row = check(await this.db.from("conversations")
      .insert({ id: newId("conv"), patient_id: patient.id, channel }).select().single());
    return toConv(row);
  }
  async saveConversation(c: Conversation) {
    check(await this.db.from("conversations").update({
      llm_provider: c.llmProvider, llm_state: c.llmState, messages: c.messages,
      privacy_shown: c.privacyShown, handed_off: c.handedOff, updated_at: new Date().toISOString(),
    }).eq("id", c.id));
  }
  async listConversations() {
    const rows = check(await this.db.from("conversations").select("*").order("updated_at", { ascending: false }).limit(200));
    return (rows ?? []).map(toConv);
  }

  async createAppointment(a: Omit<Appointment, "id" | "createdAt">) {
    const row = check(await this.db.from("appointments").insert({
      id: newId("cita"), patient_id: a.patientId, ...apptPatch(a),
    }).select().single());
    return toAppt(row);
  }
  async updateAppointment(id: string, patch: Partial<Appointment>) {
    return toAppt(check(await this.db.from("appointments").update(apptPatch(patch)).eq("id", id).select().single()));
  }
  async getAppointment(id: string) {
    const r = check(await this.db.from("appointments").select("*").eq("id", id).maybeSingle());
    return r ? toAppt(r) : null;
  }
  async listAppointments(f: { patientId?: string; from?: string; to?: string; status?: AppointmentStatus[] } = {}) {
    let q = this.db.from("appointments").select("*").order("start_at");
    if (f.patientId) q = q.eq("patient_id", f.patientId);
    if (f.from) q = q.gte("start_at", f.from);
    if (f.to) q = q.lt("start_at", f.to);
    if (f.status) q = q.in("status", f.status);
    return (check(await q) ?? []).map(toAppt);
  }
  async deleteAppointment(id: string) {
    check(await this.db.from("appointments").delete().eq("id", id));
  }

  async createHandoff(h: Omit<Handoff, "id" | "createdAt" | "status">) {
    return toHandoff(check(await this.db.from("handoffs").insert({
      id: newId("der"), conversation_id: h.conversationId, patient_id: h.patientId, reason: h.reason, summary: h.summary,
    }).select().single()));
  }
  async listHandoffs() {
    return (check(await this.db.from("handoffs").select("*").order("created_at", { ascending: false })) ?? []).map(toHandoff);
  }

  async logMetric(m: TurnMetric) {
    check(await this.db.from("turn_metrics").insert({
      conversation_id: m.conversationId, provider: m.provider, model: m.model, latency_ms: m.latencyMs,
      input_tokens: m.inputTokens, output_tokens: m.outputTokens, cache_read_tokens: m.cacheReadTokens,
      cost_usd: m.costUsd, model_calls: m.modelCalls, tools: m.tools, at: m.at,
    }));
  }
  async listMetrics() {
    const rows = check(await this.db.from("turn_metrics").select("*").order("at", { ascending: false }).limit(1000));
    return (rows ?? []).map((r: any): TurnMetric => ({
      conversationId: r.conversation_id, provider: r.provider, model: r.model, latencyMs: r.latency_ms,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens,
      costUsd: Number(r.cost_usd), modelCalls: r.model_calls, tools: r.tools, at: r.at,
    }));
  }

  /** Para el script de verificaciÃ³n. */
  async ping(): Promise<number> {
    // Sin "head": así, si falla, el error trae mensaje (una consulta HEAD lo devuelve vacío).
    const r = await this.db.from("patients").select("id", { count: "exact" }).limit(1);
    if (r.error) {
      const e = r.error as { message?: string; code?: string; details?: string; hint?: string };
      throw new Error([`HTTP ${r.status}`, e.code, e.message, e.details, e.hint].filter(Boolean).join(" · "));
    }
    return r.count ?? 0;
  }
}
