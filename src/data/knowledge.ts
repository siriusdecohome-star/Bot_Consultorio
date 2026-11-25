import { currentClinic } from "../clinics/context.js";
import type { ClinicKnowledge } from "../clinics/types.js";

export type { OpeningHours } from "../clinics/types.js";

/**
 * Base de conocimiento de la clínica actual (ver clinics/context.ts).
 * Es corta, así que va completa en el prompt de sistema (cacheado):
 * evita una ronda extra de herramientas y baja la latencia.
 */
export function kb(): ClinicKnowledge {
  return currentClinic().knowledge;
}

/** Texto de la base de conocimiento para el prompt de sistema. */
export function knowledgeText(k: ClinicKnowledge = kb()): string {
  const t = k.treatments
    .map((x) => `- ${x.name}${x.specialty ? ` [${x.specialty}]` : ""}: ${x.price}. Duración: ${x.duration}. ${x.notes}`)
    .join("\n");
  // Profesionales con su especialidad y días (los horarios exactos los da buscar_horarios_disponibles).
  const DAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
  const profs = (currentClinic().professionals ?? []).filter((p) => p.active);
  const team = profs.length
    ? profs.map((p) => `- ${p.name} (id ${p.id}) — ${p.specialty}. Atiende: ${p.hours.map((h) => DAYS[h.weekday - 1]).join(", ")}. Tratamientos: ${p.treatments.map((x) => k.treatments.find((tr) => tr.id === x.id)?.name ?? x.id).join(", ")}.`).join("\n")
    : `- ${k.professionals.join("\n- ")}`;
  return [
    `Nombre: ${k.name} (${k.tagline})`,
    `Dirección: ${k.address}. ${k.reference}`,
    `Teléfono: ${k.phone}. Correo: ${k.email}`,
    `Profesionales:\n${team}`,
    `Horario de atención: ${k.hoursText}`,
    `Tratamientos y precios:\n${t}`,
    `Promoción vigente: ${k.promo.name}. ${k.promo.detail}`,
    `Medios de pago: ${k.payments}`,
    `Coberturas: ${k.insurance}`,
    `Política de cancelación: ${k.cancellationPolicy}`,
    `Urgencias: ${k.emergencies}`,
    k.faq?.length ? `Preguntas frecuentes:\n${k.faq.map((f) => `- ${f.q} → ${f.a}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Versión breve que va al final del primer saludo (modo "inline"). */
export const privacyLine =
  "_🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._";

export function privacyNotice(): string {
  return `🔒 Aviso de privacidad: soy el asistente virtual de ${kb().name}. ` +
    "Uso sus datos (nombre y teléfono) solo para gestionar sus turnos y la conversación queda registrada de forma confidencial. " +
    "No comparta información médica sensible por este medio. Si en algún momento prefiere hablar con una persona, escriba «persona».";
}
