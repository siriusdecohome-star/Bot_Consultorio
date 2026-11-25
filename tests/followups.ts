/**
 * Pruebas de la etapa de seguimientos (reglas por clínica), en memoria y con reloj simulado:
 * - reglas activadas y desactivadas (72 h, 24 h, 2 h, 1 h antes; después del turno; reactivación; lead);
 * - una sola regla por turno cuando varias caen juntas, sin envíos dobles;
 * - reserva hecha dentro de la ventana de la regla: se omite;
 * - horario de silencio: no se envía nada y sale al terminar;
 * - textos editables con sus campos; edición desde el panel (solo admin, con validación);
 * - duración de la oferta de la lista de espera por clínica.
 * Uso: npm run test:followups
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { DateTime } from "luxon";
import { MockProvider } from "../src/llm/mock.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore } from "../src/services/store.js";
import { WebOutbox } from "../src/services/notifier.js";
import { demoClinics, CLINIC_A } from "../src/data/clinics/index.js";
import { demoUsers } from "../src/data/clinics/users.js";
import { buildRuntimes } from "../src/clinics/registry.js";
import { MemoryAuth } from "../src/auth.js";
import { createPanelRouter } from "../src/panel.js";
import { defaultSettings } from "../src/data/clinics/settings.js";
import type { Services } from "../src/services/factory.js";

const TZ = "America/La_Paz";
let nowMs = DateTime.fromISO("2026-11-23T09:00", { zone: TZ }).toMillis();
const setNow = (local: string) => { nowMs = DateTime.fromISO(local, { zone: TZ }).toMillis(); };
const clock = () => new Date(nowMs);
const store = new InMemoryStore(clock);
const outbox = new WebOutbox();
const services: Services = { store, calendar: new InMemoryCalendar(), storeKind: "memoria", calendarKind: "memoria" };
const runtimes = buildRuntimes({ services, clinics: demoClinics(), provider: new MockProvider(), clock, outbox });
const A = runtimes.get(CLINIC_A)!;
const S = A.profile.settings;
const rule = (id: string) => S.rules.find((r) => r.id === id)!;
const box = (phone: string) => outbox.take(`${CLINIC_A}|${phone}`);

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
  const r = await fetch(`${base}${p}?clinic=${CLINIC_A}`, { method, headers: { cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};

/** Crea un turno «reservado ahora» (el reloj marca la fecha de reserva). */
async function book(phone: string, name: string, startLocal: string, extra: Record<string, unknown> = {}) {
  const p = await A.store.getOrCreatePatient(phone, "web");
  await A.store.updatePatient(p.id, { name });
  const start = DateTime.fromISO(startLocal, { zone: TZ });
  return A.store.createAppointment({
    patientId: p.id, patientName: name, treatment: "Limpieza dental (profilaxis)", professionalId: "prof-mendez",
    start: start.toUTC().toISO()!, end: start.plus({ minutes: 30 }).toUTC().toISO()!, status: "confirmada",
    calendarEventId: "", confirmedByPatient: false, reminder24Sent: false, reminder2Sent: false, ...extra,
  });
}

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}

