import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { BotEngine } from "./bot/engine.js";
import { createProvider } from "./llm/index.js";
import { createServices } from "./services/factory.js";
import { seedCalendar } from "./data/seed.js";
import { systemClock } from "./services/time.js";

/** Chat por consola para probar el motor sin WhatsApp ni navegador. */
async function main() {
  const provider = await createProvider();
  const s = await createServices();
  if (s.calendarKind === "memoria") await seedCalendar(s.calendar, systemClock);
  const bot = new BotEngine(provider, s.store, s.calendar);
  console.log(`Bot del consultorio — IA: ${bot.providerName} · base: ${s.storeKind} · agenda: ${s.calendarKind}`);
  console.log(`Escriba "salir" para terminar.\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  while (true) {
    const text = (await rl.question("Usted > ")).trim();
    if (!text) continue;
    if (text.toLowerCase() === "salir") break;
    const r = await bot.handle({ channel: "cli", userId: "+5491100000001", text, source: "promo-noviembre" });
    for (const m of r.messages) console.log(`\nBot   > ${m}\n`);
    if (r.metric) {
      const tools = r.toolCalls.map((c) => c.name).join(", ") || "ninguna";
      console.log(`        [${r.metric.latencyMs} ms · USD ${r.metric.costUsd.toFixed(4)} · herramientas: ${tools}]\n`);
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
