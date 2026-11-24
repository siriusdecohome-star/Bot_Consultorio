import { existsSync } from "node:fs";
import { config } from "../config.js";
import { InMemoryCalendar, type CalendarService } from "./calendar.js";
import { InMemoryStore, type Store } from "./store.js";

export interface Services {
  /** Base vista desde la clínica principal; `store.forClinic(id)` da la vista de otra clínica. */
  store: Store;
  /** Calendario compartido, sin filtrar: cada clínica lo usa a través de ClinicCalendar. */
  calendar: CalendarService;
  storeKind: "supabase" | "memoria";
  calendarKind: "google" | "memoria";
}

export const hasSupabase = () => Boolean(config.supabase.url && config.supabase.secretKey);
export const hasGoogle = () => Boolean(config.google.calendarId && (config.google.keyJsonBase64 || existsSync(config.google.keyFile)));

/**
 * Elige la implementación según el .env: si están las credenciales usa los
 * servicios reales; si no, memoria. Así la demo funciona siempre.
 * `forceMemory` lo usan las pruebas para no tocar datos reales.
 */
export async function createServices(opts: { forceMemory?: boolean } = {}): Promise<Services> {
  let store: Store = new InMemoryStore();
  let calendar: CalendarService = new InMemoryCalendar();
  let storeKind: Services["storeKind"] = "memoria";
  let calendarKind: Services["calendarKind"] = "memoria";

  if (!opts.forceMemory && hasSupabase()) {
    const { SupabaseStore } = await import("./supabaseStore.js");
    store = SupabaseStore.withSecretKey(config.supabase.url, config.supabase.secretKey);
    storeKind = "supabase";
  }
  if (!opts.forceMemory && hasGoogle()) {
    const { GoogleCalendarService } = await import("./googleCalendar.js");
    calendar = new GoogleCalendarService(config.google.calendarId, config.google.keyFile);
    calendarKind = "google";
  }
  return { store, calendar, storeKind, calendarKind };
}
