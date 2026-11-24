/**
 * Prueba del canal WhatsApp SIN llamar a Meta: se simulan los avisos (webhooks)
 * firmados y se captura lo que el bot enviaría.
 * Uso: npm run test:whatsapp
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { BotEngine } from "../src/bot/engine.js";
import { MockProvider } from "../src/llm/mock.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore } from "../src/services/store.js";
import { seedCalendar } from "../src/data/seed.js";
import { createWhatsAppRouter, parseWebhook } from "../src/channels/whatsappWebhook.js";
import { phoneVariants, WhatsAppCloudClient, type WhatsAppSender } from "../src/channels/whatsappClient.js";

const clock = () => new Date("2026-11-23T14:15:00Z");
const calendar = new InMemoryCalendar();
await seedCalendar(calendar, clock);
const bot = new BotEngine(new MockProvider(), new InMemoryStore(), calendar, clock);

const sent: Array<{ to: string; text: string }> = [];
const fakeSender: WhatsAppSender = {
  async sendText(to, text) { sent.push({ to, text }); },
  async sendButtons(to, text) { sent.push({ to, text }); },
  async sendTemplate() {},
  async markReadAndTyping() {},
};

const SECRET = "secreto-de-prueba";
const VERIFY = "token-verificacion-prueba";
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { (req as any).rawBody = buf; } }));
app.use("/webhook/whatsapp", createWhatsAppRouter({ bot, sender: fakeSender, verifyToken: VERIFY, appSecret: SECRET, log: () => {} }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/whatsapp`;

const payload = (id: string, from: string, msg: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550000000", phone_number_id: "123" },
    contacts: [{ profile: { name: "Paciente Prueba" }, wa_id: from }],
    messages: [{ from, id, timestamp: "1764000000", ...msg }],
  } }] }],
});
async function post(body: unknown, sign = true) {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  return fetch(base, { method: "POST", headers: { "Content-Type": "application/json", ...(sign ? { "X-Hub-Signature-256": sig } : {}) }, body: raw });
}
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
};
const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}

try {
  await check("Verificación GET con token correcto devuelve el challenge", async () => {
    const r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "12345");
  });
  await check("Verificación GET con token incorrecto → 403", async () => {
    const r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1`);
    assert.equal(r.status, 403);
  });
  await check("Aviso sin firma → 401 y el bot no responde", async () => {
    const r = await post(payload("wamid.X0", "5491100000001", { type: "text", text: { body: "hola" } }), false);
    assert.equal(r.status, 401);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, 0);
  });
  await check("Primer mensaje: saludo con nombre de perfil + respuesta + privacidad en una línea", async () => {
    const r = await post(payload("wamid.A1", "5491100000001", { type: "text", text: { body: "Hola, vi la promo #promo-noviembre" } }));
    assert.equal(r.status, 200);
    await until(() => sent.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, 1, "debe ser un solo mensaje");
    assert.match(sent[0]!.text, /^¡Hola, Paciente! 👋/);
    assert.match(sent[0]!.text, /Promo Sonrisa Noviembre/);
    assert.match(sent[0]!.text, /🔒 Sus datos se usan solo para gestionar sus turnos/);
    assert.equal(sent[0]!.to, "5491100000001");
  });
  await check("Segundo mensaje: no vuelve a presentarse", async () => {
    const before = sent.length;
    await post(payload("wamid.A1b", "5491100000001", { type: "text", text: { body: "¿Dónde quedan?" } }));
    await until(() => sent.length > before);
    assert.doesNotMatch(sent.at(-1)!.text, /Soy su asistente virtual|🔒/);
    assert.match(sent.at(-1)!.text, /📍/);
  });
  await check("Aviso repetido por Meta (mismo id) no se procesa dos veces", async () => {
    const before = sent.length;
    await post(payload("wamid.A1", "5491100000001", { type: "text", text: { body: "Hola, vi la promo" } }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sent.length, before);
  });
  await check("Pedido de turno usa la agenda y ofrece horarios", async () => {
    const before = sent.length;
    await post(payload("wamid.A2", "5491100000001", { type: "text", text: { body: "Quiero un turno para mañana a la tarde" } }));
    await until(() => sent.length > before);
    assert.match(sent.at(-1)!.text, /1️⃣ .*\n2️⃣ /);
  });
  await check("Respuesta con botón interactivo se lee como texto", async () => {
    const before = sent.length;
    await post(payload("wamid.A3", "5491100000001", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "opt1", title: "1" } } }));
    await until(() => sent.length > before);
    assert.match(sent.at(-1)!.text, /nombre y apellido/);
  });
  await check("Audio u otro tipo → pide escribir en texto", async () => {
    const before = sent.length;
    await post(payload("wamid.A4", "5491100000002", { type: "audio", audio: { id: "media1" } }));
    await until(() => sent.length > before);
    assert.match(sent.at(-1)!.text, /solo puedo leer mensajes de texto/);
  });
  await check("Avisos de estado (entregado/leído) se ignoran", async () => {
    const statusOnly = { entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.A1", status: "read" }] } }] }] };
    assert.equal(parseWebhook(statusOnly).length, 0);
  });
  await check("Variantes de número AR/MX para el destinatario de prueba", async () => {
    assert.deepEqual(phoneVariants("5491122334455"), ["5491122334455", "541122334455"]);
    assert.deepEqual(phoneVariants("5215512345678"), ["5215512345678", "525512345678"]);
    assert.deepEqual(phoneVariants("59171234567"), ["59171234567"]);
  });
  await check("Si Meta rechaza el número (131030) se reintenta con la variante", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const to = JSON.parse(String(init.body)).to;
      calls.push(to);
      const ok = to === "541122334455";
      return new Response(JSON.stringify(ok ? { messages: [{ id: "x" }] } : { error: { code: 131030, message: "Recipient not in allowed list" } }), { status: ok ? 200 : 400 });
    }) as typeof fetch;
    const c = new WhatsAppCloudClient("tok", "123", "v23.0", fakeFetch);
    await c.sendText("5491122334455", "hola");
    await c.sendText("5491122334455", "de nuevo");
    assert.deepEqual(calls, ["5491122334455", "541122334455", "541122334455"]);
  });
} finally {
  server.close();
}

console.log("\nCanal WhatsApp (simulado):");
for (const [n, ok] of results) console.log(`  ${ok ? "✅" : "❌"} ${n}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} prueba(s) fallaron` : `\n✅ ${results.length}/${results.length} OK`);
process.exitCode = failed ? 1 : 0;
