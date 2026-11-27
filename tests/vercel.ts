/**
 * Prueba de integración del modo Vercel CONTRA SUPABASE: levanta dos instancias de la
 * aplicación (como dos funciones de Vercel atendiendo pedidos a la vez) y comprueba que
 * lo que tiene que ser común a todas vive en la base:
 * - una demo creada en la instancia A se usa desde la B (panel y chat);
 * - el límite de mensajes por IP se cuenta entre las dos;
 * - la bandeja del simulador: lo que manda el bot desde A se entrega una sola vez desde B;
 * - un aviso de Meta repetido en A y en B se procesa una sola vez;
 * - /api/cron/tick exige CRON_SECRET y corre el trabajo periódico;
 * - el borrado de la demo vencida, desde la otra instancia.
 * Crea una clínica temporal y la borra al final. No envía mensajes de WhatsApp reales.
 * Uso: npm run test:vercel   (necesita el .env con Supabase y schema.sql ejecutado)
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createClient } from "@supabase/supabase-js";

process.env.WEB_MAX_MSGS_PER_10MIN = "3";
process.env.CLINIC_CACHE_MS = "500"; // en producción la demo vence sola; acá se la vence a mano
process.env.CRON_SECRET ||= `prueba-${randomBytes(12).toString("hex")}`; // solo en este proceso
const { config } = await import("../src/config.js");
const { createApp } = await import("../src/app.js");
if (!config.supabase.url || !config.supabase.secretKey) {
  console.log("Sin Supabase en el .env: esta prueba es solo para la base real.");
  process.exit(0);
}
const db = createClient(config.supabase.url, config.supabase.secretKey, { auth: { persistSession: false } });

const deferred: Promise<unknown>[] = [];
const [A, B] = await Promise.all([
  createApp({ serverless: true, defer: (w) => void deferred.push(w) }),
  createApp({ serverless: true, defer: (w) => void deferred.push(w) }),
]);
const servers = [A.app.listen(0), B.app.listen(0)];
const url = (i: 0 | 1) => `http://127.0.0.1:${(servers[i]!.address() as AddressInfo).port}`;

const results: Array<[string, boolean]> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false]); console.error(`  ✗ ${name}:`, (e as Error).message); }
}
const ip = `203.0.113.${Math.floor(Math.random() * 200) + 20}`; // red de documentación (ficticia)
const post = (i: 0 | 1, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url(i)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": ip, ...headers }, body: JSON.stringify(body) });

let clinicId = "";
let cookie = "";
try {
  await check("Demo creada en la instancia A, usada desde la B (panel y simulador)", async () => {
    const r = await post(0, "/api/demo/start", {});
    assert.equal(r.status, 200, await r.clone().text());
    clinicId = (await r.json()).clinicId;
    cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await fetch(`${url(1)}/api/panel/me?clinic=${clinicId}`, { headers: { cookie } })).json();
    assert.deepEqual(me.clinics.map((c: any) => c.id), [clinicId], "B conoce la clínica creada en A");
    const cfg = await (await fetch(`${url(1)}/api/config?clinic=${clinicId}`)).json();
    assert.equal(cfg.demo, true);
    assert.equal(cfg.lines.length, 2);
  });

  await check("Límite de mensajes por IP compartido entre instancias (3 cada 10 min en la prueba)", async () => {
    const codes = [];
    for (const i of [0, 1, 0, 1] as const) {
      codes.push((await post(i, `/api/chat?clinic=${clinicId}`, { sessionId: "web:vercel01", text: "Hola" })).status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429]);
  });

  await check("Bandeja del simulador: lo que el bot manda desde A se entrega una vez desde B", async () => {
    assert.equal((await post(0, `/api/demo/followup?clinic=${clinicId}`, { sessionId: "web:vercel02" })).status, 200);
    const take = async () => (await (await fetch(`${url(1)}/api/outbox?clinic=${clinicId}&sessionId=web:vercel02`)).json()).messages;
    assert.equal((await take()).length, 1);
    assert.equal((await take()).length, 0, "no se repite");
  });

  await check("Aviso de Meta repetido en A y en B: se procesa una sola vez", async () => {
    const id = `wamid.prueba-${randomBytes(6).toString("hex")}`;
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: "NUMERO-DE-PRUEBA-INEXISTENTE" },
      contacts: [{ profile: { name: "Prueba" }, wa_id: "59170000999" }],
      messages: [{ from: "59170000999", id, timestamp: "1764000000", type: "text", text: { body: "Hola" } }],
    } }] }] });
    const sig = "sha256=" + createHmac("sha256", config.whatsapp.appSecret).update(raw).digest("hex");
    const send = (i: 0 | 1) => fetch(`${url(i)}/webhook/whatsapp`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: raw });
    const codes = await Promise.all([send(0), send(1)]).then((rs) => rs.map((r) => r.status));
    assert.deepEqual(codes, [200, 200], "Meta recibe 200 de las dos");
    await Promise.all(deferred);
    const rows = await db.from("processed_messages").select("id").eq("id", id);
    assert.equal(rows.data?.length, 1);
    await db.from("processed_messages").delete().eq("id", id);
  });

  await check("/api/cron/tick: sin la clave no existe; con la clave corre el trabajo periódico", async () => {
    assert.equal((await post(1, "/api/cron/tick", {})).status, 404);
    assert.equal((await post(1, "/api/cron/tick", {}, { authorization: "Bearer otra-clave" })).status, 404);
    const r = await post(1, "/api/cron/tick", {}, { authorization: `Bearer ${process.env.CRON_SECRET}` });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });

  await check("Demo vencida: la borra el cron desde la otra instancia (datos, líneas y visitante)", async () => {
    await db.from("clinics").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", clinicId);
    const members = (await db.from("clinic_members").select("user_id").eq("clinic_id", clinicId)).data ?? [];
    const r = await post(1, "/api/cron/tick", {}, { authorization: `Bearer ${process.env.CRON_SECRET}` });
    assert.match((await r.json()).log.join(" "), /vencida/);
    assert.equal((await db.from("clinics").select("id").eq("id", clinicId)).data?.length, 0);
    assert.equal((await db.from("whatsapp_lines").select("id").eq("clinic_id", clinicId)).data?.length, 0);
    for (const m of members) assert.equal((await db.auth.admin.getUserById(m.user_id)).data.user, null, "usuario anónimo borrado");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal((await fetch(`${url(0)}/api/config?clinic=${clinicId}`)).status, 404, "A ya no la atiende");
    clinicId = "";
  });
} finally {
  // Si algo falló a mitad de camino, la clínica de prueba se borra igual.
  if (clinicId) {
    const members = (await db.from("clinic_members").select("user_id").eq("clinic_id", clinicId)).data ?? [];
    for (const m of members) await db.auth.admin.deleteUser(m.user_id).catch(() => undefined);
    await db.from("clinics").delete().eq("id", clinicId);
  }
  await db.from("rate_hits").delete().like("key", `%${ip}`);
  for (const s of servers) { s.closeAllConnections(); s.close(); }
}

const ok = results.filter(([, p]) => p).length;
for (const [name, passed] of results) if (passed) console.log(`  ✅ ${name}`);
console.log(`\n${ok === results.length ? "✅" : "❌"} ${ok}/${results.length} OK`);
process.exit(ok === results.length ? 0 : 1);
