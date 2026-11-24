import { DateTime } from "luxon";
import { kb } from "../data/knowledge.js";
import { localKey, parseLocal, slotMinutes, toLocal, TZ, type Clock } from "./time.js";

export interface CalendarEvent {
  id: string;
  start: string; // ISO con zona
  end: string;
  summary: string;
  description?: string;
  /** Clínica dueña del evento (etiqueta privada `clinic`); vacío = evento cargado a mano en el calendario. */
  clinic?: string;
  /** Metadatos privados del evento. */
  tags?: Record<string, string>;
}

/**
 * Agenda del consultorio. En la etapa 1 hay una versión en memoria;
 * en la etapa 2 se suma la de Google Calendar con la misma interfaz.
 */
export interface CalendarService {
  listEvents(from: DateTime, to: DateTime): Promise<CalendarEvent[]>;
  /** `tags` = metadatos privados del evento (p. ej. { demo: "seed" } para los de ejemplo). */
  createEvent(ev: Omit<CalendarEvent, "id">, tags?: Record<string, string>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}

export class InMemoryCalendar implements CalendarService {
  private events = new Map<string, CalendarEvent>();
  private seq = 0;

  async listEvents(from: DateTime, to: DateTime) {
    return [...this.events.values()].filter(
      (e) => DateTime.fromISO(e.end) > from && DateTime.fromISO(e.start) < to,
    );
  }
  async createEvent(ev: Omit<CalendarEvent, "id">, tags: Record<string, string> = {}) {
    const e: CalendarEvent = { ...ev, id: `ev_${++this.seq}`, clinic: tags.clinic ?? ev.clinic, tags };
    this.events.set(e.id, e);
    return e;
  }
  async deleteEvent(id: string) {
    this.events.delete(id);
  }
}

/**
 * Vista de UNA clínica sobre un calendario compartido (multiempresa).
 * - Cada evento que crea lleva la etiqueta `clinic` y el color de la clínica.
 * - La clínica principal ve como ocupados sus eventos y los que no tienen etiqueta
 *   (cargados a mano en el calendario); las demás ven solo los suyos.
 */
export class ClinicCalendar implements CalendarService {
  constructor(
    readonly base: CalendarService,
    private clinic: { calendarTag: string; primary: boolean; calendarColor: string },
  ) {}

  private visible(e: CalendarEvent): boolean {
    return e.clinic ? e.clinic === this.clinic.calendarTag : this.clinic.primary;
  }
  async listEvents(from: DateTime, to: DateTime) {
    return (await this.base.listEvents(from, to)).filter((e) => this.visible(e));
  }
  async createEvent(ev: Omit<CalendarEvent, "id">, tags: Record<string, string> = {}) {
    return this.base.createEvent(ev, { ...tags, clinic: this.clinic.calendarTag, color: tags.demo === "seed" ? "8" : this.clinic.calendarColor });
  }
  async deleteEvent(id: string) {
    await this.base.deleteEvent(id);
  }
}

export type Franja = "manana" | "tarde" | "cualquiera";

/** Horarios de atención de un día como intervalos locales. */
function openBlocks(day: DateTime): Array<[DateTime, DateTime]> {
  const h = kb().hours.find((x) => x.weekday === day.weekday);
  if (!h) return [];
  return h.blocks.map(([a, b]) => [
    parseLocal(`${day.toISODate()}T${a}`),
    parseLocal(`${day.toISODate()}T${b}`),
  ]);
}

/** ¿El turno [start, start+slot) cae completo dentro del horario de atención? */
export function withinOpeningHours(start: DateTime): boolean {
  const end = start.plus({ minutes: slotMinutes() });
  return openBlocks(start.startOf("day")).some(([a, b]) => start >= a && end <= b);
}

/**
 * Lógica de disponibilidad sobre cualquier CalendarService.
 * Toda la disponibilidad sale del calendario real: el modelo nunca la inventa.
 */
export class Availability {
  constructor(private cal: CalendarService, private clock: Clock) {}

  /** Mínimo de anticipación para reservar (1 hora). */
  private earliest(): DateTime {
    return toLocal(this.clock()).plus({ hours: 1 });
  }

  async freeSlots(fromDate: string, toDate: string, franja: Franja, limit = 6): Promise<string[]> {
    const slot = slotMinutes();
    const today: DateTime = toLocal(this.clock()).startOf("day");
    let day: DateTime = DateTime.fromISO(fromDate, { zone: TZ() }).startOf("day");
    if (!day.isValid || day < today) day = today;
    let lastDay: DateTime = DateTime.fromISO(toDate, { zone: TZ() }).startOf("day");
    if (!lastDay.isValid || lastDay < day) lastDay = day.plus({ days: 6 });
    const maxDay: DateTime = DateTime.min(lastDay, day.plus({ days: 30 }));

    const busy = await this.cal.listEvents(day, maxDay.endOf("day"));
    const busyIv = busy.map((e) => [DateTime.fromISO(e.start), DateTime.fromISO(e.end)] as const);
    const out: string[] = [];
    const earliest = this.earliest();

    for (let d = day; d <= maxDay && out.length < limit; d = d.plus({ days: 1 })) {
      for (const [a, b] of openBlocks(d)) {
        for (let s = a; s.plus({ minutes: slot }) <= b; s = s.plus({ minutes: slot })) {
          if (s < earliest) continue;
          if (franja === "manana" && s.hour >= 13) continue;
          if (franja === "tarde" && s.hour < 13) continue;
          const e = s.plus({ minutes: slot });
          if (busyIv.some(([bs, be]) => s < be && e > bs)) continue;
          out.push(localKey(s));
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async isFree(start: DateTime): Promise<boolean> {
    const end = start.plus({ minutes: slotMinutes() });
    const evs = await this.cal.listEvents(start, end);
    return evs.length === 0;
  }

  /** Motivo por el que un horario no se puede reservar, o null si se puede. */
  async validate(start: DateTime): Promise<string | null> {
    if (!start.isValid) return "fecha_invalida";
    if (start < this.earliest()) return "horario_pasado_o_muy_proximo";
    if (!withinOpeningHours(start)) return "fuera_de_horario";
    if (!(await this.isFree(start))) return "horario_ocupado";
    return null;
  }
}
