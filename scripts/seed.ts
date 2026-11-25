/**
 * Carga los datos de ejemplo FICTICIOS de las dos clínicas (30 días).
 * - Supabase: guarda las clínicas (perfil + conocimiento) en `clinics` y reemplaza los
 *   datos de ejemplo (ids demo_…): pacientes, conversaciones, turnos pasados y próximos,
 *   cancelaciones, derivaciones, lista de espera, pacientes para reactivar y métricas
 *   simuladas. Los datos reales (WhatsApp, pruebas) no se tocan.
 * - Google Calendar: borra los eventos de ejemplo anteriores (demo=seed) y crea los horarios
 *   ocupados del profesional que usa Google y sus turnos de ejemplo próximos (el resto usa la agenda interna).
 * - Sube el documento de ejemplo (indicaciones después del tratamiento) a la clínica A.
 * Sin Supabase no hace nada: en memoria todo se carga solo al iniciar el servidor.
 * Uso: npm run seed                      → clínicas + 30 días de ejemplo
 *      npm run seed -- --sin-ejemplos    → solo las clínicas (producción): no carga datos ficticios
 */
import { seedCalendar } from "../src/data/seed.js";
import { createServices } from "../src/services/factory.js";
import { systemClock, toLocal } from "../src/services/time.js";
import { demoClinics, CLINIC_A } from "../src/data/clinics/index.js";
import { clinicToRow } from "../src/clinics/registry.js";
import { withClinic } from "../src/clinics/context.js";
import { ClinicCalendar } from "../src/services/calendar.js";
import { loadDemoSupabase, loadExampleDocument } from "../src/data/loadDemo.js";
import type { GoogleCalendarService } from "../src/services/googleCalendar.js";
import type { SupabaseStore } from "../src/services/supabaseStore.js";

const s = await createServices();
console.log(`Base: ${s.storeKind} · Agenda: ${s.calendarKind}`);
if (s.storeKind !== "supabase") {
  console.log("Sin Supabase: en memoria los 30 días de ejemplo se cargan solos al iniciar el servidor (npm run dev).");
  process.exit(0);
}
const db = (s.store as SupabaseStore).client;
const clinics = demoClinics();
const now = systemClock();

const r = await db.from("clinics").upsert(clinics.map(clinicToRow));
if (r.error) throw new Error(`clínicas: ${r.error.message}`);
console.log(`Clínicas guardadas: ${clinics.map((c) => c.name).join(" · ")}`);

// Profesionales de cada clínica (horario, tratamientos con duración y calendario).
const pr = await db.from("professionals").upsert(clinics.flatMap((c) => c.professionals.map((p) => ({
  id: p.id, clinic_id: c.id, name: p.name, specialty: p.specialty, color: p.color, hours: p.hours, treatments: p.treatments, calendar: p.calendar, active: p.active,
}))), { onConflict: "clinic_id,id" });
if (pr.error) throw new Error(`profesionales: ${pr.error.message}. ¿Ejecutó supabase/schema.sql?`);
console.log(`Profesionales guardados: ${clinics.map((c) => `${c.name}: ${c.professionals.length}`).join(" · ")}`);

if (process.argv.includes("--sin-ejemplos")) {
  console.log("Solo clínicas (--sin-ejemplos): no se cargaron datos de ejemplo.");
  process.exit(0);
}

const google = s.calendarKind === "google" ? (s.calendar as GoogleCalendarService) : null;
if (google) {
  const today = toLocal(now).startOf("day");
  console.log(`Eventos de ejemplo anteriores borrados: ${await google.deleteSeedEvents(today.minus({ days: 14 }), today.plus({ days: 45 }))}`);
}

for (const c of clinics) {
  const cal = google ? new ClinicCalendar(google, c) : null;
  const busy = cal ? await withClinic(c, () => seedCalendar(cal, systemClock, c.primary ? "a" : "b")) : 0;
  const d = await loadDemoSupabase(db, cal, c, now);
  const future = d.appointments.filter((a) => ["confirmada", "pendiente"].includes(a.status) && new Date(a.start) > now).length;
  console.log(`${c.name}: ${d.patients.length} pacientes · ${d.conversations.length} conversaciones · ${d.appointments.length} turnos (${future} próximos) · ` +
    `${d.handoffs.length} derivaciones · ${d.waitlist.length} en lista de espera · ${d.metrics.length} métricas${cal ? ` · ${busy} horarios ocupados en el calendario` : ""}`);
}

// Documento de ejemplo para la búsqueda (clínica A), si todavía no está.
const loaded = await loadExampleDocument(s.store.forClinic(CLINIC_A));
if (loaded) console.log(`Documento de ejemplo cargado: ${loaded}`);
console.log("Listo.");
