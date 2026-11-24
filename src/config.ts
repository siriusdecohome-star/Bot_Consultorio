import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Raíz del proyecto: el .env y las rutas relativas se resuelven desde acá, no desde la carpeta actual. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(ROOT, ".env"), quiet: true });

/** Lee una variable de entorno con valor por defecto. Nunca hay claves hardcodeadas. */
function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
}

export type ProviderName = "claude" | "openai" | "mock";

export const config = {
  /** claude | openai | mock (mock = sin clave, respuestas guionadas para demo y pruebas) */
  llmProvider: env("LLM_PROVIDER", "mock") as ProviderName,

  claude: {
    model: env("CLAUDE_MODEL", "claude-opus-5-5"),
    /** low | medium | high — para un chat de turnos cortos, "low" alcanza y es más barato y rápido */
    effort: env("CLAUDE_EFFORT", "low") as "low" | "medium" | "high",
    /** Precios USD por millón de tokens (verificar en la página oficial de precios) */
    priceIn: num("CLAUDE_PRICE_INPUT_PER_MTOK", 4),
    priceOut: num("CLAUDE_PRICE_OUTPUT_PER_MTOK", 20),
    priceCacheRead: num("CLAUDE_PRICE_CACHE_READ_PER_MTOK", 0.2),
  },

  openai: {
    model: env("OPENAI_MODEL", "gpt-5.5"),
    /** Precios USD por millón de tokens: completar desde la página oficial de OpenAI */
    priceIn: num("OPENAI_PRICE_INPUT_PER_MTOK", 0),
    priceOut: num("OPENAI_PRICE_OUTPUT_PER_MTOK", 0),
  },

  clinic: {
    timezone: env("CLINIC_TIMEZONE", "America/Argentina/Buenos_Aires"),
    /** Duración de cada turno en minutos */
    slotMinutes: num("SLOT_MINUTES", 30),
  },

  supabase: {
    url: env("SUPABASE_URL"),
    secretKey: env("SUPABASE_SECRET_KEY"),
  },

  google: {
    calendarId: env("GOOGLE_CALENDAR_ID"),
    keyFile: path.resolve(ROOT, env("GOOGLE_SERVICE_ACCOUNT_JSON_PATH", "secrets/google-service-account.json")),
  },

  whatsapp: {
    /** Token de acceso (temporal de 24 h o permanente de usuario del sistema) */
    token: env("WHATSAPP_TOKEN"),
    /** "Identificador del número de teléfono" que muestra Meta (no es el número en sí) */
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
    /** Texto que inventamos nosotros y se pega también en Meta al configurar el webhook */
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    /** "Clave secreta de la app" (Configuración de la app → Básica): valida que los avisos vengan de Meta */
    appSecret: env("WHATSAPP_APP_SECRET"),
    /** Versión de la Graph API (la que usa el ejemplo de Meta en "API Setup"; verificar si cambia) */
    graphVersion: env("WHATSAPP_GRAPH_VERSION", "v25.0"),
  },

  port: num("PORT", 3000),
};
