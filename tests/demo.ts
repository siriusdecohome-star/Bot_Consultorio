/**
 * Pruebas de la demo pública (etapa 4), en memoria:
 * - «Entrar al demo» crea una clínica temporal con datos y una sesión de admin SOLO de esa clínica;
 * - aislamiento: no ve otras clínicas, sus datos no pisan los de otra, no escribe en Google Calendar;
 * - el simulador entra por la misma función que el webhook y el chat aparece en la bandeja;
 * - límites por IP y de demos abiertas; borrado al vencer;
 * - tope de IA por visita y por día: al agotarse responde el modo sin IA, sin cortar la conversación.
 * Uso: npm run test:demo
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { MockProvider } from "../src/llm/mock.js";
import type { LlmProvider, TurnInput, TurnResult } from "../src/llm/types.js";
import { emptyUsage } from "../src/llm/types.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore } from "../src/services/store.js";
import { demoClinics, CLINIC_A, CLINIC_B } from "../src/data/clinics/index.js";
import { buildRuntimes, type ClinicRuntime } from "../src/clinics/registry.js";
import { MemoryAuth } from "../src/auth.js";
import { createPanelRouter } from "../src/panel.js";
import { DemoLimitError, DemoService } from "../src/demo/tempClinics.js";
import { receiveMessage } from "../src/channels/inbound.js";
import type { Services } from "../src/services/factory.js";

/** «IA real» de prueba: responde como el modo sin IA pero se registra como Claude (para contar el tope). */
class FakeClaude implements LlmProvider {
  readonly name = "claude";
  readonly model = "claude-haiku-5-5";
  private mock = new MockProvider();
  async runTurn(input: TurnInput): Promise<TurnResult> {
    const r = await this.mock.runTurn(input);
    return { ...r, usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 100, costUsd: 0.00015 }, modelCalls: 1 };
  }
}

let nowMs = new Date("2026-11-23T14:15:00Z").getTime();
const clock = () => new Date(nowMs);
const store = new InMemoryStore(clock);
const calendar = new InMemoryCalendar();
const services: Services = { store, calendar, storeKind: "memoria", calendarKind: "memoria" };
const provider = new FakeClaude();
const fallback = new MockProvider("tope de IA de la demo");
const auth = new MemoryAuth();
const runtimes = new Map<string, ClinicRuntime>();
const clinics = demoClinics();
const demo = new DemoService({
  services, runtimes, provider, fallback, clock, auth, template: clinics[0]!,
  limits: { enabled: true, hours: 24, maxActive: 3, perIpPerDay: 2, aiPerVisit: 3, aiDaily: 5 },
});
for (const [id, rt] of buildRuntimes({ services, clinics, provider, clock, aiBudgetFor: (p) => demo.budgetFor(p), fallbackProvider: fallback })) runtimes.set(id, rt);

const app = express();
app.use(express.json());
app.use("/api/panel", createPanelRouter({ auth, runtimes, clock, storeFor: (_u, id) => store.forClinic(id) }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/panel`;
const call = async (p: string, cookie: string, clinic: string) => {
  const r = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}clinic=${clinic}`, { headers: { cookie } });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}

