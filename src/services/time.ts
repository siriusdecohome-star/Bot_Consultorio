import { DateTime } from "luxon";
import { currentClinic } from "../clinics/context.js";
import "../data/clinics/default.js";

/** Reloj inyectable: las pruebas fijan "ahora" para que los resultados sean reproducibles. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Zona horaria de la clínica actual. */
export const TZ = () => currentClinic().timezone;
/** Duración del turno de la clínica actual, en minutos. */
export const slotMinutes = () => currentClinic().slotMinutes;

/** "2026-11-24T10:30" (hora local del consultorio) → DateTime */
export function parseLocal(iso: string): DateTime {
  return DateTime.fromISO(iso, { zone: TZ() });
}

export function toLocal(d: Date | string): DateTime {
  return (typeof d === "string" ? DateTime.fromISO(d) : DateTime.fromJSDate(d)).setZone(TZ());
}

/** "martes 24/11 a las 10:30" */
export function human(dt: DateTime): string {
  return dt.setLocale("es").toFormat("cccc dd/MM 'a las' HH:mm");
}

/** Formato local sin zona, el que usan las herramientas: "2026-11-24T10:30" */
export function localKey(dt: DateTime): string {
  return dt.setZone(TZ()).toFormat("yyyy-MM-dd'T'HH:mm");
}
