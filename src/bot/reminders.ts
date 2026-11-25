import { DateTime } from "luxon";
import { kb } from "../data/knowledge.js";
import type { Notifier, OutboundMessage } from "../services/notifier.js";
import type { Appointment, Conversation, Patient, Store } from "../services/store.js";
import { toLocal, type Clock } from "../services/time.js";
import { currentClinic, withClinic } from "../clinics/context.js";
import type { ClinicProfile, FollowupRule } from "../clinics/types.js";
import { defaultSettings } from "../data/clinics/settings.js";
import { professionalById } from "../services/availability.js";

/**
 * Seguimientos y recordatorios por REGLAS de cada clínica (pestaña Seguimientos del panel):
 * - «antes»: X horas antes del turno; «despues»: X días después de un turno al que asistió;
 * - «reactivacion»: a quien no viene hace X días, repetido cada N días;
 * - «lead»: a quien consultó por la promo y no agendó.
 * Respeta el horario de silencio y no repite avisos: cada regla enviada (u omitida)
 * queda registrada en el turno o en la conversación.
 */

export type ReminderKind = "reminder24" | "reminder2";

export interface SweepResult {
  reminder24: number;
  reminder2: number;
  /** Recordatorios de otras reglas «antes» (72 h, 1 h…). */
  reminders: number;
  postVisits: number;
  followups: number;
  reactivations: number;
  skipped: number;
  /** La revisión cayó en el horario de silencio: no se envió nada (se envía al terminar). */
  quiet: boolean;
  errors: string[];
}

const firstName = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] ?? "";
const settings = () => currentClinic().settings ?? defaultSettings();
export const activeRules = (kind: FollowupRule["kind"]) => settings().rules.filter((r) => r.kind === kind && r.active);

/** «hoy, martes 24/11 a las 17:00», «mañana, …» o «jueves 26/11 a las 10:00». */
function whenText(a: Appointment, now: DateTime) {
  const start = toLocal(a.start).setLocale("es");
  const day = start.hasSame(now, "day") ? "hoy" : start.hasSame(now.plus({ days: 1 }), "day") ? "mañana" : null;
  return `${day ? `${day}, ` : ""}${start.toFormat("cccc dd/MM")} a las ${start.toFormat("HH:mm")}`;
}

/** Reemplaza los {campos} del texto. Un campo vacío se quita con lo que lo acompaña («, {nombre}», « con {profesional}»). */
export function renderText(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    if (v) continue;
    out = out.replace(new RegExp(`,\\s*\\{${k}\\}`, "g"), "").replace(new RegExp(` con \\{${k}\\}`, "g"), "").replace(new RegExp(` \\(\\{${k}\\}\\)`, "g"), "");
    out = out.split("\n").filter((line) => !line.includes(`{${k}}`) || line.replace(`{${k}}`, "").trim().length > 3).join("\n");
  }
  return out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

const baseVars = () => ({ clinica: kb().name, direccion: kb().address, promo: kb().promo.name });

function appointmentVars(a: Appointment, now: DateTime): Record<string, string> {
  const start = toLocal(a.start).setLocale("es");
  return {
    ...baseVars(),
    nombre: firstName(a.patientName), cuando: whenText(a, now), fecha: start.toFormat("cccc dd/MM"), hora: start.toFormat("HH:mm"),
    tratamiento: a.treatment, profesional: professionalById(a.professionalId)?.name ?? "", meses: "",
  };
}

/** Mensaje de una regla «antes» o «despues» para un turno. Si ya confirmó, usa el texto sin botones. */
export function ruleMessage(rule: FollowupRule, a: Appointment, now: DateTime): OutboundMessage {
  const vars = appointmentVars(a, now);
  const confirmed = rule.kind === "antes" && a.confirmedByPatient && !!rule.textConfirmed;
  return {
    text: renderText(confirmed ? rule.textConfirmed! : rule.text, vars),
    buttons: confirmed || !rule.buttons.length ? undefined : rule.buttons,
    template: { name: rule.template, params: rule.kind === "despues" ? [vars.nombre || "¡hola", a.treatment] : [vars.nombre || "¡hola", vars.cuando!, a.treatment] },
  };
}

/** Regla «antes» para un recordatorio manual de 24 h o 2 h (la más parecida). */
function ruleForKind(kind: ReminderKind): FollowupRule {
  const all = settings().rules.filter((r) => r.kind === "antes");
  const want = kind === "reminder2" ? 2 : 24;
  return all.find((r) => r.hours === want)
    ?? [...all].sort((x, y) => Math.abs((x.hours ?? 0) - want) - Math.abs((y.hours ?? 0) - want))[0]
    ?? defaultSettings().rules.find((r) => r.hours === want)!;
}

