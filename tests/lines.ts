/**
 * Pruebas de las líneas de WhatsApp (etapa 5), en memoria:
 * - el webhook elige clínica y línea por el número que recibió el mensaje y responde por esa línea;
 * - un número desconocido se ignora;
 * - si el paciente cambia de línea, la conversación pasa a la nueva (con una nota) y responde por ahí;
 * - la respuesta del panel y los avisos automáticos salen por la línea del paciente;
 * - la línea de un profesional hace que el bot lo ofrezca primero;
 * - la bandeja muestra la línea de cada chat y filtra por línea;
 * - las líneas simuladas (simulador) entran por la misma función, sin enviar nada a Meta.
 * Uso: npm run test:lines
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { DateTime } from "luxon";
import { MockProvider } from "../src/llm/mock.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore } from "../src/services/store.js";
import { demoClinics, CLINIC_A, CLINIC_B } from "../src/data/clinics/index.js";
import { demoUsers } from "../src/data/clinics/users.js";
import { buildRuntimes, lineByPhoneNumberId } from "../src/clinics/registry.js";
import type { WhatsAppLine } from "../src/clinics/types.js";
import { createWhatsAppRouter } from "../src/channels/whatsappWebhook.js";
import type { WhatsAppSender } from "../src/channels/whatsappClient.js";
import { receiveMessage } from "../src/channels/inbound.js";
import { MemoryAuth } from "../src/auth.js";
import { createPanelRouter } from "../src/panel.js";
import type { Services } from "../src/services/factory.js";

const TZ = "America/La_Paz";
const clock = () => new Date("2026-11-23T14:15:00Z"); // lunes 10:15 en La Paz
const line = (id: string, clinicId: string, name: string, extra: Partial<WhatsAppLine> = {}): WhatsAppLine => ({
  id, clinicId, name, kind: "cloud", phoneNumberId: null, displayPhone: null, professionalId: null, area: null, active: true, ...extra,
});
// Clínica A: dos números reales (ficticios en la prueba) y una línea simulada. Clínica B: un número.
const clinics = demoClinics();
clinics[0]!.lines = [
  line("a-recepcion", CLINIC_A, "Recepción", { phoneNumberId: "PN_A1" }),
  line("a-ortodoncia", CLINIC_A, "Ortodoncia · Dr. Ríos", { phoneNumberId: "PN_A2", professionalId: "prof-rios", area: "Ortodoncia" }),
  line("a-sim", CLINIC_A, "Línea general", { kind: "simulada" }),
];
clinics[1]!.lines = [line("b-recepcion", CLINIC_B, "Recepción", { phoneNumberId: "PN_B" })];
for (const c of clinics) c.settings.quietHours = null;

const services: Services = { store: new InMemoryStore(clock), calendar: new InMemoryCalendar(), storeKind: "memoria", calendarKind: "memoria" };
const sent: Array<{ to: string; text: string; via: string }> = [];
const senderFor = (via: string): WhatsAppSender => ({
  async sendText(to, text) { sent.push({ to, text, via }); },
  async sendButtons(to, text) { sent.push({ to, text, via }); },
  async sendList(to, text) { sent.push({ to, text, via }); },
  async sendTemplate(to, name) { sent.push({ to, text: `plantilla ${name}`, via }); },
  async markReadAndTyping() {},
});
const runtimes = buildRuntimes({ services, clinics, provider: new MockProvider(), clock, whatsappFor: (pn) => senderFor(pn) });
const A = runtimes.get(CLINIC_A)!;
const B = runtimes.get(CLINIC_B)!;

const SECRET = "secreto-prueba";
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { (req as any).rawBody = buf; } }));
app.use("/webhook/whatsapp", createWhatsAppRouter({
  verifyToken: "v", appSecret: SECRET, log: () => {},
  route: (pn) => { const hit = lineByPhoneNumberId(runtimes, pn); return hit ? { bot: hit.rt.bot, sender: hit.rt.senders.get(hit.line.id)!, lineId: hit.line.id } : null; },
}));
for (const u of demoUsers) process.env[u.passwordVar] = `prueba-${u.passwordVar.toLowerCase()}`;
const auth = new MemoryAuth();
app.use("/api/panel", createPanelRouter({ auth, runtimes, clock, storeFor: (_u, id) => services.store.forClinic(id) }));
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

let msgSeq = 0;
async function postWebhook(phoneNumberId: string, from: string, body: string) {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
    contacts: [{ profile: { name: "Paciente Prueba" }, wa_id: from }],
    messages: [{ from, id: `wamid.L${++msgSeq}`, timestamp: "1764000000", type: "text", text: { body } }],
  } }] }] });
  const sig = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  return fetch(`http://127.0.0.1:${port}/webhook/whatsapp`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: raw });
}
/** Manda un mensaje al webhook y espera las respuestas nuevas. */
async function say(pn: string, from: string, body: string) {
  const before = sent.length;
  assert.equal((await postWebhook(pn, from, body)).status, 200);
  const t0 = Date.now();
  while (sent.length === before && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 60));
  return sent.slice(before);
}
async function cookieFor(email: string) {
  const u = demoUsers.find((x) => x.email === email)!;
  return (await auth.login(email, process.env[u.passwordVar]!, false))!.setCookie!.split(";")[0]!;
}
const panel = (path: string, cookie: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}/api/panel${path}`, { ...init, headers: { cookie, "Content-Type": "application/json", ...(init.headers ?? {}) } });
const convOf = async (store: typeof A.store, phone: string) => {
  const p = (await store.listPatients()).find((x) => x.phone === phone)!;
  return { p, c: (await store.listConversations()).find((x) => x.patientId === p.id)! };
};

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}

try {
  await check("Webhook: el número de Recepción de A responde el bot de A, por esa misma línea", async () => {
    const out = await say("PN_A1", "59170000101", "Hola");
    assert.ok(out.length > 0 && out.every((m) => m.via === "PN_A1"));
    assert.match(out.map((m) => m.text).join(" "), /Sonrisa Clara/);
    const { c, p } = await convOf(A.store, "+59170000101");
    assert.equal(c.lineId, "a-recepcion");
    assert.equal(p.lineId, "a-recepcion");
  });

  await check("Webhook: el número de B va a la clínica B (ruteo por número, no por clínica principal)", async () => {
    const out = await say("PN_B", "59170000102", "Hola");
    assert.ok(out.length > 0 && out.every((m) => m.via === "PN_B"));
    assert.match(out.map((m) => m.text).join(" "), /Altamira/);
    assert.equal((await convOf(B.store, "+59170000102")).c.lineId, "b-recepcion");
    assert.ok(!(await A.store.listPatients()).some((x) => x.phone === "+59170000102"));
  });

  await check("Webhook: un número sin línea asignada se ignora (200 a Meta, sin respuesta)", async () => {
    const before = sent.length;
    assert.equal((await postWebhook("PN_DESCONOCIDO", "59170000103", "Hola")).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.length, before);
  });

  await check("Línea de un profesional: al pedir turno, el bot ofrece primero a ese profesional", async () => {
    const out = await say("PN_A2", "59170000104", "Quiero sacar un turno");
    assert.ok(out.every((m) => m.via === "PN_A2"), "responde por la línea de ortodoncia");
    const text = out.map((m) => m.text).join(" ");
    assert.match(text, /Ríos/);
    assert.doesNotMatch(text, /especialidad/i, "no pregunta la especialidad");
    const { c } = await convOf(A.store, "+59170000104");
    assert.equal(c.lineId, "a-ortodoncia");
  });

  await check("Si el paciente escribe por otra línea, la conversación pasa a esa línea (con nota) y responde por ahí", async () => {
    const out = await say("PN_A1", "59170000104", "¿Dónde quedan?");
    assert.ok(out.length > 0 && out.every((m) => m.via === "PN_A1"));
    const { c, p } = await convOf(A.store, "+59170000104");
    assert.equal(c.lineId, "a-recepcion");
    assert.equal(p.lineId, "a-recepcion");
    assert.ok(c.messages.some((m) => m.role === "system" && /línea «Recepción»/.test(m.text)));
    assert.equal((await A.store.listConversations()).filter((x) => x.patientId === p.id).length, 1, "sigue siendo una sola conversación");
  });

  await check("Respuesta desde el panel: sale por la línea de la conversación", async () => {
    await say("PN_A2", "59170000105", "Hola");
    const { c } = await convOf(A.store, "+59170000105");
    const cookie = await cookieFor("recepcion@sonrisaclara.demo.test");
    const before = sent.length;
    const r = await panel(`/conversation/${c.id}/reply?clinic=${CLINIC_A}`, cookie, { method: "POST", body: JSON.stringify({ text: "Hola, le escribe recepción" }) });
    assert.equal(r.status, 200);
    const out = sent.slice(before);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.via, "PN_A2");
    assert.equal(out[0]!.to, "59170000105");
  });

  await check("Avisos automáticos (recordatorio): salen por la última línea del paciente", async () => {
    const { p } = await convOf(A.store, "+59170000105");
    await A.store.updatePatient(p.id, { name: "Paula Línea" });
    const start = DateTime.fromISO("2026-11-24T16:00", { zone: TZ });
    const a = await A.store.createAppointment({
      patientId: p.id, patientName: "Paula Línea", treatment: "Control de ortodoncia", professionalId: "prof-rios",
      start: start.toUTC().toISO()!, end: start.plus({ minutes: 30 }).toUTC().toISO()!, status: "confirmada",
      calendarEventId: "", confirmedByPatient: false, reminder24Sent: false, reminder2Sent: false,
    });
    const before = sent.length;
    assert.ok(await A.reminders.remindNow(a.id));
    const out = sent.slice(before);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.via, "PN_A2");
  });

  await check("Sin línea conocida (paciente cargado a mano): el aviso sale por la primera línea real", async () => {
    const p = await A.store.getOrCreatePatient("+59170000106", "whatsapp");
    const before = sent.length;
    await A.notifier.send("whatsapp", p.phone, { text: "Aviso" }, p.lineId);
    assert.equal(sent.slice(before)[0]?.via, "PN_A1");
  });

  await check("Bandeja: cada chat muestra su línea y se puede filtrar por línea", async () => {
    const cookie = await cookieFor("recepcion@sonrisaclara.demo.test");
    const lines = await (await panel(`/lines?clinic=${CLINIC_A}`, cookie)).json();
    assert.deepEqual(lines.lines.map((l: any) => l.label), ["Recepción", "Ortodoncia · Dr. Ríos", "Línea general (simulada)"]);
    assert.equal(lines.lines[1].professional, "Dr. Martín Ríos");
    assert.ok(!JSON.stringify(lines).includes("PN_A"), "no muestra el identificador de Meta");
    const all = await (await panel(`/conversations?clinic=${CLINIC_A}&filtro=todas`, cookie)).json();
    const mine = all.conversations.find((x: any) => x.phone.endsWith("105"));
    assert.equal(mine.line.name, "Ortodoncia · Dr. Ríos");
    const ortho = await (await panel(`/conversations?clinic=${CLINIC_A}&filtro=todas&linea=a-ortodoncia`, cookie)).json();
    assert.ok(ortho.conversations.length > 0 && ortho.conversations.every((x: any) => x.line?.id === "a-ortodoncia"));
    assert.equal(ortho.counts.todas, ortho.conversations.length, "los contadores respetan el filtro de línea");
    const detail = await (await panel(`/conversation/${mine.id}?clinic=${CLINIC_A}`, cookie)).json();
    assert.equal(detail.line.label, "Ortodoncia · Dr. Ríos");
  });

  await check("Línea simulada (simulador): misma entrada que WhatsApp, queda en la bandeja y no envía nada a Meta", async () => {
    const before = sent.length;
    const r = await receiveMessage(A.bot, { channel: "web", from: "web:sim1", text: "Hola", lineId: "a-sim" });
    assert.ok(r.messages.length > 0);
    assert.equal(sent.length, before);
    const { c } = await convOf(A.store, "web:sim1");
    assert.equal(c.lineId, "a-sim");
  });

  await check("Una línea de otra clínica no se acepta: la conversación queda sin esa línea", async () => {
    await receiveMessage(A.bot, { channel: "web", from: "web:sim2", text: "Hola", lineId: "b-recepcion" });
    assert.equal((await convOf(A.store, "web:sim2")).c.lineId ?? null, null);
  });
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

const ok = results.filter(([, p]) => p).length;
for (const [name, passed] of results) if (passed) console.log(`  ✅ ${name}`);
console.log(`\n${ok === results.length ? "✅" : "❌"} ${ok}/${results.length} OK`);
process.exitCode = ok === results.length ? 0 : 1;
