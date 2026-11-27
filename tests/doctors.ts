/**
 * Pruebas de la etapa multidoctores, en memoria:
 * - doble reserva POR PROFESIONAL (dos doctores a la misma hora sí; el mismo con turnos superpuestos, no);
 * - «el primero disponible» elige el horario más temprano entre los profesionales;
 * - duración propia por tratamiento y horario semanal por profesional;
 * - excepciones (día, franja, vacaciones): bloquean horarios, listan los turnos afectados y
 *   el aviso por el bot permite reprogramar;
 * - flujo del chat: especialidad → profesional (si hay más de uno) → día y horario;
 * - lista de espera respetando el profesional pedido; edición de profesionales desde el panel.
 * Uso: npm run test:doctors
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { MockProvider } from "../src/llm/mock.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore, SlotTakenError } from "../src/services/store.js";
import { demoClinics, CLINIC_A } from "../src/data/clinics/index.js";
import { demoUsers } from "../src/data/clinics/users.js";
import { buildRuntimes } from "../src/clinics/registry.js";
import { MemoryAuth } from "../src/auth.js";
import { createPanelRouter } from "../src/panel.js";
import { Availability, candidatesFor } from "../src/services/availability.js";
import { withClinic } from "../src/clinics/context.js";
import { parseLocal } from "../src/services/time.js";
import type { Services } from "../src/services/factory.js";

const clock = () => new Date("2026-11-23T14:15:00Z"); // lunes 10:15 en La Paz
const store = new InMemoryStore(clock);
const calendar = new InMemoryCalendar();
const services: Services = { store, calendar, storeKind: "memoria", calendarKind: "memoria" };
const runtimes = buildRuntimes({ services, clinics: demoClinics(), provider: new MockProvider(), clock });
const A = runtimes.get(CLINIC_A)!;
const avail = () => new Availability(A.calendar, clock, A.store);
const inA = <T>(fn: () => Promise<T>) => withClinic(A.profile, fn);
const at = (local: string) => parseLocal(local).toUTC().toISO()!;

for (const u of demoUsers) process.env[u.passwordVar] = `prueba-${u.passwordVar.toLowerCase()}`;
const auth = new MemoryAuth();
const app = express();
app.use(express.json());
app.use("/api/panel", createPanelRouter({ auth, runtimes, clock, storeFor: (_u, id) => store.forClinic(id) }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/panel`;
const cookieOf = async (email: string) => {
  const u = demoUsers.find((x) => x.email === email)!;
  return (await auth.login(email, process.env[u.passwordVar]!, false))!.setCookie!.split(";")[0]!;
};
const admin = await cookieOf("admin@sonrisaclara.demo.test");
const recep = await cookieOf("recepcion@sonrisaclara.demo.test");
const call = async (method: string, p: string, cookie: string, body?: unknown) => {
  const r = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}clinic=${CLINIC_A}`, {
    method, headers: { cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const say = (userId: string, text: string) => A.bot.handle({ channel: "web", userId, text });
const book = async (phone: string, treatment: string, professionalId: string, startLocal: string, minutes: number) => {
  const p = await A.store.getOrCreatePatient(phone, "web");
  return A.store.createAppointment({
    patientId: p.id, patientName: phone, treatment, professionalId, start: at(startLocal), end: parseLocal(startLocal).plus({ minutes }).toUTC().toISO()!,
    status: "confirmada", calendarEventId: "", confirmedByPatient: false, reminder24Sent: false, reminder2Sent: false,
  });
};

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}

try {
  // ---------------- Doble reserva por profesional ----------------
  await check("Doble reserva: dos profesionales a la misma hora sí; el mismo con turnos superpuestos de distinta duración, no", async () => {
    await book("web:dr-1", "Limpieza dental (profilaxis)", "prof-mendez", "2026-11-25T15:00", 30);
    await book("web:dr-2", "Blanqueamiento en consultorio", "prof-paredes", "2026-11-25T15:00", 60); // misma hora, otra doctora
    // Paredes: blanqueamiento 15:00–16:00; una limpieza de 45 min a las 15:30 se superpone aunque no empiece igual.
    await assert.rejects(book("web:dr-3", "Limpieza dental (profilaxis)", "prof-paredes", "2026-11-25T15:30", 45), SlotTakenError);
    await book("web:dr-3", "Limpieza dental (profilaxis)", "prof-paredes", "2026-11-25T16:00", 45); // justo al terminar: sí
  });

  await check("Doble reserva desde la herramienta: el horario ocupado de ese profesional se rechaza con alternativas", async () => {
    await inA(async () => {
      const { makeExecutor } = await import("../src/bot/tools.js");
      const patient = await A.store.getOrCreatePatient("web:dr-4", "web");
      const conversation = await A.store.getOrCreateConversation(patient, "web");
      const exec = makeExecutor({ store: A.store, calendar: A.calendar, clock, patient, conversation });
      const r = (await exec("crear_cita", { nombre_completo: "Rita Paz", tratamiento: "Blanqueamiento en consultorio", inicio: "2026-11-25T15:30", profesional_id: "prof-paredes" })) as any;
      assert.equal(r.ok, false);
      assert.equal(r.error, "horario_ocupado");
      assert.ok(r.alternativas.length > 0 && r.alternativas.every((x: any) => x.profesional_id === "prof-paredes"));
    });
  });

  // ---------------- Primero disponible ----------------
  await check("«El primero disponible»: cada hora aparece una vez, con el primer profesional libre", async () => {
    // Miércoles 25/11 a la tarde: Méndez ocupada a las 15:00 → la limpieza de las 15:00 la ofrece... nadie (Paredes también ocupada).
    const slots = await inA(() => avail().freeSlots({ fromDate: "2026-11-25", toDate: "2026-11-25", franja: "tarde", treatment: "Limpieza dental (profilaxis)", professionalId: "cualquiera", limit: 20 }));
    const times = slots.map((s) => s.inicio);
    assert.equal(new Set(times).size, times.length, "sin horas repetidas");
    assert.ok(!times.includes("2026-11-25T15:00"), "las 15:00 están ocupadas para las dos");
    assert.equal(slots.find((s) => s.inicio === "2026-11-25T14:00")?.professionalId, "prof-mendez", "a las 14:00 la primera libre es Méndez");
  });

  await check("«El primero disponible» elige al otro profesional si el primero está ocupado (y usa su duración)", async () => {
    await book("web:dr-5", "Consulta y diagnóstico", "prof-mendez", "2026-11-23T16:00", 30); // lunes 16:00 Méndez ocupada
    const slots = await inA(() => avail().freeSlots({ fromDate: "2026-11-23", toDate: "2026-11-23", franja: "tarde", treatment: "Limpieza dental (profilaxis)", limit: 20 }));
    const s16 = slots.find((s) => s.inicio === "2026-11-23T16:00");
    assert.equal(s16?.professionalId, "prof-paredes");
    assert.equal(s16?.minutes, 45, "Paredes tarda 45 min en una limpieza");
    const p = await inA(() => avail().pick(parseLocal("2026-11-23T16:00"), "Limpieza dental (profilaxis)"));
    assert.equal(p?.id, "prof-paredes");
  });

  await check("Horario por profesional: Ríos (ortodoncia) solo martes y jueves; Paredes solo por la tarde", async () => {
    const ort = await inA(() => avail().freeSlots({ fromDate: "2026-11-23", toDate: "2026-11-28", franja: "cualquiera", treatment: "Consulta de ortodoncia", limit: 200 }));
    assert.ok(ort.length > 0 && ort.every((s) => [2, 4].includes(parseLocal(s.inicio).weekday) && s.professionalId === "prof-rios"));
    const est = await inA(() => avail().freeSlots({ fromDate: "2026-11-23", toDate: "2026-11-28", franja: "cualquiera", treatment: "Blanqueamiento en consultorio", limit: 200 }));
    assert.ok(est.length > 0 && est.every((s) => parseLocal(s.inicio).hour >= 14 && [1, 3, 5].includes(parseLocal(s.inicio).weekday)));
    assert.deepEqual(await inA(async () => candidatesFor({ treatment: "Limpieza dental (profilaxis)" }).map((p) => p.id)), ["prof-mendez", "prof-paredes"]);
  });

  // ---------------- Excepciones ----------------
  let excId = "";
  await check("Excepción de día completo: lista los turnos afectados y bloquea esos horarios", async () => {
    await book("web:exc-1", "Consulta y diagnóstico", "prof-mendez", "2026-11-27T10:00", 30);
    await book("web:exc-2", "Arreglo de caries (resina)", "prof-mendez", "2026-11-27T15:00", 30);
    await book("web:exc-3", "Blanqueamiento en consultorio", "prof-paredes", "2026-11-27T15:00", 60); // otra doctora: no afectada
    const r = await call("POST", "/exceptions", recep, { professionalId: "prof-mendez", kind: "dia", fromDate: "2026-11-27", reason: "Congreso" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    excId = r.json.exception.id;
    assert.deepEqual(r.json.affected.map((a: any) => a.start).sort(), [at("2026-11-27T10:00"), at("2026-11-27T15:00")].sort());
    const slots = await inA(() => avail().freeSlots({ fromDate: "2026-11-27", toDate: "2026-11-27", franja: "cualquiera", professionalId: "prof-mendez" }));
    assert.equal(slots.length, 0, "ese día no se ofrecen horarios de Méndez");
    const err = await inA(async () => avail().validate(parseLocal("2026-11-27T11:00"), A.profile.professionals[0]!, 30));
    assert.equal(err, "profesional_no_atiende");
    const anyone = await inA(() => avail().freeSlots({ fromDate: "2026-11-27", toDate: "2026-11-27", franja: "tarde", treatment: "Limpieza dental (profilaxis)" }));
    assert.ok(anyone.length > 0 && anyone.every((s) => s.professionalId === "prof-paredes"), "la limpieza la puede hacer Paredes");
  });

  await check("Aviso por el bot: los afectados reciben el pedido de reprogramación con botones", async () => {
    const r = await call("POST", `/exceptions/${excId}/notify`, recep);
    assert.equal(r.status, 200);
    assert.equal(r.json.sent, 2);
    const p = (await A.store.listPatients()).find((x) => x.phone === "web:exc-1")!;
    const c = (await A.store.listConversations()).find((x) => x.patientId === p.id)!;
    const last = c.messages.at(-1)!;
    assert.equal(last.meta?.kind, "reschedule_request");
    assert.deepEqual(last.options, ["Reprogramar", "Cancelar turno"]);
    assert.match(last.text, /Dra\. Laura Méndez no podrá atender/);
    const list = await call("GET", "/professionals", recep);
    assert.ok(list.json.exceptions.find((e: any) => e.id === excId).notifiedAt);
  });

  await check("El paciente toca «Reprogramar»: se le ofrecen horarios fuera de la excepción y se mueve el turno", async () => {
    const r1 = await say("web:exc-1", "Reprogramar");
    assert.ok(r1.toolCalls.some((t) => t.name === "buscar_horarios_disponibles"));
    const offered = r1.messages.join("\n").split("\n").filter((l) => /^[1-4]️⃣/.test(l));
    assert.ok(offered.length > 0 && offered.every((l) => !l.includes("27/11") && !/vie 27/i.test(l)), "no ofrece el día de la excepción");
    const r2 = await say("web:exc-1", "1");
    assert.match(r2.messages.join(" "), /Listo/);
    const p = (await A.store.listPatients()).find((x) => x.phone === "web:exc-1")!;
    const appts = await A.store.listAppointments({ patientId: p.id });
    assert.ok(appts.some((a) => a.status === "reprogramada"));
    const active = appts.find((a) => a.status === "confirmada")!;
    assert.ok(!active.start.startsWith("2026-11-27") || active.professionalId !== "prof-mendez");
  });

  await check("Excepción por franja: solo bloquea esa franja; vacaciones: bloquean el rango", async () => {
    await call("POST", "/exceptions", recep, { professionalId: "prof-rios", kind: "franja", fromDate: "2026-12-01", fromTime: "09:00", toTime: "11:00", reason: "Trámite" });
    const ort = await inA(() => avail().freeSlots({ fromDate: "2026-12-01", toDate: "2026-12-01", franja: "cualquiera", treatment: "Consulta de ortodoncia", limit: 50 }));
    assert.ok(ort.length > 0 && ort.every((s) => s.inicio >= "2026-12-01T11:00"));
    const bad = await call("POST", "/exceptions", recep, { professionalId: "prof-rios", kind: "franja", fromDate: "2026-12-01", fromTime: "11:00", toTime: "10:00", reason: "x" });
    assert.equal(bad.status, 400);
    await call("POST", "/exceptions", recep, { professionalId: "prof-paredes", kind: "rango", fromDate: "2026-12-07", toDate: "2026-12-11", reason: "Vacaciones" });
    const est = await inA(() => avail().freeSlots({ fromDate: "2026-12-07", toDate: "2026-12-11", franja: "cualquiera", treatment: "Blanqueamiento en consultorio" }));
    assert.equal(est.length, 0);
  });

  // ---------------- Flujo del chat ----------------
  await check("Chat: especialidad → profesional (con «el primero disponible») → horario → reserva con ese profesional", async () => {
    const r1 = await say("web:flujo-1", "Quiero sacar un turno");
    assert.match(r1.messages.join(" "), /especialidad/);
    assert.match(r1.messages.join(" "), /Ortodoncia/);
    const r2 = await say("web:flujo-1", "Odontología general");
    assert.match(r2.messages.join(" "), /Con quién/);
    assert.match(r2.messages.join(" "), /El primero disponible/);
    const r3 = await say("web:flujo-1", "El primero disponible");
    assert.match(r3.messages.join(" "), /1️⃣/);
    await say("web:flujo-1", "1");
    const r5 = await say("web:flujo-1", "Ana Ruiz");
    assert.match(r5.messages.join(" "), /Listo/);
    assert.match(r5.messages.join(" "), /Dra\./, "la confirmación dice con quién es");
    const p = (await A.store.listPatients()).find((x) => x.phone === "web:flujo-1")!;
    const a = (await A.store.listAppointments({ patientId: p.id }))[0]!;
    assert.ok(a.professionalId);
  });

  await check("Chat: con un solo profesional para la especialidad no pregunta con quién", async () => {
    await say("web:flujo-2", "Quiero sacar un turno");
    const r = await say("web:flujo-2", "Ortodoncia");
    assert.doesNotMatch(r.messages.join(" "), /Con quién/);
    assert.match(r.messages.join(" "), /Dr\. Martín Ríos/);
  });

  await check("Chat: una pregunta al pasar mientras elige profesional u horario se responde y las opciones siguen valiendo", async () => {
    await say("web:flujo-3", "Quiero un turno de limpieza");
    const q1 = await say("web:flujo-3", "¿Dónde quedan?");
    assert.match(q1.messages.join(" "), /📍/);
    const r = await say("web:flujo-3", "2"); // sigue eligiendo profesional
    assert.match(r.messages.join(" "), /horarios libres/);
    const q2 = await say("web:flujo-3", "¿Aceptan tarjeta?");
    assert.doesNotMatch(q2.messages.join(" "), /no identifiqué/);
    const pick = await say("web:flujo-3", "1"); // y después el horario
    assert.match(pick.messages.join(" "), /nombre y apellido/);
  });

  await check("Chat: con día y franja pedidos, igual pregunta especialidad/profesional y después respeta ese día", async () => {
    const q = await say("web:flujo-4", "Quiero sacar un turno para mañana a la mañana");
    assert.match(q.messages.join(" "), /especialidad/, "primero pregunta la especialidad, no asigna un profesional");
    let r = await say("web:flujo-4", "1");
    if (/Con quién prefiere/.test(r.messages.join(" "))) r = await say("web:flujo-4", "1");
    const text = r.messages.join(" ");
    assert.match(text, /horarios libres/);
    for (const h of text.match(/\b\d\d:\d\d\b/g) ?? []) assert.ok(h < "13:00", `franja de la mañana: ${h}`);
  });

  // ---------------- Lista de espera por profesional ----------------
  await check("Lista de espera: quien espera a un profesional no recibe el hueco de otro", async () => {
    const p = await A.store.getOrCreatePatient("web:espera-ríos", "web");
    await A.store.addWaitlist({ patientId: p.id, patientName: "Lía Soto", treatment: "Limpieza dental (profilaxis)", fromDate: "2026-11-30", toDate: "2026-12-04", franja: "cualquiera", professionalId: "prof-paredes" });
    const offeredMendez = await A.waitlist.onSlotFreed("2026-11-30T09:00", "prof-mendez");
    assert.equal(offeredMendez, null, "Paredes no atiende los lunes a la mañana y la paciente la pidió a ella");
    const offeredParedes = await A.waitlist.onSlotFreed("2026-11-30T14:00", "prof-paredes");
    assert.equal(offeredParedes?.patientName, "Lía Soto");
  });

  // ---------------- Panel: profesionales y agenda ----------------
  await check("Panel: el admin edita el horario de un profesional y rige al instante; recepción no puede", async () => {
    const list = await call("GET", "/professionals", admin);
    const rios = list.json.professionals.find((p: any) => p.id === "prof-rios");
    assert.equal((await call("PUT", "/professionals/prof-rios", recep, rios)).status, 403);
    const r = await call("PUT", "/professionals/prof-rios", admin, { ...rios, hours: [{ weekday: 3, blocks: [["09:00", "12:00"]] }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ort = await inA(() => avail().freeSlots({ fromDate: "2026-11-30", toDate: "2026-12-05", franja: "cualquiera", treatment: "Consulta de ortodoncia", limit: 200 }));
    assert.ok(ort.length > 0 && ort.every((s) => parseLocal(s.inicio).weekday === 3 && parseLocal(s.inicio).hour < 12));
    const twoGoogle = await call("PUT", "/professionals/prof-rios", admin, { ...rios, calendar: "google" });
    assert.equal(twoGoogle.status, 400, "solo uno usa Google Calendar");
    const newProf = await call("PUT", "/professionals/prof-nuevo", admin, { name: "Dr. Nuevo Prueba", specialty: "Odontología general", color: "#123456", calendar: "interno", hours: [], treatments: [{ id: "consulta", minutes: 20 }] });
    assert.equal(newProf.status, 200);
    assert.ok(A.profile.professionals.some((p) => p.id === "prof-nuevo"));
  });

  await check("Agenda: devuelve los profesionales, las excepciones y el profesional de cada turno (vista del día)", async () => {
    const r = await call("GET", "/agenda?days=1&from=2026-11-27", recep);
    assert.equal(r.json.days, 1);
    assert.ok(r.json.professionals.length >= 3);
    assert.ok(r.json.exceptions.some((e: any) => e.professionalId === "prof-mendez"));
    assert.ok(r.json.appointments.every((a: any) => "professionalId" in a));
    assert.ok(r.json.appointments.some((a: any) => a.professional === "Dra. Sofía Paredes"));
  });
} finally {
  server.close();
}

const ok = results.filter(([, p]) => p).length;
for (const [name, passed] of results) if (passed) console.log(`  ✅ ${name}`);
console.log(`\n${ok === results.length ? "✅" : "❌"} ${ok}/${results.length} OK`);
process.exit(ok === results.length ? 0 : 1);
