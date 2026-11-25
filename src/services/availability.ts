import { DateTime } from "luxon";
import { currentClinic } from "../clinics/context.js";
import type { Professional, Treatment } from "../clinics/types.js";
import { kb } from "../data/knowledge.js";
import type { CalendarService, Franja } from "./calendar.js";
import type { Appointment, ProfessionalException, Store } from "./store.js";
import { localKey, parseLocal, slotMinutes, toLocal, TZ, type Clock } from "./time.js";

/**
 * Disponibilidad POR PROFESIONAL. Un horario está libre para un profesional si:
 * 1. cae dentro de su horario semanal y del horario de atención de la clínica;
 * 2. no lo toca ninguna excepción (día, franja o vacaciones);
 * 3. no se superpone con otro turno activo suyo, con la duración del tratamiento;
 * 4. si usa Google Calendar, tampoco con un evento de su calendario.
 * El modelo nunca inventa horarios: todos salen de acá.
 */

export interface SlotOption {
  /** Inicio, hora local YYYY-MM-DDTHH:mm */
  inicio: string;
  professionalId: string;
  professional: string;
  minutes: number;
}

export interface SlotQuery {
  fromDate: string;
  toDate: string;
  franja: Franja;
  treatment?: string | null;
  specialty?: string | null;
  /** Id del profesional, o "cualquiera"/vacío = el primero disponible. */
  professionalId?: string | null;
  limit?: number;
}

type Interval = readonly [DateTime, DateTime];

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
export const treatmentIdOf = (t: Treatment) => t.id ?? norm(t.name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Busca un tratamiento del conocimiento por id o por nombre (tolerante a variantes). */
export function findTreatment(q?: string | null): Treatment | null {
  if (!q) return null;
  const list = kb().treatments;
  const t = norm(q);
  const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 4);
  return list.find((x) => x.id === q || norm(x.name) === t)
    ?? list.find((x) => t.includes(norm(x.name).split(" (")[0]!) || norm(x.name).split(" (")[0]!.includes(t))
    ?? list.find((x) => words(x.name).some((w) => words(q).includes(w)))
    ?? null;
}

/**
 * Profesionales activos de la clínica actual. Si una clínica todavía no cargó
 * profesionales, se usa uno «virtual» con el horario de la clínica (compatibilidad).
 */
export function activeProfessionals(): Professional[] {
  const list = (currentClinic().professionals ?? []).filter((p) => p.active);
  if (list.length) return list;
  const k = kb();
  return [{
    id: "clinica", name: k.name, specialty: "Odontología general", color: "#25d366", hours: k.hours,
    treatments: k.treatments.map((t) => ({ id: treatmentIdOf(t), minutes: slotMinutes() })), calendar: "google", active: true,
  }];
}

/** Especialidades que se pueden agendar (las de los tratamientos que hace algún profesional). */
export function specialtiesList(): string[] {
  const done = new Set(activeProfessionals().flatMap((p) => p.treatments.map((t) => t.id)));
  const out = kb().treatments.filter((t) => done.has(treatmentIdOf(t))).map((t) => t.specialty ?? "Odontología general");
  return [...new Set(out)];
}

/**
 * Quiénes pueden atender: el profesional pedido; si no, los que hacen el tratamiento;
 * si no, los de la especialidad; y si no se sabe qué necesita (por ejemplo, la promo),
 * los de odontología general.
 */
export function candidatesFor(o: { treatment?: string | null; specialty?: string | null; professionalId?: string | null }): Professional[] {
  const list = activeProfessionals();
  if (o.professionalId && o.professionalId !== "cualquiera") return list.filter((p) => p.id === o.professionalId);
  const t = findTreatment(o.treatment);
  if (t) {
    const doing = list.filter((p) => p.treatments.some((x) => x.id === treatmentIdOf(t)));
    if (doing.length) return doing;
  }
  if (o.specialty) {
    const s = norm(o.specialty);
    const ids = new Set(kb().treatments.filter((x) => norm(x.specialty ?? "") === s).map(treatmentIdOf));
    const bySpecialty = list.filter((p) => norm(p.specialty).includes(s) || p.treatments.some((x) => ids.has(x.id)));
    if (bySpecialty.length) return bySpecialty;
  }
  const general = list.filter((p) => /general/i.test(p.specialty));
  return general.length ? general : list;
}

