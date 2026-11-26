import { config } from "./config.js";
import { createApp } from "./app.js";

/**
 * Servidor local o en una máquina propia: la aplicación (src/app.ts) más los temporizadores
 * del trabajo periódico. En Vercel no se usa este archivo: la función es api/index.ts y el
 * trabajo periódico lo dispara el cron de Supabase llamando a POST /api/cron/tick.
 */
let created;
try {
  created = await createApp();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const { app, sweepReminders, housekeeping, info } = created;

const print = (lines: string[]) => lines.forEach((l) => console.log(l));
let remindersStatus = "desactivados (REMINDERS_ENABLED=false)";
if (config.reminders.enabled) {
  setInterval(() => sweepReminders().then(print).catch((e) => console.error("[recordatorios]", e)), config.reminders.intervalSec * 1000);
  setTimeout(() => sweepReminders().then(print).catch(() => {}), 5000);
  remindersStatus = `cada ${config.reminders.intervalSec} s · seguimiento de leads a las ${config.reminders.followupAfterHours} h`;
}
// Cierre por inactividad, demos vencidas y limpieza del estado compartido.
setInterval(() => housekeeping().then(print).catch((e) => console.error("[mantenimiento]", e)), 5 * 60_000);
setTimeout(() => housekeeping().then(print).catch(() => {}), 8000);

app.listen(config.port, () => {
  console.log(`Simulador listo en http://localhost:${config.port}`);
  console.log(`IA: ${info.provider} · base: ${info.store} · agenda: ${info.calendar}`);
  console.log(`Clínicas: ${info.clinics}`);
  console.log(`WhatsApp: ${info.whatsapp}`);
  console.log(`Recordatorios: ${remindersStatus}`);
  console.log(`Panel: http://localhost:${config.port}/panel (contraseñas en el .env, ver npm run seed:users)`);
});
