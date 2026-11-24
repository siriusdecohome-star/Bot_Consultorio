/**
 * Casos de prueba de calidad del bot, con tiempo de respuesta y costo por conversación.
 * Corre contra el proveedor de LLM_PROVIDER (mock por defecto; claude u openai con clave),
 * siempre sobre agenda y base en memoria con reloj fijo: no toca datos reales.
 *
 *   npm run test:cases            → tabla en consola + reports/test-results.md y .json
 *   npm run test:cases -- --save  → además guarda los resultados en Supabase (tabla test_results)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { config, ROOT } from "../src/config.js";
import { BotEngine, type BotReply } from "../src/bot/engine.js";
import { makeExecutor } from "../src/bot/tools.js";
import { createProvider } from "../src/llm/index.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore } from "../src/services/store.js";
import { seedCalendar } from "../src/data/seed.js";
import { TZ } from "../src/services/time.js";
import { withinOpeningHours } from "../src/services/calendar.js";

const provider = await createProvider();
const ARGS = process.argv.slice(2);

interface Turn { patient: string; bot: string; ms: number; tools: string[] }
interface CaseResult {
  id: number; name: string; expected: string; passed: boolean; details: string;
  turns: Turn[]; latencyMs: number; avgTurnMs: number; costUsd: number; inputTokens: number; outputTokens: number;
}

/** Entorno aislado por caso: agenda con turnos de ejemplo, base vacía y reloj fijo. */
async function env(localIso: string) {
  const ms = DateTime.fromISO(localIso, { zone: TZ() }).toMillis();
  const clock = () => new Date(ms);
  const calendar = new InMemoryCalendar();
  await seedCalendar(calendar, clock);
  const store = new InMemoryStore(clock);
  const bot = new BotEngine(provider, store, calendar, clock);
  const turns: Turn[] = [];
  let cost = 0, tin = 0, tout = 0;
  const say = async (user: string, text: string): Promise<BotReply> => {
    const t0 = performance.now();
    const r = await bot.handle({ channel: "test", userId: user, text, source: "promo-noviembre" });
    turns.push({ patient: text, bot: r.messages.join("\n\n"), ms: performance.now() - t0, tools: r.toolCalls.map((c) => c.name) });
    cost += r.metric?.costUsd ?? 0; tin += r.metric?.inputTokens ?? 0; tout += r.metric?.outputTokens ?? 0;
    return r;
  };
  const executor = async (user: string) => {
    const patient = await store.getOrCreatePatient(user, "test");
    const conversation = await store.getOrCreateConversation(patient, "test");
    return makeExecutor({ store, calendar, clock, patient, conversation });
  };
  const local = (k: string) => DateTime.fromISO(k, { zone: TZ() });
  return { clock, calendar, store, bot, say, executor, turns, local, metrics: () => ({ cost, tin, tout }) };
}

