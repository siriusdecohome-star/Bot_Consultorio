/**
 * Prueba de integración contra los servicios REALES del .env (Supabase + Google Calendar).
 * Reserva → verifica el evento en el calendario → intenta doble reserva → reprograma → cancela.
 * Multiempresa: la misma hora en la otra clínica sí se puede reservar, y con la sesión de una
 * recepcionista la base (RLS) no deja leer ni escribir datos de otra clínica ni ver costos.
 * Requiere haber corrido npm run seed y npm run seed:users.
 * Al final borra todo lo que creó (pacientes de prueba y eventos).
 * Uso: npm run test:integration
 */
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { makeExecutor } from "../src/bot/tools.js";
import { createServices } from "../src/services/factory.js";
import { systemClock, toLocal } from "../src/services/time.js";
import { createClient } from "@supabase/supabase-js";
import { config } from "../src/config.js";
import { loadClinics } from "../src/clinics/registry.js";
import { setDefaultClinic } from "../src/clinics/context.js";
import { ClinicCalendar } from "../src/services/calendar.js";
import { CLINIC_A, CLINIC_B } from "../src/data/clinics/index.js";
import { demoUsers } from "../src/data/clinics/users.js";

const s = await createServices();
console.log(`Base: ${s.storeKind} · Agenda: ${s.calendarKind}`);
if (s.storeKind !== "supabase" || s.calendarKind !== "google") {
  console.log("Esta prueba necesita Supabase y Google Calendar configurados (npm run check).");
  process.exit(1);
}

const clinics = await loadClinics(s);
const clinicA = clinics.find((c) => c.id === CLINIC_A)!;
setDefaultClinic(clinicA);
const store = s.store.forClinic(CLINIC_A);
const storeB = s.store.forClinic(CLINIC_B);
const calendar = new ClinicCalendar(s.calendar, clinicA);

