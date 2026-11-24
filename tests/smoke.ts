/**
 * Prueba rápida de la etapa 1: conversación completa con el proveedor elegido
 * (por defecto "mock") sobre una agenda en memoria con reloj fijo.
 * Uso: npm run smoke   (o con LLM_PROVIDER=claude en .env para probar con IA real)
 */
import assert from "node:assert/strict";
import { BotEngine } from "../src/bot/engine.js";
import { createProvider } from "../src/llm/index.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore } from "../src/services/store.js";
import { seedCalendar } from "../src/data/seed.js";

// Lunes 23/11/2026 11:15 en Buenos Aires (UTC-3)
const clock = () => new Date("2026-11-23T14:15:00Z");

const provider = await createProvider();
const calendar = new InMemoryCalendar();
await seedCalendar(calendar, clock);
const store = new InMemoryStore();
const bot = new BotEngine(provider, store, calendar, clock);

const script = [
  "Hola, vi la promo de limpieza",
  "Quiero sacar un turno para mañana",
  "La 1",
  "Ana Pérez",
  "Al final no voy a poder ir, cancelo",
  "2",
  "Quiero hablar con una persona",
];

for (const text of script) {
  const r = await bot.handle({ channel: "test", userId: "+5491100000099", text, source: "promo-noviembre" });
  console.log(`\nPaciente: ${text}`);
  for (const m of r.messages) console.log(`Bot: ${m}`);
  if (r.toolCalls.length) console.log(`   ↳ herramientas: ${r.toolCalls.map((c) => c.name).join(", ")} · ${r.metric?.latencyMs} ms`);
}

const citas = await store.listAppointments();
console.log("\nCitas en la base:", citas.map((c) => `${c.status} ${c.start} ${c.patientName}`));
const busy = await calendar.listEvents(
  (await import("luxon")).DateTime.fromISO("2026-11-23"), (await import("luxon")).DateTime.fromISO("2026-12-01"),
);
console.log("Eventos en agenda:", busy.length);

if (provider.name === "mock") {
  assert.equal(citas.filter((c) => c.status === "cancelada").length, 1, "debe haber una cita cancelada");
  assert.equal(citas.filter((c) => c.status === "confirmada").length, 1, "debe haber una cita reprogramada/confirmada");
  assert.equal(busy.length, 11, "10 de ejemplo + 1 activa");
  assert.equal((await store.listHandoffs()).length, 1, "debe haber una derivación");
}

// Doble reserva: dos pacientes piden el mismo horario al mismo tiempo → solo uno lo obtiene.
const { makeExecutor } = await import("../src/bot/tools.js");
async function execFor(phone: string) {
  const patient = await store.getOrCreatePatient(phone, "test");
  const conversation = await store.getOrCreateConversation(patient, "test");
  return makeExecutor({ store, calendar, clock, patient, conversation });
}
const [e1, e2] = await Promise.all([execFor("+5491100000201"), execFor("+5491100000202")]);
const args = { tratamiento: "Consulta", inicio: "2026-11-25T11:00" };
const [r1, r2] = (await Promise.all([
  e1("crear_cita", { ...args, nombre_completo: "Paciente Uno" }),
  e2("crear_cita", { ...args, nombre_completo: "Paciente Dos" }),
])) as Array<{ ok: boolean; error?: string }>;
console.log("Doble reserva simultánea:", r1, r2);
assert.equal([r1, r2].filter((r) => r.ok).length, 1, "solo una reserva debe prosperar");
assert.equal([r1, r2].find((r) => !r.ok)?.error, "horario_ocupado");

console.log("\n✅ Smoke test OK");
