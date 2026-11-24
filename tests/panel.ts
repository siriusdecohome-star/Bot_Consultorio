/**
 * Pruebas del panel (punto 2) y de la zona de aprendizaje (punto 3), en memoria:
 * bandeja con traspaso y pausa del bot, agenda, pacientes, estadísticas, costos,
 * edición del conocimiento con efecto inmediato, documentos PDF con búsqueda y probador.
 * Uso: npm run test:panel
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { ROOT } from "../src/config.js";
import { MockProvider } from "../src/llm/mock.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore, type TurnMetric } from "../src/services/store.js";
import { demoClinics, CLINIC_A } from "../src/data/clinics/index.js";
import { demoUsers } from "../src/data/clinics/users.js";
import { buildRuntimes } from "../src/clinics/registry.js";
import { MemoryAuth } from "../src/auth.js";
import { createPanelRouter } from "../src/panel.js";
import { buildCosts, buildStats } from "../src/analytics.js";
import { chunkText } from "../src/services/textSearch.js";
import type { Services } from "../src/services/factory.js";

const clock = () => new Date("2026-11-23T14:15:00Z"); // lunes 10:15 en La Paz
const store = new InMemoryStore(clock);
const services: Services = { store, calendar: new InMemoryCalendar(), storeKind: "memoria", calendarKind: "memoria" };
const runtimes = buildRuntimes({ services, clinics: demoClinics(), provider: new MockProvider(), clock });
const A = runtimes.get(CLINIC_A)!;

for (const u of demoUsers) process.env[u.passwordVar] = `prueba-${u.passwordVar.toLowerCase()}`;
const auth = new MemoryAuth();
const app = express();
app.use("/api/panel/documents", express.json({ limit: "12mb" }));
app.use(express.json());
app.use("/api/panel", createPanelRouter({ auth, runtimes, clock, storeFor: (_u, id) => store.forClinic(id) }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/panel`;

async function cookieFor(email: string) {
  const u = demoUsers.find((x) => x.email === email)!;
  return (await auth.login(email, process.env[u.passwordVar]!, false))!.setCookie!.split(";")[0]!;
}
const admin = await cookieFor("admin@sonrisaclara.demo.test");
const recep = await cookieFor("recepcion@sonrisaclara.demo.test");
const call = async (method: string, p: string, cookie: string, body?: unknown) => {
  const r = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}clinic=${CLINIC_A}`, {
    method, headers: { cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const say = (userId: string, text: string) => A.bot.handle({ channel: "web", userId, text });

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}

try {
  // ---------------- Conversaciones ----------------
  await say("web:paciente-1", "Hola, quiero un turno para mañana");
  const convId = (await A.store.listConversations())[0]!.id;

  await check("Bandeja: lista la conversación con estado «bot»", async () => {
    const r = await call("GET", "/conversations", recep);
    assert.equal(r.status, 200);
    assert.equal(r.json.conversations[0].status, "bot");
  });

  await check("Tomar conversación: el bot deja de contestar y queda una derivación abierta", async () => {
    assert.equal((await call("POST", `/conversation/${convId}/takeover`, recep)).status, 200);
    const reply = await say("web:paciente-1", "¿Me escuchan?");
    assert.match(reply.messages.join(" "), /persona del equipo/);
    const inbox = await call("GET", "/conversations?estado=esperando", recep);
    assert.ok(inbox.json.conversations.some((c: any) => c.id === convId), "debe figurar en «Esperan respuesta»");
    assert.ok((await A.store.listHandoffs()).some((h) => h.conversationId === convId && h.status === "abierta"));
  });

  await check("Devolver al bot: cierra la derivación y el bot vuelve a responder", async () => {
    await call("POST", `/conversation/${convId}/release`, recep);
    assert.ok(!(await A.store.listHandoffs()).some((h) => h.conversationId === convId && h.status === "abierta"));
    const reply = await say("web:paciente-1", "¿Qué horarios tienen?");
    assert.doesNotMatch(reply.messages.join(" "), /persona del equipo/);
  });

  await check("Pausar el bot: el mensaje se guarda y no se responde nada", async () => {
    await call("POST", `/conversation/${convId}/pause`, recep, { paused: true });
    const reply = await say("web:paciente-1", "Hola?");
    assert.equal(reply.messages.length, 0);
    const c = await A.store.getConversation(convId);
    assert.equal(c!.messages.at(-1)!.text, "Hola?");
    const d = await call("GET", `/conversation/${convId}`, recep);
    assert.equal(d.json.status, "pausada");
    await call("POST", `/conversation/${convId}/pause`, recep, { paused: false });
    assert.ok((await say("web:paciente-1", "Quiero sacar un turno")).messages.length > 0);
  });

  // ---------------- Agenda y pacientes ----------------
  await check("Agenda: el turno reservado por el bot aparece y al cancelarlo se libera el calendario", async () => {
    let r = await say("web:paciente-2", "Quiero sacar un turno para el miércoles a las 11:00");
    r = await say("web:paciente-2", "Ana Pérez");
    assert.match(r.messages.join(" "), /Listo/);
    const ag = await call("GET", "/agenda?from=2026-11-23", recep);
    const appt = ag.json.appointments.find((a: any) => a.patient === "Ana Pérez");
    assert.ok(appt, "el turno debe estar en la agenda");
    const evId = (await A.store.getAppointment(appt.id))!.calendarEventId;
    assert.equal((await call("POST", `/appointment/${appt.id}/status`, recep, { status: "cancelada" })).status, 200);
    const after = await A.store.getAppointment(appt.id);
    assert.equal(after!.status, "cancelada");
    assert.ok(after!.cancelledAt);
    const evs = await services.calendar.listEvents(
      (await import("luxon")).DateTime.fromISO("2026-11-25T00:00", { zone: "America/La_Paz" }),
      (await import("luxon")).DateTime.fromISO("2026-11-26T00:00", { zone: "America/La_Paz" }));
    assert.ok(!evs.some((e) => e.id === evId), "el evento debe haberse borrado");
  });

  await check("Pacientes: distingue «con turno» de «solo consulta»", async () => {
    const r = await call("GET", "/patients", recep);
    const ana = r.json.patients.find((p: any) => p.name === "Ana Pérez");
    assert.equal(ana.type, "paciente");
    assert.ok(r.json.patients.some((p: any) => p.type === "consulta"));
    const leads = await call("GET", "/patients?tipo=consulta", recep);
    assert.ok(leads.json.patients.every((p: any) => p.type === "consulta"));
  });

  // ---------------- Estadísticas y costos ----------------
  await check("Estadísticas: consultas, turnos, cancelaciones, conversión y traspasos", async () => {
    const r = await call("GET", "/stats?days=7", recep);
    assert.equal(r.status, 200);
    assert.equal(r.json.daily.length, 7);
    assert.ok(r.json.totals.consultas >= 2);
    assert.equal(r.json.totals.turnosAgendados, 1);
    assert.equal(r.json.totals.turnosCancelados, 1);
    assert.ok(r.json.resolucion.traspasadas >= 1, "la conversación tomada/pausada cuenta como traspasada");
    assert.ok(r.json.conversion.tasa > 0);
  });

  await check("Costos: por mes con proyección; recepción no puede verlos", async () => {
    assert.equal((await call("GET", "/costs", recep)).status, 403);
    const m = (conv: string, at: string, costUsd: number): TurnMetric => ({ conversationId: conv, provider: "claude", model: "claude-haiku-5-5", latencyMs: 900, inputTokens: 3000, outputTokens: 200, cacheReadTokens: 0, costUsd, modelCalls: 2, tools: [], at });
    const costs = buildCosts([m("c1", "2026-11-02T15:00:00Z", 0.01), m("c1", "2026-11-02T15:01:00Z", 0.01), m("c2", "2026-11-10T15:00:00Z", 0.02), m("c3", "2026-10-30T15:00:00Z", 0.05)], "America/La_Paz", clock());
    assert.equal(costs.months[0]!.month, "2026-11");
    assert.equal(costs.months[0]!.conversations, 2);
    assert.ok(Math.abs(costs.months[0]!.costPerConversation - 0.02) < 1e-9);
    // 22,4 días transcurridos de 30 → proyección ≈ 0,04 × 30 / 22,4
    assert.ok(Math.abs(costs.currentMonth.projectedCost - 0.04 * 30 / costs.currentMonth.daysElapsed) < 0.002);
    assert.equal((await call("GET", "/costs", admin)).status, 200);
  });

  await check("Estadísticas: un turno reprogramado no se cuenta dos veces", async () => {
    const s = buildStats({ tz: "America/La_Paz", now: clock(), days: 7, patients: [], conversations: [], handoffs: [], appointments: [
      { id: "1", patientId: "p", patientName: "X", treatment: "Limpieza", start: "2026-11-24T14:00:00Z", end: "2026-11-24T14:30:00Z", status: "reprogramada", calendarEventId: "", confirmedByPatient: false, reminder24Sent: false, reminder2Sent: false, createdAt: "2026-11-20T14:00:00Z" },
      { id: "2", patientId: "p", patientName: "X", treatment: "Limpieza", start: "2026-11-25T14:00:00Z", end: "2026-11-25T14:30:00Z", status: "confirmada", calendarEventId: "", confirmedByPatient: false, reminder24Sent: false, reminder2Sent: false, createdAt: "2026-11-21T14:00:00Z" },
    ] });
    assert.equal(s.totals.turnosAgendados, 1);
    assert.deepEqual(s.tratamientos, [{ name: "Limpieza", count: 1 }]);
  });

  // ---------------- Aprendizaje ----------------
  await check("Conocimiento: el admin cambia un precio y el bot lo dice en el mensaje siguiente", async () => {
    const before = await say("web:precio-1", "¿Cuánto sale la limpieza?");
    assert.match(before.messages.join(" "), /USD 40/);
    const k = (await call("GET", "/knowledge", admin)).json.knowledge;
    k.treatments = k.treatments.map((t: any) => (t.name.startsWith("Limpieza") ? { ...t, price: "USD 45" } : t));
    k.faq = [{ q: "¿Atienden a domicilio?", a: "No, solo atendemos en el consultorio." }];
    assert.equal((await call("PUT", "/knowledge", admin, { knowledge: k })).status, 200);
    const after = await say("web:precio-1", "¿Cuánto sale la limpieza?");
    assert.match(after.messages.join(" "), /USD 45/);
    const faq = await say("web:precio-2", "¿atienden a domicilio?");
    assert.match(faq.messages.join(" "), /solo atendemos en el consultorio/);
  });

  await check("Conocimiento: recepción no puede editarlo y se rechazan horarios inválidos", async () => {
    const k = (await call("GET", "/knowledge", recep)).json;
    assert.equal(k.canEdit, false);
    assert.equal((await call("PUT", "/knowledge", recep, { knowledge: k.knowledge })).status, 403);
    const bad = { ...k.knowledge, hours: [{ weekday: 1, blocks: [["13:00", "09:00"]] }] };
    assert.equal((await call("PUT", "/knowledge", admin, { knowledge: bad })).status, 400);
  });

  await check("Documentos: un PDF se lee, se parte en fragmentos y la búsqueda encuentra la respuesta", async () => {
    const pdf = readFileSync(path.join(ROOT, "docs/ejemplos/indicaciones-post-tratamiento.pdf"));
    const up = await call("POST", "/documents", admin, { name: "indicaciones-post-tratamiento.pdf", mime: "application/pdf", dataBase64: pdf.toString("base64") });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.ok(up.json.document.chunks >= 2);
    const s = await call("GET", `/documents/search?q=${encodeURIComponent("qué no puedo tomar después del blanqueamiento")}`, recep);
    assert.match(s.json.results[0].content, /café/);
    assert.equal((await call("POST", "/documents", recep, { name: "x.txt", mime: "text/plain", dataBase64: "aG9sYQ==" })).status, 403);
  });

  await check("El bot responde con lo que encuentra en los documentos", async () => {
    const r = await say("web:doc-1", "Después del blanqueamiento, ¿puedo tomar café?");
    assert.match(r.messages.join(" "), /café/);
    assert.ok(r.toolCalls.some((t) => t.name === "buscar_en_documentos"));
  });

  await check("Probador: responde con el conocimiento actual y no aparece en la bandeja", async () => {
    const r = await call("POST", "/tester", recep, { text: "¿Cuánto sale la limpieza?", session: "prueba-1" });
    assert.equal(r.status, 200);
    assert.match(r.json.messages.join(" "), /USD 45/);
    const inbox = await call("GET", "/conversations", recep);
    assert.ok(inbox.json.conversations.every((c: any) => c.channel !== "test"));
  });

  await check("Fragmentos: respetan párrafos y no superan el tamaño máximo", async () => {
    const text = Array.from({ length: 12 }, (_, i) => `Párrafo ${i}. ${"palabra ".repeat(40)}`).join("\n\n");
    const chunks = chunkText(text, 900);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 900));
  });
} finally {
  server.close();
}

const passed = results.filter(([, ok]) => ok).length;
for (const [name, ok] of results) console.log(`  ${ok ? "✅" : "❌"} ${name}`);
console.log(`\n${passed === results.length ? "✅" : "❌"} ${passed}/${results.length} OK`);
process.exitCode = passed === results.length ? 0 : 1;
