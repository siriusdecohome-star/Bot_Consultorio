import { DateTime } from "luxon";
import { config } from "../config.js";
import type { ClinicProfile } from "../clinics/types.js";
import type { Appointment, AppointmentStatus, ChatMessage, Conversation, Handoff, Patient, TurnMetric, WaitlistEntry } from "../services/store.js";

/**
 * Datos de ejemplo FICTICIOS de 30 días para una clínica: pacientes, conversaciones,
 * turnos (pasados y próximos), cancelaciones, derivaciones, lista de espera, pacientes
 * para reactivar y métricas de uso de la IA.
 * - Todo es inventado: nombres con «(demo)», teléfonos de rangos ficticios e ids «demo_…».
 * - Es determinístico (misma semilla → mismos datos), relativo a la fecha de hoy.
 * - Las métricas simulan Claude Haiku 5.5 con sus precios oficiales y se marcan
 *   «(simulado)» en el modelo, para no confundirlas con mediciones reales.
 */

export interface DemoData {
  patients: Patient[];
  conversations: Conversation[];
  appointments: Appointment[];
  handoffs: Handoff[];
  metrics: TurnMetric[];
  waitlist: WaitlistEntry[];
}

/** Generador pseudoaleatorio con semilla (mulberry32): reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Lucía", "Mateo", "Valentina", "Santiago", "Camila", "Benjamín", "Sofía", "Joaquín", "Martina", "Tomás", "Isabella", "Lucas",
  "Emma", "Nicolás", "Catalina", "Diego", "Renata", "Gabriel", "Julieta", "Andrés", "Paula", "Martín", "Florencia", "Sebastián",
  "Antonella", "Felipe", "Carla", "Javier", "Daniela", "Ignacio", "Mariana", "Facundo", "Victoria", "Agustín", "Laura", "Bruno"];
const LAST = ["González", "Rodríguez", "Fernández", "López", "Martínez", "García", "Pérez", "Sánchez", "Romero", "Sosa", "Torres",
  "Álvarez", "Ruiz", "Flores", "Benítez", "Acosta", "Medina", "Herrera", "Suárez", "Aguirre", "Giménez", "Molina", "Rojas",
  "Quiroga", "Vargas", "Mamani", "Choque", "Gutiérrez", "Castro", "Ortiz"];

const PRICES = { in: 0.1, out: 0.5 }; // Claude Haiku 5.5, USD por millón de tokens

export function buildDemoData(clinic: ClinicProfile, now: Date, seed = 7): DemoData {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const chance = (p: number) => r() < p;
  const tz = clinic.timezone;
  const today = DateTime.fromJSDate(now).setZone(tz).startOf("day");
  const k = clinic.knowledge;
  const slot = clinic.slotMinutes;
  const primary = clinic.primary;
  const promoSource = primary ? "promo-noviembre" : "chequeo-familiar";
  const sources = [promoSource, promoSource, promoSource, "instagram", "google", null, null] as const;
  const nPatients = primary ? 64 : 38;
  // Consultas de los últimos días que reservan para la semana próxima: así la agenda futura tiene turnos.
  const nUpcoming = primary ? 16 : 9;
  const nowDt = DateTime.fromJSDate(now).setZone(tz);
  const phoneBase = primary ? 5491100002000 : 59170002000;
  const id = (p: string, n: number) => `demo_${primary ? "a" : "b"}_${p}${n}`;
  const iso = (dt: DateTime) => dt.toUTC().toISO()!;

  // Horarios de atención → turnos posibles de un día (sin repetir: índice único por clínica)
  const used = new Set<string>();
  const slotsOf = (day: DateTime) => {
    const h = k.hours.find((x) => x.weekday === day.weekday);
    if (!h) return [];
    const out: DateTime[] = [];
    for (const [a, b] of h.blocks) {
      let s = DateTime.fromISO(`${day.toISODate()}T${a}`, { zone: tz });
      const e = DateTime.fromISO(`${day.toISODate()}T${b}`, { zone: tz });
      for (; s.plus({ minutes: slot }) <= e; s = s.plus({ minutes: slot })) out.push(s);
    }
    return out;
  };
  const freeSlot = (from: DateTime, maxDays: number): DateTime | null => {
    for (let tries = 0; tries < 30; tries++) {
      const day = from.startOf("day").plus({ days: Math.floor(r() * maxDays) });
      const free = slotsOf(day).filter((s) => s > from && !used.has(s.toISO()!));
      if (free.length) {
        const s = pick(free);
        used.add(s.toISO()!);
        return s;
      }
    }
    return null;
  };

  const data: DemoData = { patients: [], conversations: [], appointments: [], handoffs: [], metrics: [], waitlist: [] };
  const treatments = k.treatments.map((t) => t.name);
  const msg = (role: ChatMessage["role"], text: string, at: DateTime, meta?: ChatMessage["meta"]): ChatMessage => ({ role, text, at: iso(at), ...(meta ? { meta } : {}) });

  for (let i = 0; i < nPatients + nUpcoming; i++) {
    const upcoming = i >= nPatients;
    const name = `${pick(FIRST)} ${pick(LAST)} (demo)`;
    const channel = chance(primary ? 0.8 : 0.35) ? "whatsapp" : "web";
    const phone = channel === "whatsapp" ? `+${phoneBase + i}` : `web:demo${(seed * 1000 + i).toString(36)}`;
    const source = pick(sources);
    // Las consultas se concentran en días hábiles y crecen un poco hacia hoy (efecto de la promo).
    let first: DateTime;
    do {
      const daysAgo = upcoming ? Math.floor(r() * 4) : Math.floor(Math.pow(r(), 1.3) * 30);
      first = today.minus({ days: daysAgo }).set({ hour: 8 + Math.floor(r() * 13), minute: Math.floor(r() * 60) });
    } while ((first.weekday === 7 && chance(0.7)) || first > nowDt);
    const pid = id("p", i);
    const books = upcoming || chance(source === promoSource ? 0.68 : 0.55);
    const treatment = source === promoSource ? `${k.promo.name} (promo)` : pick(treatments);
    const patient: Patient = { id: pid, phone, name: books || chance(0.4) ? name : null, channel, source, createdAt: iso(first) };
    data.patients.push(patient);

    const at = (min: number) => first.plus({ minutes: min });
    const messages: ChatMessage[] = [msg("patient", source === promoSource ? `Hola, vi la ${k.promo.name}` : `Hola, ¿cuánto sale ${treatment.toLowerCase()}?`, at(0))];
    messages.push(msg("bot", `¡Hola! 👋 Gracias por escribir a *${k.name}*. ${source === promoSource ? `*${k.promo.name}*: ${k.promo.detail}` : `${treatment}: ${k.treatments.find((t) => t.name === treatment)?.price ?? "consultar"}.`}\n\n¿Le busco un turno?`, at(0.1)));
    const conv: Conversation = {
      id: id("c", i), patientId: pid, channel, llmState: [], llmProvider: "mock", messages, privacyShown: true,
      handedOff: false, botPaused: false, createdAt: iso(first), updatedAt: iso(first),
    };

    if (books) {
      const start = upcoming ? freeSlot(DateTime.max(first.plus({ hours: 2 }), nowDt.plus({ hours: 2 })), 8) : freeSlot(first.plus({ hours: 2 }), 9);
      if (start) {
        messages.push(msg("patient", "Sí, quiero un turno", at(2)));
        messages.push(msg("bot", `Tengo libre el *${start.setLocale("es").toFormat("cccc dd/MM 'a las' HH:mm")}*, entre otros horarios. ¿Le sirve?`, at(2.1)));
        messages.push(msg("patient", `Sí. Soy ${name.replace(" (demo)", "")}`, at(4)));
        messages.push(msg("bot", `¡Listo! ✅ Su turno quedó confirmado:\n\n📅 *${start.setLocale("es").toFormat("cccc dd/MM 'a las' HH:mm")}*\n🦷 ${treatment}`, at(4.1)));
        const past = start < DateTime.fromJSDate(now);
        let status: AppointmentStatus = past ? (chance(0.82) ? "asistio" : "ausente") : chance(0.85) ? "confirmada" : "pendiente";
        let cancelledAt: string | null = null;
        if (chance(upcoming ? 0.05 : 0.13)) {
          status = "cancelada";
          const c = DateTime.min(start.minus({ hours: 2 + Math.floor(r() * 40) }), DateTime.fromJSDate(now));
          cancelledAt = iso(c > first ? c : first.plus({ hours: 3 }));
          messages.push(msg("patient", "Hola, no voy a poder ir, quiero cancelar", DateTime.fromISO(cancelledAt)));
          messages.push(msg("bot", "Listo, cancelé su turno y el horario quedó libre. ¿Lo reprogramamos?", DateTime.fromISO(cancelledAt).plus({ seconds: 5 })));
          used.delete(start.toISO()!);
        }
        data.appointments.push({
          id: id("t", i), patientId: pid, patientName: name, treatment, start: iso(start), end: iso(start.plus({ minutes: slot })),
          status, calendarEventId: "", confirmedByPatient: status === "asistio" || (status === "confirmada" && chance(0.5)),
          reminder24Sent: past, reminder2Sent: past, createdAt: messages[5]!.at, cancelledAt,
        });
      }
    } else if (chance(0.35)) {
      messages.push(msg("bot", `Hola 👋 Le escribo de ${k.name}. Hace poco consultó por la *${k.promo.name}*. ¿Quiere que le busque un turno?`, at(60 * 20), { kind: "followup" }));
      if (chance(0.4)) messages.push(msg("patient", "Más adelante", at(60 * 21)));
    }

    // Algunas conversaciones pasan a una persona (pedido del paciente o consulta clínica).
    if (chance(0.11)) {
      const t0 = DateTime.fromISO(messages.at(-1)!.at).plus({ minutes: 30 });
      const clinical = chance(0.5);
      messages.push(msg("patient", clinical ? "Me duele una muela desde ayer, ¿qué puedo tomar?" : "Prefiero hablar con una persona", t0));
      messages.push(msg("bot", clinical ? "Lamento la molestia. No puedo indicar medicamentos; le paso su consulta al equipo para que lo atiendan." : "¡Por supuesto! Ya le pasé su consulta a una persona del equipo.", t0.plus({ seconds: 6 })));
      const open = chance(0.25) && t0 > today.minus({ days: 3 });
      data.handoffs.push({
        id: id("h", i), conversationId: conv.id, patientId: pid, reason: clinical ? "consulta_clinica" : "pedido_del_paciente",
        summary: clinical ? "Paciente con dolor de muela desde ayer; pide qué tomar. Ofrecer turno de urgencia." : "Pidió hablar con una persona sobre formas de pago.",
        status: open ? "abierta" : "resuelta", createdAt: iso(t0),
      });
      if (open) conv.handedOff = true;
      else messages.push(msg("human", clinical ? "Hola, soy de recepción. Le reservamos un sobreturno para hoy a las 17:00, ¿le sirve?" : "Hola, aceptamos tarjeta en 3 cuotas sin interés. ¿Le reservo un turno?", t0.plus({ minutes: 40 })));
    }

    conv.updatedAt = messages.at(-1)!.at;
    data.conversations.push(conv);

    // Métricas simuladas: un registro por cada respuesta del bot.
    for (const m of messages.filter((x) => x.role === "bot" && !x.meta)) {
      const inputTokens = 2600 + Math.floor(r() * 1600);
      const outputTokens = 90 + Math.floor(r() * 160);
      data.metrics.push({
        conversationId: conv.id, provider: "claude", model: `${config.claude.model.includes("haiku") ? config.claude.model : "claude-haiku-5-5"} (simulado)`,
        latencyMs: 900 + Math.floor(r() * 1500), inputTokens, outputTokens, cacheReadTokens: 0,
        costUsd: (inputTokens * PRICES.in + outputTokens * PRICES.out) / 1e6, modelCalls: chance(0.5) ? 2 : 1,
        tools: chance(0.5) ? ["buscar_horarios_disponibles"] : [], at: m.at,
      });
    }
  }

  // Pacientes que no vuelven (última visita hace 7 a 10 meses): candidatos a reactivación.
  for (let j = 0; j < (primary ? 6 : 4); j++) {
    const name = `${pick(FIRST)} ${pick(LAST)} (demo)`;
    const pid = id("r", j);
    const visit = today.minus({ months: 7 + Math.floor(r() * 4), days: Math.floor(r() * 20) }).set({ hour: 10 + j % 6 });
    data.patients.push({ id: pid, phone: `+${phoneBase + 500 + j}`, name, channel: "whatsapp", source: null, createdAt: iso(visit.minus({ days: 3 })) });
    data.appointments.push({
      id: id("rt", j), patientId: pid, patientName: name, treatment: pick(treatments), start: iso(visit), end: iso(visit.plus({ minutes: slot })),
      status: "asistio", calendarEventId: "", confirmedByPatient: true, reminder24Sent: true, reminder2Sent: true, createdAt: iso(visit.minus({ days: 3 })),
    });
  }

  // Lista de espera: algunos leads que no encontraron horario.
  const waiting = data.patients.filter((p) => p.name && !data.appointments.some((a) => a.patientId === p.id)).slice(0, primary ? 4 : 2);
  waiting.forEach((p, j) => {
    const from = today.plus({ days: 1 + j });
    data.waitlist.push({
      id: id("w", j), patientId: p.id, patientName: p.name!, treatment: j % 2 ? pick(treatments) : `${k.promo.name} (promo)`,
      fromDate: from.toISODate()!, toDate: from.plus({ days: 4 }).toISODate()!, franja: (["manana", "tarde", "cualquiera"] as const)[j % 3]!,
      status: "esperando", offeredSlot: null, offeredAt: null, declinedSlots: [], createdAt: iso(today.minus({ days: j + 1 }).set({ hour: 11 })),
    });
  });

  return data;
}
