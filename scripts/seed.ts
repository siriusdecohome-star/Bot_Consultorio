/**
 * Carga turnos de ejemplo FICTICIOS en el calendario configurado.
 * - Borra los eventos de ejemplo anteriores (marcados demo=seed).
 * - Crea horarios ocupados de ejemplo para los próximos días.
 * - Si hay Supabase, crea en el calendario los eventos de los turnos demo de seed.sql.
 * Uso: npm run seed
 */
import { DateTime } from "luxon";
import { seedCalendar } from "../src/data/seed.js";
import { createServices } from "../src/services/factory.js";
import { systemClock, toLocal } from "../src/services/time.js";
import type { GoogleCalendarService } from "../src/services/googleCalendar.js";

const s = await createServices();
console.log(`Base: ${s.storeKind} · Agenda: ${s.calendarKind}`);
if (s.calendarKind === "memoria") {
  console.log("No hay Google Calendar configurado: la agenda en memoria se carga sola al iniciar. Nada que hacer.");
  process.exit(0);
}

const cal = s.calendar as GoogleCalendarService;
const today = toLocal(systemClock()).startOf("day");
const removed = await cal.deleteSeedEvents(today.minus({ days: 14 }), today.plus({ days: 45 }));
console.log(`Eventos de ejemplo anteriores borrados: ${removed}`);

await seedCalendar(cal, systemClock);
console.log("Horarios ocupados de ejemplo creados: 10");

if (s.storeKind === "supabase") {
  const demo = (await s.store.listAppointments({ status: ["confirmada", "pendiente"] })).filter((a) => a.id.startsWith("demo_"));
  for (const a of demo) {
    const ev = await cal.createEvent({
      start: DateTime.fromISO(a.start).toISO()!,
      end: DateTime.fromISO(a.end).toISO()!,
      summary: `${a.treatment} — ${a.patientName}`,
      description: `Id de cita: ${a.id}\nTurno de ejemplo (datos ficticios).`,
    }, { demo: "seed" });
    await s.store.updateAppointment(a.id, { calendarEventId: ev.id });
  }
  console.log(`Turnos demo de la base sincronizados con el calendario: ${demo.length}`);
}
console.log("Listo.");
