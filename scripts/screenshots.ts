/**
 * Capturas del simulador y del panel para el README y el portafolio (docs/img/*.png).
 * - Levanta el entorno de pruebas (memoria, 30 días de datos ficticios) en un puerto propio.
 * - Abre Edge sin ventana y lo maneja por el protocolo de depuración (CDP), sin librerías.
 * - Inicia sesión en el panel con un usuario de prueba y una contraseña temporal propia
 *   de esta ejecución (no usa ni muestra las del .env).
 * Uso (Windows, con Microsoft Edge instalado): npm run capturas
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../src/config.js";

const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 3190;
const CDP_PORT = 9333;
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(ROOT, "docs", "img");
const PASS = randomBytes(9).toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const children: ChildProcess[] = [];
const cleanup = () => { for (const c of children) c.kill(); };
process.on("exit", cleanup);

// 1) Servidor del entorno de pruebas, con la contraseña temporal del admin de ejemplo
const server = spawn(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "scripts", "dev-test.ts")], {
  cwd: ROOT, env: { ...process.env, TEST_PORT: String(PORT), DEMO_PASS_ADMIN_SONRISA: PASS }, stdio: "ignore",
});
children.push(server);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch {}
  await sleep(500);
}

// 2) Sesión del panel
const login = await fetch(`${BASE}/panel/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ email: "admin@sonrisaclara.demo.test", password: PASS }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
if (!cookie.includes("=")) throw new Error("No se pudo iniciar sesión en el entorno de pruebas");
const [cookieName, ...rest] = cookie.split("=");

// 3) Edge sin ventana con depuración remota
const profile = path.join(os.tmpdir(), `bot-capturas-${Date.now()}`);
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
children.push(edge);
let wsUrl = "";
for (let i = 0; i < 40 && !wsUrl; i++) {
  try { wsUrl = ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as any[]).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? ""; } catch {}
  if (!wsUrl) await sleep(300);
}
if (!wsUrl) throw new Error("No se pudo conectar con Edge (¿está instalado? EDGE_PATH)");

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); }
});
const cdp = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = (expression: string) => cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

await cdp("Page.enable");
await cdp("Network.enable");
await cdp("Network.setCookie", { name: cookieName, value: rest.join("="), domain: "localhost", path: "/", httpOnly: true });

async function shot(file: string, url: string, opts: { width?: number; height?: number; prepare?: string; wait?: number } = {}) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: opts.width ?? 1440, height: opts.height ?? 900, deviceScaleFactor: 1.5, mobile: false });
  await cdp("Page.navigate", { url });
  await sleep(1800);
  // Sin animaciones: la captura no sale a mitad de una transición.
  await evaluate(`document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>")`);
  if (opts.prepare) { await evaluate(opts.prepare); await sleep(opts.wait ?? 1200); }
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, file), Buffer.from(data, "base64"));
  console.log(`✔ docs/img/${file}`);
}

// Escribe en el simulador como un paciente, esperando cada respuesta.
const chat = (msgs: string[]) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const m of ${JSON.stringify(msgs)}) {
    const input = document.querySelector("#input");
    input.value = m;
    document.querySelector("#form").requestSubmit();
    await wait(2600);
  }
})()`;

try {
  await shot("simulador.png", `${BASE}/?modo=grabacion`, {
    prepare: chat(["Hola, vi la promo", "Quiero sacar un turno para el jueves a la tarde", "2", "Ana Pérez"]), wait: 1500,
  });
  await shot("panel-resumen.png", `${BASE}/panel#resumen`);
  await shot("panel-conversaciones.png", `${BASE}/panel#conversaciones`, {
    prepare: `(async () => {
      await new Promise((r) => setTimeout(r, 800));
      const convs = [...document.querySelectorAll("#inbox .conv")];
      (convs.find((c) => c.textContent.includes("Con una persona")) ?? convs[0])?.click();
    })()`,
  });
  await shot("panel-agenda.png", `${BASE}/panel#agenda`);
  await shot("panel-estadisticas.png", `${BASE}/panel#estadisticas`, { height: 1000 });
  await shot("panel-costos.png", `${BASE}/panel#costos`, { height: 700 });
  await shot("panel-aprendizaje.png", `${BASE}/panel#aprendizaje`, {
    prepare: `(async () => {
      await new Promise((r) => setTimeout(r, 800));
      const send = async (t) => { document.querySelector("#tester-text").value = t; document.querySelector("#tester-form").requestSubmit(); await new Promise((r) => setTimeout(r, 1800)); };
      await send("Después del blanqueamiento, ¿puedo tomar café?");
    })()`, wait: 600,
  });
  await shot("panel-pacientes.png", `${BASE}/panel#pacientes`);
} finally {
  ws.close();
  cleanup();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
