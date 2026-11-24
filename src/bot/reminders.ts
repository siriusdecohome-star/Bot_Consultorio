import { DateTime } from "luxon";
import { config } from "../config.js";
import { kb } from "../data/knowledge.js";
import type { Notifier, OutboundMessage } from "../services/notifier.js";
import type { Appointment, Conversation, Patient, Store } from "../services/store.js";
import { toLocal, type Clock } from "../services/time.js";
import { withClinic } from "../clinics/context.js";
import type { ClinicProfile } from "../clinics/types.js";

export type ReminderKind = "reminder24" | "reminder2";

export interface SweepResult {
  reminder24: number;
  reminder2: number;
  followups: number;
  reactivations: number;
  skipped: number;
  errors: string[];
}

const firstName = (n: string) => n.replace(/\s*\(demo\)\s*/i, "").trim().split(/\s+/)[0] ?? "";
const address = () => kb().address.replace(" (dirección ficticia)", "");

/** Texto del recordatorio. «mañana» / «hoy» según la fecha, para que suene natural. */
export function reminderMessage(a: Appointment, kind: ReminderKind, now: DateTime): OutboundMessage {
  const start = toLocal(a.start).setLocale("es");
  const day = start.hasSame(now, "day") ? "hoy" : start.hasSame(now.plus({ days: 1 }), "day") ? "mañana" : start.toFormat("cccc dd/MM");
  const when = `${day === "hoy" || day === "mañana" ? `${day}, ${start.toFormat("cccc dd/MM")}` : day} a las ${start.toFormat("HH:mm")}`;
  const name = firstName(a.patientName);
  const params = [name, when, a.treatment];

  if (kind === "reminder24") {
    return {
      text: `⏰ *Recordatorio de turno*\n\nHola, ${name}. Le recuerdo su turno de *${when}* en ${kb().name}.\n🦷 ${a.treatment}\n📍 ${address()}\n\n¿Nos confirma su asistencia?`,
      buttons: ["✅ Confirmo", "📅 Cambiar horario", "❌ Cancelar"],
      template: { name: config.whatsapp.templateReminder, params },
    };
  }
  return {
    text: a.confirmedByPatient
      ? `👋 Hola, ${name}. Le esperamos *${when}*.\n📍 ${address()}\n\nSi surge algo, avíseme por aquí.`
      : `👋 Hola, ${name}. Su turno es *${when}*.\n📍 ${address()}\n\n¿Puede asistir?`,
    buttons: a.confirmedByPatient ? undefined : ["✅ Confirmo", "❌ Cancelar"],
    template: { name: config.whatsapp.templateReminder, params },
  };
}

export function followupMessage(name: string | null): OutboundMessage {
  const n = name ? firstName(name) : "";
  return {
    text: `Hola${n ? `, ${n}` : ""} 👋 Le escribo de ${kb().name}. Hace poco consultó por la *${kb().promo.name}*: ${kb().promo.detail.split(". ")[0]}.\n\nTodavía quedan turnos esta semana. ¿Quiere que le busque uno?`,
    buttons: ["📅 Sí, buscar turno", "Más adelante"],
    template: { name: config.whatsapp.templateFollowup, params: [n || "¡hola"] },
  };
}

export function reactivationMessage(name: string | null, months: number, lastTreatment: string | null): OutboundMessage {
  const n = name ? firstName(name) : "";
  return {
    text: `Hola${n ? `, ${n}` : ""} 👋 Le escribimos de ${kb().name}. Ya pasaron ${months} meses desde su última visita${lastTreatment ? ` (${lastTreatment})` : ""} y le recomendamos un control cada 6 meses.\n\n¿Quiere que le busque un turno?`,
    buttons: ["📅 Sí, buscar turno", "Más adelante"],
    template: { name: config.whatsapp.templateReactivation, params: [n || "¡hola"] },
  };
}

export interface ReactivationCandidate {
  patient: Patient;
  lastVisit: string; // ISO del último turno al que asistió
  lastTreatment: string;
  monthsAgo: number;
  lastInvitation: string | null;
}

/**
 * Revisa la agenda y envía recordatorios y seguimientos. Es idempotente:
 * cada aviso queda marcado y no se repite aunque el proceso se reinicie.
 */
export class ReminderService {
  private failedAt = new Map<string, number>();

  constructor(private store: Store, private notifier: Notifier, private clock: Clock, readonly clinic?: ClinicProfile) {}