/** Minutos que le lleva el tratamiento a ese profesional (si no lo tiene cargado, la duración base de la clínica). */
export function minutesFor(p: Professional, treatment?: string | null): number {
  const t = findTreatment(treatment);
  return (t && p.treatments.find((x) => x.id === treatmentIdOf(t))?.minutes) || slotMinutes();
}

export const professionalById = (id: string | null | undefined) => activeProfessionals().find((p) => p.id === id) ?? (currentClinic().professionals ?? []).find((p) => p.id === id) ?? null;

const ACTIVE = new Set(["confirmada", "pendiente"]);

/** Intervalos de una excepción en un día (vacío si no lo toca). */
export function exceptionWindows(exs: ProfessionalException[], professionalId: string, day: DateTime): Interval[] {
  const d = day.toISODate()!;
  return exs
    .filter((e) => e.professionalId === professionalId && e.fromDate <= d && e.toDate >= d)
    .map((e) => e.kind === "franja" && e.fromTime && e.toTime
      ? [parseLocal(`${d}T${e.fromTime}`), parseLocal(`${d}T${e.toTime}`)] as const
      : [day.startOf("day"), day.endOf("day")] as const);
}

/** ¿El turno [start, end) cae dentro de alguna excepción? Devuelve la excepción. */
export function exceptionHit(exs: ProfessionalException[], professionalId: string, start: DateTime, end: DateTime): ProfessionalException | null {
  const d = start.toISODate()!;
  for (const e of exs.filter((x) => x.professionalId === professionalId && x.fromDate <= d && x.toDate >= d)) {
    const [a, b]: DateTime[] = e.kind === "franja" && e.fromTime && e.toTime
      ? [parseLocal(`${d}T${e.fromTime}`), parseLocal(`${d}T${e.toTime}`)]
      : [start.startOf("day"), start.endOf("day")];
    if (start < b && end > a) return e;
  }
  return null;
}

/** Bloques de atención del profesional en un día: su horario ∩ el horario de la clínica. */
export function professionalBlocks(p: Professional, day: DateTime): Interval[] {
  const at = (hm: string) => parseLocal(`${day.toISODate()}T${hm}`);
  const clinic = kb().hours.find((x) => x.weekday === day.weekday)?.blocks ?? [];
  const own = p.hours.find((x) => x.weekday === day.weekday)?.blocks ?? [];
  const out: Interval[] = [];
  for (const [a1, b1] of own) for (const [a2, b2] of clinic) {
    const a = DateTime.max(at(a1), at(a2));
    const b = DateTime.min(at(b1), at(b2));
    if (a < b) out.push([a, b]);
  }
  return out;
}

export class Availability {
  constructor(private cal: CalendarService, private clock: Clock, private store: Store) {}

  /** Mínimo de anticipación para reservar (1 hora). */
  private earliest(): DateTime {
    return toLocal(this.clock()).plus({ hours: 1 });
  }

  /** Ocupado del profesional entre `from` y `to`: sus turnos activos y, si usa Google, su calendario. */
  private async busy(p: Professional, from: DateTime, to: DateTime, appts?: Appointment[], excludeId?: string): Promise<Interval[]> {
    const list = appts ?? await this.store.listAppointments({ from: from.minus({ hours: 4 }).toUTC().toISO()!, to: to.toUTC().toISO()! });
    const out: Interval[] = list
      .filter((a) => ACTIVE.has(a.status) && a.id !== excludeId && (a.professionalId === p.id || (!a.professionalId && p.calendar === "google")))
      .map((a) => [DateTime.fromISO(a.start), DateTime.fromISO(a.end)] as const);
    if (p.calendar === "google") {
      const own = new Set(list.filter((a) => a.id === excludeId).map((a) => a.calendarEventId).filter(Boolean));
      for (const e of await this.cal.listEvents(from, to)) {
        if (own.has(e.id)) continue;
        // En su calendario: los eventos sin profesional (cargados a mano) y los suyos.
        if (e.tags?.professional && e.tags.professional !== p.id) continue;
        out.push([DateTime.fromISO(e.start), DateTime.fromISO(e.end)]);
      }
    }
    return out;
  }

