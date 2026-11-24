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

export interface Store {
  getOrCreatePatient(phone: string, channel: Channel, source?: string | null): Promise<Patient>;
  updatePatient(id: string, patch: Partial<Pick<Patient, "name" | "source">>): Promise<Patient>;
  getPatient(id: string): Promise<Patient | null>;

  getOrCreateConversation(patient: Patient, channel: Channel): Promise<Conversation>;
  saveConversation(c: Conversation): Promise<void>;
  listConversations(): Promise<Conversation[]>;

  createAppointment(a: Omit<Appointment, "id" | "createdAt">): Promise<Appointment>;
  updateAppointment(id: string, patch: Partial<Appointment>): Promise<Appointment>;
  getAppointment(id: string): Promise<Appointment | null>;
  listAppointments(filter?: { patientId?: string; from?: string; to?: string; status?: AppointmentStatus[] }): Promise<Appointment[]>;
  deleteAppointment(id: string): Promise<void>;

  createHandoff(h: Omit<Handoff, "id" | "createdAt" | "status">): Promise<Handoff>;
  listHandoffs(): Promise<Handoff[]>;

  logMetric(m: TurnMetric): Promise<void>;
  listMetrics(): Promise<TurnMetric[]>;
}

const now = () => new Date().toISOString();
let seq = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`;

export class InMemoryStore implements Store {
  patients = new Map<string, Patient>();
  conversations = new Map<string, Conversation>();
  appointments = new Map<string, Appointment>();
  handoffs: Handoff[] = [];
  metrics: TurnMetric[] = [];

  async getOrCreatePatient(phone: string, channel: Channel, source: string | null = null) {
    const found = [...this.patients.values()].find((p) => p.phone === phone);
    if (found) return found;
    const p: Patient = { id: id("pac"), phone, name: null, channel, source, createdAt: now() };
    this.patients.set(p.id, p);
    return p;
  }
  async updatePatient(pid: string, patch: Partial<Pick<Patient, "name" | "source">>) {
    const p = { ...this.patients.get(pid)!, ...patch };
    this.patients.set(pid, p);
    return p;
  }
  async getPatient(pid: string) {
    return this.patients.get(pid) ?? null;
  }

  async getOrCreateConversation(patient: Patient, channel: Channel) {
    const found = [...this.conversations.values()].find((c) => c.patientId === patient.id && c.channel === channel);
    if (found) return found;
    const c: Conversation = {
      id: id("conv"), patientId: patient.id, channel, llmState: [], llmProvider: "",
      messages: [], privacyShown: false, handedOff: false, createdAt: now(), updatedAt: now(),
    };
    this.conversations.set(c.id, c);
    return c;
  }
  async saveConversation(c: Conversation) {
    this.conversations.set(c.id, { ...c, updatedAt: now() });
  }
  async listConversations() {
    return [...this.conversations.values()];
  }

  async createAppointment(a: Omit<Appointment, "id" | "createdAt">) {
    const active = (s: AppointmentStatus) => s === "confirmada" || s === "pendiente";
    if (active(a.status) && [...this.appointments.values()].some((x) => active(x.status) && x.start === a.start)) {
      throw new SlotTakenError(); // mismo comportamiento que el índice único de Supabase
    }
    const ap: Appointment = { ...a, id: id("cita"), createdAt: now() };
    this.appointments.set(ap.id, ap);
    return ap;
  }
  async updateAppointment(aid: string, patch: Partial<Appointment>) {
    const ap = { ...this.appointments.get(aid)!, ...patch };
    this.appointments.set(aid, ap);
    return ap;
  }
  async getAppointment(aid: string) {
    return this.appointments.get(aid) ?? null;
  }
  async listAppointments(f: { patientId?: string; from?: string; to?: string; status?: AppointmentStatus[] } = {}) {
    return [...this.appointments.values()]
      .filter((a) => !f.patientId || a.patientId === f.patientId)
      .filter((a) => !f.from || a.start >= f.from)
      .filter((a) => !f.to || a.start < f.to)
      .filter((a) => !f.status || f.status.includes(a.status))
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  async deleteAppointment(aid: string) {
    this.appointments.delete(aid);
  }

  async createHandoff(h: Omit<Handoff, "id" | "createdAt" | "status">) {
    const x: Handoff = { ...h, id: id("der"), status: "abierta", createdAt: now() };
    this.handoffs.push(x);
    return x;
  }
  async listHandoffs() {
    return this.handoffs;
  }

  async logMetric(m: TurnMetric) {
    this.metrics.push(m);
  }
  async listMetrics() {
    return this.metrics;
  }
}
