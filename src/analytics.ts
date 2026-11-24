import { DateTime } from "luxon";
import type { Appointment, Conversation, Handoff, Patient, TurnMetric } from "./services/store.js";

/**
 * Cálculos del panel (estadísticas y costos) como funciones puras sobre los datos
 * de UNA clínica: se prueban sin servidor y valen igual para memoria y Supabase.
 * Las fechas se agrupan por día en la zona horaria de la clínica.
 */

export type ConvStatus = "bot" | "persona" | "pausada";

export function conversationStatus(c: Conversation): ConvStatus {
  if (c.botPaused) return "pausada";
  if (c.handedOff) return "persona";
  return "bot";
}

/** La conversación espera una respuesta de una persona: el último mensaje es del paciente y el bot no responde. */
export function waitingForHuman(c: Conversation): boolean {
  if (conversationStatus(c) === "bot") return false;
  const lastPatient = c.messages.findLastIndex((m) => m.role === "patient");
  const lastHuman = c.messages.findLastIndex((m) => m.role === "human");
  return lastPatient > lastHuman;
}

const dayKey = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: "utc" }).setZone(tz).toISODate()!;
const firstPatientAt = (c: Conversation) => c.messages.find((m) => m.role === "patient")?.at ?? c.createdAt;
const normTreatment = (t: string) =>
  t.replace(/\s*\(.*?\)\s*/g, " ").replace(/^promo:\s*/i, "Promo ").replace(/\s+/g, " ").trim() || "Sin especificar";

export interface StatsInput {
  tz: string;
  now: Date;
  days: number;
  patients: Patient[];
  conversations: Conversation[];
  appointments: Appointment[];
  handoffs: Handoff[];
}

export interface DailyRow {
  date: string;
  consultas: number;
  pacientesNuevos: number;
  turnosAgendados: number;
  turnosCancelados: number;
}

