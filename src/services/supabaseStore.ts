import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_CLINIC_ID, SlotTakenError,
  type Appointment, type AppointmentFilter, type Channel, type Conversation, type Handoff, type Patient,
  type Store, type TurnMetric, type ClinicDocument, type DocumentHit, type WaitlistEntry, type WaitlistStatus,
} from "./store.js";
import type { ClinicKnowledge } from "../clinics/types.js";
import { tsQuery } from "./textSearch.js";

let seq = 0;
const newId = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    if (res.error.code === "23505" && res.error.message.includes("no_double_booking")) throw new SlotTakenError();
    throw new Error(`Supabase: ${res.error.message}`);
  }
  return res.data;
}

// --- Conversión fila ↔ objeto (snake_case en la base, camelCase en el código) ---
const toPatient = (r: any): Patient => ({
  id: r.id, phone: r.phone, name: r.name, channel: r.channel, source: r.source, createdAt: r.created_at,
});
const toConv = (r: any): Conversation => ({
  id: r.id, patientId: r.patient_id, channel: r.channel, llmProvider: r.llm_provider, llmState: r.llm_state,
  messages: r.messages, privacyShown: r.privacy_shown, handedOff: r.handed_off, botPaused: r.bot_paused ?? false,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toAppt = (r: any): Appointment => ({
  id: r.id, patientId: r.patient_id, patientName: r.patient_name, treatment: r.treatment,
  start: new Date(r.start_at).toISOString(), end: new Date(r.end_at).toISOString(), status: r.status,
  calendarEventId: r.calendar_event_id, confirmedByPatient: r.confirmed_by_patient,
  reminder24Sent: r.reminder24_sent, reminder2Sent: r.reminder2_sent, createdAt: r.created_at,
  cancelledAt: r.cancelled_at ?? null,
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
  if (p.cancelledAt !== undefined) m.cancelled_at = p.cancelledAt;
  return m;
};
const toHandoff = (r: any): Handoff => ({
  id: r.id, conversationId: r.conversation_id, patientId: r.patient_id, reason: r.reason,
  summary: r.summary, status: r.status, createdAt: r.created_at,
});

const toWait = (r: any): WaitlistEntry => ({
  id: r.id, patientId: r.patient_id, patientName: r.patient_name, treatment: r.treatment, fromDate: r.from_date, toDate: r.to_date,
  franja: r.franja, status: r.status, offeredSlot: r.offered_slot, offeredAt: r.offered_at, declinedSlots: r.declined_slots ?? [], createdAt: r.created_at,
});
const waitPatch = (p: Partial<WaitlistEntry>) => {
  const m: Record<string, unknown> = {};
  if (p.status !== undefined) m.status = p.status;
  if (p.offeredSlot !== undefined) m.offered_slot = p.offeredSlot;
  if (p.offeredAt !== undefined) m.offered_at = p.offeredAt;
  if (p.declinedSlots !== undefined) m.declined_slots = p.declinedSlots;
  if (p.fromDate !== undefined) m.from_date = p.fromDate;
  if (p.toDate !== undefined) m.to_date = p.toDate;
  if (p.franja !== undefined) m.franja = p.franja;
  if (p.treatment !== undefined) m.treatment = p.treatment;
  return m;
};

const noSession = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/**
 * Persistencia en Supabase (PostgreSQL) para UNA clínica.
 * - Con la clave secreta (bot, webhook, recordatorios): se saltea el RLS, por eso
 *   cada consulta filtra por clinic_id en el código.
 * - Con el token de un usuario del panel (`asUser`): además se aplica el RLS en la base,
 *   así una recepcionista no puede leer otra clínica aunque el código tuviera un error.
 */
export class SupabaseStore implements Store {
  private constructor(private db: SupabaseClient, readonly clinicId: string) {}

  /** Cliente de servidor con la clave secreta. */
  static withSecretKey(url: string, secretKey: string, clinicId = DEFAULT_CLINIC_ID): SupabaseStore {
    return new SupabaseStore(createClient(url, secretKey, noSession), clinicId);
  }

  /** Cliente con la sesión de un usuario del panel: la base aplica las políticas RLS. */
  static asUser(url: string, publishableKey: string, accessToken: string, clinicId: string): SupabaseStore {
    const db = createClient(url, publishableKey, { ...noSession, global: { headers: { Authorization: `Bearer ${accessToken}` } } });
    return new SupabaseStore(db, clinicId);
  }

  forClinic(clinicId: string): Store {
    return new SupabaseStore(this.db, clinicId);
  }

  /** Acceso al cliente para consultas que no son de una sola clínica (lista de clínicas, scripts). */
  get client(): SupabaseClient {
    return this.db;
  }

  private from(table: string) {
    return this.db.from(table);
  }

  async getOrCreatePatient(phone: string, channel: Channel, source: string | null = null) {
    const found = check(await this.from("patients").select("*").eq("clinic_id", this.clinicId).eq("phone", phone).maybeSingle());
    if (found) return toPatient(found);
    const row = check(await this.from("patients")
      .upsert({ id: newId("pac"), clinic_id: this.clinicId, phone, channel, source }, { onConflict: "clinic_id,phone", ignoreDuplicates: false })
      .select().single());
    return toPatient(row);
  }
  async updatePatient(id: string, patch: Partial<Pick<Patient, "name" | "source">>) {
    return toPatient(check(await this.from("patients").update(patch).eq("clinic_id", this.clinicId).eq("id", id).select().single()));
  }
  async getPatient(id: string) {
    const r = check(await this.from("patients").select("*").eq("clinic_id", this.clinicId).eq("id", id).maybeSingle());
    return r ? toPatient(r) : null;
  }
  async listPatients() {
    const rows = check(await this.from("patients").select("*").eq("clinic_id", this.clinicId)
      .order("created_at", { ascending: false }).limit(2000));
    return (rows ?? []).map(toPatient);
  }

  async getOrCreateConversation(patient: Patient, channel: Channel) {
    const found = check(await this.from("conversations").select("*")
      .eq("clinic_id", this.clinicId).eq("patient_id", patient.id).eq("channel", channel).maybeSingle());
    if (found) return toConv(found);
    const row = check(await this.from("conversations")
      .insert({ id: newId("conv"), clinic_id: this.clinicId, patient_id: patient.id, channel }).select().single());
    return toConv(row);
  }
  async getConversation(id: string) {
    const r = check(await this.from("conversations").select("*").eq("clinic_id", this.clinicId).eq("id", id).maybeSingle());
    return r ? toConv(r) : null;
  }
  async saveConversation(c: Conversation) {
    check(await this.from("conversations").update({
      llm_provider: c.llmProvider, llm_state: c.llmState, messages: c.messages,
      privacy_shown: c.privacyShown, handed_off: c.handedOff, bot_paused: c.botPaused, updated_at: new Date().toISOString(),
    }).eq("clinic_id", this.clinicId).eq("id", c.id));
  }
  async listConversations() {
    const rows = check(await this.from("conversations").select("*").eq("clinic_id", this.clinicId)
      .order("updated_at", { ascending: false }).limit(500));
    return (rows ?? []).map(toConv);
  }

  async createAppointment(a: Omit<Appointment, "id" | "createdAt">) {
    const row = check(await this.from("appointments").insert({
      id: newId("cita"), clinic_id: this.clinicId, patient_id: a.patientId, ...apptPatch(a),
    }).select().single());
    return toAppt(row);
  }
  async updateAppointment(id: string, patch: Partial<Appointment>) {
    return toAppt(check(await this.from("appointments").update(apptPatch(patch))
      .eq("clinic_id", this.clinicId).eq("id", id).select().single()));
  }
  async getAppointment(id: string) {
    const r = check(await this.from("appointments").select("*").eq("clinic_id", this.clinicId).eq("id", id).maybeSingle());
    return r ? toAppt(r) : null;
  }
  async listAppointments(f: AppointmentFilter = {}) {
    let q = this.from("appointments").select("*").eq("clinic_id", this.clinicId).order("start_at");
    if (f.patientId) q = q.eq("patient_id", f.patientId);
    if (f.from) q = q.gte("start_at", f.from);
    if (f.to) q = q.lt("start_at", f.to);
    if (f.status) q = q.in("status", f.status);
    return (check(await q) ?? []).map(toAppt);
  }
  async deleteAppointment(id: string) {
    check(await this.from("appointments").delete().eq("clinic_id", this.clinicId).eq("id", id));
  }

  async createHandoff(h: Omit<Handoff, "id" | "createdAt" | "status">) {
    return toHandoff(check(await this.from("handoffs").insert({
      id: newId("der"), clinic_id: this.clinicId, conversation_id: h.conversationId, patient_id: h.patientId,
      reason: h.reason, summary: h.summary,
    }).select().single()));
  }
  async listHandoffs() {
    return (check(await this.from("handoffs").select("*").eq("clinic_id", this.clinicId)
      .order("created_at", { ascending: false })) ?? []).map(toHandoff);
  }
  async updateHandoff(id: string, patch: Partial<Pick<Handoff, "status">>) {
    check(await this.from("handoffs").update(patch).eq("clinic_id", this.clinicId).eq("id", id));
  }

  async logMetric(m: TurnMetric) {
    check(await this.from("turn_metrics").insert({
      clinic_id: this.clinicId, conversation_id: m.conversationId, provider: m.provider, model: m.model,
      latency_ms: m.latencyMs, input_tokens: m.inputTokens, output_tokens: m.outputTokens,
      cache_read_tokens: m.cacheReadTokens, cost_usd: m.costUsd, model_calls: m.modelCalls, tools: m.tools, at: m.at,
    }));
  }
  async listMetrics() {
    const rows = check(await this.from("turn_metrics").select("*").eq("clinic_id", this.clinicId)
      .order("at", { ascending: false }).limit(5000));
    return (rows ?? []).map((r: any): TurnMetric => ({
      conversationId: r.conversation_id, provider: r.provider, model: r.model, latencyMs: r.latency_ms,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens,
      costUsd: Number(r.cost_usd), modelCalls: r.model_calls, tools: r.tools, at: r.at,
    }));
  }

  async addWaitlist(e: Omit<WaitlistEntry, "id" | "createdAt" | "status" | "offeredSlot" | "offeredAt" | "declinedSlots">) {
    return toWait(check(await this.from("waitlist").insert({
      id: newId("esp"), clinic_id: this.clinicId, patient_id: e.patientId, patient_name: e.patientName, treatment: e.treatment,
      from_date: e.fromDate, to_date: e.toDate, franja: e.franja,
    }).select().single()));
  }
  async listWaitlist(status?: WaitlistStatus[]) {
    let q = this.from("waitlist").select("*").eq("clinic_id", this.clinicId).order("created_at");
    if (status) q = q.in("status", status);
    return (check(await q) ?? []).map(toWait);
  }
  async updateWaitlist(id: string, patch: Partial<Omit<WaitlistEntry, "id" | "createdAt">>) {
    return toWait(check(await this.from("waitlist").update(waitPatch(patch)).eq("clinic_id", this.clinicId).eq("id", id).select().single()));
  }

  async updateKnowledge(k: ClinicKnowledge) {
    // Con el token de un usuario, la política RLS solo deja actualizar al admin de la clínica.
    const rows = check(await this.from("clinics").update({ knowledge: k }).eq("id", this.clinicId).select("id"));
    if (!rows?.length) throw new Error("Sin permiso para editar esta clínica (solo el admin).");
  }
  async listDocuments(): Promise<ClinicDocument[]> {
    const rows = check(await this.from("documents").select("*").eq("clinic_id", this.clinicId).order("created_at", { ascending: false }));
    return (rows ?? []).map((r: any) => ({ id: r.id, name: r.name, mime: r.mime, sizeBytes: r.size_bytes, chunks: r.chunks, createdAt: r.created_at }));
  }
  async addDocument(doc: Omit<ClinicDocument, "id" | "createdAt" | "chunks">, chunks: string[]) {
    const id = newId("doc");
    const row = check(await this.from("documents").insert({
      id, clinic_id: this.clinicId, name: doc.name, mime: doc.mime, size_bytes: doc.sizeBytes, chunks: chunks.length,
    }).select().single());
    try {
      for (let i = 0; i < chunks.length; i += 200) {
        check(await this.from("document_chunks").insert(
          chunks.slice(i, i + 200).map((content, j) => ({ document_id: id, clinic_id: this.clinicId, ord: i + j, content })),
        ));
      }
    } catch (err) {
      await this.from("documents").delete().eq("id", id);
      throw err;
    }
    return { id, name: row.name, mime: row.mime, sizeBytes: row.size_bytes, chunks: row.chunks, createdAt: row.created_at };
  }
  async deleteDocument(id: string) {
    check(await this.from("documents").delete().eq("clinic_id", this.clinicId).eq("id", id));
  }
  async searchDocuments(query: string, limit = 3): Promise<DocumentHit[]> {
    const q = tsQuery(query);
    if (!q) return [];
    const rows = check(await this.db.rpc("search_document_chunks", { cid: this.clinicId, q, max_results: limit }));
    return ((rows as any[]) ?? []).map((r) => ({ documentId: r.document_id, name: r.name, content: r.content, rank: Number(r.rank) }));
  }

  /** Para el script de verificación: cuántas clínicas hay cargadas. */

  async ping(): Promise<number> {
    // Sin "head": así, si falla, el error trae mensaje (una consulta HEAD lo devuelve vacío).
    const r = await this.from("clinics").select("id", { count: "exact" }).limit(1);
    if (r.error) {
      const e = r.error as { message?: string; code?: string; details?: string; hint?: string };
      throw new Error([`HTTP ${r.status}`, e.code, e.message, e.details, e.hint].filter(Boolean).join(" · "));
    }
    return r.count ?? 0;
  }
}
