/**
 * Persistencia del bot. En la etapa 1 vive en memoria; en la etapa 2 se suma
 * la implementación con Supabase (PostgreSQL) que cumple la misma interfaz.
 */

export type Channel = "web" | "whatsapp" | "cli" | "test";

export interface Patient {
  id: string;
  phone: string;
  name: string | null;
  channel: Channel;
  source: string | null; // p. ej. "promo-noviembre"
  createdAt: string;
}

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
}

export interface ChatMessage {
  role: "patient" | "bot" | "human" | "system";
  text: string;
  at: string;
  /** Mensajes que envía el bot por iniciativa propia (recordatorios, seguimiento). */
  meta?: { kind: "reminder24" | "reminder2" | "followup"; appointmentId?: string };
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
  createdAt: string;
  updatedAt: string;
}

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
  updatePatient(id: string, patch: Partial<Pick<Patient, "name" | "source">>): Promise<Patient>;
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
    this.data = data ?? { patients: new Map(), conversations: new Map(), appointments: new Map(), handoffs: [], metrics: [] };
  }
  forClinic(clinicId: string): Store {
    return new InMemoryStore(this.clock, clinicId, this.data);
  }
  private now = () => this.clock().toISOString();
  private mine = <T>(x: Owned<T> | undefined): x is Owned<T> => !!x && x.clinicId === this.clinicId;

  async getOrCreatePatient(phone: string, channel: Channel, source: string | null = null) {
    const found = [...this.data.patients.values()].find((p) => this.mine(p) && p.phone === phone);
    if (found) return strip(found);
    const p: Owned<Patient> = { id: id("pac"), phone, name: null, channel, source, createdAt: this.now(), clinicId: this.clinicId };
    this.data.patients.set(p.id, p);
    return strip(p);
  }
  async updatePatient(pid: string, patch: Partial<Pick<Patient, "name" | "source">>) {
    const cur = this.data.patients.get(pid);
    if (!this.mine(cur)) throw new Error("paciente no encontrado");
    const p = { ...cur, ...patch };
    this.data.patients.set(pid, p);
    return strip(p);
  }
  async getPatient(pid: string) {
    const p = this.data.patients.get(pid);
    return this.mine(p) ? strip(p) : null;
  }
  async listPatients() {
    return [...this.data.patients.values()].filter((p) => this.mine(p)).map((p) => strip(p));
  }

  async getOrCreateConversation(patient: Patient, channel: Channel) {
    const found = [...this.data.conversations.values()].find((c) => this.mine(c) && c.patientId === patient.id && c.channel === channel);
    if (found) return structuredClone(strip(found));
    const c: Owned<Conversation> = {
      id: id("conv"), patientId: patient.id, channel, llmState: [], llmProvider: "",
      messages: [], privacyShown: false, handedOff: false, createdAt: this.now(), updatedAt: this.now(), clinicId: this.clinicId,
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
}