export function buildStats(i: StatsInput) {
  const end = DateTime.fromJSDate(i.now).setZone(i.tz).startOf("day");
  const start = end.minus({ days: i.days - 1 });
  const rows = new Map<string, DailyRow>();
  for (let d = start; d <= end; d = d.plus({ days: 1 })) {
    const k = d.toISODate()!;
    rows.set(k, { date: k, consultas: 0, pacientesNuevos: 0, turnosAgendados: 0, turnosCancelados: 0 });
  }
  const inRange = (iso: string) => rows.has(dayKey(iso, i.tz));
  const bump = (iso: string, f: keyof Omit<DailyRow, "date">) => {
    const r = rows.get(dayKey(iso, i.tz));
    if (r) r[f]++;
  };

  const convs = i.conversations.filter((c) => c.messages.some((m) => m.role === "patient"));
  for (const c of convs) bump(firstPatientAt(c), "consultas");
  for (const p of i.patients) bump(p.createdAt, "pacientesNuevos");
  // Un turno reprogramado se reemplaza por uno nuevo: se cuenta solo el nuevo.
  const booked = i.appointments.filter((a) => a.status !== "reprogramada");
  for (const a of booked) bump(a.createdAt, "turnosAgendados");
  for (const a of i.appointments.filter((x) => x.status === "cancelada")) bump(a.cancelledAt ?? a.start, "turnosCancelados");

  // Conversión: de los pacientes nuevos del período, cuántos reservaron al menos un turno.
  const withAppt = new Set(booked.map((a) => a.patientId));
  const newPatients = i.patients.filter((p) => inRange(p.createdAt));
  const leads = newPatients.filter((p) => p.source);
  const rate = (xs: Patient[]) => (xs.length ? xs.filter((p) => withAppt.has(p.id)).length / xs.length : 0);

  // Resueltas por el bot vs traspasadas a una persona (conversaciones del período).
  const periodConvs = convs.filter((c) => inRange(firstPatientAt(c)));
  const handedIds = new Set(i.handoffs.map((h) => h.conversationId));
  const traspasadas = periodConvs.filter((c) => c.handedOff || handedIds.has(c.id) || c.botPaused).length;

  // Tratamientos más pedidos (turnos del período).
  const byTreatment = new Map<string, number>();
  for (const a of booked.filter((x) => inRange(x.createdAt))) {
    const k = normTreatment(a.treatment);
    byTreatment.set(k, (byTreatment.get(k) ?? 0) + 1);
  }

  const daily = [...rows.values()];
  const sum = (f: keyof Omit<DailyRow, "date">) => daily.reduce((s, r) => s + r[f], 0);
  return {
    from: start.toISODate(),
    to: end.toISODate(),
    days: i.days,
    daily,
    totals: {
      consultas: sum("consultas"),
      pacientesNuevos: sum("pacientesNuevos"),
      turnosAgendados: sum("turnosAgendados"),
      turnosCancelados: sum("turnosCancelados"),
    },
    conversion: {
      pacientesNuevos: newPatients.length,
      conTurno: newPatients.filter((p) => withAppt.has(p.id)).length,
      tasa: rate(newPatients),
      leadsPromo: leads.length,
      tasaLeads: rate(leads),
    },
    resolucion: { total: periodConvs.length, bot: periodConvs.length - traspasadas, traspasadas },
    tratamientos: [...byTreatment.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

export interface CostRow {
  month: string; // "2026-11"
  turns: number;
  conversations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  costPerConversation: number;
}

/** Costos por mes, el mes en curso con proyección a fin de mes, y desglose por modelo. */
export function buildCosts(metrics: TurnMetric[], tz: string, now: Date) {
  const byMonth = new Map<string, { rows: TurnMetric[]; convs: Set<string> }>();
  for (const m of metrics) {
    const k = DateTime.fromISO(m.at, { zone: "utc" }).setZone(tz).toFormat("yyyy-MM");
    const g = byMonth.get(k) ?? { rows: [], convs: new Set<string>() };
    g.rows.push(m);
    g.convs.add(m.conversationId);
    byMonth.set(k, g);
  }
  const months: CostRow[] = [...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, g]) => {
    const costUsd = g.rows.reduce((s, m) => s + m.costUsd, 0);
    return {
      month,
      turns: g.rows.length,
      conversations: g.convs.size,
      inputTokens: g.rows.reduce((s, m) => s + m.inputTokens, 0),
      outputTokens: g.rows.reduce((s, m) => s + m.outputTokens, 0),
      cacheReadTokens: g.rows.reduce((s, m) => s + m.cacheReadTokens, 0),
      costUsd,
      costPerConversation: g.convs.size ? costUsd / g.convs.size : 0,
    };
  });

  const local = DateTime.fromJSDate(now).setZone(tz);
  const current = months.find((m) => m.month === local.toFormat("yyyy-MM"));
  const elapsed = local.day - 1 + (local.hour * 60 + local.minute) / 1440;
  const daysInMonth = local.daysInMonth ?? 30;
  const factor = elapsed > 0 ? daysInMonth / elapsed : 0;

  const byModel = new Map<string, { turns: number; costUsd: number }>();
  for (const m of metrics) {
    const k = `${m.provider} · ${m.model}`;
    const g = byModel.get(k) ?? { turns: 0, costUsd: 0 };
    g.turns++;
    g.costUsd += m.costUsd;
    byModel.set(k, g);
  }

  return {
    months,
    currentMonth: {
      month: local.toFormat("yyyy-MM"),
      costToDate: current?.costUsd ?? 0,
      conversations: current?.conversations ?? 0,
      projectedCost: (current?.costUsd ?? 0) * factor,
      projectedConversations: Math.round((current?.conversations ?? 0) * factor),
      daysElapsed: Math.round(elapsed * 10) / 10,
      daysInMonth,
    },
    byModel: [...byModel.entries()].map(([model, g]) => ({ model, ...g })).sort((a, b) => b.costUsd - a.costUsd),
    onlyMock: metrics.length > 0 && metrics.every((m) => m.provider === "mock"),
    /** Hay métricas de los datos de ejemplo (simuladas, no medidas). */
    simulated: metrics.some((m) => m.model.includes("(simulado)")),
  };
}
