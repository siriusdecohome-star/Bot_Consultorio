/**
 * Persistencia del bot. En la etapa 1 vive en memoria; en la etapa 2 se suma
 * la implementación con Supabase (PostgreSQL) que cumple la misma interfaz.
 */

import type { ClinicKnowledge } from "../clinics/types.js";
import { score, terms } from "./textSearch.js";

export type Channel = "web" | "whatsapp" | "cli" | "test";

export interface Patient {
  id: string;
  phone: string;
  /** Nombre real (lo pide el bot al agendar o lo corrige recepción en la ficha). */
  name: string | null;
  /** Nombre del perfil de WhatsApp: puede no ser el real, se guarda aparte. */
  profileName: string | null;
  /** Teléfono de contacto editable. `phone` es la identidad del canal (número de WhatsApp o sesión del simulador) y no cambia. */
  contactPhone: string | null;
  notes: string;
  tags: string[];
  channel: Channel;
  source: string | null; // p. ej. "promo-noviembre"
  createdAt: string;
}

export type PatientPatch = Partial<Pick<Patient, "name" | "source" | "profileName" | "contactPhone" | "notes" | "tags">>;

export type AppointmentStatus = "confirmada" | "pendiente" | "cancelada" | "reprogramada" | "asistio" | "ausente";

export interface Appointment {
  id: string;
  patientId: string;
  patientName: string;
  treatment: string;
  start: string; // ISO con zona
  end: string;
  status: AppointmentStatus;
  calendarEventId: string;
  confirmedByPatient: boolean;
  reminder24Sent: boolean;
  reminder2Sent: boolean;
  createdAt: string;
  /** Cuándo se canceló (para las estadísticas). */
  cancelledAt?: string | null;
}

export interface ChatMessage {
  role: "patient" | "bot" | "human" | "system";
  text: string;
  at: string;
  /** Quién escribió los mensajes de recepción (correo del usuario del panel). */
  by?: string;
  /** Opciones del menú que acompañaron al mensaje del bot (botones o lista). */
  options?: string[];
  /** Mensajes que envía el bot por iniciativa propia (recordatorios, seguimiento). */
  meta?: {
    kind: "reminder24" | "reminder2" | "followup" | "waitlist_offer" | "reactivation";
    appointmentId?: string;
    /** Lista de espera: entrada y horario ofrecido (hora local YYYY-MM-DDTHH:mm). */
    waitlistId?: string;
    slot?: string;
  };
}

export interface Conversation {
  id: string;
  patientId: string;
  channel: Channel;
  /** Historial nativo del proveedor LLM (append-only). */
  llmState: unknown[];
  llmProvider: string;
  messages: ChatMessage[];
  privacyShown: boolean;
  /** true cuando una persona tomó la conversación: el bot deja de responder. */
  handedOff: boolean;
  /** Pausa manual desde el panel: el bot no responde nada (ni el aviso de recepción). */
  botPaused: boolean;
  /** Persona del equipo que tomó la conversación (correo). */
  assignedTo: string | null;
  /** Cerrada por inactividad, al confirmar o cancelar un turno, o a mano. Se reabre si el paciente vuelve a escribir. */
  closedAt: string | null;
  closedReason: CloseReason | null;
  createdAt: string;
  updatedAt: string;
}

export type CloseReason = "inactividad" | "turno_confirmado" | "turno_cancelado" | "manual";

export interface Handoff {
  id: string;
  conversationId: string;
  patientId: string;
  reason: string;
  summary: string;
  status: "abierta" | "resuelta";
  createdAt: string;
}

export interface TurnMetric {
  conversationId: string;
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  modelCalls: number;
  tools: string[];
  at: string;
}

export type WaitlistStatus = "esperando" | "ofrecido" | "aceptado" | "cancelado";

/** Paciente que espera un hueco: si se libera un horario dentro de su rango, se le ofrece. */
export interface WaitlistEntry {
  id: string;
  patientId: string;
  patientName: string;
  treatment: string;
  /** Rango de días aceptable (YYYY-MM-DD, hora local de la clínica). */
  fromDate: string;
  toDate: string;
  franja: "manana" | "tarde" | "cualquiera";
  status: WaitlistStatus;
  /** Horario ofrecido ahora (YYYY-MM-DDTHH:mm) y cuándo se ofreció. */
  offeredSlot: string | null;
  offeredAt: string | null;
  /** Horarios que ya rechazó o dejó vencer: no se le vuelven a ofrecer. */
  declinedSlots: string[];
  createdAt: string;
}