  sweep(): Promise<SweepResult> {
    return withClinic(this.clinic, () => this.sweepInClinic());
  }

  private async sweepInClinic(): Promise<SweepResult> {
    const res: SweepResult = { reminder24: 0, reminder2: 0, followups: 0, reactivations: 0, skipped: 0, errors: [] };
    const now = toLocal(this.clock());
    const upcoming = await this.store.listAppointments({
      from: now.toUTC().toISO()!,
      to: now.plus({ hours: 24 }).toUTC().toISO()!,
      status: ["confirmada", "pendiente"],
    });

    for (const a of upcoming) {
      // Los turnos de ejemplo (datos ficticios) no tienen un teléfono real al que escribir.
      if (a.patientId.startsWith("demo_")) continue;
      // Tras un error de envío se espera 30 min antes de reintentar, para no insistir cada minuto.
      if ((this.failedAt.get(a.id) ?? 0) > Date.now() - 30 * 60_000) continue;
      const start = toLocal(a.start);
      const created = DateTime.fromISO(a.createdAt);
      const hoursLeft = start.diff(now, "hours").hours;
      try {
        if (!a.reminder24Sent && hoursLeft > 2) {
          // Si se reservó con menos de 24 h de anticipación, la confirmación de la reserva ya cumple esa función.
          if (start.diff(created, "hours").hours < 24) {
            await this.store.updateAppointment(a.id, { reminder24Sent: true });
            res.skipped++;
          } else {
            await this.send(a, "reminder24", now);
            res.reminder24++;
          }
        } else if (!a.reminder2Sent && hoursLeft <= 2) {
          if (start.diff(created, "hours").hours < 3) {
            await this.store.updateAppointment(a.id, { reminder2Sent: true, reminder24Sent: true });
            res.skipped++;
          } else {
            await this.send(a, "reminder2", now);
            res.reminder2++;
          }
        }
      } catch (err) {
        this.failedAt.set(a.id, Date.now());
        res.errors.push(`${a.id}: ${(err as Error).message}`);
      }
    }

    res.followups = await this.followups(now, res.errors);
    if (config.reactivation.enabled) res.reactivations = await this.reactivations(res.errors);
    return res;
  }

  /** Envía un recordatorio ya mismo (para la demo y el video). */
  remindNow(appointmentId: string, kind: ReminderKind = "reminder24"): Promise<OutboundMessage | null> {
    return withClinic(this.clinic, async () => {
      const a = await this.store.getAppointment(appointmentId);
      if (!a || !["confirmada", "pendiente"].includes(a.status)) return null;
      return this.send(a, kind, toLocal(this.clock()));
    });
  }

  /**
   * Pacientes que no vuelven: su última visita fue hace `months` meses o más, no tienen
   * turnos próximos y no se les escribió por esto en los últimos 90 días.
   */
  reactivationCandidates(months = config.reactivation.months): Promise<ReactivationCandidate[]> {
    return withClinic(this.clinic, async () => {
      const now = toLocal(this.clock());
      const nowIso = now.toUTC().toISO()!;
      const [patients, appts, convs] = await Promise.all([this.store.listPatients(), this.store.listAppointments(), this.store.listConversations()]);
      const out: ReactivationCandidate[] = [];
      for (const p of patients) {
        if (p.channel === "test") continue;
        const mine = appts.filter((a) => a.patientId === p.id);
        if (mine.some((a) => a.start >= nowIso && ["confirmada", "pendiente"].includes(a.status))) continue;
        const visits = mine.filter((a) => a.start < nowIso && (a.status === "asistio" || a.status === "confirmada"));
        const last = visits.at(-1);
        if (!last) continue;
        const monthsAgo = Math.floor(now.diff(toLocal(last.start), "months").months);
        if (monthsAgo < months) continue;
        const conv = convs.find((c) => c.patientId === p.id);
        const lastInvitation = conv ? [...conv.messages].reverse().find((m) => m.meta?.kind === "reactivation")?.at ?? null : null;
        out.push({ patient: p, lastVisit: last.start, lastTreatment: last.treatment, monthsAgo, lastInvitation });
      }
      return out.sort((a, b) => a.lastVisit.localeCompare(b.lastVisit));
    });
  }

  /** Envía ya la invitación a volver a un paciente (botón del panel). */
  reactivateNow(patientId: string): Promise<boolean> {
    return withClinic(this.clinic, async () => {
      const c = (await this.reactivationCandidates(0)).find((x) => x.patient.id === patientId);
      if (!c) return false;
      await this.sendReactivation(c);
      return true;
    });
  }