const phoneA = `+549110000${String(Date.now()).slice(-4)}`;
const phoneB = `${phoneA}9`;
async function exec(phone: string) {
  const patient = await store.getOrCreatePatient(phone, "test", "prueba-integracion");
  const conversation = await store.getOrCreateConversation(patient, "test");
  return makeExecutor({ store, calendar, clock: systemClock, patient, conversation });
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
  const appt = await store.getAppointment(r.cita.id);
  assert.ok(appt?.calendarEventId, "la cita debe tener evento en el calendario");
  const day = DateTime.fromISO(slot1, { zone: toLocal(systemClock()).zoneName! });
  let evs = await calendar.listEvents(day, day.plus({ minutes: 30 }));
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
  evs = await calendar.listEvents(day, day.plus({ minutes: 30 }));
  assert.ok(!evs.some((e) => e.id === appt!.calendarEventId), "el evento viejo debe haberse borrado");
  step(`reprogramada a ${slot2}; el horario anterior quedó libre`);

  // 5. Cancelar
  const c = (await ea("cancelar_cita", { cita_id: m.nueva.id, motivo: "prueba" })) as any;
  assert.equal(c.ok, true);
  const nueva = await store.getAppointment(m.nueva.id);
  const d2 = DateTime.fromISO(slot2, { zone: day.zoneName! });
  evs = await calendar.listEvents(d2, d2.plus({ minutes: 30 }));
  assert.ok(!evs.some((e) => e.id === nueva!.calendarEventId), "el evento cancelado debe haberse borrado");
  step("cancelada; evento eliminado del calendario");

  // 6. Índice de doble reserva por clínica: la misma hora en la clínica B se acepta
  const pB = await storeB.getOrCreatePatient(phoneA, "test", "prueba-integracion");
  const sameHour = { patientName: "Prueba B", treatment: "Consulta", professionalId: appt!.professionalId ?? "prof-mendez", start: appt!.start, end: appt!.end, status: "confirmada" as const,
    calendarEventId: "", confirmedByPatient: false, reminder24Sent: false, reminder2Sent: false };
  const tA = await store.createAppointment({ ...sameHour, patientId: (await store.getOrCreatePatient(phoneA, "test")).id });
  const tB = await storeB.createAppointment({ ...sameHour, patientId: pB.id });
  assert.ok(tA.id && tB.id);
  await assert.rejects(store.createAppointment({ ...sameHour, patientId: tA.patientId }), /horario_ocupado/);
  step("misma hora: aceptada en A y en B; rechazada la segunda vez en A (índice por clínica)");

  // 7. RLS con la sesión de la recepcionista de A
  const rec = demoUsers.find((u) => u.email.startsWith("recepcion@sonrisaclara"))!;
  const password = process.env[rec.passwordVar];
  assert.ok(password && config.supabase.publishableKey, "faltan la contraseña de prueba (npm run seed:users) o SUPABASE_PUBLISHABLE_KEY");
  const pub = createClient(config.supabase.url, config.supabase.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: login, error: loginErr } = await pub.auth.signInWithPassword({ email: rec.email, password });
  assert.ok(login.session, `login de la recepcionista: ${loginErr?.message}`);
  const asRec = createClient(config.supabase.url, config.supabase.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${login.session!.access_token}` } },
  });
  const ownA = await asRec.from("appointments").select("id").eq("id", tA.id);
  assert.equal(ownA.data?.length, 1, "debe ver los turnos de su clínica");
  for (const t of ["patients", "appointments", "conversations"]) {
    const r = await asRec.from(t).select("id").eq("clinic_id", CLINIC_B);
    assert.equal(r.data?.length ?? 0, 0, `no debe ver ${t} de la clínica B`);
  }
  const ins = await asRec.from("patients").insert({ id: `rls_${Date.now()}`, clinic_id: CLINIC_B, phone: "+0", channel: "test" });
  assert.ok(ins.error, "no debe poder crear pacientes en la clínica B");
  const upd = await asRec.from("clinics").update({ name: "Cambio no autorizado" }).eq("id", CLINIC_A).select("id");
  assert.equal(upd.data?.length ?? 0, 0, "recepción no debe editar la configuración de la clínica");
  const costs = await asRec.from("turn_metrics").select("id").limit(1);
  assert.equal(costs.data?.length ?? 0, 0, "recepción no debe ver costos");
  const otherClinic = await asRec.from("clinics").select("id");
  assert.deepEqual(otherClinic.data?.map((c: any) => c.id), [CLINIC_A], "solo ve su clínica");
  // RLS sobre documentos: recepción los lee pero no puede subirlos
  const docIns = await asRec.from("documents").insert({ id: `rls_doc_${Date.now()}`, clinic_id: CLINIC_A, name: "x", mime: "text/plain", size_bytes: 1 });
  assert.ok(docIns.error, "recepción no debe poder subir documentos");
  await pub.auth.signOut();

  // 8. Documentos: búsqueda de texto en PostgreSQL (tsvector en español + función search_document_chunks)
  const doc = await store.addDocument({ name: "prueba-integracion.txt", mime: "text/plain", sizeBytes: 100 }, [
    "Después de un blanqueamiento evite café, té y vino tinto durante 48 horas.",
    "El consultorio tiene ascensor y estacionamiento medido en la cuadra.",
  ]);
  try {
    const hits = await store.searchDocuments("¿Puedo tomar café después del blanqueamiento?");
    assert.ok(hits[0]?.content.includes("café"), `la búsqueda debe encontrar el fragmento: ${JSON.stringify(hits)}`);
    assert.equal((await storeB.searchDocuments("blanqueamiento café")).length, 0, "la clínica B no ve los documentos de A");
    step("documentos: la búsqueda de texto de Postgres encuentra el fragmento y no cruza clínicas");
  } finally {
    await store.deleteDocument(doc.id);
  }
  step("RLS: la recepcionista de A ve su clínica y no puede leer ni escribir la B, ni editar la configuración, ni ver costos");

  console.log("\n✅ Integración OK");
} finally {
  // Limpieza: quedan solo los turnos de ejemplo.
  for (const id of created) {
    const a = await store.getAppointment(id);
    if (a?.calendarEventId) await s.calendar.deleteEvent(a.calendarEventId);
  }
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  await db.from("patients").delete().in("phone", [phoneA, phoneB]); // borra en cascada citas y conversaciones (en las dos clínicas)
  console.log("Limpieza hecha.");
}
