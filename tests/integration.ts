/**
 * Prueba de integración contra los servicios REALES del .env (Supabase + Google Calendar).
 * Reserva → verifica el evento en el calendario → intenta doble reserva → reprograma → cancela.
 * Al final borra todo lo que creó (paciente de prueba y eventos).
 * Uso: npm run test:integration
 */
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { makeExecutor } from "../src/bot/tools.js";
import { createServices } from "../src/services/factory.js";
import { systemClock, toLocal } from "../src/services/time.js";

const s = await createServices();
console.log(`Base: ${s.storeKind} · Agenda: ${s.calendarKind}`);
if (s.storeKind !== "supabase" || s.calendarKind !== "google") {
  console.log("Esta prueba necesita Supabase y Google Calendar configurados (npm run check).");
  process.exit(1);
}

const phoneA = `+549110000${String(Date.now()).slice(-4)}`;
const phoneB = `${phoneA}9`;
async function exec(phone: string) {
  const patient = await s.store.getOrCreatePatient(phone, "test", "prueba-integracion");
  const conversation = await s.store.getOrCreateConversation(patient, "test");
  return makeExecutor({ store: s.store, calendar: s.calendar, clock: systemClock, patient, conversation });
}
const ea = await exec(phoneA);
const eb = await exec(phoneB);
const created: string[] = [];
const step = (m: string) => console.log(`✔ ${m}`);

try {
  // 1. Disponibilidad real
  const from = toLocal(systemClock()).plus({ days: 2 }).toISODate()!;
  const h = (await ea("buscar_horarios_disponibles", { fecha_desde: from, fecha_hasta: from, franja: "cualquiera" })) as any;
  assert.ok(h.horarios.length >= 2, "debe haber al menos 2 horarios libres");
  const [slot1, slot2] = [h.horarios[0].inicio, h.horarios[1].inicio];
  step(`horarios libres el ${from}: ${h.horarios.map((x: any) => x.inicio.slice(11)).join(", ")}`);

  // 2. Reserva + evento en Google
  const r = (await ea("crear_cita", { nombre_completo: "Prueba Integración (demo)", tratamiento: "Consulta", inicio: slot1 })) as any;
  assert.equal(r.ok, true, JSON.stringify(r));
  created.push(r.cita.id);
  const appt = await s.store.getAppointment(r.cita.id);
  assert.ok(appt?.calendarEventId, "la cita debe tener evento en el calendario");
  const day = DateTime.fromISO(slot1, { zone: toLocal(systemClock()).zoneName! });
  let evs = await s.calendar.listEvents(day, day.plus({ minutes: 30 }));
  assert.ok(evs.some((e) => e.id === appt!.calendarEventId), "el evento debe existir en Google Calendar");
  step(`cita creada en Supabase y evento en Google Calendar (${slot1})`);

  // 3. Doble reserva: otro paciente pide el mismo horario
  const d = (await eb("crear_cita", { nombre_completo: "Otro Paciente (demo)", tratamiento: "Consulta", inicio: slot1 })) as any;
  assert.equal(d.ok, false);
  assert.equal(d.error, "horario_ocupado");
  step(`doble reserva rechazada; alternativas: ${d.alternativas.slice(0, 3).map((x: string) => x.slice(11)).join(", ")}`);

  // 4. Reprogramar
  const m = (await ea("reprogramar_cita", { cita_id: r.cita.id, nuevo_inicio: slot2 })) as any;
  assert.equal(m.ok, true, JSON.stringify(m));
  created.push(m.nueva.id);
  evs = await s.calendar.listEvents(day, day.plus({ minutes: 30 }));
  assert.ok(!evs.some((e) => e.id === appt!.calendarEventId), "el evento viejo debe haberse borrado");
  step(`reprogramada a ${slot2}; el horario anterior quedó libre`);

  // 5. Cancelar
  const c = (await ea("cancelar_cita", { cita_id: m.nueva.id, motivo: "prueba" })) as any;
  assert.equal(c.ok, true);
  const nueva = await s.store.getAppointment(m.nueva.id);
  const d2 = DateTime.fromISO(slot2, { zone: day.zoneName! });
  evs = await s.calendar.listEvents(d2, d2.plus({ minutes: 30 }));
  assert.ok(!evs.some((e) => e.id === nueva!.calendarEventId), "el evento cancelado debe haberse borrado");
  step("cancelada; evento eliminado del calendario");

  console.log("\n✅ Integración OK");
} finally {
  // Limpieza: quedan solo los turnos de ejemplo.
  for (const id of created) {
    const a = await s.store.getAppointment(id);
    if (a?.calendarEventId) await s.calendar.deleteEvent(a.calendarEventId);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  await db.from("patients").delete().in("phone", [phoneA, phoneB]); // borra en cascada citas y conversaciones
  console.log("Limpieza hecha.");
}
