import { config } from "../../config.js";
import type { ClinicProfile, WhatsAppLine } from "../../clinics/types.js";
import { altamira } from "./altamira.js";
import { sonrisaClara } from "./sonrisaClara.js";
import { altamiraProfessionals, sonrisaProfessionals } from "./professionals.js";
import { defaultSettings } from "./settings.js";

export const CLINIC_A = "sonrisa-clara";
export const CLINIC_B = "altamira";

/**
 * Las dos clínicas de ejemplo. Con Supabase, `npm run seed` las guarda en la
 * tabla `clinics` y desde ahí se leen; en memoria se usan tal cual.
 * Solo la clínica A tiene el número de prueba de WhatsApp (línea real); las dos tienen
 * líneas simuladas para el simulador.
 */
export function demoClinics(): ClinicProfile[] {
  return [
    {
      id: CLINIC_A,
      name: sonrisaClara.name,
      timezone: config.clinic.timezone,
      slotMinutes: config.clinic.slotMinutes,
      lines: sonrisaLines(CLINIC_A, config.whatsapp.phoneNumberId || null),
      calendarTag: CLINIC_A,
      primary: true,
      calendarColor: "10", // verde
      knowledge: structuredClone(sonrisaClara),
      professionals: structuredClone(sonrisaProfessionals),
      settings: defaultSettings(),
    },
    {
      id: CLINIC_B,
      name: altamira.name,
      timezone: config.clinic.timezone,
      slotMinutes: 30,
      lines: [line(CLINIC_B, "recepcion", "Recepción")],
      calendarTag: CLINIC_B,
      primary: false,
      calendarColor: "9", // azul
      knowledge: structuredClone(altamira),
      professionals: structuredClone(altamiraProfessionals),
      settings: defaultSettings(),
    },
  ];
}

const line = (clinicId: string, key: string, name: string, extra: Partial<WhatsAppLine> = {}): WhatsAppLine => ({
  id: `${clinicId}-${key}`, clinicId, name, kind: "simulada", phoneNumberId: null, displayPhone: null, professionalId: null, area: null, active: true, ...extra,
});

/**
 * Líneas de la clínica A: el número de prueba de Meta (si está configurado) y dos líneas
 * simuladas: la general y la de ortodoncia del Dr. Ríos (el bot lo ofrece primero).
 * Las clínicas temporales de la demo copian solo las simuladas.
 */
export function sonrisaLines(clinicId: string, phoneNumberId: string | null): WhatsAppLine[] {
  return [
    ...(phoneNumberId ? [line(clinicId, "recepcion", "Recepción", { kind: "cloud", phoneNumberId })] : []),
    line(clinicId, "general", "Línea general"),
    line(clinicId, "ortodoncia", "Ortodoncia · Dr. Ríos", { professionalId: "prof-rios", area: "Ortodoncia" }),
  ];
}
