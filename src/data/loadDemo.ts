import { DateTime } from "luxon";
import type { ClinicProfile } from "../clinics/types.js";
import { withClinic } from "../clinics/context.js";
import { lineToRow } from "../clinics/lines.js";
import type { CalendarService } from "../services/calendar.js";
import type { Store } from "../services/store.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDemoData, type DemoData } from "./demoData.js";

/** Sube el PDF de ejemplo (indicaciones después del tratamiento) si la clínica todavía no lo tiene. */
export async function loadExampleDocument(store: Store): Promise<string | null> {
  const name = "indicaciones-post-tratamiento.pdf";
  if ((await store.listDocuments()).some((d) => d.name === name)) return null;
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { ROOT } = await import("../config.js");
  const { toChunks } = await import("../documents.js");
  const buf = readFileSync(path.join(ROOT, "docs/ejemplos", name));
  const doc = await store.addDocument({ name, mime: "application/pdf", sizeBytes: buf.length }, await toChunks(buf, "pdf"));
  return `${doc.name} (${doc.chunks} fragmentos)`;
}

/** Semilla distinta por clínica: datos distintos pero reproducibles. */
export const demoSeed = (c: ClinicProfile) => (c.primary || c.id.startsWith("demo-") ? 7 : 11);

/**
 * Crea en Google Calendar los turnos de ejemplo próximos de los profesionales que usan
 * Google (los pasados no ocupan agenda; los de agenda interna viven solo en la base).
 */
async function calendarEvents(data: DemoData, calendar: CalendarService, now: Date, clinic: ClinicProfile) {
  const ids = new Map<string, string>();
  const google = new Set(clinic.professionals.filter((p) => p.calendar === "google").map((p) => p.id));
  for (const a of data.appointments) {
    if (!["confirmada", "pendiente"].includes(a.status) || new Date(a.start) < now || !a.professionalId || !google.has(a.professionalId)) continue;
    const ev = await calendar.createEvent({
      start: DateTime.fromISO(a.start).toISO()!, end: DateTime.fromISO(a.end).toISO()!,
      summary: `${a.treatment} — ${a.patientName}`, description: `Id de cita: ${a.id}\nTurno de ejemplo (datos ficticios).`,
    }, { demo: "seed", professional: a.professionalId });
    ids.set(a.id, ev.id);
  }
  return ids;
}

