/**
 * Multiempresa: cada clínica tiene su perfil (zona horaria, duración de turno,
 * número de WhatsApp, etiqueta en el calendario) y su base de conocimiento.
 */

export interface OpeningHours {
  /** 1 = lunes … 7 = domingo (como Luxon) */
  weekday: number;
  /** Bloques de atención en hora local, "HH:mm" */
  blocks: Array<[string, string]>;
}

export interface Treatment {
  /** Id estable (lo usan los profesionales para decir qué tratamientos hacen). */
  id?: string;
  name: string;
  /** Especialidad a la que pertenece (el bot pregunta primero la especialidad). */
  specialty?: string;
  price: string;
  duration: string;
  notes: string;
}

/**
 * Opción del menú inicial. «consulta»: el bot recibe `text` como si lo hubiera escrito
 * el paciente (responde con los datos actuales). «respuesta»: se contesta `text` tal cual.
 */
export interface MenuOption {
  id: string;
  /** Título del botón o de la fila de la lista (WhatsApp: hasta 24 caracteres en listas, 20 en botones). */
  label: string;
  /** Descripción opcional de la fila (hasta 72 caracteres). */
  description?: string;
  kind: "consulta" | "respuesta";
  text: string;
}

/** Menú con botones (hasta 3 opciones) o lista interactiva de WhatsApp (hasta 10). */
export interface ClinicMenu {
  enabled: boolean;
  /** Texto que acompaña al menú. */
  intro: string;
  /** Texto del botón que abre la lista (hasta 20 caracteres). */
  button: string;
  options: MenuOption[];
}

/** Base de conocimiento de una clínica: lo único que el bot puede afirmar. */
export interface ClinicKnowledge {
  name: string;
  tagline: string;
  address: string;
  reference: string;
  phone: string;
  email: string;
  professionals: string[];
  hours: OpeningHours[];
  hoursText: string;
  treatments: Treatment[];
  promo: { name: string; detail: string };
  payments: string;
  insurance: string;
  cancellationPolicy: string;
  emergencies: string;
  /** Instrucciones de tono propias de la clínica (se suman al estilo general). */
  tone?: string;
  /** Preguntas frecuentes propias. */
  faq?: Array<{ q: string; a: string }>;
  /** Menú inicial (saludo o «menú»). */
  menu?: ClinicMenu;
}

/**
 * Profesional de la clínica: horario semanal propio, tratamientos que realiza
 * con su duración, y de dónde se lee su ocupación (Google Calendar o agenda interna).
 */
export interface Professional {
  id: string;
  name: string;
  specialty: string;
  /** Color en la agenda (hex). */
  color: string;
  /** Horario semanal propio (se cruza con el horario de atención de la clínica). */
  hours: OpeningHours[];
  /** Tratamientos que realiza (id del tratamiento) y cuántos minutos le lleva cada uno. */
  treatments: Array<{ id: string; minutes: number }>;
  /** "google": su ocupación se lee también de Google Calendar; "interno": solo la agenda del sistema. */
  calendar: "google" | "interno";
  active: boolean;
}

/**
 * Regla de seguimiento: cuándo escribe el bot por su cuenta y qué dice.
 * - antes: X horas antes del turno (72, 24, 2, 1…).
 * - despues: X días después de un turno al que asistió.
 * - reactivacion: a quien no viene hace X días; se repite cada `repeatDays`.
 * - lead: X horas después de que un lead de la promo dejó de escribir sin agendar (una vez).
 * El texto admite {nombre}, {cuando}, {fecha}, {hora}, {tratamiento}, {profesional}, {clinica}, {direccion}, {promo}, {meses}.
 */
export interface FollowupRule {
  id: string;
  kind: "antes" | "despues" | "reactivacion" | "lead";
  active: boolean;
  hours?: number;
  days?: number;
  repeatDays?: number;
  text: string;
  /** Solo «antes»: texto si el paciente ya confirmó (sin botones). */
  textConfirmed?: string;
  /** Botones de respuesta rápida (hasta 3, de hasta 20 caracteres). */
  buttons: string[];
  /** Plantilla de Meta que se usa si pasaron más de 24 h desde el último mensaje del paciente. */
  template: string;
}

export interface ClinicSettings {
  /** Horario de silencio (hora local): los avisos automáticos esperan hasta que termine. */
  quietHours: { from: string; to: string } | null;
  /** Minutos que se guarda un horario ofrecido a la lista de espera. */
  waitlistOfferMinutes: number;
  rules: FollowupRule[];
}

/** Línea de WhatsApp de una clínica (ver clinics/lines.ts). */
export interface WhatsAppLine {
  id: string;
  clinicId: string;
  /** Nombre que ve el equipo en la bandeja, p. ej. «Recepción» u «Ortodoncia · Dr. Ríos». */
  name: string;
  kind: "cloud" | "simulada";
  /** «Identificador del número de teléfono» de Meta (solo las líneas reales). */
  phoneNumberId: string | null;
  /** Número visible, solo para mostrar (opcional). */
  displayPhone: string | null;
  /** Línea de un profesional: el bot lo ofrece primero. */
  professionalId: string | null;
  /** Línea de un área (texto libre). */
  area: string | null;
  active: boolean;
}

export interface ClinicProfile {
  /** slug, p. ej. "sonrisa-clara" */
  id: string;
  name: string;
  timezone: string;
  slotMinutes: number;
  /** Líneas de WhatsApp: números reales de la Cloud API y líneas simuladas de la demo. */
  lines: WhatsAppLine[];
  /** Valor de la etiqueta `clinic` en los eventos de Google Calendar */
  calendarTag: string;
  /** La clínica principal también ve como ocupados los eventos sin etiqueta del calendario compartido. */
  primary: boolean;
  /** colorId de Google Calendar para los turnos que reserva el bot */
  calendarColor: string;
  knowledge: ClinicKnowledge;
  /** Profesionales de la clínica (se editan en el panel y se guardan en la base). */
  professionals: Professional[];
  /** Reglas de seguimiento y recordatorios, horario de silencio y lista de espera. */
  settings: ClinicSettings;
  /** Clínica temporal de la demo pública: se borra a esta hora (ISO). */
  expiresAt?: string | null;
}

export type Role = "admin" | "recepcion";
