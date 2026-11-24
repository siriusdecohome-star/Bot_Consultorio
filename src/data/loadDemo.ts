import { DateTime } from "luxon";
import type { ClinicProfile } from "../clinics/types.js";
import { withClinic } from "../clinics/context.js";
import type { CalendarService } from "../services/calendar.js";
import type { Store } from "../services/store.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDemoData, type DemoData } from "./demoData.js";

/** Semilla distinta por clínica: datos distintos pero reproducibles. */
export const demoSeed = (c: ClinicProfile) => (c.primary ? 7 : 11);

/** Crea en el calendario los turnos de ejemplo próximos (los pasados no ocupan agenda). */
async function calendarEvents(data: DemoData, calendar: CalendarService, now: Date) {
  const ids = new Map<string, string>();
  for (const a of data.appointments) {
    if (!["confirmada", "pendiente"].includes(a.status) || new Date(a.start) < now) continue;
    const ev = await calendar.createEvent({
      start: DateTime.fromISO(a.start).toISO()!, end: DateTime.fromISO(a.end).toISO()!,
      summary: `${a.treatment} — ${a.patientName}`, description: `Id de cita: ${a.id}\nTurno de ejemplo (datos ficticios).`,
    }, { demo: "seed" });
    ids.set(a.id, ev.id);
  }
  return ids;
}

/** Entorno de pruebas: carga los 30 días de ejemplo en la base en memoria. */
export async function loadDemoMemory(store: Store, calendar: CalendarService, clinic: ClinicProfile, now: Date): Promise<DemoData> {
  return withClinic(clinic, async () => {
    const data = buildDemoData(clinic, now, demoSeed(clinic));
    const ids = await calendarEvents(data, calendar, now);
    for (const a of data.appointments) a.calendarEventId = ids.get(a.id) ?? "";
    const mem = store as Store & { importDemo?: (d: DemoData) => void };
    if (!mem.importDemo) throw new Error("loadDemoMemory solo funciona con la base en memoria");
    mem.importDemo(data);
    return data;
  });
}

/**
 * Supabase: reemplaza los datos de ejemplo (ids demo_…) de una clínica por los 30 días
 * generados. No toca los datos reales (conversaciones de WhatsApp, pruebas).
 */
export async function loadDemoSupabase(db: SupabaseClient, calendar: CalendarService | null, clinic: ClinicProfile, now: Date): Promise<DemoData> {
  return withClinic(clinic, async () => {
    const data = buildDemoData(clinic, now, demoSeed(clinic));
    const must = (r: { error: { message: string } | null }, what: string) => {
      if (r.error) throw new Error(`${what}: ${r.error.message}`);
    };
    must(await db.from("patients").delete().eq("clinic_id", clinic.id).like("id", "demo_%"), "borrar ejemplos");
    must(await db.from("turn_metrics").delete().eq("clinic_id", clinic.id).like("conversation_id", "demo_%"), "borrar métricas de ejemplo");
    const ids = calendar ? await calendarEvents(data, calendar, now) : new Map<string, string>();
    const c = clinic.id;
    const chunks = <T>(xs: T[], n = 300) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
    for (const part of chunks(data.patients)) {
      must(await db.from("patients").insert(part.map((p) => ({ id: p.id, clinic_id: c, phone: p.phone, name: p.name, channel: p.channel, source: p.source, created_at: p.createdAt }))), "pacientes");
    }
    for (const part of chunks(data.conversations)) {
      must(await db.from("conversations").insert(part.map((v) => ({
        id: v.id, clinic_id: c, patient_id: v.patientId, channel: v.channel, llm_provider: v.llmProvider, messages: v.messages,
        privacy_shown: true, handed_off: v.handedOff, bot_paused: false, created_at: v.createdAt, updated_at: v.updatedAt,
      }))), "conversaciones");
    }
    for (const part of chunks(data.appointments)) {
      must(await db.from("appointments").insert(part.map((a) => ({
        id: a.id, clinic_id: c, patient_id: a.patientId, patient_name: a.patientName, treatment: a.treatment, start_at: a.start, end_at: a.end,
        status: a.status, calendar_event_id: ids.get(a.id) ?? "", confirmed_by_patient: a.confirmedByPatient,
        reminder24_sent: a.reminder24Sent, reminder2_sent: a.reminder2Sent, created_at: a.createdAt, cancelled_at: a.cancelledAt ?? null,
      }))), "turnos");
    }
    if (data.handoffs.length) {
      must(await db.from("handoffs").insert(data.handoffs.map((h) => ({
        id: h.id, clinic_id: c, conversation_id: h.conversationId, patient_id: h.patientId, reason: h.reason, summary: h.summary, status: h.status, created_at: h.createdAt,
      }))), "derivaciones");
    }
    for (const part of chunks(data.metrics, 500)) {
      must(await db.from("turn_metrics").insert(part.map((m) => ({
        clinic_id: c, conversation_id: m.conversationId, provider: m.provider, model: m.model, latency_ms: m.latencyMs, input_tokens: m.inputTokens,
        output_tokens: m.outputTokens, cache_read_tokens: m.cacheReadTokens, cost_usd: m.costUsd, model_calls: m.modelCalls, tools: m.tools, at: m.at,
      }))), "métricas");
    }
    if (data.waitlist.length) {
      must(await db.from("waitlist").insert(data.waitlist.map((w) => ({
        id: w.id, clinic_id: c, patient_id: w.patientId, patient_name: w.patientName, treatment: w.treatment, from_date: w.fromDate, to_date: w.toDate,
        franja: w.franja, status: w.status, created_at: w.createdAt,
      }))), "lista de espera");
    }
    return data;
  });
}