/** Entorno de pruebas: carga los 30 días de ejemplo en la base en memoria. */
export async function loadDemoMemory(store: Store, calendar: CalendarService, clinic: ClinicProfile, now: Date): Promise<DemoData> {
  return withClinic(clinic, async () => {
    const data = buildDemoData(clinic, now, demoSeed(clinic));
    const ids = await calendarEvents(data, calendar, now, clinic);
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
 * `fresh`: clínica recién creada (demo pública): no hay nada que borrar ni comparar, y las
 * tablas que no dependen entre sí se cargan en paralelo para que «Entrar al demo» sea rápido.
 */
export async function loadDemoSupabase(db: SupabaseClient, calendar: CalendarService | null, clinic: ClinicProfile, now: Date, opts: { fresh?: boolean } = {}): Promise<DemoData> {
  return withClinic(clinic, async () => {
    const data = buildDemoData(clinic, now, demoSeed(clinic));
    const must = (r: { error: { message: string } | null }, what: string) => {
      if (r.error) throw new Error(`${what}: ${r.error.message}`);
    };
    let missing = clinic.professionals;
    if (!opts.fresh) {
      must(await db.from("patients").delete().eq("clinic_id", clinic.id).like("id", "demo_%"), "borrar ejemplos");
      must(await db.from("turn_metrics").delete().eq("clinic_id", clinic.id).like("conversation_id", "demo_%"), "borrar métricas de ejemplo");
      must(await db.from("professional_exceptions").delete().eq("clinic_id", clinic.id).like("id", "demo_%"), "borrar excepciones de ejemplo");
      // Profesionales de la clínica (si todavía no están; los editados en el panel no se pisan).
      const { data: existing } = await db.from("professionals").select("id").eq("clinic_id", clinic.id);
      const have = new Set((existing ?? []).map((p: any) => p.id));
      missing = clinic.professionals.filter((p) => !have.has(p.id));
    }
    const ids = calendar ? await calendarEvents(data, calendar, now, clinic) : new Map<string, string>();
    const c = clinic.id;
    const chunks = <T>(xs: T[], n = 300) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
    const insertAll = async <T>(table: string, what: string, rows: T[], map: (x: T) => object, n = 300) => {
      for (const part of chunks(rows, n)) if (part.length) must(await db.from(table).insert(part.map(map)), what);
    };
    const professionals = () => insertAll("professionals", "profesionales", missing, (p) => ({
      id: p.id, clinic_id: c, name: p.name, specialty: p.specialty, color: p.color, hours: p.hours, treatments: p.treatments, calendar: p.calendar, active: p.active,
    }));
    // Líneas de WhatsApp (solo clínica nueva; en las existentes las carga el seed). Antes que pacientes
    // y conversaciones, que las referencian, y después de los profesionales.
    const lines = () => insertAll("whatsapp_lines", "líneas de WhatsApp", opts.fresh ? clinic.lines : [], lineToRow);
    const patients = () => insertAll("patients", "pacientes", data.patients, (p) => ({
      id: p.id, clinic_id: c, phone: p.phone, name: p.name, profile_name: p.profileName, contact_phone: p.contactPhone,
      notes: p.notes, tags: p.tags, channel: p.channel, source: p.source, line_id: p.lineId ?? null, created_at: p.createdAt,
    }));
    const conversations = () => insertAll("conversations", "conversaciones", data.conversations, (v) => ({
      id: v.id, clinic_id: c, patient_id: v.patientId, channel: v.channel, llm_provider: v.llmProvider, messages: v.messages,
      privacy_shown: true, handed_off: v.handedOff, bot_paused: v.botPaused, assigned_to: v.assignedTo, closed_at: v.closedAt,
      closed_reason: v.closedReason, line_id: v.lineId ?? null, created_at: v.createdAt, updated_at: v.updatedAt,
    }));
    const appointments = () => insertAll("appointments", "turnos", data.appointments, (a) => ({
      id: a.id, clinic_id: c, patient_id: a.patientId, patient_name: a.patientName, treatment: a.treatment, professional_id: a.professionalId, start_at: a.start, end_at: a.end,
      status: a.status, calendar_event_id: ids.get(a.id) ?? "", confirmed_by_patient: a.confirmedByPatient,
      reminder24_sent: a.reminder24Sent, reminder2_sent: a.reminder2Sent, created_at: a.createdAt, cancelled_at: a.cancelledAt ?? null,
    }));
    const handoffs = () => insertAll("handoffs", "derivaciones", data.handoffs, (h) => ({
      id: h.id, clinic_id: c, conversation_id: h.conversationId, patient_id: h.patientId, reason: h.reason, summary: h.summary, status: h.status, created_at: h.createdAt,
    }), 1000);
    const metrics = () => insertAll("turn_metrics", "métricas", data.metrics, (m) => ({
      clinic_id: c, conversation_id: m.conversationId, provider: m.provider, model: m.model, latency_ms: m.latencyMs, input_tokens: m.inputTokens,
      output_tokens: m.outputTokens, cache_read_tokens: m.cacheReadTokens, cost_usd: m.costUsd, model_calls: m.modelCalls, tools: m.tools, at: m.at,
    }), 500);
    const waitlist = () => insertAll("waitlist", "lista de espera", data.waitlist, (w) => ({
      id: w.id, clinic_id: c, patient_id: w.patientId, patient_name: w.patientName, treatment: w.treatment, from_date: w.fromDate, to_date: w.toDate,
      franja: w.franja, status: w.status, professional_id: w.professionalId, created_at: w.createdAt,
    }), 1000);
    const exceptions = () => insertAll("professional_exceptions", "excepciones", data.exceptions, (e) => ({
      id: e.id, clinic_id: c, professional_id: e.professionalId, kind: e.kind, from_date: e.fromDate, to_date: e.toDate,
      from_time: e.fromTime, to_time: e.toTime, reason: e.reason, created_by: e.createdBy, notified_at: e.notifiedAt, created_at: e.createdAt,
    }), 1000);
    if (opts.fresh) {
      // Orden por claves foráneas: profesionales → líneas → pacientes → turnos, lista de espera, excepciones y
      // conversaciones → derivaciones. Las métricas no dependen de nada.
      await Promise.all([
        metrics(),
        professionals().then(lines).then(patients).then(() => Promise.all([
          appointments(), waitlist(), exceptions(), conversations().then(handoffs),
        ])),
      ]);
    } else {
      await professionals(); await patients(); await conversations(); await appointments();
      await handoffs(); await metrics(); await waitlist(); await exceptions();
    }
    return data;
  });
}
