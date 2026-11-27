/**
 * Pruebas de la lista de espera y la reactivación (punto 4), en memoria:
 * anotarse desde el chat, ofrecer el hueco al cancelar, aceptar, rechazar, vencer,
 * horario tomado mientras tanto, cancelación desde el panel y pacientes que no vuelven.
 * Uso: npm run test:waitlist
 */
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { MockProvider } from "../src/llm/mock.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore } from "../src/services/store.js";
import { WebOutbox } from "../src/services/notifier.js";
import { demoClinics, CLINIC_A } from "../src/data/clinics/index.js";
import { buildRuntimes } from "../src/clinics/registry.js";
import type { Services } from "../src/services/factory.js";

let now = new Date("2026-11-23T14:15:00Z"); // lunes 10:15 en La Paz
const clock = () => now;
const store = new InMemoryStore(clock);
const services: Services = { store, calendar: new InMemoryCalendar(), storeKind: "memoria", calendarKind: "memoria" };
const outbox = new WebOutbox();
const runtimes = buildRuntimes({ services, clinics: demoClinics(), provider: new MockProvider(), clock, outbox });
const A = runtimes.get(CLINIC_A)!;
const box = (user: string) => outbox.take(`${CLINIC_A}|${user}`);
const say = (user: string, text: string) => A.bot.handle({ channel: "web", userId: user, text });
const settle = () => new Promise((r) => setTimeout(r, 50));
const WED_10 = "2026-11-25T10:00";

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}
async function book(user: string, name: string, when = "el miércoles a las 10:00") {
  let q = await say(user, `Quiero sacar un turno para ${when}`);
  // Especialidad y profesional: la opción 1 (Odontología general).
  for (let i = 0; i < 2 && /especialidad|con quién prefiere/i.test(q.messages.at(-1) ?? ""); i++) q = await say(user, "1");
  const r = await say(user, name);
  assert.match(r.messages.join(" "), /Listo/, `no se pudo reservar para ${name}`);
}
async function addWaiting(user: string, name: string) {
  const p = await A.store.getOrCreatePatient(user, "web");
  await A.store.updatePatient(p.id, { name });
  return A.store.addWaitlist({ patientId: p.id, patientName: name, treatment: "Limpieza dental", fromDate: "2026-11-25", toDate: "2026-11-25", franja: "manana" });
}
const entry = async (id: string) => (await A.store.listWaitlist()).find((e) => e.id === id)!;

await check("Anotarse desde el chat: el bot pide el nombre y guarda rango y franja", async () => {
  await say("web:wanda", "Quiero un turno para el miércoles a la mañana");
  let r = await say("web:wanda", "Anóteme en la lista de espera");
  assert.match(r.messages.join(" "), /nombre y apellido/);
  r = await say("web:wanda", "Wanda Ruiz");
  assert.match(r.messages.join(" "), /lista de espera/);
  const w = (await A.store.listWaitlist(["esperando"])).find((e) => e.patientName === "Wanda Ruiz");
  assert.ok(w, "debe quedar anotada");
  assert.equal(w!.fromDate, "2026-11-25");
  assert.equal(w!.franja, "manana");
  await A.store.updateWaitlist(w!.id, { status: "cancelado" }); // no interfiere con las pruebas siguientes
});

await check("Al cancelar un turno, el hueco se ofrece por el chat a quien espera (con botones)", async () => {
  await book("web:ana", "Ana Pérez");
  const w = await addWaiting("web:bruno", "Bruno Díaz");
  const r = await say("web:ana", "Quiero cancelar mi turno");
  assert.match(r.messages.join(" "), /cancelé/);
  await settle();
  const offer = box("web:bruno");
  assert.equal(offer.length, 1, "Bruno debe recibir la oferta");
  assert.match(offer[0]!.text, /Se liberó un turno/);
  assert.deepEqual(offer[0]!.buttons, ["✅ Lo tomo", "No, gracias"]);
  const e = await entry(w.id);
  assert.equal(e.status, "ofrecido");
  assert.equal(e.offeredSlot, WED_10);
});

await check("«Lo tomo»: se reserva el horario ofrecido y la entrada queda aceptada", async () => {
  const r = await say("web:bruno", "✅ Lo tomo");
  assert.match(r.messages.join(" "), /Le reservé el turno/);
  const p = await A.store.getOrCreatePatient("web:bruno", "web");
  const appts = await A.store.listAppointments({ patientId: p.id, status: ["confirmada"] });
  assert.equal(appts.length, 1);
  assert.equal(DateTime.fromISO(appts[0]!.start).setZone("America/La_Paz").toFormat("yyyy-MM-dd'T'HH:mm"), WED_10);
  assert.ok((await A.store.listWaitlist(["aceptado"])).some((e) => e.patientId === p.id));
});

await check("«No, gracias»: la oferta pasa a la siguiente persona de la lista", async () => {
  const c1 = await addWaiting("web:carla", "Carla Gómez");
  const c2 = await addWaiting("web:dario", "Darío López");
  await say("web:bruno", "Necesito cancelar el turno");
  await settle();
  assert.equal(box("web:carla").length, 1, "primero se le ofrece a Carla (se anotó antes)");
  assert.equal(box("web:dario").length, 0);
  const r = await say("web:carla", "No, gracias");
  assert.match(r.messages.join(" "), /Sigue en la lista de espera/);
  await settle();
  assert.equal(box("web:dario").length, 1, "ahora se le ofrece a Darío");
  const e1 = await entry(c1.id);
  assert.equal(e1.status, "esperando");
  assert.ok(e1.declinedSlots.includes(WED_10));
  assert.equal((await entry(c2.id)).status, "ofrecido");
});

