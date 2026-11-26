/**
 * Pruebas del multiempresa en el entorno de pruebas (memoria, sin Supabase ni Meta):
 * datos separados por clínica, doble reserva por clínica, agenda compartida con
 * etiquetas, conocimiento propio, webhook por número y acceso al panel por rol.
 * Uso: npm run test:clinics
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { DateTime } from "luxon";
import { MockProvider } from "../src/llm/mock.js";
import { InMemoryCalendar, Availability } from "../src/services/calendar.js";
import { InMemoryStore, SlotTakenError } from "../src/services/store.js";
import { demoClinics, CLINIC_A, CLINIC_B } from "../src/data/clinics/index.js";
import { demoUsers } from "../src/data/clinics/users.js";
import { buildRuntimes, lineByPhoneNumberId } from "../src/clinics/registry.js";
import { withClinic } from "../src/clinics/context.js";
import { createWhatsAppRouter } from "../src/channels/whatsappWebhook.js";
import type { WhatsAppSender } from "../src/channels/whatsappClient.js";
import { MemoryAuth } from "../src/auth.js";
import { createPanelRouter } from "../src/panel.js";
import type { Services } from "../src/services/factory.js";

const clock = () => new Date("2026-11-23T14:15:00Z"); // lunes 10:15 en La Paz
const clinics = demoClinics();
clinics[0]!.lines = clinics[0]!.lines.filter((l) => l.kind !== "cloud"); // sin el número real del .env
clinics[0]!.lines.unshift({ id: "sonrisa-clara-recepcion", clinicId: CLINIC_A, name: "Recepción", kind: "cloud", phoneNumberId: "PN_A", displayPhone: null, professionalId: null, area: null, active: true }); // número de prueba ficticio de la clínica A
const services: Services = { store: new InMemoryStore(clock), calendar: new InMemoryCalendar(), storeKind: "memoria", calendarKind: "memoria" };

const sent: Array<{ to: string; text: string; via: string }> = [];
const senderFor = (via: string): WhatsAppSender => ({
  async sendText(to, text) { sent.push({ to, text, via }); },
  async sendButtons(to, text) { sent.push({ to, text, via }); },
  async sendTemplate() {},
  async markReadAndTyping() {},
});
const runtimes = buildRuntimes({ services, clinics, provider: new MockProvider(), clock, whatsappFor: (id) => senderFor(id) });
const A = runtimes.get(CLINIC_A)!;
const B = runtimes.get(CLINIC_B)!;

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}
const at = (iso: string) => DateTime.fromISO(iso, { zone: "America/La_Paz" }).toUTC().toISO()!;

await check("El mismo teléfono en las dos clínicas son dos pacientes distintos", async () => {
  const pa = await A.store.getOrCreatePatient("+59170000001", "whatsapp");
  const pb = await B.store.getOrCreatePatient("+59170000001", "whatsapp");
  assert.notEqual(pa.id, pb.id);
  assert.equal(await A.store.getPatient(pb.id), null, "A no debe leer el paciente de B");
  assert.equal(await B.store.getPatient(pa.id), null, "B no debe leer el paciente de A");
});

await check("La misma hora se reserva en las dos clínicas; dos veces con el mismo profesional, no", async () => {
  const pa = await A.store.getOrCreatePatient("+59170000002", "web");
  const pb = await B.store.getOrCreatePatient("+59170000002", "web");
  const base = { patientName: "Paciente Prueba", treatment: "Consulta", professionalId: "prof-x", start: at("2026-11-25T11:00"), end: at("2026-11-25T11:30"),
    status: "confirmada" as const, calendarEventId: "", confirmedByPatient: false, reminder24Sent: false, reminder2Sent: false };
  await A.store.createAppointment({ ...base, patientId: pa.id });
  await B.store.createAppointment({ ...base, patientId: pb.id });
  await assert.rejects(A.store.createAppointment({ ...base, patientId: pa.id }), SlotTakenError);
  assert.equal((await A.store.listAppointments()).length, 1);
  assert.equal((await B.store.listAppointments()).length, 1);
});

await check("Calendario de Google: cada clínica ve sus eventos; la principal, también los sin etiqueta", async () => {
  const day = DateTime.fromISO("2026-11-26T00:00", { zone: "America/La_Paz" });
  await services.calendar.createEvent({ start: day.set({ hour: 9 }).toISO()!, end: day.set({ hour: 9, minute: 30 }).toISO()!, summary: "Cargado a mano" });
  const eb = await withClinic(B.profile, () => B.calendar.createEvent({ start: day.set({ hour: 15 }).toISO()!, end: day.set({ hour: 15, minute: 30 }).toISO()!, summary: "Turno B" }));
  const listA = await A.calendar.listEvents(day, day.endOf("day"));
  const listB = await B.calendar.listEvents(day, day.endOf("day"));
  assert.deepEqual(listA.map((e) => e.summary), ["Cargado a mano"]);
  assert.deepEqual(listB.map((e) => e.summary), ["Turno B"]);
  assert.equal(eb.clinic ?? (await services.calendar.listEvents(day, day.endOf("day"))).find((e) => e.id === eb.id)?.clinic, CLINIC_B);
});

await check("Disponibilidad con el horario de cada clínica (B abre 8:30 y cierra los sábados)", async () => {
  const slotsB = await withClinic(B.profile, () => new Availability(B.calendar, clock, B.store).freeSlots({ fromDate: "2026-11-24", toDate: "2026-11-24", franja: "manana", limit: 2 }));
  assert.equal(slotsB[0]?.inicio, "2026-11-24T08:30");
  const satB = await withClinic(B.profile, () => new Availability(B.calendar, clock, B.store).freeSlots({ fromDate: "2026-11-28", toDate: "2026-11-28", franja: "cualquiera" }));
  assert.equal(satB.length, 0);
  const satA = await withClinic(A.profile, () => new Availability(A.calendar, clock, A.store).freeSlots({ fromDate: "2026-11-28", toDate: "2026-11-28", franja: "cualquiera" }));
  assert.ok(satA.length > 0, "A atiende los sábados");
});

await check("Cada bot responde con el conocimiento de su clínica", async () => {
  const ra = await A.bot.handle({ channel: "web", userId: "web:clinica-a1", text: "Cuánto sale la promo?" });
  const rb = await B.bot.handle({ channel: "web", userId: "web:clinica-b1", text: "Cuánto sale la promo?" });
  const ta = ra.messages.join("\n"), tb = rb.messages.join("\n");
  assert.match(ta, /Sonrisa Clara/); assert.match(ta, /Promo Sonrisa Noviembre/);
  assert.match(tb, /Altamira/); assert.match(tb, /Chequeo Familiar/); assert.match(tb, /Bs 300/);
  assert.doesNotMatch(tb, /Sonrisa/);
});

await check("Las conversaciones y métricas de B no aparecen en A", async () => {
  const convA = await A.store.listConversations();
  const convB = await B.store.listConversations();
  assert.ok(convB.length >= 1);
  assert.ok(convB.every((c) => !convA.some((x) => x.id === c.id)));
  for (const c of convB) assert.equal(await A.store.getConversation(c.id), null);
});

// --- Webhook: la clínica se elige por el número que recibió el mensaje ---
const SECRET = "secreto-prueba";
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { (req as any).rawBody = buf; } }));
app.use("/webhook/whatsapp", createWhatsAppRouter({
  verifyToken: "v", appSecret: SECRET, log: () => {},
  route: (pn) => { const hit = lineByPhoneNumberId(runtimes, pn); return hit ? { bot: hit.rt.bot, sender: hit.rt.senders.get(hit.line.id)!, lineId: hit.line.id } : null; },
}));

// --- Panel con usuarios de prueba (contraseñas solo para esta prueba) ---
for (const u of demoUsers) process.env[u.passwordVar] = `prueba-${u.passwordVar.toLowerCase()}`;
const auth = new MemoryAuth();
app.use("/api/panel", createPanelRouter({ auth, runtimes, clock, storeFor: (_u, id) => services.store.forClinic(id) }));
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

async function postWebhook(phoneNumberId: string, id: string, from: string, body: string) {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
    contacts: [{ profile: { name: "Paciente Prueba" }, wa_id: from }],
    messages: [{ from, id, timestamp: "1764000000", type: "text", text: { body } }],
  } }] }] });
  const sig = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  return fetch(`http://127.0.0.1:${port}/webhook/whatsapp`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: raw });
}
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
};
async function cookieFor(email: string) {
  const u = demoUsers.find((x) => x.email === email)!;
  const r = await auth.login(email, process.env[u.passwordVar]!, false);
  return r!.setCookie!.split(";")[0]!;
}
const panel = (path: string, cookie: string) => fetch(`http://127.0.0.1:${port}/api/panel${path}`, { headers: { cookie } });

try {
  await check("Webhook: el número de la clínica A responde con el bot de A, desde ese número", async () => {
    const r = await postWebhook("PN_A", "wamid.M1", "59170000009", "Hola");
    assert.equal(r.status, 200);
    await until(() => sent.length > 0);
    assert.equal(sent[0]?.via, "PN_A");
    assert.match(sent[0]!.text, /Sonrisa Clara/);
    assert.ok((await A.store.listPatients()).some((p) => p.phone === "+59170000009"));
    assert.ok(!(await B.store.listPatients()).some((p) => p.phone === "+59170000009"));
  });

  await check("Webhook: un número sin clínica asignada se ignora (200 a Meta, sin respuesta)", async () => {
    const before = sent.length;
    const r = await postWebhook("PN_DESCONOCIDO", "wamid.M2", "59170000010", "Hola");
    assert.equal(r.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.length, before);
  });

  await check("Panel: sin sesión → 401; contraseña incorrecta no inicia sesión", async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/panel/me`)).status, 401);
    assert.equal(await auth.login("recepcion@sonrisaclara.demo.test", "otra", false), null);
  });

  await check("Panel: la recepcionista de A no puede abrir la clínica B", async () => {
    const c = await cookieFor("recepcion@sonrisaclara.demo.test");
    const me = await (await panel("/me", c)).json();
    assert.deepEqual(me.clinics.map((x: any) => x.id), [CLINIC_A]);
    assert.equal((await panel(`/summary?clinic=${CLINIC_B}`, c)).status, 403);
    const convB = (await B.store.listConversations())[0]!;
    assert.equal((await panel(`/conversation/${convB.id}?clinic=${CLINIC_A}`, c)).status, 404, "una conversación de B no existe vista desde A");
  });

  await check("Panel: recepción no ve costos ni pruebas; el admin sí", async () => {
    const rec = await (await panel(`/summary?clinic=${CLINIC_A}`, await cookieFor("recepcion@sonrisaclara.demo.test"))).json();
    assert.equal(rec.role, "recepcion");
    assert.equal(rec.metrics, null);
    assert.deepEqual(rec.tests, []);
    const adm = await (await panel(`/summary?clinic=${CLINIC_A}`, await cookieFor("admin@sonrisaclara.demo.test"))).json();
    assert.equal(adm.role, "admin");
    assert.ok(adm.metrics);
  });

  await check("Panel: el dueño ve las dos clínicas y cada resumen trae solo los datos de esa clínica", async () => {
    const c = await cookieFor("admin@sonrisaclara.demo.test");
    const me = await (await panel("/me", c)).json();
    assert.deepEqual(me.clinics.map((x: any) => x.id).sort(), [CLINIC_B, CLINIC_A].sort());
    const sb = await (await panel(`/summary?clinic=${CLINIC_B}`, c)).json();
    assert.equal(sb.clinic.id, CLINIC_B);
    const idsB = new Set((await B.store.listConversations()).map((x) => x.id));
    const inboxB = await (await panel(`/conversations?clinic=${CLINIC_B}&filtro=todas`, c)).json();
    assert.ok(inboxB.conversations.length > 0 && inboxB.conversations.every((x: any) => idsB.has(x.id)));
  });
} finally {
  server.close();
}

const passed = results.filter(([, ok]) => ok).length;
for (const [name, ok] of results) console.log(`  ${ok ? "✅" : "❌"} ${name}`);
console.log(`\n${passed === results.length ? "✅" : "❌"} ${passed}/${results.length} OK`);
process.exitCode = passed === results.length ? 0 : 1;
