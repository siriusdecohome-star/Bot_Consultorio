/**
 * Carga los datos de ejemplo FICTICIOS de las dos clínicas.
 * - Supabase: guarda las clínicas (perfil + conocimiento) en `clinics` y reemplaza los
 *   pacientes, turnos y conversaciones de ejemplo (los que tienen id demo_…).
 * - Google Calendar: borra los eventos de ejemplo anteriores (demo=seed) y crea los
 *   horarios ocupados de cada clínica, con su etiqueta, más los turnos de ejemplo.
 * Sin Supabase ni Google no hace nada: en memoria todo se carga solo al iniciar.
 * Uso: npm run seed
 */
import { DateTime } from "luxon";
import { seedCalendar } from "../src/data/seed.js";
import { createServices } from "../src/services/factory.js";
import { systemClock, toLocal } from "../src/services/time.js";
import { demoClinics, CLINIC_A, CLINIC_B } from "../src/data/clinics/index.js";
import { clinicToRow } from "../src/clinics/registry.js";
import { withClinic } from "../src/clinics/context.js";
import { ClinicCalendar } from "../src/services/calendar.js";
import type { GoogleCalendarService } from "../src/services/googleCalendar.js";
import type { SupabaseStore } from "../src/services/supabaseStore.js";

const s = await createServices();
console.log(`Base: ${s.storeKind} · Agenda: ${s.calendarKind}`);
if (s.storeKind === "memoria" && s.calendarKind === "memoria") {
  console.log("No hay Supabase ni Google Calendar configurados: en memoria los datos de ejemplo se cargan solos al iniciar.");
  process.exit(0);
}
const clinics = demoClinics();

// --- Pacientes, turnos y conversaciones de ejemplo (relativos a hoy) ---
type DemoAppt = { id: string; patient: string; name: string; treatment: string; day: number; time: string; status: string; confirmed: boolean };
const DEMO: Record<string, { patients: Array<[string, string, string | null, string, string | null]>; appts: DemoAppt[]; lead: string }> = {
  [CLINIC_A]: {
    patients: [
      ["demo_a_p1", "+5491100001001", "Lucía Fernández (demo)", "whatsapp", "promo-noviembre"],
      ["demo_a_p2", "+5491100001002", "Carlos Gómez (demo)", "whatsapp", "promo-noviembre"],
      ["demo_a_p3", "+5491100001003", "Sofía Martínez (demo)", "web", null],
      ["demo_a_p4", "+5491100001004", "Diego Romero (demo)", "whatsapp", "promo-noviembre"],
      ["demo_a_p5", "+5491100001005", null, "whatsapp", "promo-noviembre"], // lead que no agendó
    ],
    appts: [
      { id: "demo_a_c1", patient: "demo_a_p1", name: "Lucía Fernández (demo)", treatment: "Limpieza + control (Promo)", day: 0, time: "15:00", status: "confirmada", confirmed: true },
      { id: "demo_a_c2", patient: "demo_a_p2", name: "Carlos Gómez (demo)", treatment: "Consulta y diagnóstico", day: 1, time: "12:00", status: "confirmada", confirmed: false },
      { id: "demo_a_c3", patient: "demo_a_p3", name: "Sofía Martínez (demo)", treatment: "Consulta de ortodoncia", day: 2, time: "17:00", status: "confirmada", confirmed: false },
      { id: "demo_a_c4", patient: "demo_a_p4", name: "Diego Romero (demo)", treatment: "Arreglo de caries", day: -1, time: "10:00", status: "cancelada", confirmed: false },
    ],
    lead: "demo_a_p5",
  },
  [CLINIC_B]: {
    patients: [
      ["demo_b_p1", "+59170001001", "Mariana Rojas (demo)", "web", "chequeo-familiar"],
      ["demo_b_p2", "+59170001002", "Jorge Salinas (demo)", "web", null],
      ["demo_b_p3", "+59170001003", null, "web", "chequeo-familiar"], // lead que no agendó
    ],
    appts: [
      { id: "demo_b_c1", patient: "demo_b_p1", name: "Mariana Rojas (demo)", treatment: "Chequeo Familiar (Promo)", day: 0, time: "16:00", status: "confirmada", confirmed: true },
      { id: "demo_b_c2", patient: "demo_b_p2", name: "Jorge Salinas (demo)", treatment: "Tratamiento de conducto", day: 2, time: "09:30", status: "confirmada", confirmed: false },
    ],
    lead: "demo_b_p3",
  },
};

