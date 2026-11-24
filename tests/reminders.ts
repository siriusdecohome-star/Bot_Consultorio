/**
 * Prueba de recordatorios, respuestas y seguimiento de leads con un reloj simulado
 * (de lunes a miércoles en segundos). Todo en memoria: no envía nada real.
 * Uso: npm run test:reminders
 */
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { BotEngine } from "../src/bot/engine.js";
import { makeExecutor } from "../src/bot/tools.js";
import { ReminderService, type SweepResult } from "../src/bot/reminders.js";
import { MockProvider } from "../src/llm/mock.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore } from "../src/services/store.js";
import { ChannelNotifier, WebOutbox } from "../src/services/notifier.js";
import { WhatsAppApiError, type WhatsAppSender } from "../src/channels/whatsappClient.js";
import { TZ } from "../src/services/time.js";

let nowMs = 0;
const at = (iso: string) => { nowMs = DateTime.fromISO(iso, { zone: TZ() }).toMillis(); };
const clock = () => new Date(nowMs);

const store = new InMemoryStore(clock);
const calendar = new InMemoryCalendar();
const outbox = new WebOutbox();
const bot = new BotEngine(new MockProvider(), store, calendar, clock);
const reminders = new ReminderService(store, new ChannelNotifier({ web: outbox, log: () => {} }), clock);

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}: ${(e as Error).message}`); }
}
const say = (user: string, text: string, source?: string) => bot.handle({ channel: "web", userId: user, text, source });
async function book(user: string, name: string, inicio: string) {
  await say(user, "Hola");
  const patient = await store.getOrCreatePatient(user, "web");
  const conversation = await store.getOrCreateConversation(patient, "web");
  const r = (await makeExecutor({ store, calendar, clock, patient, conversation })("crear_cita", { nombre_completo: name, tratamiento: "Limpieza dental", inicio })) as any;
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.cita.id as string;
}
const counts = (r: SweepResult) => `24h=${r.reminder24} 2h=${r.reminder2} seg=${r.followups} omit=${r.skipped}`;

const A = "web:paciente-a", B = "web:paciente-b", C = "web:paciente-c", D = "web:lead-d", E = "web:lead-e";
let idA = "", idB = "", idC = "";

// Lunes 23/11 10:00: A y B reservan para el miércoles
at("2026-11-23T10:00");
idA = await book(A, "Ana Rivas", "2026-11-25T10:00");
idB = await book(B, "Bruno Paz", "2026-11-25T15:00");

// Martes 24/11 09:30: llegan dos leads; C reserva para hoy a las 17:00 (menos de 24 h)
at("2026-11-24T09:30");
await say(D, "Hola, vi la promo", "promo-noviembre");
await say(E, "Hola, ¿atienden los sábados?");
idC = await book(C, "Carla Sosa", "2026-11-24T17:00");

await check("Martes 10:05 → recordatorio 24 h a A; a C (reservó con < 24 h) se le omite", async () => {
  at("2026-11-24T10:05");
  const r = await reminders.sweep();
  assert.equal(counts(r), "24h=1 2h=0 seg=0 omit=1");
  const box = outbox.take(A);
  assert.equal(box.length, 1);
  assert.match(box[0]!.text, /Recordatorio de turno[\s\S]*mañana, miércoles 25\/11 a las 10:00/);
  assert.deepEqual(box[0]!.buttons, ["✅ Confirmo", "📅 Cambiar horario", "❌ Cancelar"]);
});
await check("Una segunda revisión no repite avisos", async () => {
  const r = await reminders.sweep();
  assert.equal(counts(r), "24h=0 2h=0 seg=0 omit=0");
});
await check("A toca «✅ Confirmo» → asistencia confirmada sin usar IA", async () => {
  const r = await say(A, "✅ Confirmo");
  assert.match(r.messages.at(-1)!, /Su asistencia quedó confirmada/);
  assert.equal(r.toolCalls.length, 0);
  assert.equal((await store.getAppointment(idA))!.confirmedByPatient, true);
});
await check("Martes 15:05 → recordatorio 24 h a B y de 2 h a C", async () => {
  at("2026-11-24T15:05");
  const r = await reminders.sweep();
  assert.equal(counts(r), "24h=1 2h=1 seg=0 omit=0");
  assert.match(outbox.take(C)[0]!.text, /Su turno es \*hoy, martes 24\/11 a las 17:00\*/);
  assert.equal(outbox.take(B).length, 1);
});
await check("B toca «❌ Cancelar» → se cancela, se libera el horario y se ofrece reprogramar", async () => {
  const r = await say(B, "❌ Cancelar");
  const text = r.messages.at(-1)!;
  assert.match(text, /cancelé su turno/);
  assert.match(text, /1️⃣/);
  assert.equal((await store.getAppointment(idB))!.status, "cancelada");
  const day = DateTime.fromISO("2026-11-25T15:00", { zone: TZ() });
  assert.equal((await calendar.listEvents(day, day.plus({ minutes: 30 }))).length, 0, "el horario quedó libre");
});
await check("Miércoles 06:00 → seguimiento solo al lead de la promo que no agendó", async () => {
  at("2026-11-25T06:00");
  const r = await reminders.sweep();
  assert.equal(counts(r), "24h=0 2h=0 seg=1 omit=0");
  const box = outbox.take(D);
  assert.match(box[0]!.text, /Promo Sonrisa Noviembre/);
  assert.equal(outbox.take(E).length, 0, "E no llegó por la promo");
});
await check("El lead responde «Más adelante» → respuesta amable sin IA, y no se le vuelve a escribir", async () => {
  const r = await say(D, "Más adelante");
  assert.match(r.messages.at(-1)!, /Cuando quiera, escríbame/);
  at("2026-11-25T07:00");
  assert.equal((await reminders.sweep()).followups, 0);
});
await check("Miércoles 08:05 → recordatorio de 2 h a A, sin botones porque ya confirmó", async () => {
  at("2026-11-25T08:05");
  const r = await reminders.sweep();
  assert.equal(r.reminder2, 1);
  const m = outbox.take(A)[0]!;
  assert.match(m.text, /Le esperamos \*hoy, miércoles 25\/11 a las 10:00\*/);
  assert.equal(m.buttons, undefined);
});
await check("Respuesta «📅 Cambiar horario» a un recordatorio ofrece horarios nuevos", async () => {
  at("2026-11-25T08:10");
  const idF = await book("web:paciente-f", "Fede Luna", "2026-11-26T11:00");
  await reminders.remindNow(idF);
  const r = await say("web:paciente-f", "📅 Cambiar horario");
  assert.match(r.messages.at(-1)!, /Su turno actual es[\s\S]*1️⃣/);
});
await check("WhatsApp con la ventana de 24 h cerrada → usa la plantilla aprobada", async () => {
  const calls: string[] = [];
  const wa: WhatsAppSender = {
    async sendText() { calls.push("texto"); },
    async sendButtons() { calls.push("botones"); throw new WhatsAppApiError(400, 131047, "Re-engagement message"); },
    async sendTemplate(_to, name, _lang, params) { calls.push(`plantilla:${name}:${params?.length}`); },
    async markReadAndTyping() {},
  };
  const n = new ChannelNotifier({ whatsapp: wa, log: () => {} });
  const appt = (await store.getAppointment(idA))!;
  const { reminderMessage } = await import("../src/bot/reminders.js");
  const how = await n.send("whatsapp", "+5491100000001", reminderMessage(appt, "reminder24", DateTime.fromMillis(nowMs, { zone: TZ() })));
  assert.equal(how, "plantilla");
  assert.deepEqual(calls, ["botones", "plantilla:recordatorio_turno:3"]);
});

console.log("\nRecordatorios y seguimiento (reloj simulado):");
for (const [n, ok] of results) console.log(`  ${ok ? "✅" : "❌"} ${n}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} prueba(s) fallaron` : `\n✅ ${results.length}/${results.length} OK`);
process.exitCode = failed ? 1 : 0;
