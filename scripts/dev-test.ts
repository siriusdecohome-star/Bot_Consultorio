/**
 * Entorno de pruebas: el mismo servidor, aislado de los servicios reales.
 * - Base y agenda en memoria (no toca Supabase ni Google Calendar), con 30 días de datos ficticios.
 * - Sin webhook de WhatsApp ni recordatorios automáticos (no le escribe a nadie).
 * - IA sin costo (mock), salvo que se indique LLM_PROVIDER al lanzarlo.
 * - Puerto 3100, para poder tenerlo abierto al mismo tiempo que el de desarrollo (3000).
 * Las contraseñas de los usuarios de prueba son las del .env (npm run seed:users).
 * Uso: npm run dev:test
 */
const isolate: Record<string, string> = {
  SUPABASE_URL: "",
  GOOGLE_CALENDAR_ID: "",
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: "",
  WHATSAPP_VERIFY_TOKEN: "",
  WHATSAPP_TOKEN: "",
  REMINDERS_ENABLED: "false",
  NODE_ENV: "test",
  PORT: process.env.TEST_PORT ?? "3100",
};
// Se fijan antes de cargar la configuración: dotenv no pisa variables ya definidas.
for (const [k, v] of Object.entries(isolate)) process.env[k] = v;
process.env.LLM_PROVIDER ??= "mock";
console.log("Entorno de pruebas: memoria · sin WhatsApp · sin recordatorios automáticos");
await import("../src/server.js");
