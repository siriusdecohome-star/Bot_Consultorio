import { BotEngine } from "../bot/engine.js";
import { ReminderService } from "../bot/reminders.js";
import type { WhatsAppSender } from "../channels/whatsappClient.js";
import { demoClinics } from "../data/clinics/index.js";
import type { LlmProvider } from "../llm/types.js";
import { ClinicCalendar, type CalendarService } from "../services/calendar.js";
import type { Services } from "../services/factory.js";
import { ChannelNotifier, type Notifier, type WebOutbox } from "../services/notifier.js";
import type { Store } from "../services/store.js";
import type { SupabaseStore } from "../services/supabaseStore.js";
import type { Clock } from "../services/time.js";
import { setDefaultClinic } from "./context.js";
import type { ClinicKnowledge, ClinicProfile } from "./types.js";

/** Fila de la tabla `clinics` → perfil. */
export function rowToClinic(r: any): ClinicProfile {
  return {
    id: r.id,
    name: r.name,
    timezone: r.timezone,
    slotMinutes: r.slot_minutes,
    whatsappPhoneNumberId: r.whatsapp_phone_number_id ?? null,
    calendarTag: r.calendar_tag,
    primary: r.is_primary,
    calendarColor: r.calendar_color,
    knowledge: r.knowledge as ClinicKnowledge,
  };
}

export function clinicToRow(c: ClinicProfile) {
  return {
    id: c.id, name: c.name, timezone: c.timezone, slot_minutes: c.slotMinutes,
    whatsapp_phone_number_id: c.whatsappPhoneNumberId, calendar_tag: c.calendarTag,
    is_primary: c.primary, calendar_color: c.calendarColor, knowledge: c.knowledge,
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
  return data.map(rowToClinic);
}

export interface ClinicRuntime {
  profile: ClinicProfile;
  store: Store;
  calendar: CalendarService;
  bot: BotEngine;
  reminders: ReminderService;
  notifier: Notifier;
  /** Cliente de WhatsApp de su número, si tiene uno. */
  whatsapp: WhatsAppSender | null;
}

export interface RuntimeOptions {
  services: Services;
  clinics: ClinicProfile[];
  provider: LlmProvider;
  clock: Clock;
  outbox?: WebOutbox;
  /** Crea el cliente de WhatsApp para el número de una clínica (null = no se puede enviar). */
  whatsappFor?: (phoneNumberId: string) => WhatsAppSender | null;
}

/** Arma motor, agenda, avisos y recordatorios de cada clínica sobre los servicios compartidos. */
export function buildRuntimes(o: RuntimeOptions): Map<string, ClinicRuntime> {
  const map = new Map<string, ClinicRuntime>();
  const primary = o.clinics.find((c) => c.primary) ?? o.clinics[0];
  if (primary) setDefaultClinic(primary);
  for (const profile of o.clinics) {
    const store = o.services.store.forClinic(profile.id);
    const calendar = new ClinicCalendar(o.services.calendar, profile);
    const whatsapp = profile.whatsappPhoneNumberId && o.whatsappFor ? o.whatsappFor(profile.whatsappPhoneNumberId) : null;
    const notifier = new ChannelNotifier({ whatsapp, web: o.outbox ?? null, webPrefix: `${profile.id}|` });
    map.set(profile.id, {
      profile, store, calendar, notifier, whatsapp,
      bot: new BotEngine(o.provider, store, calendar, o.clock, profile),
      reminders: new ReminderService(store, notifier, o.clock, profile),
    });
  }
  return map;
}

/** Busca la clínica que tiene asignado un número de WhatsApp (webhook multiempresa). */
export function runtimeByPhoneNumberId(runtimes: Map<string, ClinicRuntime>, phoneNumberId: string | null | undefined) {
  if (!phoneNumberId) return null;
  return [...runtimes.values()].find((r) => r.profile.whatsappPhoneNumberId === phoneNumberId) ?? null;
}
