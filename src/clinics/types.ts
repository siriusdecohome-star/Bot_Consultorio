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
  name: string;
  price: string;
  duration: string;
  notes: string;
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
}

export interface ClinicProfile {
  /** slug, p. ej. "sonrisa-clara" */
  id: string;
  name: string;
  timezone: string;
  slotMinutes: number;
  /** "Identificador del número de teléfono" de Meta; null = solo simulador */
  whatsappPhoneNumberId: string | null;
  /** Valor de la etiqueta `clinic` en los eventos de Google Calendar */
  calendarTag: string;
  /** La clínica principal también ve como ocupados los eventos sin etiqueta del calendario compartido. */
  primary: boolean;
  /** colorId de Google Calendar para los turnos que reserva el bot */
  calendarColor: string;
  knowledge: ClinicKnowledge;
}

export type Role = "admin" | "recepcion";
