import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Raíz del proyecto: el .env y las rutas relativas se resuelven desde acá, no desde la carpeta actual. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// ENV_FILE elige otro archivo (p. ej. .env.test). En un servidor las variables suelen venir del panel del proveedor.
loadEnv({ path: path.resolve(ROOT, process.env.ENV_FILE?.trim() || ".env"), quiet: true });

/** Lee una variable de entorno con valor por defecto. Nunca hay claves hardcodeadas. */
function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
}

export type ProviderName = "claude" | "openai" | "mock";

/** Precios USD por millón de tokens (entrada / salida / lectura de caché) de la página oficial, nov. 2026. */
const CLAUDE_PRICES: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
};
const claudeModel = env("CLAUDE_MODEL", "claude-opus-5-5");
const claudePrice = CLAUDE_PRICES[claudeModel] ?? CLAUDE_PRICES["claude-opus-5-5"];

export const config = {
  /** claude | openai | mock (mock = sin clave, respuestas guionadas para demo y pruebas) */
  llmProvider: env("LLM_PROVIDER", "mock") as ProviderName,

  claude: {
    model: claudeModel,
    /** low | medium | high — para un chat de turnos cortos, "low" alcanza y es más barato y rápido */
    effort: env("CLAUDE_EFFORT", "low") as "low" | "medium" | "high",
    /** Precios USD por millón de tokens: salen de la tabla según el modelo; las variables solo los pisan */
    priceIn: num("CLAUDE_PRICE_INPUT_PER_MTOK", claudePrice[0]),
    priceOut: num("CLAUDE_PRICE_OUTPUT_PER_MTOK", claudePrice[1]),
    priceCacheRead: num("CLAUDE_PRICE_CACHE_READ_PER_MTOK", claudePrice[2]),
  },

  openai: {
    model: env("OPENAI_MODEL", "gpt-5.5"),
    /** Precios USD por millón de tokens: completar desde la página oficial de OpenAI */
    priceIn: num("OPENAI_PRICE_INPUT_PER_MTOK", 0),
    priceOut: num("OPENAI_PRICE_OUTPUT_PER_MTOK", 0),
  },

  /** inline = una línea al final del saludo (por defecto) · separate = mensaje aparte · off = sin aviso */
  privacyMode: env("PRIVACY_NOTICE", "inline") as "inline" | "separate" | "off",

  clinic: {
    timezone: env("CLINIC_TIMEZONE", "America/Argentina/Buenos_Aires"),
    /** Duración de cada turno en minutos */
    slotMinutes: num("SLOT_MINUTES", 30),
  },

  supabase: {
    url: env("SUPABASE_URL"),
    secretKey: env("SUPABASE_SECRET_KEY"),
    /** Clave pública: solo la usa el login del panel (Supabase Auth); las consultas van con el token del usuario. */
    publishableKey: env("SUPABASE_PUBLISHABLE_KEY"),
  },

  google: {
    calendarId: env("GOOGLE_CALENDAR_ID"),
    keyFile: path.resolve(ROOT, env("GOOGLE_SERVICE_ACCOUNT_JSON_PATH", "secrets/google-service-account.json")),
    /** Alternativa para servidores sin archivos: el JSON de la cuenta de servicio en base64. */
    keyJsonBase64: env("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64"),
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
    /** Plantillas aprobadas por Meta: se usan solo si la ventana de 24 h está cerrada */
    templateReminder: env("WHATSAPP_TEMPLATE_REMINDER", "recordatorio_turno"),
    templateFollowup: env("WHATSAPP_TEMPLATE_FOLLOWUP", "seguimiento_promo"),
    templateWaitlist: env("WHATSAPP_TEMPLATE_WAITLIST", "turno_liberado"),
    templateReactivation: env("WHATSAPP_TEMPLATE_REACTIVATION", "reactivacion_paciente"),
    /** Aviso de reprogramación cuando un profesional no va a atender (excepción de agenda). */
    templateReschedule: env("WHATSAPP_TEMPLATE_RESCHEDULE", "turno_reprogramar"),
    /** Seguimiento posterior al turno («¿cómo se sintió?»). */
    templatePostVisit: env("WHATSAPP_TEMPLATE_POST_VISIT", "seguimiento_post_turno"),
    templateLang: env("WHATSAPP_TEMPLATE_LANG", "es"),
  },

  reminders: {
    enabled: env("REMINDERS_ENABLED", "true") !== "false",
    /** Cada cuántos segundos se revisan los turnos */
    intervalSec: num("REMINDERS_INTERVAL_SEC", 60),
    /** Horas sin respuesta tras las que se escribe a un lead que no agendó (menos de 24 para seguir dentro de la ventana de WhatsApp) */
    followupAfterHours: num("FOLLOWUP_AFTER_HOURS", 20),
  },

  /** Demo pública: clínica temporal por visita y tope de IA. */
  demo: {
    enabled: env("PUBLIC_DEMO", "true") !== "false",
    hours: num("DEMO_HOURS", 24),
    maxActive: num("DEMO_MAX_ACTIVE", 50),
    perIpPerDay: num("DEMO_PER_IP_PER_DAY", 3),
    aiPerVisit: num("DEMO_AI_PER_VISIT", 20),
    aiDaily: num("DEMO_AI_DAILY", 300),
  },
  inbox: {
    /** Horas sin mensajes para cerrar una conversación (se reabre si el paciente vuelve a escribir). */
    idleHours: num("CONVERSATION_IDLE_HOURS", 24),
  },
  waitlist: {
    /** Minutos que se le guarda el horario liberado a quien se lo ofrecemos, antes de pasar al siguiente. */
    offerMinutes: num("WAITLIST_OFFER_MINUTES", 30),
  },

  reactivation: {
    enabled: env("REACTIVATION_ENABLED", "true") !== "false",
    /** Meses desde la última visita para escribirle a un paciente que no volvió. */
    months: num("REACTIVATION_MONTHS", 6),
    /** Máximo de mensajes de reactivación por revisión (evita envíos masivos). */
    maxPerSweep: num("REACTIVATION_MAX_PER_SWEEP", 5),
  },

  panel: {
    /** Clave para firmar la cookie de sesión del panel (la genera npm run seed:users). */
    sessionSecret: env("PANEL_SESSION_SECRET"),
  },

  port: num("PORT", 3000),
  /** production = controles estrictos al arrancar (ver server.ts). */
  isProduction: env("NODE_ENV") === "production",
};
