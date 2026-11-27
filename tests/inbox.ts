/**
 * Pruebas de la bandeja, la ficha y el menú (etapa «bandeja, ficha y UX»), en memoria:
 * - cada estado (esperando, con el bot, con una persona, pausada, cerrada) y sus transiciones;
 * - cierre automático (inactividad, turno confirmado o cancelado) y reapertura;
 * - contadores coherentes entre la bandeja, la pestaña y el resumen;
 * - ficha editable (nombre real que se propaga, nombre de WhatsApp aparte, etiquetas, notas);
 * - herramienta que guarda el nombre real; menú inicial con botones o lista;
 * - los horarios editados limitan los turnos que ofrece la herramienta;
 * - datos de ejemplo: todos los estados, sin «(demo)», nuevos ≤ consultas.
 * Uso: npm run test:inbox
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { MockProvider } from "../src/llm/mock.js";
import { InMemoryCalendar } from "../src/services/calendar.js";
import { InMemoryStore } from "../src/services/store.js";
import { demoClinics, CLINIC_A, CLINIC_B } from "../src/data/clinics/index.js";
import { demoUsers } from "../src/data/clinics/users.js";
import { buildRuntimes } from "../src/clinics/registry.js";
import { MemoryAuth } from "../src/auth.js";
import { createPanelRouter } from "../src/panel.js";
import { buildStats } from "../src/analytics.js";
import { closeIdleConversations, conversationState, inboxCounts } from "../src/bot/conversationState.js";
import { isMenuRequest, matchMenuOption, menuInteractive, validateMenu } from "../src/bot/menu.js";
import { makeExecutor } from "../src/bot/tools.js";
import { buildDemoData } from "../src/data/demoData.js";
import { withClinic } from "../src/clinics/context.js";
import type { Services } from "../src/services/factory.js";

let now = new Date("2026-11-23T14:15:00Z"); // lunes 10:15 en La Paz
const clock = () => now;
const store = new InMemoryStore(clock);
const calendar = new InMemoryCalendar();
const services: Services = { store, calendar, storeKind: "memoria", calendarKind: "memoria" };
const runtimes = buildRuntimes({ services, clinics: demoClinics(), provider: new MockProvider(), clock });
const A = runtimes.get(CLINIC_A)!;

for (const u of demoUsers) process.env[u.passwordVar] = `prueba-${u.passwordVar.toLowerCase()}`;
const auth = new MemoryAuth();
const app = express();
app.use(express.json());
app.use("/api/panel", createPanelRouter({ auth, runtimes, clock, storeFor: (_u, id) => store.forClinic(id) }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/panel`;
const u = demoUsers.find((x) => x.email === "recepcion@sonrisaclara.demo.test")!;
const recep = (await auth.login(u.email, process.env[u.passwordVar]!, false))!.setCookie!.split(";")[0]!;
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}clinic=${CLINIC_A}`, {
    method, headers: { cookie: recep, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
const say = (userId: string, text: string, profileName?: string) => A.bot.handle({ channel: "web", userId, text, profileName });
/** Pide un turno y, si el bot pregunta especialidad o profesional, elige la opción 1. */
const askTurn = async (userId: string, text: string) => {
  let r = await say(userId, text);
  for (let i = 0; i < 2 && /especialidad|con quién prefiere/i.test(r.messages.at(-1) ?? ""); i++) r = await say(userId, "1");
  return r;
};
const convOf = async (userId: string) => {
  const p = (await A.store.listPatients()).find((x) => x.phone === userId)!;
  return (await A.store.listConversations()).find((c) => c.patientId === p.id)!;
};
const stateOf = async (userId: string) => conversationState(await convOf(userId));
const advance = (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); };

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}