/** Texto del recordatorio de 24 h o 2 h (compatibilidad: demo, script y pruebas). */
export function reminderMessage(a: Appointment, kind: ReminderKind, now: DateTime): OutboundMessage {
  return ruleMessage(ruleForKind(kind), a, now);
}

function simpleMessage(rule: FollowupRule, name: string | null, extra: Record<string, string> = {}): OutboundMessage {
  const n = firstName(name);
  return {
    text: renderText(rule.text, { ...baseVars(), nombre: n, tratamiento: "", profesional: "", cuando: "", fecha: "", hora: "", meses: "", ...extra }),
    buttons: rule.buttons.length ? rule.buttons : undefined,
    template: { name: rule.template, params: [n || "¡hola"] },
  };
}

const leadRule = () => settings().rules.find((r) => r.kind === "lead") ?? defaultSettings().rules.find((r) => r.kind === "lead")!;
const reactivationRule = () => settings().rules.find((r) => r.kind === "reactivacion") ?? defaultSettings().rules.find((r) => r.kind === "reactivacion")!;

export function followupMessage(name: string | null): OutboundMessage {
  return simpleMessage(leadRule(), name);
}

export function reactivationMessage(name: string | null, months: number, lastTreatment: string | null): OutboundMessage {
  return simpleMessage(reactivationRule(), name, { meses: String(months), tratamiento: lastTreatment ?? "" });
}

/** ¿`now` cae en el horario de silencio de la clínica? (admite que cruce la medianoche, p. ej. 21:00–08:00). */
export function inQuietHours(now: DateTime, q = settings().quietHours): boolean {
  if (!q) return false;
  const hm = now.toFormat("HH:mm");
  return q.from <= q.to ? hm >= q.from && hm < q.to : hm >= q.from || hm < q.to;
}

export interface ReactivationCandidate {
  patient: Patient;
  lastVisit: string; // ISO del último turno al que asistió
  lastTreatment: string;
  monthsAgo: number;
  daysAgo: number;
  lastInvitation: string | null;
}

/**
 * Revisa la agenda y envía los avisos que tocan según las reglas. Es idempotente:
 * cada aviso queda marcado y no se repite aunque el proceso se reinicie.
 */
export class ReminderService {
  private failedAt = new Map<string, number>();

  constructor(private store: Store, private notifier: Notifier, private clock: Clock, readonly clinic?: ClinicProfile) {}

  sweep(): Promise<SweepResult> {
    return withClinic(this.clinic, () => this.sweepInClinic());
  }

  private retryLater(key: string) {
    return (this.failedAt.get(key) ?? 0) > Date.now() - 30 * 60_000;
  }

  /** Reglas ya enviadas u omitidas de un turno (incluye las marcas de versiones anteriores). */
  private sentOf(a: Appointment): Set<string> {
    const s = new Set(a.remindersSent ?? []);
    for (const r of settings().rules.filter((x) => x.kind === "antes")) {
      if (a.reminder2Sent) s.add(r.id);
      else if (a.reminder24Sent && (r.hours ?? 0) > 2) s.add(r.id);
    }
    return s;
  }

  private async sweepInClinic(): Promise<SweepResult> {
    const res: SweepResult = { reminder24: 0, reminder2: 0, reminders: 0, postVisits: 0, followups: 0, reactivations: 0, skipped: 0, quiet: false, errors: [] };
    const now = toLocal(this.clock());
    if (inQuietHours(now)) {
      res.quiet = true;
      return res;
    }
    await this.beforeAppointment(now, res);
    await this.afterAppointment(now, res);
    if (activeRules("lead").length) res.followups = await this.followups(now, res.errors);
    if (activeRules("reactivacion").length) res.reactivations = await this.reactivations(res.errors);
    return res;
  }