/** Documento subido por el consultorio (PDF/Word), ya convertido a texto y partido en fragmentos. */
export interface ClinicDocument {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  chunks: number;
  createdAt: string;
}

export interface DocumentHit {
  documentId: string;
  name: string;
  content: string;
  rank: number;
}

/** El horario ya fue tomado por otro turno activo (doble reserva). */
export class SlotTakenError extends Error {
  constructor() {
    super("horario_ocupado");
  }
}

export interface AppointmentFilter {
  patientId?: string;
  from?: string;
  to?: string;
  status?: AppointmentStatus[];
}

/**
 * Persistencia de UNA clínica: todas las lecturas y escrituras quedan filtradas
 * por `clinicId`. `forClinic()` devuelve la misma base vista desde otra clínica.
 */
export interface Store {
  readonly clinicId: string;
  forClinic(clinicId: string): Store;

  getOrCreatePatient(phone: string, channel: Channel, source?: string | null): Promise<Patient>;
  updatePatient(id: string, patch: PatientPatch): Promise<Patient>;
  getPatient(id: string): Promise<Patient | null>;
  listPatients(): Promise<Patient[]>;

  getOrCreateConversation(patient: Patient, channel: Channel): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  saveConversation(c: Conversation): Promise<void>;
  listConversations(): Promise<Conversation[]>;

  createAppointment(a: Omit<Appointment, "id" | "createdAt">): Promise<Appointment>;
  updateAppointment(id: string, patch: Partial<Appointment>): Promise<Appointment>;
  getAppointment(id: string): Promise<Appointment | null>;
  listAppointments(filter?: AppointmentFilter): Promise<Appointment[]>;
  deleteAppointment(id: string): Promise<void>;

  createHandoff(h: Omit<Handoff, "id" | "createdAt" | "status">): Promise<Handoff>;
  listHandoffs(): Promise<Handoff[]>;
  updateHandoff(id: string, patch: Partial<Pick<Handoff, "status">>): Promise<void>;

  logMetric(m: TurnMetric): Promise<void>;
  listMetrics(): Promise<TurnMetric[]>;

  // Lista de espera
  addWaitlist(e: Omit<WaitlistEntry, "id" | "createdAt" | "status" | "offeredSlot" | "offeredAt" | "declinedSlots">): Promise<WaitlistEntry>;
  listWaitlist(status?: WaitlistStatus[]): Promise<WaitlistEntry[]>;
  updateWaitlist(id: string, patch: Partial<Omit<WaitlistEntry, "id" | "createdAt">>): Promise<WaitlistEntry>;

  // Zona de aprendizaje
  updateKnowledge(k: ClinicKnowledge): Promise<void>;
  listDocuments(): Promise<ClinicDocument[]>;
  addDocument(doc: Omit<ClinicDocument, "id" | "createdAt" | "chunks">, chunks: string[]): Promise<ClinicDocument>;
  deleteDocument(id: string): Promise<void>;
  /** Fragmentos más parecidos a la consulta (búsqueda de texto, no vectores). */
  searchDocuments(query: string, limit?: number): Promise<DocumentHit[]>;
}