await check("Oferta vencida sin respuesta: pasa a la siguiente y la anterior no puede aceptarla", async () => {
  const e3 = await addWaiting("web:elena", "Elena Paz");
  now = new Date(now.getTime() + 31 * 60_000);
  const expired = await A.waitlist.sweep();
  assert.equal(expired, 1);
  await settle();
  assert.equal(box("web:elena").length, 1, "Elena recibe la oferta que venció para Darío");
  const r = await say("web:dario", "Lo tomo");
  assert.match(r.messages.join(" "), /venció/);
  assert.equal((await entry(e3.id)).status, "ofrecido");
});

await check("Si el horario se ocupó antes de aceptar, se avisa y sigue en espera", async () => {
  await book("web:fede", "Federico Sosa"); // toma el 10:00 que estaba ofrecido a Elena
  const r = await say("web:elena", "Lo tomo");
  assert.match(r.messages.join(" "), /se ocupó/);
  const e = (await A.store.listWaitlist()).find((x) => x.patientName === "Elena Paz")!;
  assert.equal(e.status, "esperando");
});

await check("Cancelar desde el panel también ofrece el hueco a la lista", async () => {
  const fede = await A.store.getOrCreatePatient("web:fede", "web");
  const appt = (await A.store.listAppointments({ patientId: fede.id, status: ["confirmada"] }))[0]!;
  await A.store.updateAppointment(appt.id, { status: "cancelada" });
  await A.calendar.deleteEvent(appt.calendarEventId);
  const offered = await A.waitlist.onSlotFreed(WED_10);
  // Carla y Elena ya lo rechazaron/vencieron; Darío lo dejó vencer: no queda nadie para ese horario.
  assert.equal(offered, null);
  const g = await addWaiting("web:gabi", "Gabriela Ríos");
  const again = await A.waitlist.onSlotFreed(WED_10);
  assert.equal(again?.id, g.id);
});

await check("No se ofrece un horario fuera del rango o la franja de la persona", async () => {
  const p = await A.store.getOrCreatePatient("web:hugo", "web");
  await A.store.addWaitlist({ patientId: p.id, patientName: "Hugo", treatment: "Consulta", fromDate: "2026-11-26", toDate: "2026-11-27", franja: "tarde" });
  const offered = await A.waitlist.onSlotFreed("2026-11-26T10:00"); // jueves a la mañana: Hugo quiere tarde
  assert.equal(offered, null);
});

// ---------------- Reactivación ----------------
await check("Reactivación: invita una sola vez a quien no viene hace 6 meses o más", async () => {
  const p = await A.store.getOrCreatePatient("web:ines", "web");
  await A.store.updatePatient(p.id, { name: "Inés Molina" });
  await A.store.createAppointment({ patientId: p.id, patientName: "Inés Molina", treatment: "Limpieza dental", professionalId: "prof-mendez", start: "2026-04-10T13:00:00Z", end: "2026-04-10T13:30:00Z", status: "asistio", calendarEventId: "", confirmedByPatient: true, reminder24Sent: true, reminder2Sent: true });
  const q = await A.store.getOrCreatePatient("web:juan", "web");
  await A.store.createAppointment({ patientId: q.id, patientName: "Juan (demo)", treatment: "Consulta", professionalId: "prof-mendez", start: "2026-03-01T13:00:00Z", end: "2026-03-01T13:30:00Z", status: "asistio", calendarEventId: "", confirmedByPatient: true, reminder24Sent: true, reminder2Sent: true });
  await A.store.createAppointment({ patientId: q.id, patientName: "Juan (demo)", treatment: "Consulta", professionalId: "prof-mendez", start: "2026-12-10T13:00:00Z", end: "2026-12-10T13:30:00Z", status: "confirmada", calendarEventId: "", confirmedByPatient: false, reminder24Sent: false, reminder2Sent: false });
  const cands = await A.reminders.reactivationCandidates();
  assert.ok(cands.some((c) => c.patient.id === p.id && c.monthsAgo >= 7));
  assert.ok(!cands.some((c) => c.patient.id === q.id), "quien ya tiene un turno próximo no se invita");
  const r1 = await A.reminders.sweep();
  assert.equal(r1.reactivations, 1);
  const msg = box("web:ines");
  assert.match(msg[0]!.text, /última visita \(Limpieza dental\)/);
  assert.equal((await A.reminders.sweep()).reactivations, 0, "no se repite");
});

await check("Reactivación: «Más adelante» responde sin IA", async () => {
  const r = await say("web:ines", "Más adelante");
  assert.match(r.messages.join(" "), /Cuando quiera/);
  assert.equal(r.toolCalls.length, 0);
});

const passed = results.filter(([, ok]) => ok).length;
for (const [name, ok] of results) console.log(`  ${ok ? "✅" : "❌"} ${name}`);
console.log(`\n${passed === results.length ? "✅" : "❌"} ${passed}/${results.length} OK`);
process.exitCode = passed === results.length ? 0 : 1;
