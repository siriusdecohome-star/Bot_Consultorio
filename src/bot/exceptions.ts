import { DateTime } from "luxon";
import { config } from "../config.js";
import { kb } from "../data/knowledge.js";
import { exceptionHit, professionalById } from "../services/availability.js";
import type { Notifier, OutboundMessage } from "../services/notifier.js";
import type { Appointment, ProfessionalException, Store } from "../services/store.js";
import { human, toLocal, TZ, type Clock } from "../services/time.js";

/**
 * Excepciones de agenda (día completo, franja o vacaciones). Al cargar una, se listan
 * los turnos que quedan afectados y recepción puede avisarles por el bot para reprogramar.
 */

/** Turnos activos y futuros del profesional que caen dentro de la excepción. */
export async function affectedAppointments(store: Store, e: ProfessionalException, now: Date): Promise<Appointment[]> {
  const from = DateTime.fromISO(`${e.fromDate}T00:00`, { zone: TZ() });
  const list = await store.listAppointments({
    from: DateTime.max(from, DateTime.fromJSDate(now)).toUTC().toISO()!,
    to: DateTime.fromISO(`${e.toDate}T23:59`, { zone: TZ() }).toUTC().toISO()!,
    status: ["confirmada", "pendiente"],
  });
  return list.filter((a) => a.professionalId === e.professionalId && exceptionHit([e], e.professionalId, toLocal(a.start), toLocal(a.end)));
}

/** Mensaje al paciente: el profesional no atiende, ¿reprogramamos? (con botones y plantilla de respaldo). */
export function rescheduleMessage(a: Appointment, e: ProfessionalException, professional: string): OutboundMessage {
  const first = a.patientName.split(/\s+/)[0] ?? "";
  const when = human(toLocal(a.start));
  return {
    text: `Hola, ${first}. Le escribimos de ${kb().name}: ${professional} no podrá atender el *${when}* (${e.reason.toLowerCase()}), que es el horario de su turno de ${a.treatment.toLowerCase()}.\n\n¿Lo reprogramamos? Le busco otro horario ahora mismo.`,
    buttons: ["Reprogramar", "Cancelar turno"],
    template: { name: config.whatsapp.templateReschedule, params: [first || "¡hola", when, professional] },
  };
}

export interface NotifyResult {
  sent: number;
  /** Pacientes de ejemplo: el aviso queda en su conversación, pero no se envía (teléfono ficticio). */
  demo: number;
  failed: string[];
}

/** Avisa por el bot a cada paciente afectado y deja el aviso en su conversación. */
export async function notifyAffected(store: Store, notifier: Notifier, e: ProfessionalException, clock: Clock): Promise<NotifyResult> {
  const prof = professionalById(e.professionalId)?.name ?? "El profesional";
  const out: NotifyResult = { sent: 0, demo: 0, failed: [] };
  for (const a of await affectedAppointments(store, e, clock())) {
    const patient = await store.getPatient(a.patientId);
    if (!patient) continue;
    const msg = rescheduleMessage(a, e, prof);
    try {
      if (patient.id.startsWith("demo_")) out.demo++;
      else { await notifier.send(patient.channel, patient.phone, msg); out.sent++; }
      const conv = await store.getOrCreateConversation(patient, patient.channel);
      conv.messages.push({ role: "bot", text: msg.text, at: clock().toISOString(), options: msg.buttons, meta: { kind: "reschedule_request", appointmentId: a.id, reason: e.reason } });
      conv.privacyShown = true;
      // Queda abierta para que el paciente responda (si estaba cerrada, se reabre).
      if (conv.closedAt) {
        conv.closedAt = null;
        conv.closedReason = null;
      }
      await store.saveConversation(conv);
    } catch (err) {
      out.failed.push(`${a.patientName}: ${(err as Error).message}`);
    }
  }
  await store.updateException(e.id, { notifiedAt: clock().toISOString() });
  return out;
}

/** Valida una excepción cargada desde el panel. Devuelve el problema o null. */
export function validateException(b: any, professionalIds: string[]): string | null {
  if (!professionalIds.includes(b?.professionalId)) return "Elija un profesional";
  if (!["dia", "franja", "rango"].includes(b.kind)) return "Tipo inválido";
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!date.test(b.fromDate ?? "")) return "Fecha inválida";
  if (b.kind === "rango" && (!date.test(b.toDate ?? "") || b.toDate < b.fromDate)) return "El rango necesita fecha de fin igual o posterior al inicio";
  if (b.kind === "franja") {
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!hm.test(b.fromTime ?? "") || !hm.test(b.toTime ?? "") || b.fromTime >= b.toTime) return "La franja va de HH:mm a HH:mm (inicio antes que fin)";
  }
  if (typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 120) return "Indique el motivo (hasta 120 caracteres)";
  return null;
}
