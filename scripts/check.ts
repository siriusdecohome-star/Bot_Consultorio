/**
 * Verifica la configuración del .env sin mostrar ninguna clave.
 * Uso: npm run check
 */
import { existsSync } from "node:fs";
import { config } from "../src/config.js";

const ok = (m: string) => console.log(`✅ ${m}`);
const bad = (m: string) => console.log(`❌ ${m}`);
const skip = (m: string) => console.log(`⚪ ${m}`);
let failures = 0;

console.log("Verificando configuración…\n");

// --- IA ---
const p = config.llmProvider;
if (p === "mock") skip("IA: LLM_PROVIDER=mock (sin IA real; las respuestas son por reglas)");
else if (p === "claude") process.env.ANTHROPIC_API_KEY ? ok(`IA: Claude (${config.claude.model}), clave cargada`) : (bad("IA: falta ANTHROPIC_API_KEY"), failures++);
else if (p === "openai") process.env.OPENAI_API_KEY ? ok(`IA: OpenAI (${config.openai.model}), clave cargada`) : (bad("IA: falta OPENAI_API_KEY"), failures++);
else (bad(`IA: LLM_PROVIDER inválido: ${p}`), failures++);

// --- Supabase ---
if (!config.supabase.url && !config.supabase.secretKey) {
  skip("Supabase: sin configurar → se usa base en memoria");
} else if (!config.supabase.url || !config.supabase.secretKey) {
  bad("Supabase: falta SUPABASE_URL o SUPABASE_SECRET_KEY"); failures++;
} else if (!/^https:\/\/.+\.supabase\.co\/?$/.test(config.supabase.url)) {
  bad("Supabase: SUPABASE_URL debería tener la forma https://xxxx.supabase.co"); failures++;
} else {
  try {
    const { SupabaseStore } = await import("../src/services/supabaseStore.js");
    const n = await new SupabaseStore(config.supabase.url, config.supabase.secretKey).ping();
    ok(`Supabase: conectado, tabla patients con ${n} registros`);
  } catch (e) {
    const msg = (e as Error).message;
    bad(`Supabase: ${msg}`);
    if (/relation .* does not exist|Could not find the table|PGRST205|42P01|HTTP 404/i.test(msg)) console.log("   → Falta ejecutar supabase/schema.sql en el SQL Editor.");
    if (/Invalid API key|JWT|401/i.test(msg)) console.log("   → Revisá SUPABASE_SECRET_KEY (debe ser la clave secreta, no la pública).");
    failures++;
  }
}

// --- Google Calendar ---
if (!config.google.calendarId) {
  skip("Google Calendar: sin GOOGLE_CALENDAR_ID → se usa agenda en memoria");
} else if (!existsSync(config.google.keyFile)) {
  bad(`Google Calendar: no encuentro el archivo de clave en ${config.google.keyFile}`); failures++;
} else {
  try {
    const { GoogleCalendarService } = await import("../src/services/googleCalendar.js");
    const name = await new GoogleCalendarService(config.google.calendarId, config.google.keyFile).ping();
    ok(`Google Calendar: conectado al calendario "${name}"`);
  } catch (e: any) {
    bad(`Google Calendar: ${e?.message ?? e}`);
    if (e?.code === 404) console.log("   → El calendario no existe o no está compartido con el correo de la cuenta de servicio.");
    if (e?.code === 403) console.log("   → Revisá que la Google Calendar API esté habilitada y que el permiso sea «Hacer cambios en eventos».");
    failures++;
  }
}

// --- WhatsApp Cloud API ---
const wa = config.whatsapp;
if (!wa.token && !wa.phoneNumberId) {
  skip("WhatsApp: sin configurar → solo funciona el simulador web");
} else if (!wa.token || !wa.phoneNumberId) {
  bad("WhatsApp: falta WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID"); failures++;
} else {
  try {
    const { WhatsAppCloudClient } = await import("../src/channels/whatsappClient.js");
    const n = await new WhatsAppCloudClient().describeNumber();
    ok(`WhatsApp: token válido, número ${n.display_phone_number ?? "?"} (${n.verified_name ?? "sin nombre"})`);
  } catch (e: any) {
    bad(`WhatsApp: ${e?.message ?? e}`);
    if (e?.code === 190) console.log("   → El token venció o es inválido. El temporal dura 24 h: generá uno nuevo o usá el permanente.");
    if (e?.code === 100) console.log("   → Revisá WHATSAPP_PHONE_NUMBER_ID (es el «Identificador del número de teléfono», no el número).");
    failures++;
  }
  if (!wa.verifyToken) { bad("WhatsApp: falta WHATSAPP_VERIFY_TOKEN (lo pide Meta al configurar el webhook)"); failures++; }
  if (!wa.appSecret) console.log("⚠️ WhatsApp: sin WHATSAPP_APP_SECRET no se valida que los avisos vengan de Meta.");
}

console.log(failures ? `\n${failures} problema(s) para revisar.` : "\nTodo listo.");
process.exitCode = failures ? 1 : 0;
