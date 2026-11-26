import type { ClinicProfile, WhatsAppLine } from "./types.js";

/**
 * Líneas de WhatsApp de una clínica.
 * - `cloud`: un número real de la Cloud API de Meta (su phone_number_id). El webhook elige
 *   la clínica y la línea por el número que recibió el mensaje, y la respuesta sale por esa línea.
 * - `simulada`: la usa el simulador web de la demo; entra por la misma función que el webhook,
 *   pero no tiene número ni envía nada a Meta.
 * Una línea puede ser de toda la clínica, de un profesional (el bot ofrece primero a ese
 * profesional) o de un área (texto libre, p. ej. «Ortodoncia» o «Administración»).
 */

export const activeLines = (c: ClinicProfile) => c.lines.filter((l) => l.active);
export const cloudLines = (c: ClinicProfile) => activeLines(c).filter((l) => l.kind === "cloud" && l.phoneNumberId);
export const simulatedLines = (c: ClinicProfile) => activeLines(c).filter((l) => l.kind === "simulada");
export const hasWhatsApp = (c: ClinicProfile) => cloudLines(c).length > 0;
export const lineById = (c: ClinicProfile, id: string | null | undefined) => (id ? c.lines.find((l) => l.id === id) ?? null : null);

/** Línea por defecto para los avisos de un paciente que nunca escribió por una línea real. */
export const defaultCloudLine = (c: ClinicProfile) => cloudLines(c)[0] ?? null;

/** Nombre corto para la bandeja: «Ortodoncia · Dr. Ríos (simulada)». */
export function lineLabel(l: WhatsAppLine): string {
  return l.kind === "simulada" ? `${l.name} (simulada)` : l.name;
}

/** Nota para el modelo: por qué línea escribió el paciente y a quién priorizar. */
export function lineContext(c: ClinicProfile, l: WhatsAppLine | null): string {
  if (!l) return "";
  const p = l.professionalId ? c.professionals.find((x) => x.id === l.professionalId) : null;
  const who = p ? ` Es la línea del profesional ${p.name} (id ${p.id}, ${p.specialty}): si pide un turno sin aclarar con quién, ofrézcale primero a ${p.name}; si pide otra especialidad, atiéndalo igual con quien corresponda.` : "";
  const area = l.area && !p ? ` Es la línea del área «${l.area}».` : "";
  return `El paciente escribió a la línea «${l.name}».${who}${area}`;
}


/** Fila de la tabla `whatsapp_lines` → línea. */
export const rowToLine = (r: any): WhatsAppLine => ({
  id: r.id, clinicId: r.clinic_id, name: r.name, kind: r.kind, phoneNumberId: r.phone_number_id ?? null, displayPhone: r.display_phone ?? null,
  professionalId: r.professional_id ?? null, area: r.area ?? null, active: r.active,
});
export const lineToRow = (l: WhatsAppLine) => ({
  id: l.id, clinic_id: l.clinicId, name: l.name, kind: l.kind, phone_number_id: l.phoneNumberId, display_phone: l.displayPhone,
  professional_id: l.professionalId, area: l.area, active: l.active,
});
