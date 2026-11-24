/**
 * Conecta la app a la cuenta de WhatsApp (WABA) para que Meta le envíe los mensajes al webhook.
 * Uso: npm run wa:subscribe
 * Requiere WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID y WHATSAPP_WABA_ID en el .env.
 */
import { config } from "../src/config.js";

const { token, phoneNumberId, graphVersion } = config.whatsapp;
if (!token || !phoneNumberId) {
  console.log("Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID en el .env");
  process.exit(1);
}
const g = (path: string, init: RequestInit = {}) =>
  fetch(`https://graph.facebook.com/${graphVersion}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  }).then(async (r) => {
    const data = (await r.json()) as any;
    if (!r.ok) throw new Error(data?.error?.message ?? `HTTP ${r.status}`);
    return data;
  });

const waba = (process.env.WHATSAPP_WABA_ID ?? "").trim();
if (!waba) {
  console.log("Falta WHATSAPP_WABA_ID en el .env (es el «Identificador de la cuenta de mensajes» de Meta).");
  process.exit(1);
}

const r = await g(`${waba}/subscribed_apps`, { method: "POST" });
console.log(`Suscripción: ${r.success ? "✅ ok" : "❌ falló"}`);
const list = await g(`${waba}/subscribed_apps`);
console.log("Apps conectadas a la cuenta de WhatsApp:");
for (const a of list.data ?? []) console.log(`  - ${a.whatsapp_business_api_data?.name}`);
