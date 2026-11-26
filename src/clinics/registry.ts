import { BotEngine } from "../bot/engine.js";
import { ReminderService } from "../bot/reminders.js";
import { WaitlistService } from "../bot/waitlist.js";
import type { WhatsAppSender } from "../channels/whatsappClient.js";
import { demoClinics } from "../data/clinics/index.js";
import { withDefaults } from "../data/clinics/settings.js";
import type { LlmProvider } from "../llm/types.js";
import { ClinicCalendar, type CalendarService } from "../services/calendar.js";
import type { Services } from "../services/factory.js";
import { ChannelNotifier, type Notifier, type WebOutbox } from "../services/notifier.js";
import type { Store } from "../services/store.js";
import type { SupabaseStore } from "../services/supabaseStore.js";
import type { Clock } from "../services/time.js";
import { setDefaultClinic } from "./context.js";
import { defaultCloudLine, lineById, rowToLine } from "./lines.js";
import type { ClinicKnowledge, ClinicProfile } from "./types.js";


/** Fila de la tabla `clinics` → perfil. */
export function rowToClinic(r: any): ClinicProfile {
  return {
    id: r.id,
    name: r.name,
    timezone: r.timezone,
    slotMinutes: r.slot_minutes,
    lines: [],
    calendarTag: r.calendar_tag,
    primary: r.is_primary,
    calendarColor: r.calendar_color,
    knowledge: r.knowledge as ClinicKnowledge,
    professionals: [],
    settings: withDefaults(r.settings),
    expiresAt: r.expires_at ?? null,
  };
}

export function clinicToRow(c: ClinicProfile) {
  return {
    id: c.id, name: c.name, timezone: c.timezone, slot_minutes: c.slotMinutes,
    calendar_tag: c.calendarTag,
    is_primary: c.primary, calendar_color: c.calendarColor, knowledge: c.knowledge, settings: c.settings, expires_at: c.expiresAt ?? null,
  };
}

/**
 * Clínicas de la instalación. Con Supabase se leen de la tabla `clinics`
 * (las carga `npm run seed`); en memoria son las dos de ejemplo.
 */
export async function loadClinics(services: Services): Promise<ClinicProfile[]> {
  if (services.storeKind !== "supabase") return demoClinics();
  const db = (services.store as SupabaseStore).client;
  const { data, error } = await db.from("clinics").select("*").order("is_primary", { ascending: false }).order("id");
  if (error) throw new Error(`No se pudieron leer las clínicas: ${error.message}. ¿Ejecutó supabase/schema.sql?`);
  if (!data?.length) {
    console.warn("⚠ La tabla clinics está vacía: se usan las clínicas de ejemplo en memoria. Ejecute npm run seed.");
    return demoClinics();
  }
  // Profesionales de cada clínica (tabla professionals). Si una clínica no tiene, se usan los de ejemplo.
  const { data: profs, error: e2 } = await db.from("professionals").select("*").order("created_at");
  if (e2) throw new Error(`No se pudieron leer los profesionales: ${e2.message}. ¿Ejecutó supabase/schema.sql?`);
  const { data: lines, error: e3 } = await db.from("whatsapp_lines").select("*").order("created_at");
  if (e3) throw new Error(`No se pudieron leer las líneas de WhatsApp: ${e3.message}. ¿Ejecutó supabase/schema.sql?`);
  const demo = new Map(demoClinics().map((c) => [c.id, c.professionals]));
  return data.map((r: any) => {
    const c = rowToClinic(r);
    const mine = (profs ?? []).filter((p: any) => p.clinic_id === c.id).map((p: any) => ({
      id: p.id, name: p.name, specialty: p.specialty, color: p.color, hours: p.hours ?? [], treatments: p.treatments ?? [], calendar: p.calendar, active: p.active,
    }));
    if (!mine.length && demo.has(c.id)) console.warn(`⚠ ${c.name} no tiene profesionales en la base: se usan los de ejemplo. Ejecute npm run seed.`);
    c.professionals = mine.length ? mine : structuredClone(demo.get(c.id) ?? []);
    c.lines = (lines ?? []).filter((l: any) => l.clinic_id === c.id).map(rowToLine);
    return c;
  });
}