try {
  S.quietHours = null; // el silencio se prueba aparte

  await check("Regla de 24 h desactivada: no se envía; la de 2 h sigue funcionando", async () => {
    rule("antes-24").active = false;
    setNow("2026-11-23T09:00");
    await book("web:f1", "Ana Paz", "2026-11-26T10:00");
    setNow("2026-11-25T10:05");
    let r = await A.reminders.sweep();
    assert.equal(r.reminder24, 0);
    assert.equal(box("web:f1").length, 0);
    setNow("2026-11-26T08:05");
    r = await A.reminders.sweep();
    assert.equal(r.reminder2, 1);
    assert.match(box("web:f1")[0]!.text, /Su turno es \*hoy, jueves 26\/11 a las 10:00\*/);
    rule("antes-24").active = true;
  });

  await check("Regla de 72 h activada: se envía a las 72 h con el profesional en el texto", async () => {
    rule("antes-72").active = true;
    setNow("2026-11-20T09:00");
    await book("web:f2", "Bruno Díaz", "2026-11-27T11:00");
    setNow("2026-11-24T11:05");
    const r = await A.reminders.sweep();
    assert.equal(r.reminders, 1);
    const m = box("web:f2")[0]!;
    assert.match(m.text, /viernes 27\/11 a las 11:00/);
    assert.match(m.text, /Limpieza dental \(profilaxis\) con Dra\. Laura Méndez/);
    assert.deepEqual(m.buttons, ["✅ Confirmo", "📅 Cambiar horario", "❌ Cancelar"]);
    assert.equal((await A.reminders.sweep()).reminders, 0, "no se repite");
    rule("antes-72").active = false;
  });

  await check("Varias reglas en su ventana: sale solo la más cercana al turno y no se duplica", async () => {
    rule("antes-1").active = true;
    setNow("2026-11-23T09:00");
    const a = await book("web:f3", "Carla Ruiz", "2026-11-25T15:00");
    setNow("2026-11-25T14:20"); // a 40 min: 24 h, 2 h y 1 h están en su ventana y ninguna se envió
    const r = await A.reminders.sweep();
    assert.equal(r.reminders + r.reminder2 + r.reminder24, 1);
    const sent = box("web:f3");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /en una hora es su turno \(15:00\)/);
    const after = await A.store.getAppointment(a.id);
    assert.deepEqual(new Set(after!.remindersSent), new Set(["antes-24", "antes-2", "antes-1"]));
    assert.equal((await A.reminders.sweep()).reminders, 0);
    rule("antes-1").active = false;
  });

  await check("Reserva dentro de la ventana: se omite (la confirmación de la reserva ya cumple)", async () => {
    setNow("2026-11-24T16:00");
    await book("web:f4", "Diego Sosa", "2026-11-25T09:00"); // 17 h antes: dentro de la ventana de 24 h
    setNow("2026-11-24T16:05");
    const r = await A.reminders.sweep();
    assert.equal(r.reminder24, 0);
    assert.ok(r.skipped >= 1);
    assert.equal(box("web:f4").length, 0);
  });

  await check("Horario de silencio: a las 22:00 no sale nada; al terminar (08:00) sí", async () => {
    S.quietHours = { from: "21:00", to: "08:00" };
    setNow("2026-11-23T09:00");
    await book("web:f5", "Elena Vera", "2026-11-28T09:30");
    setNow("2026-11-27T22:00"); // 11,5 h antes: el de 24 h está en su ventana, pero es horario de silencio
    let r = await A.reminders.sweep();
    assert.equal(r.quiet, true);
    assert.equal(box("web:f5").length, 0);
    setNow("2026-11-28T08:00");
    r = await A.reminders.sweep();
    assert.equal(r.quiet, false);
    assert.equal(box("web:f5").length, 1, "sale apenas termina el silencio");
    S.quietHours = null;
  });

  await check("Después del turno (activada): «¿cómo se sintió?» al día siguiente, una vez; «Todo bien» responde sin IA", async () => {
    rule("despues-1").active = true;
    setNow("2026-11-23T09:00");
    const a = await book("web:f6", "Fabio Luna", "2026-11-23T11:00", { status: "asistio", reminder24Sent: true, reminder2Sent: true });
    setNow("2026-11-24T12:00");
    const r = await A.reminders.sweep();
    assert.equal(r.postVisits, 1);
    const m = box("web:f6")[0]!;
    assert.match(m.text, /¿Cómo se sintió después de su Limpieza dental/);
    assert.equal((await A.reminders.sweep()).postVisits, 0);
    assert.ok((await A.store.getAppointment(a.id))!.remindersSent!.includes("despues-1"));
    const reply = await A.bot.handle({ channel: "web", userId: "web:f6", text: "😊 Todo bien" });
    assert.match(reply.messages.at(-1)!, /Qué bueno/);
    assert.equal(reply.toolCalls.length, 0);
  });

  await check("Después del turno (desactivada): no se envía", async () => {
    rule("despues-1").active = false;
    setNow("2026-11-23T09:00");
    await book("web:f7", "Gala Ríos", "2026-11-23T12:00", { status: "asistio", reminder24Sent: true, reminder2Sent: true });
    setNow("2026-11-24T13:00");
    assert.equal((await A.reminders.sweep()).postVisits, 0);
    assert.equal(box("web:f7").length, 0);
  });

  await check("Reactivación: a quien no viene hace N días; no se repite antes de «cada N días»", async () => {
    const re = rule("reactivacion");
    re.active = true; re.days = 120; re.repeatDays = 30;
    setNow("2026-06-01T09:00");
    await book("web:f8", "Hugo Mena", "2026-06-02T10:00", { status: "asistio" });
    setNow("2026-11-25T10:00");
    let r = await A.reminders.sweep();
    assert.ok(r.reactivations >= 1);
    assert.match(box("web:f8")[0]!.text, /Ya pasaron 5 meses desde su última visita/);
    setNow("2026-12-10T10:00");
    r = await A.reminders.sweep();
    assert.equal(box("web:f8").length, 0, "dentro de los 30 días no se repite");
    re.active = false;
    setNow("2027-01-10T10:00");
    await A.reminders.sweep();
    assert.equal(box("web:f8").length, 0, "desactivada no escribe");
  });

  await check("Seguimiento de leads desactivado: no escribe; activado: escribe una vez", async () => {
    const lead = rule("lead");
    lead.active = false;
    setNow("2026-11-23T09:00");
    const p = await A.store.getOrCreatePatient("web:f9", "web", "promo-noviembre");
    const c = await A.store.getOrCreateConversation(p, "web");
    c.messages.push({ role: "patient", text: "Hola, vi la promo", at: clock().toISOString() });
    await A.store.saveConversation(c);
    setNow("2026-11-24T07:00");
    assert.equal((await A.reminders.sweep()).followups, 0);
    lead.active = true;
    assert.equal((await A.reminders.sweep()).followups, 1);
    assert.equal((await A.reminders.sweep()).followups, 0);
  });

  // ---------------- Panel ----------------
  await check("Panel: recepción ve las reglas pero no las edita; el admin sí (con validación)", async () => {
    const g = await call("GET", "/followups", recep);
    assert.equal(g.status, 200);
    assert.equal(g.json.canEdit, false);
    assert.ok(g.json.settings.rules.length >= 7);
    const s = structuredClone(g.json.settings);
    assert.equal((await call("PUT", "/followups", recep, { settings: s })).status, 403);
    const bad = structuredClone(s);
    bad.rules[0].buttons = ["uno", "dos", "tres", "cuatro"];
    assert.equal((await call("PUT", "/followups", admin, { settings: bad })).status, 400);
    const bad2 = structuredClone(s);
    bad2.quietHours = { from: "21:00", to: "21:00" };
    assert.equal((await call("PUT", "/followups", admin, { settings: bad2 })).status, 400);
    s.rules.find((r: any) => r.id === "antes-24").text = "Hola {nombre}: turno el {fecha} a las {hora} ({profesional}).";
    s.waitlistOfferMinutes = 15;
    s.quietHours = { from: "22:00", to: "07:30" };
    const ok = await call("PUT", "/followups", admin, { settings: s });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(A.profile.settings.waitlistOfferMinutes, 15);
    assert.deepEqual(A.profile.settings.quietHours, { from: "22:00", to: "07:30" });
  });

  await check("El texto editado rige en el siguiente envío; la oferta de la lista de espera usa los minutos de la clínica", async () => {
    A.profile.settings.quietHours = null;
    setNow("2026-11-23T09:00");
    await book("web:f10", "Inés Molina", "2026-11-30T10:00");
    setNow("2026-11-29T10:05");
    await A.reminders.sweep();
    assert.equal(box("web:f10")[0]!.text, "Hola Inés: turno el lunes 30/11 a las 10:00 (Dra. Laura Méndez).");
    const p = await A.store.getOrCreatePatient("web:f11", "web");
    await A.store.addWaitlist({ patientId: p.id, patientName: "Juan Paz", treatment: "Limpieza dental (profilaxis)", fromDate: "2026-12-01", toDate: "2026-12-04", franja: "cualquiera" });
    const offered = await A.waitlist.onSlotFreed("2026-12-02T09:00", "prof-mendez");
    assert.equal(offered?.patientName, "Juan Paz");
    assert.match(box("web:f11")[0]!.text, /durante 15 minutos/);
  });

  await check("Próximos envíos: la vista previa lista los recordatorios pendientes con su hora", async () => {
    setNow("2026-11-23T09:00");
    A.profile.settings = defaultSettings();
    A.profile.settings.quietHours = null;
    await book("web:f12", "Karen Gil", "2026-11-25T16:00");
    const g = await call("GET", "/followups", recep);
    const mine = g.json.upcoming.filter((u: any) => u.patient === "Karen Gil");
    assert.deepEqual(mine.map((u: any) => u.ruleId).sort(), ["antes-2", "antes-24"]);
  });
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

const ok = results.filter(([, p]) => p).length;
for (const [name, passed] of results) if (passed) console.log(`  ✅ ${name}`);
console.log(`\n${ok === results.length ? "✅" : "❌"} ${ok}/${results.length} OK`);
process.exitCode = ok === results.length ? 0 : 1;
