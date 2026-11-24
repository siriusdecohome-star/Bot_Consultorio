import { DateTime } from "luxon";
import type { CalendarService } from "../services/calendar.js";
import { toLocal, TZ, type Clock } from "../services/time.js";

/**
 * Datos de ejemplo FICTICIOS: ocupa algunos horarios de los próximos días
 * para que la agenda se vea realista y existan casos de "horario ocupado".
 */
/** Clínica B: otros horarios ocupados, dentro de su horario de atención. */
const BUSY_B: Array<[number, string, string]> = [
  [0, "09:00", "Consulta general — Paciente demo J"],
  [1, "08:30", "Odontopediatría — Paciente demo K"],
  [1, "10:00", "Limpieza — Paciente demo L"],
  [1, "15:30", "Endodoncia — Paciente demo M"],
  [1, "16:00", "Endodoncia — Paciente demo M"],
  [2, "11:00", "Sellantes — Paciente demo N"],
  [3, "17:30", "Consulta general — Paciente demo O"],
];

/** `plan` "a" = clínica principal; "b" = la segunda clínica de ejemplo. Devuelve cuántos eventos creó. */
export async function seedCalendar(cal: CalendarService, clock: Clock, plan: "a" | "b" = "a"): Promise<number> {
  const today = toLocal(clock()).startOf("day");
  const busyA: Array<[number, string, string]> = [
    // [días desde hoy, hora, resumen]
    [0, "10:00", "Control — Paciente demo A"],
    [1, "09:00", "Limpieza — Paciente demo B"],
    [1, "09:30", "Arreglo de caries — Paciente demo C"],
    [1, "11:00", "Ortodoncia — Paciente demo D"],
    [1, "16:00", "Blanqueamiento — Paciente demo E"],
    [1, "16:30", "Blanqueamiento — Paciente demo E"],
    [2, "10:30", "Extracción — Paciente demo F"],
    [2, "15:00", "Consulta — Paciente demo G"],
    [3, "09:00", "Limpieza — Paciente demo H"],
    [3, "14:00", "Implantes — Paciente demo I"],
  ];
  const busy = plan === "a" ? busyA : BUSY_B;
  for (const [d, hm, summary] of busy) {
    const start = DateTime.fromISO(`${today.plus({ days: d }).toISODate()}T${hm}`, { zone: TZ() });
    await cal.createEvent({
      start: start.toISO()!,
      end: start.plus({ minutes: 30 }).toISO()!,
      summary,
      description: "Turno de ejemplo (datos ficticios).",
    }, { demo: "seed" });
  }
  return busy.length;
}