export interface ClinicRuntime {
  profile: ClinicProfile;
  store: Store;
  calendar: CalendarService;
  bot: BotEngine;
  reminders: ReminderService;
  waitlist: WaitlistService;
  notifier: Notifier;
  /** Cliente de WhatsApp de su primera línea real, si tiene una. */
  whatsapp: WhatsAppSender | null;
  /** Cliente de WhatsApp de cada línea real (por id de línea). */
  senders: Map<string, WhatsAppSender>;
  /** Cliente de la línea indicada; sin línea (o simulada), el de la primera línea real. */
  senderFor(lineId: string | null | undefined): WhatsAppSender | null;
}

export interface RuntimeOptions {
  services: Services;
  clinics: ClinicProfile[];
  provider: LlmProvider;
  clock: Clock;
  outbox?: WebOutbox;
  /** Crea el cliente de WhatsApp para el número de una línea (null = no se puede enviar). */
  whatsappFor?: (phoneNumberId: string) => WhatsAppSender | null;
  /** false = no cambia la clínica por defecto (al sumar una clínica temporal de la demo). */
  setDefault?: boolean;
  /** Tope de IA por clínica (demo pública): si devuelve false, ese mensaje lo responde el modo sin IA. */
  aiBudgetFor?: (profile: ClinicProfile) => (() => Promise<boolean>) | undefined;
  /** Proveedor de respaldo cuando se agota el tope de IA. */
  fallbackProvider?: LlmProvider;
}

/** Arma motor, agenda, avisos y recordatorios de cada clínica sobre los servicios compartidos. */
export function buildRuntimes(o: RuntimeOptions): Map<string, ClinicRuntime> {
  const map = new Map<string, ClinicRuntime>();
  const primary = o.clinics.find((c) => c.primary) ?? o.clinics[0];
  if (primary && o.setDefault !== false) setDefaultClinic(primary);
  for (const profile of o.clinics) {
    const store = o.services.store.forClinic(profile.id);
    const calendar = new ClinicCalendar(o.services.calendar, profile);
    const senders = new Map<string, WhatsAppSender>();
    for (const l of profile.lines) {
      const s = l.kind === "cloud" && l.phoneNumberId && o.whatsappFor ? o.whatsappFor(l.phoneNumberId) : null;
      if (s) senders.set(l.id, s);
    }
    const fallbackLine = defaultCloudLine(profile);
    const whatsapp = fallbackLine ? senders.get(fallbackLine.id) ?? null : null;
    // La respuesta sale por la línea por la que escribió el paciente; si no se sabe, por la primera real.
    const senderFor = (lineId: string | null | undefined) => {
      const l = lineById(profile, lineId);
      return (l?.kind === "cloud" ? senders.get(l.id) : null) ?? whatsapp;
    };
    const notifier = new ChannelNotifier({ whatsapp: senderFor, web: o.outbox ?? null, webPrefix: `${profile.id}|` });
    const bot = new BotEngine(o.provider, store, calendar, o.clock, profile);
    const waitlist = new WaitlistService(store, notifier, calendar, o.clock, profile);
    bot.waitlist = waitlist;
    const budget = o.aiBudgetFor?.(profile);
    if (budget && o.fallbackProvider) {
      bot.aiBudget = budget;
      bot.fallback = o.fallbackProvider;
    }
    map.set(profile.id, {
      profile, store, calendar, notifier, whatsapp, senders, senderFor, bot, waitlist,
      reminders: new ReminderService(store, notifier, o.clock, profile),
    });
  }
  return map;
}

/** Webhook: la clínica y la línea según el número de Meta que recibió el mensaje (null = número desconocido). */
export function lineByPhoneNumberId(runtimes: Map<string, ClinicRuntime>, phoneNumberId: string | null | undefined) {
  if (!phoneNumberId) return null;
  for (const rt of runtimes.values()) {
    const line = rt.profile.lines.find((l) => l.active && l.kind === "cloud" && l.phoneNumberId === phoneNumberId);
    if (line) return { rt, line };
  }
  return null;
}