let seq = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`;

type Owned<T> = T & { clinicId: string };

/** Datos compartidos por todas las vistas por clínica de la base en memoria. */
interface MemoryData {
  patients: Map<string, Owned<Patient>>;
  conversations: Map<string, Owned<Conversation>>;
  appointments: Map<string, Owned<Appointment>>;
  handoffs: Array<Owned<Handoff>>;
  metrics: Array<Owned<TurnMetric>>;
  documents: Array<Owned<ClinicDocument>>;
  chunks: Array<{ documentId: string; clinicId: string; content: string }>;
  knowledge: Map<string, ClinicKnowledge>;
  waitlist: Array<Owned<WaitlistEntry>>;
}

export const DEFAULT_CLINIC_ID = "sonrisa-clara";

function strip<T>(x: Owned<T>): T {
  const { clinicId: _c, ...rest } = x;
  return rest as unknown as T;
}

/** Base en memoria (entorno de pruebas): mismo comportamiento que Supabase, incluido el filtro por clínica. */
export class InMemoryStore implements Store {
  private data: MemoryData;

  /** El reloj es inyectable para que las pruebas con tiempo simulado fechen bien los registros. */
  constructor(private clock: () => Date = () => new Date(), readonly clinicId = DEFAULT_CLINIC_ID, data?: MemoryData) {
    this.data = data ?? { patients: new Map(), conversations: new Map(), appointments: new Map(), handoffs: [], metrics: [], documents: [], chunks: [], knowledge: new Map(), waitlist: [] };
  }
  forClinic(clinicId: string): Store {
    return new InMemoryStore(this.clock, clinicId, this.data);
  }
  private now = () => this.clock().toISOString();
  private mine = <T>(x: Owned<T> | undefined): x is Owned<T> => !!x && x.clinicId === this.clinicId;

  async getOrCreatePatient(phone: string, channel: Channel, source: string | null = null) {
    const found = [...this.data.patients.values()].find((p) => this.mine(p) && p.phone === phone);
    if (found) return structuredClone(strip(found));
    const p: Owned<Patient> = {
      id: id("pac"), phone, name: null, profileName: null, contactPhone: channel === "whatsapp" ? phone : null, notes: "", tags: [],
      channel, source, createdAt: this.now(), clinicId: this.clinicId,
    };
    this.data.patients.set(p.id, p);
    return structuredClone(strip(p));
  }
  async updatePatient(pid: string, patch: PatientPatch) {
    const cur = this.data.patients.get(pid);
    if (!this.mine(cur)) throw new Error("paciente no encontrado");
    const p = { ...cur, ...structuredClone(patch) };
    this.data.patients.set(pid, p);
    return structuredClone(strip(p));
  }
  async getPatient(pid: string) {
    const p = this.data.patients.get(pid);
    return this.mine(p) ? structuredClone(strip(p)) : null;
  }
  async listPatients() {
    return [...this.data.patients.values()].filter((p) => this.mine(p)).map((p) => structuredClone(strip(p)));
  }

  async getOrCreateConversation(patient: Patient, channel: Channel) {
    const found = [...this.data.conversations.values()].find((c) => this.mine(c) && c.patientId === patient.id && c.channel === channel);
    if (found) return structuredClone(strip(found));
    const c: Owned<Conversation> = {
      id: id("conv"), patientId: patient.id, channel, llmState: [], llmProvider: "",
      messages: [], privacyShown: false, handedOff: false, botPaused: false, assignedTo: null, closedAt: null, closedReason: null,
      createdAt: this.now(), updatedAt: this.now(), clinicId: this.clinicId,
    };
    this.data.conversations.set(c.id, c);
    return structuredClone(strip(c));
  }
  async getConversation(cid: string) {
    const c = this.data.conversations.get(cid);
    return this.mine(c) ? structuredClone(strip(c)) : null;
  }
  async saveConversation(c: Conversation) {
    if (!this.mine(this.data.conversations.get(c.id))) throw new Error("conversación no encontrada");
    this.data.conversations.set(c.id, { ...structuredClone(c), updatedAt: this.now(), clinicId: this.clinicId });
  }
  async listConversations() {
    return [...this.data.conversations.values()].filter((c) => this.mine(c)).map((c) => structuredClone(strip(c)));
  }

  async createAppointment(a: Omit<Appointment, "id" | "createdAt">) {
    const active = (s: AppointmentStatus) => s === "confirmada" || s === "pendiente";
    // Mismo comportamiento que el índice único (clinic_id, start_at) de Supabase.
    if (active(a.status) && [...this.data.appointments.values()].some((x) => this.mine(x) && active(x.status) && x.start === a.start)) {
      throw new SlotTakenError();
    }
    const ap: Owned<Appointment> = { ...a, id: id("cita"), createdAt: this.now(), clinicId: this.clinicId };
    this.data.appointments.set(ap.id, ap);
    return strip(ap);
  }
  async updateAppointment(aid: string, patch: Partial<Appointment>) {
    const cur = this.data.appointments.get(aid);
    if (!this.mine(cur)) throw new Error("turno no encontrado");
    const ap = { ...cur, ...patch, clinicId: this.clinicId };
    this.data.appointments.set(aid, ap);
    return strip(ap);
  }
  async getAppointment(aid: string) {
    const a = this.data.appointments.get(aid);
    return this.mine(a) ? strip(a) : null;
  }
  async listAppointments(f: AppointmentFilter = {}) {
    return [...this.data.appointments.values()]
      .filter((a) => this.mine(a))
      .filter((a) => !f.patientId || a.patientId === f.patientId)
      .filter((a) => !f.from || a.start >= f.from)
      .filter((a) => !f.to || a.start < f.to)
      .filter((a) => !f.status || f.status.includes(a.status))
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((a) => strip(a));
  }
  async deleteAppointment(aid: string) {
    if (this.mine(this.data.appointments.get(aid))) this.data.appointments.delete(aid);
  }

  async createHandoff(h: Omit<Handoff, "id" | "createdAt" | "status">) {
    const x: Owned<Handoff> = { ...h, id: id("der"), status: "abierta", createdAt: this.now(), clinicId: this.clinicId };
    this.data.handoffs.push(x);
    return strip(x);
  }
  async listHandoffs() {
    return this.data.handoffs.filter((h) => this.mine(h)).map((h) => strip(h));
  }
  async updateHandoff(hid: string, patch: Partial<Pick<Handoff, "status">>) {
    const h = this.data.handoffs.find((x) => x.id === hid);
    if (this.mine(h)) Object.assign(h, patch);
  }

  async logMetric(m: TurnMetric) {
    this.data.metrics.push({ ...m, clinicId: this.clinicId });
  }
  async listMetrics() {
    return this.data.metrics.filter((m) => this.mine(m)).map((m) => strip(m));
  }

  async addWaitlist(e: Omit<WaitlistEntry, "id" | "createdAt" | "status" | "offeredSlot" | "offeredAt" | "declinedSlots">) {
    const x: Owned<WaitlistEntry> = { ...e, id: id("esp"), status: "esperando", offeredSlot: null, offeredAt: null, declinedSlots: [], createdAt: this.now(), clinicId: this.clinicId };
    this.data.waitlist.push(x);
    return strip(x);
  }
  async listWaitlist(status?: WaitlistStatus[]) {
    return this.data.waitlist.filter((w) => this.mine(w) && (!status || status.includes(w.status)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((w) => structuredClone(strip(w)));
  }
  async updateWaitlist(wid: string, patch: Partial<Omit<WaitlistEntry, "id" | "createdAt">>) {
    const w = this.data.waitlist.find((x) => x.id === wid);
    if (!this.mine(w)) throw new Error("entrada de lista de espera no encontrada");
    Object.assign(w, structuredClone(patch));
    return structuredClone(strip(w));
  }

  /** Carga datos de ejemplo ya armados (ids y fechas propios) en esta clínica. Solo en memoria. */
  importDemo(d: { patients: Patient[]; conversations: Conversation[]; appointments: Appointment[]; handoffs: Handoff[]; metrics: TurnMetric[]; waitlist: WaitlistEntry[] }) {
    const c = this.clinicId;
    for (const p of d.patients) this.data.patients.set(p.id, { ...structuredClone(p), clinicId: c });
    for (const v of d.conversations) this.data.conversations.set(v.id, { ...structuredClone(v), clinicId: c });
    for (const a of d.appointments) this.data.appointments.set(a.id, { ...a, clinicId: c });
    for (const h of d.handoffs) this.data.handoffs.push({ ...h, clinicId: c });
    for (const m of d.metrics) this.data.metrics.push({ ...m, clinicId: c });
    for (const w of d.waitlist) this.data.waitlist.push({ ...structuredClone(w), clinicId: c });
  }

  async updateKnowledge(k: ClinicKnowledge) {
    this.data.knowledge.set(this.clinicId, structuredClone(k));
  }
  async listDocuments() {
    return this.data.documents.filter((d) => this.mine(d)).map((d) => strip(d)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async addDocument(doc: Omit<ClinicDocument, "id" | "createdAt" | "chunks">, chunks: string[]) {
    const d: Owned<ClinicDocument> = { ...doc, id: id("doc"), chunks: chunks.length, createdAt: this.now(), clinicId: this.clinicId };
    this.data.documents.push(d);
    for (const content of chunks) this.data.chunks.push({ documentId: d.id, clinicId: this.clinicId, content });
    return strip(d);
  }
  async deleteDocument(did: string) {
    if (!this.mine(this.data.documents.find((d) => d.id === did))) return;
    this.data.documents = this.data.documents.filter((d) => d.id !== did);
    this.data.chunks = this.data.chunks.filter((c) => c.documentId !== did);
  }
  async searchDocuments(query: string, limit = 3) {
    const q = terms(query);
    if (!q.length) return [];
    const names = new Map(this.data.documents.map((d) => [d.id, d.name]));
    return this.data.chunks
      .filter((c) => c.clinicId === this.clinicId)
      .map((c) => ({ documentId: c.documentId, name: names.get(c.documentId) ?? "", content: c.content, rank: score(c.content, q) }))
      .filter((h) => h.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit);
  }
}