  /** Horarios libres. Con «el primero disponible», cada hora aparece una vez con el primer profesional libre. */
  async freeSlots(q: SlotQuery): Promise<SlotOption[]> {
    const limit = q.limit ?? 6;
    const cands = candidatesFor({ treatment: q.treatment, specialty: q.specialty, professionalId: q.professionalId });
    if (!cands.length) return [];
    const step = slotMinutes();
    const today: DateTime = toLocal(this.clock()).startOf("day");
    let day: DateTime = DateTime.fromISO(q.fromDate, { zone: TZ() }).startOf("day");
    if (!day.isValid || day < today) day = today;
    let lastDay: DateTime = DateTime.fromISO(q.toDate, { zone: TZ() }).startOf("day");
    if (!lastDay.isValid || lastDay < day) lastDay = day.plus({ days: 6 });
    const maxDay: DateTime = DateTime.min(lastDay, day.plus({ days: 30 }));

    const [exs, appts] = await Promise.all([
      this.store.listExceptions(),
      this.store.listAppointments({ from: day.minus({ hours: 4 }).toUTC().toISO()!, to: maxDay.endOf("day").toUTC().toISO()! }),
    ]);
    const busyBy = new Map<string, Interval[]>();
    for (const p of cands) busyBy.set(p.id, await this.busy(p, day, maxDay.endOf("day"), appts));
    const earliest = this.earliest();
    const out: SlotOption[] = [];

    for (let d = day; d <= maxDay && out.length < limit; d = d.plus({ days: 1 })) {
      const byTime = new Map<string, SlotOption>();
      for (const p of cands) {
        const minutes = minutesFor(p, q.treatment);
        const blocked = [...busyBy.get(p.id)!, ...exceptionWindows(exs, p.id, d)];
        for (const [a, b] of professionalBlocks(p, d)) {
          for (let s = a; s.plus({ minutes }) <= b; s = s.plus({ minutes: step })) {
            if (s < earliest) continue;
            if (q.franja === "manana" && s.hour >= 13) continue;
            if (q.franja === "tarde" && s.hour < 13) continue;
            const e = s.plus({ minutes });
            if (blocked.some(([bs, be]) => s < be && e > bs)) continue;
            const key = localKey(s);
            if (!byTime.has(key)) byTime.set(key, { inicio: key, professionalId: p.id, professional: p.name, minutes });
          }
        }
      }
      out.push(...[...byTime.values()].sort((x, y) => x.inicio.localeCompare(y.inicio)));
    }
    return out.slice(0, limit);
  }

  /** Motivo por el que el profesional no puede atender en `start`, o null si puede. */
  async validate(start: DateTime, p: Professional, minutes: number, excludeId?: string): Promise<string | null> {
    if (!start.isValid) return "fecha_invalida";
    if (start < this.earliest()) return "horario_pasado_o_muy_proximo";
    const end = start.plus({ minutes });
    if (exceptionHit(await this.store.listExceptions(), p.id, start, end)) return "profesional_no_atiende";
    if (!professionalBlocks(p, start.startOf("day")).some(([a, b]) => start >= a && end <= b)) return "fuera_de_horario";
    const busy = await this.busy(p, start.startOf("day"), start.endOf("day"), undefined, excludeId);
    if (busy.some(([bs, be]) => start < be && end > bs)) return "horario_ocupado";
    return null;
  }

  /** El primer profesional (de los que pueden hacer el tratamiento) libre en `start`. */
  async pick(start: DateTime, treatment?: string | null, specialty?: string | null, excludeId?: string): Promise<Professional | null> {
    for (const p of candidatesFor({ treatment, specialty })) {
      if (!(await this.validate(start, p, minutesFor(p, treatment), excludeId))) return p;
    }
    return null;
  }
}