let first = { clinicId: "", cookie: "" };
try {
  const altamiraPatients = (await store.forClinic(CLINIC_B).listPatients()).length;

  await check("«Entrar al demo»: clínica temporal con 30 días de datos y sesión de admin solo de esa clínica", async () => {
    const r = await demo.start("10.0.0.1", false);
    first = { clinicId: r.clinicId, cookie: r.session.setCookie!.split(";")[0]! };
    assert.match(r.clinicId, /^demo-[0-9a-f]{10}$/);
    const rt = runtimes.get(r.clinicId)!;
    assert.ok(rt.profile.expiresAt);
    assert.ok((await rt.store.listPatients()).length > 50, "carga los datos de ejemplo");
    assert.ok((await rt.store.listDocuments()).length === 1, "y el documento de ejemplo");
    assert.ok(rt.profile.professionals.every((p) => p.calendar === "interno"), "sin Google Calendar");
    const me = await call("/me", first.cookie, r.clinicId);
    assert.deepEqual(me.json.clinics.map((c: any) => [c.id, c.role]), [[r.clinicId, "admin"]]);
    assert.equal((await call("/summary", first.cookie, r.clinicId)).status, 200);
  });

  await check("Aislamiento: el visitante no entra a otras clínicas y sus datos no pisan los de otra", async () => {
    assert.equal((await call("/summary", first.cookie, CLINIC_A)).status, 403);
    assert.equal((await call("/conversations", first.cookie, CLINIC_B)).status, 403);
    assert.equal((await store.forClinic(CLINIC_B).listPatients()).length, altamiraPatients, "Altamira queda igual");
    const ids = new Set((await store.forClinic(CLINIC_A).listPatients()).map((p) => p.id));
    assert.ok((await runtimes.get(first.clinicId)!.store.listPatients()).every((p) => !ids.has(p.id)), "ids propios");
  });

  await check("El simulador entra por la misma función que WhatsApp: el turno no toca Google y el chat aparece en la bandeja", async () => {
    const rt = runtimes.get(first.clinicId)!;
    const before = (await calendar.listEvents(rt.calendar ? (await import("luxon")).DateTime.fromISO("2026-11-20") : null as any, (await import("luxon")).DateTime.fromISO("2026-12-31"))).length;
    await receiveMessage(rt.bot, { channel: "web", from: "web:visitante1", text: "Quiero sacar un turno de consulta y diagnóstico para el miércoles a las 11:00" });
    const r = await receiveMessage(rt.bot, { channel: "web", from: "web:visitante1", text: "Ana Prueba" });
    assert.match(r.messages.join(" "), /Listo/);
    const after = (await calendar.listEvents((await import("luxon")).DateTime.fromISO("2026-11-20"), (await import("luxon")).DateTime.fromISO("2026-12-31"))).length;
    assert.equal(after, before, "la demo no escribe en el calendario compartido");
    const inbox = await call("/conversations?filtro=todas", first.cookie, first.clinicId);
    assert.ok(inbox.json.conversations.some((c: any) => c.channel === "web" && c.patient === "Ana Prueba"));
  });

  await check("Tope de IA por visita: después de N mensajes responde el modo sin IA y la conversación sigue", async () => {
    const rt = runtimes.get(first.clinicId)!;
    // Ya van 2 mensajes con IA (los de la reserva); el tope de la visita es 3.
    await receiveMessage(rt.bot, { channel: "web", from: "web:visitante2", text: "¿Cuánto sale una limpieza?" });
    const r = await receiveMessage(rt.bot, { channel: "web", from: "web:visitante2", text: "¿Dónde quedan?" });
    assert.ok(r.messages.length > 0, "responde igual");
    assert.equal(r.metric?.provider, "mock", "ese mensaje lo respondió el modo sin IA");
    const metrics = await rt.store.listMetrics();
    assert.equal(metrics.filter((m) => m.provider === "claude" && !m.model.includes("(simulado)")).length, 3);
  });

  await check("Tope diario entre todas las demos: otra visita también pasa al modo sin IA al llegar al total", async () => {
    nowMs += 60_000;
    const r = await demo.start("10.0.0.2", false);
    const rt = runtimes.get(r.clinicId)!;
    const replies = [];
    for (const t of ["¿Atienden niños?", "¿Tienen estacionamiento?", "¿Aceptan tarjeta?"]) replies.push(await receiveMessage(rt.bot, { channel: "web", from: "web:v3", text: t }));
    assert.deepEqual(replies.map((x) => x.metric?.provider), ["claude", "claude", "mock"], "3 + 2 = 5 por día");
  });

  await check("Clínicas reales: sin tope (siempre la IA configurada)", async () => {
    const A = runtimes.get(CLINIC_A)!;
    for (let i = 0; i < 4; i++) {
      const r = await receiveMessage(A.bot, { channel: "web", from: `web:real${i}`, text: "¿Cuánto sale una limpieza?" });
      assert.equal(r.metric?.provider, "claude");
    }
  });

  await check("Límites: demos por IP por día y demos abiertas a la vez", async () => {
    await demo.start("10.0.0.1", false); // segunda del mismo IP: permitida (límite 2)
    await assert.rejects(demo.start("10.0.0.1", false), DemoLimitError, "tercera del mismo IP");
    await assert.rejects(demo.start("10.0.0.9", false), DemoLimitError, "ya hay 3 abiertas");
  });

  await check("Vencimiento: a las 24 h se borra la clínica, sus datos y la sesión del visitante", async () => {
    const id = first.clinicId;
    nowMs += 25 * 3_600_000;
    const n = await demo.cleanup();
    assert.equal(n, 3);
    assert.equal(runtimes.has(id), false);
    assert.equal((await store.forClinic(id).listPatients()).length, 0);
    assert.equal((await store.forClinic(id).listConversations()).length, 0);
    assert.equal((await call("/me", first.cookie, id)).status, 401, "la sesión ya no sirve");
    assert.ok(runtimes.has(CLINIC_A) && runtimes.has(CLINIC_B), "las clínicas reales siguen");
    await demo.start("10.0.0.9", false); // con las vencidas borradas, se puede abrir otra
  });
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

const ok = results.filter(([, p]) => p).length;
for (const [name, passed] of results) if (passed) console.log(`  ✅ ${name}`);
console.log(`\n${ok === results.length ? "✅" : "❌"} ${ok}/${results.length} OK`);
process.exitCode = ok === results.length ? 0 : 1;