  /**
   * Reglas «antes»: entre las que ya están en su ventana y no se enviaron, se envía la más
   * cercana al turno y las demás se marcan (no tiene sentido mandar el de 24 h a 2 h del turno).
   * Si el turno se reservó dentro de la ventana de la regla, la confirmación de la reserva
   * ya cumple esa función y se omite.
   */
  private async beforeAppointment(now: DateTime, res: SweepResult) {
    const rules = activeRules("antes").filter((r) => (r.hours ?? 0) > 0);
    if (!rules.length) return;
    const maxH = Math.max(...rules.map((r) => r.hours!));
    const upcoming = await this.store.listAppointments({
      from: now.toUTC().toISO()!, to: now.plus({ hours: maxH }).toUTC().toISO()!, status: ["confirmada", "pendiente"],
    });
    for (const a of upcoming) {
      // Los turnos de ejemplo (datos ficticios) no tienen un teléfono real al que escribir.
      if (a.patientId.startsWith("demo_") || this.retryLater(a.id)) continue;
      const start = toLocal(a.start);
      const hoursLeft = start.diff(now, "hours").hours;
      const sent = this.sentOf(a);
      const due = rules.filter((r) => r.hours! >= hoursLeft && !sent.has(r.id));
      if (!due.length) continue;
      const target = due.reduce((x, y) => (y.hours! < x.hours! ? y : x));
      const bookedAhead = start.diff(DateTime.fromISO(a.createdAt), "hours").hours;
      try {
        if (bookedAhead < target.hours!) res.skipped++;
        else {
          await this.sendRule(target, a, now);
          if (target.hours === 24) res.reminder24++;
          else if (target.hours === 2) res.reminder2++;
          else res.reminders++;
        }
        await this.mark(a, due);
      } catch (err) {
        this.failedAt.set(a.id, Date.now());
        res.errors.push(`${a.id}: ${(err as Error).message}`);
      }
    }
  }

