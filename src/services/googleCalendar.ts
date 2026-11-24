import { auth, calendar, type calendar_v3 } from "@googleapis/calendar";
import type { DateTime } from "luxon";
import type { CalendarEvent, CalendarService } from "./calendar.js";
import { TZ } from "./time.js";

/**
 * Agenda real en Google Calendar mediante una cuenta de servicio.
 * El calendario de prueba se comparte con el correo de la cuenta de servicio
 * con permiso "Hacer cambios en eventos" (ver docs/guia-cuentas-supabase-google.md).
 */
export class GoogleCalendarService implements CalendarService {
  private api: calendar_v3.Calendar;

  constructor(private calendarId: string, keyFile: string) {
    const client = new auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/calendar.events"] });
    this.api = calendar({ version: "v3", auth: client });
  }

  async listEvents(from: DateTime, to: DateTime): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.api.events.list({
        calendarId: this.calendarId,
        timeMin: from.toISO()!,
        timeMax: to.toISO()!,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
        pageToken,
      });
      for (const e of res.data.items ?? []) {
        // Se ignoran eventos cancelados y los marcados como "disponible" (transparentes).
        if (e.status === "cancelled" || e.transparency === "transparent") continue;
        const start = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00` : null);
        const end = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00` : null);
        if (!start || !end || !e.id) continue;
        out.push({ id: e.id, start, end, summary: e.summary ?? "(ocupado)", description: e.description ?? undefined });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async createEvent(ev: Omit<CalendarEvent, "id">, tags: Record<string, string> = {}): Promise<CalendarEvent> {
    const res = await this.api.events.insert({
      calendarId: this.calendarId,
      requestBody: {
        summary: ev.summary,
        description: ev.description,
        start: { dateTime: ev.start, timeZone: TZ() },
        end: { dateTime: ev.end, timeZone: TZ() },
        colorId: tags.demo === "seed" ? "8" : "10", // gris = ejemplo, verde = reservado por el bot
        extendedProperties: { private: { origen: "bot-consultorio", ...tags } },
      },
    });
    return { ...ev, id: res.data.id! };
  }

  async deleteEvent(id: string): Promise<void> {
    try {
      await this.api.events.delete({ calendarId: this.calendarId, eventId: id });
    } catch (err: any) {
      // Si ya no existe (borrado a mano en el calendario), no es un error para el bot.
      if (err?.code === 404 || err?.code === 410) return;
      throw err;
    }
  }

  /** Borra los eventos de ejemplo creados por `npm run seed`. */
  async deleteSeedEvents(from: DateTime, to: DateTime): Promise<number> {
    const res = await this.api.events.list({
      calendarId: this.calendarId, timeMin: from.toISO()!, timeMax: to.toISO()!,
      privateExtendedProperty: ["demo=seed"], singleEvents: true, maxResults: 250,
    });
    const items = res.data.items ?? [];
    for (const e of items) if (e.id) await this.deleteEvent(e.id);
    return items.length;
  }

  /** Para el script de verificación: devuelve el nombre del calendario. */
  async ping(): Promise<string> {
    const res = await this.api.events.list({ calendarId: this.calendarId, maxResults: 1 });
    return res.data.summary ?? this.calendarId;
  }
}
