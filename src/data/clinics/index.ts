import { config } from "../../config.js";
import type { ClinicProfile } from "../../clinics/types.js";
import { altamira } from "./altamira.js";
import { sonrisaClara } from "./sonrisaClara.js";
import { altamiraProfessionals, sonrisaProfessionals } from "./professionals.js";

export const CLINIC_A = "sonrisa-clara";
export const CLINIC_B = "altamira";

/**
 * Las dos clínicas de ejemplo. Con Supabase, `npm run seed` las guarda en la
 * tabla `clinics` y desde ahí se leen; en memoria se usan tal cual.
 * Solo la clínica A tiene el número de prueba de WhatsApp.
 */
export function demoClinics(): ClinicProfile[] {
  return [
    {
      id: CLINIC_A,
      name: sonrisaClara.name,
      timezone: config.clinic.timezone,
      slotMinutes: config.clinic.slotMinutes,
      whatsappPhoneNumberId: config.whatsapp.phoneNumberId || null,
      calendarTag: CLINIC_A,
      primary: true,
      calendarColor: "10", // verde
      knowledge: structuredClone(sonrisaClara),
      professionals: structuredClone(sonrisaProfessionals),
    },
    {
      id: CLINIC_B,
      name: altamira.name,
      timezone: config.clinic.timezone,
      slotMinutes: 30,
      whatsappPhoneNumberId: null,
      calendarTag: CLINIC_B,
      primary: false,
      calendarColor: "9", // azul
      knowledge: structuredClone(altamira),
      professionals: structuredClone(altamiraProfessionals),
    },
  ];
}