  /** Reglas «despues»: X días después de un turno al que asistió (una vez por turno). */
  private async afterAppointment(now: DateTime, res: SweepResult) {
    for (const rule of activeRules("despues")) {
      const days = rule.days ?? 1;
      const list = await this.store.listAppointments({
        from: now.minus({ days: days + 2 }).toUTC().toISO()!, to: now.minus({ days }).toUTC().toISO()!, status: ["asistio"],
      });
      for (const a of list) {
        if (a.patientId.startsWith("demo_") || this.retryLater(a.id) || this.sentOf(a).has(rule.id)) continue;
        try {
          await this.sendRule(rule, a, now);
          await this.mark(a, [rule]);
          res.postVisits++;
        } catch (err) {
          this.failedAt.set(a.id, Date.now());
          res.errors.push(`${a.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  private async mark(a: Appointment, rules: FollowupRule[]) {
    const sent = [...new Set([...(a.remindersSent ?? []), ...rules.map((r) => r.id)])];
    const before = rules.filter((r) => r.kind === "antes");
    await this.store.updateAppointment(a.id, {
      remindersSent: sent,
      ...(before.some((r) => (r.hours ?? 0) <= 2) ? { reminder2Sent: true, reminder24Sent: true } : {}),
      ...(before.some((r) => (r.hours ?? 0) > 2) ? { reminder24Sent: true } : {}),
    });
  }

  private async sendRule(rule: FollowupRule, a: Appointment, now: DateTime): Promise<OutboundMessage> {
    const patient = await this.store.getPatient(a.patientId);
    if (!patient) throw new Error("paciente no encontrado");
    const conv = await this.store.getOrCreateConversation(patient, patient.channel);
    const msg = ruleMessage(rule, a, now);
    await this.notifier.send(patient.channel, patient.phone, msg);
    const kind = rule.kind === "despues" ? "post_visit" : rule.hours === 24 ? "reminder24" : rule.hours === 2 ? "reminder2" : "reminder";
    conv.messages.push({ role: "bot", text: msg.text, at: this.clock().toISOString(), ...(msg.buttons ? { options: msg.buttons } : {}), meta: { kind, appointmentId: a.id, ruleId: rule.id } });
    conv.privacyShown = true;
    await this.store.saveConversation(conv);
    return msg;
  }

  /** Envía un recordatorio ya mismo (para la demo y el video). */
  remindNow(appointmentId: string, kind: ReminderKind = "reminder24"): Promise<OutboundMessage | null> {
    return withClinic(this.clinic, async () => {
      const a = await this.store.getAppointment(appointmentId);
      if (!a || !["confirmada", "pendiente"].includes(a.status)) return null;
      const rule = ruleForKind(kind);
      const msg = await this.sendRule(rule, a, toLocal(this.clock()));
      await this.mark(a, [rule]);
      return msg;
    });
  }

  /**
   * Pacientes que no vuelven: su última visita fue hace `minDays` días o más y no tienen
   * turnos próximos. (La regla decide cada cuánto se les puede volver a escribir.)
   */
  reactivationCandidates(minDays?: number): Promise<ReactivationCandidate[]> {
    return withClinic(this.clinic, async () => {
      const threshold = minDays ?? reactivationRule().days ?? 180;
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
        const daysAgo = Math.floor(now.diff(toLocal(last.start), "days").days);
        if (daysAgo < threshold) continue;
        const conv = convs.find((c) => c.patientId === p.id);
        const lastInvitation = conv?.messages.findLast((m) => m.meta?.kind === "reactivation")?.at ?? null;
        out.push({ patient: p, lastVisit: last.start, lastTreatment: last.treatment, monthsAgo: Math.floor(now.diff(toLocal(last.start), "months").months), daysAgo, lastInvitation });
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
    const rule = activeRules("reactivacion")[0]!;
    const recent = this.clock().getTime() - (rule.repeatDays ?? 90) * 86_400_000;
    let sent = 0;
    for (const c of await this.reactivationCandidates(rule.days)) {
      if (sent >= 5) break; // como máximo 5 por revisión, para no escribir a todos de golpe
      if (c.patient.id.startsWith("demo_")) continue; // datos de ejemplo: sin teléfono real
      if (c.lastInvitation && new Date(c.lastInvitation).getTime() > recent) continue;
      if (this.retryLater(c.patient.id)) continue;
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
    conv.messages.push({ role: "bot", text: msg.text, at: this.clock().toISOString(), ...(msg.buttons ? { options: msg.buttons } : {}), meta: { kind: "reactivation", ruleId: reactivationRule().id } });
    conv.privacyShown = true;
    await this.store.saveConversation(conv);
  }

  /** Envía ya el seguimiento de la promo a una conversación (para la demo). */
  followupNow(c: Conversation, channel: Conversation["channel"], userId: string, name: string | null): Promise<void> {
    return withClinic(this.clinic, () => this.sendFollowup(c, channel, userId, name));
  }

  /**
   * Seguimiento de leads de la promo: escribieron, no agendaron y no volvieron a
   * escribir en las horas de la regla. Se envía una sola vez por conversación.
   */
  private async followups(now: DateTime, errors: string[]): Promise<number> {
    const afterH = activeRules("lead")[0]!.hours ?? 20;
    let sent = 0;
    for (const c of await this.store.listConversations()) {
      if (c.handedOff || c.botPaused || c.messages.some((m) => m.meta?.kind === "followup")) continue;
      const lastPatient = c.messages.findLast((m) => m.role === "patient");
      if (!lastPatient) continue;
      const idle = now.diff(DateTime.fromISO(lastPatient.at), "hours").hours;
      // Después de las horas de la regla y antes de 47 h (luego ya no tiene sentido).
      if (idle < afterH || idle > 47) continue;
      if (c.patientId.startsWith("demo_") || this.retryLater(c.id)) continue;
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
    c.messages.push({ role: "bot", text: msg.text, at: this.clock().toISOString(), ...(msg.buttons ? { options: msg.buttons } : {}), meta: { kind: "followup", ruleId: leadRule().id } });
    await this.store.saveConversation(c);
  }
}

/**
 * Próximos envíos de las reglas «antes» (vista previa del panel): turnos de los próximos
 * días con la hora en que saldría cada recordatorio que todavía no se envió.
 */
export async function upcomingSends(store: Store, now: Date, limit = 12) {
  const local = toLocal(now);
  const rules = activeRules("antes").filter((r) => (r.hours ?? 0) > 0);
  if (!rules.length) return [];
  const maxH = Math.max(...rules.map((r) => r.hours!));
  const appts = await store.listAppointments({ from: local.toUTC().toISO()!, to: local.plus({ hours: maxH + 48 }).toUTC().toISO()!, status: ["confirmada", "pendiente"] });
  const out: Array<{ at: string; ruleId: string; hours: number; patient: string; start: string; demo: boolean }> = [];
  for (const a of appts) {
    const sent = new Set(a.remindersSent ?? []);
    for (const r of rules) {
      if (sent.has(r.id) || a.reminder2Sent || (a.reminder24Sent && r.hours! > 2)) continue;
      const at = toLocal(a.start).minus({ hours: r.hours! });
      if (at < local) continue;
      if (toLocal(a.start).diff(DateTime.fromISO(a.createdAt), "hours").hours < r.hours!) continue;
      out.push({ at: at.toUTC().toISO()!, ruleId: r.id, hours: r.hours!, patient: a.patientName, start: a.start, demo: a.patientId.startsWith("demo_") });
    }
  }
  return out.sort((x, y) => x.at.localeCompare(y.at)).slice(0, limit);
}