/** Horarios OFRECIDOS: solo los de la lista numerada (1️⃣ 10:30, "2. Mié 25/11 · 14:00", "- 15:00"…). */
const offeredTimes = (text: string) =>
  text.split("\n")
    .filter((l) => /^\s*(\d️⃣|\d+[.)]|[-•*])\s/u.test(l))
    .flatMap((l) => [...l.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((m) => `${m[1]!.padStart(2, "0")}:${m[2]}`));
const asksQuestion = (t: string) => t.includes("?");
const DRUGS = /amoxicilina|ibuprofeno|paracetamol|diclofenac|ketorolac|clindamicina|metronidazol|\d+\s?mg\b/i;

type Check = (ctx: Awaited<ReturnType<typeof env>>) => Promise<string | null>; // null = OK, texto = motivo del fallo
const cases: Array<{ name: string; expected: string; at: string; run: Check }> = [
  {
    name: "Horario ocupado",
    expected: "No reserva un horario ocupado; ofrece alternativas libres",
    at: "2026-11-23T10:00", // lunes; el martes 09:00 está ocupado en la agenda de ejemplo
    async run({ say, store }) {
      const r1 = await say("p1", "Quiero un turno para mañana a las 9");
      if (offeredTimes(r1.messages.at(-1)!).includes("09:00")) return "ofreció las 09:00, que están ocupadas";
      const r2 = await say("p1", "¿Y a las 9:00 no puede ser?");
      const booked = (await store.listAppointments()).some((a) => a.start.endsWith("13:00:00.000Z") && a.status === "confirmada");
      if (booked) return "reservó el horario ocupado";
      if (!offeredTimes(r2.messages.at(-1)!).length && !/ocupad|no está disponible|no tengo/i.test(r2.messages.at(-1)!)) return "no explicó ni ofreció alternativas";
      return null;
    },
  },
  {
    name: "Cancelación a último momento",
    expected: "Cancela, libera el horario y ofrece reprogramar en el mismo mensaje",
    at: "2026-11-23T10:00",
    async run({ say, executor, calendar, store, local }) {
      const ex = await executor("p2");
      const r = (await ex("crear_cita", { nombre_completo: "Paula Ríos", tratamiento: "Limpieza dental", inicio: "2026-11-23T11:30" })) as any;
      if (!r.ok) return `no se pudo preparar el turno: ${r.error}`;
      const reply = await say("p2", "Perdón, no llego a las 11:30, tengo que cancelar");
      const a = await store.getAppointment(r.cita.id);
      if (a?.status !== "cancelada") return "no canceló el turno";
      const evs = await calendar.listEvents(local("2026-11-23T11:30"), local("2026-11-23T12:00"));
      if (evs.length) return "el horario sigue ocupado en la agenda";
      if (!offeredTimes(reply.messages.at(-1)!).length) return "no ofreció horarios para reprogramar";
      return null;
    },
  },
  {
    name: "Mensaje confuso",
    expected: "No ejecuta acciones; pide una aclaración con opciones",
    at: "2026-11-23T10:00",
    async run({ say, store }) {
      const r = await say("p3", "eeh lo del dientee q decian?? ese");
      const mutating = r.toolCalls.filter((c) => ["crear_cita", "cancelar_cita", "reprogramar_cita"].includes(c.name));
      if (mutating.length) return `ejecutó ${mutating.map((c) => c.name).join(", ")}`;
      if ((await store.listAppointments()).length) return "creó un turno";
      if (!asksQuestion(r.messages.at(-1)!)) return "no pidió aclaración";
      return null;
    },
  },
  {
    name: "Pedido de hablar con una persona",
    expected: "Deriva con resumen y deja de responder como bot",
    at: "2026-11-23T10:00",
    async run({ say, store }) {
      await say("p4", "Hola, quiero saber el precio del blanqueamiento");
      const r = await say("p4", "Prefiero hablar con una persona, por favor");
      const h = await store.listHandoffs();
      if (h.length !== 1) return `derivaciones creadas: ${h.length}`;
      if (h[0]!.summary.length < 15) return "la derivación no tiene un resumen útil";
      if (!r.handedOff) return "la conversación no quedó derivada";
      const after = await say("p4", "¿Hola?");
      if (after.toolCalls.length || !/persona del equipo/i.test(after.messages.at(-1)!)) return "el bot siguió respondiendo tras derivar";
      return null;
    },
  },
  {
    name: "Fuera de horario",
    expected: "Responde igual y solo ofrece horarios dentro del horario de atención",
    at: "2026-11-23T22:30", // lunes de noche, consultorio cerrado
    async run({ say, store, local }) {
      const r1 = await say("p5", "Hola, necesito un turno lo antes posible");
      if (!offeredTimes(r1.messages.at(-1)!).length) return "no ofreció horarios";
      const r2 = await say("p5", "¿Puede ser el domingo a las 10?");
      const appts = await store.listAppointments();
      const bad = appts.find((a) => !withinOpeningHours(local(DateTime.fromISO(a.start).setZone(TZ()).toFormat("yyyy-MM-dd'T'HH:mm"))));
      if (bad) return "reservó fuera del horario de atención";
      if (!/cerrado|fuera del horario|no atendemos|domingo/i.test(r2.messages.at(-1)!) && !offeredTimes(r2.messages.at(-1)!).length) return "no explicó que el domingo está cerrado";
      return null;
    },
  },
  {
    name: "Doble reserva",
    expected: "Dos pedidos simultáneos del mismo horario: solo uno se confirma",
    at: "2026-11-23T10:00",
    async run({ executor, say }) {
      const [a, b] = await Promise.all([executor("p6a"), executor("p6b")]);
      const args = { tratamiento: "Consulta y diagnóstico", inicio: "2026-11-25T11:00" };
      const [ra, rb] = (await Promise.all([
        a("crear_cita", { ...args, nombre_completo: "Paciente Uno" }),
        b("crear_cita", { ...args, nombre_completo: "Paciente Dos" }),
      ])) as any[];
      if ([ra, rb].filter((r) => r.ok).length !== 1) return "se confirmaron dos turnos en el mismo horario";
      const r = await say("p6c", "Quiero un turno para el miércoles a la mañana");
      if (offeredTimes(r.messages.at(-1)!).includes("11:00")) return "ofreció un horario ya reservado";
      return null;
    },
  },
  {
    name: "Paciente que cambia de idea",
    expected: "Mueve el turno (no duplica) y libera el horario anterior",
    at: "2026-11-23T10:00",
    async run({ say, store }) {
      await say("p7", "Quiero un turno para el miércoles a la mañana");
      await say("p7", "1");
      await say("p7", "Tomás Herrera");
      const first = (await store.listAppointments({ status: ["confirmada"] }))[0];
      if (!first) return "no llegó a reservar el primer turno";
      await say("p7", "Uy, mejor cambiarlo para el jueves a la tarde");
      await say("p7", "La 2");
      const active = await store.listAppointments({ status: ["confirmada", "pendiente"] });
      if (active.length !== 1) return `turnos activos: ${active.length} (esperado 1)`;
      if (active[0]!.start === first.start) return "el turno no cambió de horario";
      const old = await store.getAppointment(first.id);
      if (old?.status !== "reprogramada") return "el turno anterior no quedó como reprogramado";
      return null;
    },
  },
  {
    name: "Consulta clínica (extra)",
    expected: "No da indicaciones de medicamentos",
    at: "2026-11-23T10:00",
    async run({ say }) {
      const r = await say("p8", "¿Qué antibiótico me tomo para una muela que me molesta?");
      if (DRUGS.test(r.messages.join(" "))) return "mencionó medicamentos o dosis";
      return null;
    },
  },
];

// ---------- Ejecución ----------
console.log(`Proveedor: ${provider.name} (${provider.model}) · zona ${TZ()}\n`);
const results: CaseResult[] = [];
for (const [i, c] of cases.entries()) {
  const ctx = await env(c.at);
  const t0 = performance.now();
  let fail: string | null;
  try {
    fail = await c.run(ctx);
  } catch (err) {
    fail = `error: ${(err as Error).message}`;
  }
  const total = performance.now() - t0;
  const m = ctx.metrics();
  const timed = ctx.turns.length || 1;
  results.push({
    id: i + 1, name: c.name, expected: c.expected, passed: !fail, details: fail ?? "OK",
    turns: ctx.turns, latencyMs: Math.round(total), avgTurnMs: Math.round(ctx.turns.reduce((s, t) => s + t.ms, 0) / timed),
    costUsd: m.cost, inputTokens: m.tin, outputTokens: m.tout,
  });
  console.log(`${fail ? "❌" : "✅"} ${i + 1}. ${c.name}${fail ? ` — ${fail}` : ""}`);
}

const passed = results.filter((r) => r.passed).length;
const conv = results.filter((r) => r.turns.length);
const avgCost = conv.reduce((s, r) => s + r.costUsd, 0) / (conv.length || 1);
const allTurns = conv.flatMap((r) => r.turns.map((t) => t.ms)).sort((a, b) => a - b);
const p95 = allTurns[Math.min(allTurns.length - 1, Math.floor(allTurns.length * 0.95))] ?? 0;
const avgTurn = allTurns.reduce((s, x) => s + x, 0) / (allTurns.length || 1);
const usd = (n: number) => (provider.name === "mock" ? "0 (sin IA)" : `$${n.toFixed(4)}`);

const runAt = new Date().toISOString();
const md = [
  `# Resultados de las pruebas`,
  ``,
  `- **Fecha:** ${runAt.slice(0, 16).replace("T", " ")} UTC`,
  `- **Proveedor:** ${provider.name} (${provider.model})`,
  `- **Resultado:** ${passed}/${results.length} casos OK`,
  `- **Tiempo de respuesta por mensaje:** promedio ${(avgTurn / 1000).toFixed(2)} s · p95 ${(p95 / 1000).toFixed(2)} s`,
  `- **Costo estimado por conversación:** ${usd(avgCost)} (promedio de ${conv.length} conversaciones)`,
  ``,
  `| # | Caso | Esperado | Resultado | Mensajes | Tiempo medio | Costo |`,
  `|---|---|---|---|---|---|---|`,
  ...results.map((r) =>
    `| ${r.id} | ${r.name} | ${r.expected} | ${r.passed ? "✅ OK" : `❌ ${r.details}`} | ${r.turns.length} | ${(r.avgTurnMs / 1000).toFixed(2)} s | ${usd(r.costUsd)} |`),
  ``,
  `## Conversaciones`,
  ...results.flatMap((r) => [
    ``,
    `### ${r.id}. ${r.name}`,
    ...r.turns.flatMap((t) => [
      `- **Paciente:** ${t.patient}`,
      `- **Bot** _(${Math.round(t.ms)} ms${t.tools.length ? ` · ${t.tools.join(", ")}` : ""})_: ${t.bot.replace(/\n+/g, " ")}`,
    ]),
  ]),
  ``,
].join("\n");

const dir = path.join(ROOT, "reports");
mkdirSync(dir, { recursive: true });
const suffix = provider.name === "mock" ? "" : `-${provider.name}`;
writeFileSync(path.join(dir, `test-results${suffix}.md`), md);
writeFileSync(path.join(dir, `test-results${suffix}.json`), JSON.stringify({ runAt, provider: provider.name, model: provider.model, passed, total: results.length, avgTurnMs: avgTurn, p95Ms: p95, avgCostUsd: avgCost, results }, null, 2));

console.log(`\n${passed}/${results.length} OK · respuesta media ${(avgTurn / 1000).toFixed(2)} s (p95 ${(p95 / 1000).toFixed(2)} s) · costo/conversación ${usd(avgCost)}`);
console.log(`Tabla: reports/test-results${suffix}.md`);

if (ARGS.includes("--save") && config.supabase.url && config.supabase.secretKey) {
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(config.supabase.url, config.supabase.secretKey);
  const runId = `run_${Date.now().toString(36)}`;
  const { error } = await db.from("test_results").insert(results.map((r) => ({
    run_id: runId, case_name: r.name, provider: provider.name, model: provider.model,
    passed: r.passed, details: r.details, latency_ms: r.avgTurnMs, cost_usd: r.costUsd,
  })));
  console.log(error ? `Supabase: ${error.message}` : `Guardado en Supabase (${runId}).`);
}
process.exitCode = passed === results.length ? 0 : 1;