try {
  // ---------------- Estados y transiciones ----------------
  await check("Estado «con el bot»: una consulta nueva", async () => {
    await say("web:estado-1", "¿Cuánto sale una limpieza?");
    assert.equal(await stateOf("web:estado-1"), "bot");
  });

  await check("Bot → esperando: derivación del bot sin respuesta de recepción", async () => {
    await say("web:estado-1", "Quiero hablar con una persona");
    assert.equal(await stateOf("web:estado-1"), "esperando");
  });

  await check("Esperando → con una persona: recepción responde (queda asignada)", async () => {
    const c = await convOf("web:estado-1");
    assert.equal((await call("POST", `/conversation/${c.id}/reply`, { text: "Hola, le atiendo yo." })).status, 200);
    const after = await convOf("web:estado-1");
    assert.equal(conversationState(after), "persona");
    assert.equal(after.assignedTo, u.email);
    const last = after.messages.at(-1)!;
    assert.equal(last.role, "human");
    assert.equal(last.by, u.email, "el mensaje guarda quién lo escribió");
  });

  await check("Con una persona → esperando: el paciente vuelve a escribir", async () => {
    await say("web:estado-1", "Gracias, ¿y el precio?");
    assert.equal(await stateOf("web:estado-1"), "esperando");
  });

  await check("Devolver al bot → con el bot, sin derivaciones abiertas", async () => {
    const c = await convOf("web:estado-1");
    await call("POST", `/conversation/${c.id}/release`);
    assert.equal(await stateOf("web:estado-1"), "bot");
    assert.ok(!(await A.store.listHandoffs()).some((h) => h.conversationId === c.id && h.status === "abierta"));
  });

  await check("Responder desde el panel a una conversación del bot la toma (el bot deja de contestar)", async () => {
    await say("web:estado-2", "Hola, ¿atienden obras sociales?");
    const c = await convOf("web:estado-2");
    await call("POST", `/conversation/${c.id}/reply`, { text: "Sí, le paso el detalle." });
    assert.equal(await stateOf("web:estado-2"), "persona");
    const r = await say("web:estado-2", "Perfecto");
    assert.match(r.messages.join(" "), /persona del equipo/);
  });

  await check("Pausada: sin mensajes nuevos queda «pausada»; si el paciente escribe, «esperando»", async () => {
    await say("web:estado-3", "Hola, quiero un presupuesto");
    const c = await convOf("web:estado-3");
    await call("POST", `/conversation/${c.id}/pause`, { paused: true });
    assert.equal(await stateOf("web:estado-3"), "pausada");
    const r = await say("web:estado-3", "¿Hola?");
    assert.equal(r.messages.length, 0, "en pausa el bot no responde");
    assert.equal(await stateOf("web:estado-3"), "esperando");
    await call("POST", `/conversation/${c.id}/pause`, { paused: false });
    assert.equal(await stateOf("web:estado-3"), "bot");
  });

  await check("Cerrar a mano → cerrada (resuelve derivaciones); reabrir → vuelve al bot", async () => {
    await say("web:estado-4", "Prefiero hablar con una persona");
    const c = await convOf("web:estado-4");
    await call("POST", `/conversation/${c.id}/close`);
    const closed = await convOf("web:estado-4");
    assert.equal(conversationState(closed), "cerrada");
    assert.equal(closed.closedReason, "manual");
    assert.ok(!(await A.store.listHandoffs()).some((h) => h.conversationId === c.id && h.status === "abierta"));
    await call("POST", `/conversation/${c.id}/reopen`);
    assert.equal(await stateOf("web:estado-4"), "bot");
  });

  // ---------------- Cierre automático y reapertura ----------------
  await check("Cierre automático al confirmar un turno", async () => {
    await askTurn("web:cierre-1", "Quiero sacar un turno para el miércoles a las 11:00");
    const r = await say("web:cierre-1", "Ana Pérez");
    assert.match(r.messages.join(" "), /Listo/);
    const c = await convOf("web:cierre-1");
    assert.equal(conversationState(c), "cerrada");
    assert.equal(c.closedReason, "turno_confirmado");
  });

  await check("Reapertura: el paciente vuelve a escribir y la conversación se reabre con el bot", async () => {
    const r = await say("web:cierre-1", "¿Dónde quedan?");
    assert.ok(r.messages.length > 0);
    const c = await convOf("web:cierre-1");
    assert.equal(conversationState(c), "bot");
    assert.ok(c.messages.some((m) => m.role === "system" && /reabierta/.test(m.text)));
  });

  await check("Cierre automático al cancelar un turno", async () => {
    await say("web:cierre-1", "Quiero cancelar mi turno");
    const c = await convOf("web:cierre-1");
    assert.equal(conversationState(c), "cerrada");
    assert.equal(c.closedReason, "turno_cancelado");
  });

  await check("Cierre por inactividad: solo las del bot o con una persona; las que esperan respuesta no", async () => {
    await say("web:idle-1", "¿Cuánto sale un blanqueamiento?"); // con el bot
    await say("web:idle-2", "Prefiero hablar con una persona"); // esperando
    advance(25 * 60);
    const n = await closeIdleConversations(A.store, now, 24);
    assert.ok(n >= 1);
    assert.equal(await stateOf("web:idle-1"), "cerrada");
    assert.equal((await convOf("web:idle-1")).closedReason, "inactividad");
    assert.equal(await stateOf("web:idle-2"), "esperando", "no se esconde lo que espera respuesta");
    assert.equal(await stateOf("web:estado-3"), "cerrada", "la que volvió al bot también se cierra");
  });

  // ---------------- Contadores coherentes ----------------
  await check("Contadores: bandeja, pestaña y resumen dan lo mismo", async () => {
    const inbox = await call("GET", "/conversations?filtro=todas");
    const counts = await call("GET", "/inbox/counts");
    const summary = await call("GET", "/summary");
    const states = inbox.json.conversations.map((c: any) => c.state);
    assert.deepEqual(inbox.json.counts, inboxCounts(states));
    assert.deepEqual(counts.json.counts, inbox.json.counts);
    assert.equal(summary.json.kpis.waiting, counts.json.counts.esperando);
    assert.equal(summary.json.waiting.length, counts.json.counts.esperando);
    assert.equal(summary.json.kpis.openHandoffs, summary.json.handoffs.length, "el número de derivaciones coincide con la lista");
    assert.ok(summary.json.handoffs.every((h: any) => h.status === "abierta"), "la lista solo muestra las abiertas");
    const esperando = await call("GET", "/conversations?filtro=esperando");
    assert.equal(esperando.json.conversations.length, counts.json.counts.esperando);
    const activas = await call("GET", "/conversations");
    assert.equal(activas.json.filter, "activas", "la vista por defecto es «Activas»");
    assert.ok(activas.json.conversations.every((c: any) => ["esperando", "bot", "persona"].includes(c.state)));
  });

  // ---------------- Ficha del paciente ----------------
  await check("Ficha: el nombre del perfil de WhatsApp se guarda aparte del nombre real", async () => {
    await say("web:ficha-1", "Hola, ¿tienen turno el jueves?", "Lu 🌸");
    const p = (await A.store.listPatients()).find((x) => x.phone === "web:ficha-1")!;
    assert.equal(p.profileName, "Lu 🌸");
    assert.equal(p.name, null);
  });

  await check("Ficha: editar nombre, teléfono, notas y etiquetas; el nombre se ve en agenda, bandeja y pacientes", async () => {
    await askTurn("web:ficha-2", "Quiero sacar un turno para el jueves a las 11:00");
    await say("web:ficha-2", "Juan Gomez");
    const p = (await A.store.listPatients()).find((x) => x.phone === "web:ficha-2")!;
    assert.equal(p.name, "Juan Gomez");
    const r = await call("PUT", `/patient/${p.id}`, { name: "Juan Gómez Ruiz", contactPhone: "+54 9 11 5555-0000", notes: "Prefiere tarde", tags: ["VIP", "Ortodoncia", "VIP"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.patient.tags, ["VIP", "Ortodoncia"]);
    const agenda = await call("GET", "/agenda?from=2026-11-23");
    assert.ok(agenda.json.appointments.some((a: any) => a.patient === "Juan Gómez Ruiz"));
    assert.ok((await A.store.listAppointments({ patientId: p.id })).every((a) => a.patientName === "Juan Gómez Ruiz"), "se propaga a los turnos");
    const inbox = await call("GET", "/conversations?filtro=todas&q=ortodoncia");
    assert.ok(inbox.json.conversations.some((c: any) => c.patient === "Juan Gómez Ruiz"), "se busca por etiqueta");
    const pats = await call("GET", "/patients?q=juan");
    assert.equal(pats.json.patients[0].name, "Juan Gómez Ruiz");
    const ficha = await call("GET", `/patient/${p.id}`);
    assert.equal(ficha.json.patient.notes, "Prefiere tarde");
    assert.equal(ficha.json.patient.contactPhone, "+54 9 11 5555-0000");
  });

  await check("Ficha: valida teléfono y etiquetas", async () => {
    const p = (await A.store.listPatients()).find((x) => x.phone === "web:ficha-2")!;
    assert.equal((await call("PUT", `/patient/${p.id}`, { contactPhone: "llamar a la tarde" })).status, 400);
    assert.equal((await call("PUT", `/patient/${p.id}`, { tags: ["x".repeat(30)] })).status, 400);
  });

  await check("Herramienta guardar_nombre_paciente: guarda el nombre real y lo propaga", async () => {
    const r = await askTurn("web:nombre-1", "Hola, quiero un turno para el viernes a las 10:00");
    assert.match(r.messages.join(" "), /nombre y apellido/);
    const r2 = await say("web:nombre-1", "me llamo maría lópez");
    assert.ok(r2.toolCalls.some((t) => t.name === "guardar_nombre_paciente"));
    const p = (await A.store.listPatients()).find((x) => x.phone === "web:nombre-1")!;
    assert.equal(p.name, "María López");
  });

  // ---------------- Menú inicial ----------------
  await check("Menú: un saludo recibe el menú (lista con más de 3 opciones) sin usar la IA", async () => {
    const r = await say("web:menu-1", "Hola, buenas tardes");
    assert.ok(r.interactive?.list, "6 opciones → lista de WhatsApp");
    assert.equal(r.interactive!.list!.rows.length, A.profile.knowledge.menu!.options.length);
    assert.equal(r.metric, undefined, "sin llamada al modelo");
    const c = await convOf("web:menu-1");
    assert.deepEqual(c.messages.at(-1)!.options, A.profile.knowledge.menu!.options.map((o) => o.label));
  });

  await check("Menú: elegir una opción (por título o por número) responde según el conocimiento", async () => {
    const r = await say("web:menu-1", "💲 Precios");
    assert.match(r.messages.join(" "), /USD/);
    await say("web:menu-2", "menú");
    const r2 = await say("web:menu-2", "1");
    assert.match(r2.messages.join(" "), /especialidad/, "sacar turno pregunta primero la especialidad");
  });

  await check("Menú: hasta 3 opciones van como botones; validación de límites de WhatsApp", async () => {
    const menu = { enabled: true, intro: "¿Qué necesita?", button: "Ver", options: [
      { id: "a", label: "Turno", kind: "consulta" as const, text: "Quiero un turno" },
      { id: "b", label: "Dirección", kind: "respuesta" as const, text: "Av. Siempreviva 742" },
    ] };
    assert.deepEqual(menuInteractive(menu).buttons, ["Turno", "Dirección"]);
    assert.equal(validateMenu(menu), null);
    assert.match(validateMenu({ ...menu, options: [{ ...menu.options[0]!, label: "Un título larguísimo de botón" }] })!, /20 caracteres/);
    assert.ok(isMenuRequest("Hola!!") && isMenuRequest("buen día") && !isMenuRequest("Hola, quiero un turno"));
    assert.equal(matchMenuOption(menu, "dirección")?.id, "b");
  });

  await check("Menú editable en Aprendizaje: una opción de respuesta fija rige al instante", async () => {
    const admin = demoUsers.find((x) => x.email === "admin@sonrisaclara.demo.test")!;
    const cookie = (await auth.login(admin.email, process.env[admin.passwordVar]!, false))!.setCookie!.split(";")[0]!;
    const k = structuredClone(A.profile.knowledge);
    k.menu!.options.push({ id: "wifi", label: "📶 Wifi", kind: "respuesta", text: "La clave del wifi se la dan en recepción." });
    const r = await fetch(`${base}/knowledge?clinic=${CLINIC_A}`, { method: "PUT", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ knowledge: k }) });
    assert.equal(r.status, 200);
    await say("web:menu-3", "hola");
    const r2 = await say("web:menu-3", "📶 Wifi");
    assert.equal(r2.messages[0], "La clave del wifi se la dan en recepción.");
  });

  // ---------------- Horarios editados → turnos que ofrece la herramienta ----------------
  await check("Los horarios editados limitan los turnos libres que devuelve la herramienta (no solo el prompt)", async () => {
    const before = structuredClone(A.profile.knowledge.hours);
    A.profile.knowledge.hours = [{ weekday: 2, blocks: [["15:00", "16:00"]] }]; // solo martes 15 a 16
    try {
      await withClinic(A.profile, async () => {
        const patient = await A.store.getOrCreatePatient("web:horario-1", "web");
        const conversation = await A.store.getOrCreateConversation(patient, "web");
        const exec = makeExecutor({ store: A.store, calendar: A.calendar, clock, patient, conversation });
        const r = (await exec("buscar_horarios_disponibles", { fecha_desde: "2026-11-30", fecha_hasta: "2026-12-04", franja: "cualquiera" })) as any;
        assert.ok(r.horarios.length > 0);
        assert.ok(r.horarios.every((h: any) => h.inicio.startsWith("2026-12-01T15")), JSON.stringify(r.horarios));
        const bad = (await exec("crear_cita", { nombre_completo: "Test Uno", tratamiento: "Consulta", inicio: "2026-11-30T10:00" })) as any;
        assert.equal(bad.error, "fuera_de_horario");
      });
    } finally {
      A.profile.knowledge.hours = before;
    }
  });

  // ---------------- Datos de ejemplo ----------------
  await check("Datos de ejemplo: todos los estados, sin «(demo)», nuevos ≤ consultas, derivaciones coherentes", async () => {
    for (const clinic of demoClinics()) {
      const d = buildDemoData(clinic, new Date("2026-11-25T21:00:00Z"));
      const states = new Set(d.conversations.map(conversationState));
      for (const s of ["esperando", "bot", "persona", "pausada", "cerrada"]) assert.ok(states.has(s as any), `${clinic.id}: falta el estado ${s}`);
      assert.ok(!JSON.stringify(d).includes("(demo)"), "sin «(demo)» en los nombres");
      const names = d.patients.map((p) => p.name).filter(Boolean);
      assert.ok(new Set(names).size === names.length, "nombres sin repetir");
      for (const h of d.handoffs.filter((x) => x.status === "abierta")) {
        const c = d.conversations.find((x) => x.id === h.conversationId)!;
        assert.ok(!c.closedAt && (c.handedOff || c.botPaused), "derivación abierta ⇒ conversación con una persona");
      }
      const s = buildStats({ tz: clinic.timezone, now: new Date("2026-11-25T21:00:00Z"), days: 30, ...d });
      assert.ok(s.totals.pacientesNuevos <= s.totals.consultas);
      for (const row of s.daily) assert.ok(row.pacientesNuevos <= row.consultas, `${row.date}: nuevos > consultas`);
      assert.ok(d.metrics.every((m) => m.model.includes("(simulado)")), "métricas marcadas como simuladas");
      assert.ok((clinic.knowledge.faq ?? []).length >= 5, "preguntas frecuentes cargadas");
    }
    assert.ok(runtimes.has(CLINIC_B));
  });
} finally {
  server.close();
}

const ok = results.filter(([, p]) => p).length;
for (const [name, passed] of results) if (passed) console.log(`  ✅ ${name}`);
console.log(`\n${ok === results.length ? "✅" : "❌"} ${ok}/${results.length} OK`);
process.exit(ok === results.length ? 0 : 1);