  private async reactivations(errors: string[]): Promise<number> {
    const recent = this.clock().getTime() - 90 * 86_400_000;
    let sent = 0;
    for (const c of await this.reactivationCandidates()) {
      if (sent >= config.reactivation.maxPerSweep) break;
      if (c.patient.id.startsWith("demo_")) continue; // datos de ejemplo: sin teléfono real
      if (c.lastInvitation && new Date(c.lastInvitation).getTime() > recent) continue;
      if ((this.failedAt.get(c.patient.id) ?? 0) > Date.now() - 30 * 60_000) continue;
      try {
        await this.sendReactivation(c);
        sent++;
      } catch (err) {
        this.failedAt.set(c.patient.id, Date.now());
        errors.push(`reactivación ${c.patient.id}: ${(err as Error).message}`);
      }
    }
    return sent;
  }

  private async sendReactivation(c: ReactivationCandidate) {
    const msg = reactivationMessage(c.patient.name, c.monthsAgo, c.lastTreatment);
    await this.notifier.send(c.patient.channel, c.patient.phone, msg);
    const conv = await this.store.getOrCreateConversation(c.patient, c.patient.channel);
    conv.messages.push({ role: "bot", text: msg.text, at: this.clock().toISOString(), meta: { kind: "reactivation" } });
    conv.privacyShown = true;
    await this.store.saveConversation(conv);
  }

  /** Envía ya el seguimiento de la promo a una conversación (para la demo). */
  followupNow(c: Conversation, channel: Conversation["channel"], userId: string, name: string | null): Promise<void> {
    return withClinic(this.clinic, () => this.sendFollowup(c, channel, userId, name));
  }

  private async send(a: Appointment, kind: ReminderKind, now: DateTime): Promise<OutboundMessage> {
    const patient = await this.store.getPatient(a.patientId);
    if (!patient) throw new Error("paciente no encontrado");
    const conv = await this.store.getOrCreateConversation(patient, patient.channel);
    const msg = reminderMessage(a, kind, now);
    await this.notifier.send(patient.channel, patient.phone, msg);
    conv.messages.push({ role: "bot", text: msg.text, at: this.clock().toISOString(), meta: { kind, appointmentId: a.id } });
    conv.privacyShown = true;
    await this.store.saveConversation(conv);
    await this.store.updateAppointment(a.id, kind === "reminder24" ? { reminder24Sent: true } : { reminder2Sent: true, reminder24Sent: true });
    return msg;
  }

  /**
   * Seguimiento de leads de la promo: escribieron, no agendaron y no volvieron a
   * escribir en `followupAfterHours`. Se envía una sola vez por conversación.
   */
  private async followups(now: DateTime, errors: string[]): Promise<number> {
    const afterH = config.reminders.followupAfterHours;
    let sent = 0;
    for (const c of await this.store.listConversations()) {
      if (c.handedOff || c.messages.some((m) => m.meta?.kind === "followup")) continue;
      const lastPatient = [...c.messages].reverse().find((m) => m.role === "patient");
      if (!lastPatient) continue;
      const idle = now.diff(DateTime.fromISO(lastPatient.at), "hours").hours;
      // Dentro de la ventana: después de `afterH` horas y antes de las 24 h (luego haría falta plantilla).
      if (idle < afterH || idle > 47) continue;
      if (c.patientId.startsWith("demo_") || (this.failedAt.get(c.id) ?? 0) > Date.now() - 30 * 60_000) continue;
      const patient = await this.store.getPatient(c.patientId);
      if (!patient?.source) continue; // solo leads que llegaron por una promoción
      const appts = await this.store.listAppointments({ patientId: patient.id });
      if (appts.length) continue; // ya agendó alguna vez
      try {
        await this.sendFollowup(c, patient.channel, patient.phone, patient.name);
        sent++;
      } catch (err) {
        this.failedAt.set(c.id, Date.now());
        errors.push(`seguimiento ${c.id}: ${(err as Error).message}`);
      }
    }
    return sent;
  }

  private async sendFollowup(c: Conversation, channel: Conversation["channel"], userId: string, name: string | null) {
    const msg = followupMessage(name);
    await this.notifier.send(channel, userId, msg);
    c.messages.push({ role: "bot", text: msg.text, at: this.clock().toISOString(), meta: { kind: "followup" } });
    await this.store.saveConversation(c);
  }
}