if (s.storeKind === "supabase") {
  const db = (s.store as SupabaseStore).client;
  const must = (r: { error: { message: string } | null }, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
  };
  must(await db.from("clinics").upsert(clinics.map(clinicToRow)), "clínicas");
  console.log(`Clínicas guardadas: ${clinics.map((c) => c.name).join(" · ")}`);
  // Los ejemplos anteriores se borran en cascada con sus pacientes.
  must(await db.from("patients").delete().like("id", "demo_%"), "borrar ejemplos");
  for (const c of clinics) {
    const d = DEMO[c.id]!;
    const today = toLocal(systemClock()).setZone(c.timezone).startOf("day");
    must(await db.from("patients").insert(d.patients.map(([id, phone, name, channel, source]) => ({ id, clinic_id: c.id, phone, name, channel, source }))), "pacientes");
    must(await db.from("appointments").insert(d.appts.map((a) => {
      const start = DateTime.fromISO(`${today.plus({ days: a.day }).toISODate()}T${a.time}`, { zone: c.timezone });
      return {
        id: a.id, clinic_id: c.id, patient_id: a.patient, patient_name: a.name, treatment: a.treatment,
        start_at: start.toUTC().toISO(), end_at: start.plus({ minutes: c.slotMinutes }).toUTC().toISO(),
        status: a.status, confirmed_by_patient: a.confirmed,
      };
    })), "turnos");
    const asked = today.minus({ days: 3 }).set({ hour: 9 }).toUTC();
    must(await db.from("conversations").insert({
      id: `${d.lead}_conv`, clinic_id: c.id, patient_id: d.lead, channel: d.patients.find((p) => p[0] === d.lead)![3],
      llm_provider: "mock", privacy_shown: true,
      messages: [
        { role: "patient", text: `Hola, cuánto sale la ${c.knowledge.promo.name}?`, at: asked.toISO() },
        { role: "bot", text: `${c.knowledge.promo.name}: ${c.knowledge.promo.detail} ¿Le reservo un turno?`, at: asked.plus({ seconds: 2 }).toISO() },
      ],
    }), "conversación de ejemplo");
    console.log(`${c.name}: ${d.patients.length} pacientes y ${d.appts.length} turnos de ejemplo`);
  }
}

if (s.calendarKind === "google") {
  const base = s.calendar as GoogleCalendarService;
  const today = toLocal(systemClock()).startOf("day");
  const removed = await base.deleteSeedEvents(today.minus({ days: 14 }), today.plus({ days: 45 }));
  console.log(`Eventos de ejemplo anteriores borrados: ${removed}`);
  for (const c of clinics) {
    const cal = new ClinicCalendar(base, c);
    const n = await withClinic(c, () => seedCalendar(cal, systemClock, c.primary ? "a" : "b"));
    let synced = 0;
    if (s.storeKind === "supabase") {
      const store = s.store.forClinic(c.id);
      const demo = (await store.listAppointments({ status: ["confirmada", "pendiente"] })).filter((a) => a.id.startsWith("demo_"));
      for (const a of demo) {
        const ev = await cal.createEvent({
          start: DateTime.fromISO(a.start).toISO()!,
          end: DateTime.fromISO(a.end).toISO()!,
          summary: `${a.treatment} — ${a.patientName}`,
          description: `Id de cita: ${a.id}\nTurno de ejemplo (datos ficticios).`,
        }, { demo: "seed" });
        await store.updateAppointment(a.id, { calendarEventId: ev.id });
        synced++;
      }
    }
    console.log(`${c.name}: ${n} horarios ocupados de ejemplo + ${synced} turnos de ejemplo en el calendario (etiqueta clinic=${c.calendarTag})`);
  }
}
console.log("Listo.");
