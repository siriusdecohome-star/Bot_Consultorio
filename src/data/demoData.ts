import { DateTime } from "luxon";
import { config } from "../config.js";
import type { ClinicProfile, Professional } from "../clinics/types.js";
import type {
  Appointment, AppointmentStatus, ChatMessage, Conversation, Handoff, Patient, ProfessionalException, TurnMetric, WaitlistEntry,
} from "../services/store.js";

/**
 * Datos de ejemplo de 30 días para una clínica: pacientes, conversaciones en todos
 * los estados, turnos (pasados y próximos), cancelaciones, derivaciones, lista de
 * espera, pacientes para reactivar y métricas de uso de la IA.
 * - Son inventados: teléfonos de rangos no asignados e ids «demo_…» (los recordatorios,
 *   la lista de espera y las respuestas de recepción no les envían nada).
 * - Es determinístico (misma semilla → mismos datos) y relativo a la fecha de hoy.
 * - Las métricas simulan Claude Haiku 5.5 con sus precios oficiales y se marcan
 *   «(simulado)» en el modelo: el panel las muestra como estimación, no como medición.
 */

export interface DemoData {
  patients: Patient[];
  conversations: Conversation[];
  appointments: Appointment[];
  handoffs: Handoff[];
  metrics: TurnMetric[];
  waitlist: WaitlistEntry[];
  exceptions: ProfessionalException[];
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

const FIRST_F = ["Lucía", "Valentina", "Camila", "Sofía", "Martina", "Isabella", "Emma", "Catalina", "Renata", "Julieta", "Paula",
  "Florencia", "Antonella", "Carla", "Daniela", "Mariana", "Victoria", "Laura", "Agustina", "Micaela", "Rocío", "Belén", "Natalia",
  "Gabriela", "Silvia", "Graciela", "Patricia", "Andrea", "Verónica", "Lorena", "Noelia", "Ximena", "Carolina", "Josefina"];
const FIRST_M = ["Mateo", "Santiago", "Benjamín", "Joaquín", "Tomás", "Lucas", "Nicolás", "Diego", "Gabriel", "Andrés", "Martín",
  "Sebastián", "Felipe", "Javier", "Ignacio", "Facundo", "Agustín", "Bruno", "Gonzalo", "Ramiro", "Federico", "Hernán", "Pablo",
  "Rodrigo", "Marcelo", "Claudio", "Esteban", "Leandro", "Matías", "Emiliano", "Alejandro", "Ricardo"];
const LAST = ["González", "Rodríguez", "Fernández", "López", "Martínez", "García", "Pérez", "Sánchez", "Romero", "Sosa", "Torres",
  "Álvarez", "Ruiz", "Flores", "Benítez", "Acosta", "Medina", "Herrera", "Suárez", "Aguirre", "Giménez", "Molina", "Rojas",
  "Quiroga", "Vargas", "Mamani", "Gutiérrez", "Castro", "Ortiz", "Navarro", "Cabrera", "Ríos", "Peralta", "Luna", "Ibáñez",
  "Paz", "Ledesma", "Villalba", "Correa", "Figueroa", "Ponce", "Arias", "Montenegro", "Salazar"];

const PRICES = { in: 0.1, out: 0.5 }; // Claude Haiku 5.5, USD por millón de tokens

type CloseHow = { reason: NonNullable<Conversation["closedReason"]>; at: DateTime };

export function buildDemoData(clinic: ClinicProfile, now: Date, seed = 7): DemoData {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const chance = (p: number) => r() < p;
  const tz = clinic.timezone;
  const nowDt = DateTime.fromJSDate(now).setZone(tz);
  const today = nowDt.startOf("day");
  const k = clinic.knowledge;
  const slot = clinic.slotMinutes;
  // Las clínicas temporales de la demo pública copian la principal: mismos datos de ejemplo,
  // con ids propios para no chocar con los de otra clínica.
  const temp = clinic.id.startsWith("demo-");
  const primary = clinic.primary || temp;
  const idTag = clinic.primary ? "a" : temp ? clinic.id.slice(5) : "b";
  const reception = primary ? "recepcion@sonrisaclara.demo.test" : "recepcion@altamira.demo.test";
  const promoSource = primary ? "promo-noviembre" : "chequeo-familiar";
  const sources = [promoSource, promoSource, promoSource, "instagram", "google", null, null] as const;
  const nPatients = primary ? 64 : 38;
  // Consultas de los últimos días que reservan para la semana próxima: así la agenda futura tiene turnos.
  const nUpcoming = primary ? 16 : 9;
  const phoneBase = primary ? 5491100002000 : 59170002000;
  const id = (p: string, n: number) => `demo_${idTag}_${p}${n}`;
  const iso = (dt: DateTime) => dt.toUTC().toISO()!;
  const address = k.address;
  const treatments = k.treatments.map((t) => t.name);
  const priceOf = (name: string) => k.treatments.find((t) => t.name === name)?.price ?? "a consultar";
  const when = (dt: DateTime) => dt.setLocale("es").toFormat("cccc dd/MM 'a las' HH:mm");
  const idle = config.inbox.idleHours;

  // --- Nombres sin repetir y nombre del perfil de WhatsApp (a veces distinto del real) ---
  const usedNames = new Set<string>();
  const person = () => {
    for (;;) {
      const female = chance(0.55);
      const first = pick(female ? FIRST_F : FIRST_M);
      const last = pick(LAST);
      const full = `${first} ${last}`;
      if (usedNames.has(full)) continue;
      usedNames.add(full);
      const style = r();
      const profile = style < 0.35 ? first : style < 0.55 ? full : style < 0.7 ? `${first} ${last[0]}.` :
        style < 0.8 ? `${first.slice(0, 3)} ${female ? "🌸" : "⚽"}` : style < 0.9 ? first.toLowerCase() : null;
      return { full, first, profile };
    }
  };

  // --- Agenda por profesional: cada turno con un profesional que hace el tratamiento y atiende ese día ---
  const profs = clinic.professionals.filter((p) => p.active);
  const tIdOf = (name: string) => k.treatments.find((t) => t.name === name)?.id;
  const doers = (treatment: string): Professional[] => {
    const id = tIdOf(treatment);
    const d = profs.filter((p) => id && p.treatments.some((x) => x.id === id));
    if (d.length) return d;
    const general = profs.filter((p) => /general/i.test(p.specialty));
    return general.length ? general : profs;
  };
  const minutesOf = (p: Professional, treatment: string) => p.treatments.find((x) => x.id === tIdOf(treatment))?.minutes ?? slot;
  const used = new Map<string, Array<[number, number]>>(); // profesional → intervalos ocupados (ms)
  const blocksOf = (p: Professional, day: DateTime) => {
    const at = (hm: string) => DateTime.fromISO(`${day.toISODate()}T${hm}`, { zone: tz });
    const clinicB = k.hours.find((x) => x.weekday === day.weekday)?.blocks ?? [];
    const own = p.hours.find((x) => x.weekday === day.weekday)?.blocks ?? [];
    const out: Array<[DateTime, DateTime]> = [];
    for (const [a1, b1] of own) for (const [a2, b2] of clinicB) {
      const a = DateTime.max(at(a1), at(a2)), b = DateTime.min(at(b1), at(b2));
      if (a < b) out.push([a, b]);
    }
    return out;
  };
  const freeSlot = (from: DateTime, maxDays: number, treatment: string): { start: DateTime; prof: Professional; minutes: number } | null => {
    for (let tries = 0; tries < 40; tries++) {
      const day = from.startOf("day").plus({ days: Math.floor(r() * maxDays) });
      const prof = pick(doers(treatment));
      const minutes = minutesOf(prof, treatment);
      const busy = used.get(prof.id) ?? [];
      const free: DateTime[] = [];
      for (const [a, b] of blocksOf(prof, day)) {
        for (let s = a; s.plus({ minutes }) <= b; s = s.plus({ minutes: slot })) {
          const e = s.plus({ minutes });
          if (s > from && !busy.some(([bs, be]) => s.toMillis() < be && e.toMillis() > bs)) free.push(s);
        }
      }
      if (free.length) {
        const start = pick(free);
        used.set(prof.id, [...busy, [start.toMillis(), start.plus({ minutes }).toMillis()]]);
        return { start, prof, minutes };
      }
    }
    return null;
  };
  const release = (profId: string, start: DateTime) => used.set(profId, (used.get(profId) ?? []).filter(([s]) => s !== start.toMillis()));

  const data: DemoData = { patients: [], conversations: [], appointments: [], handoffs: [], metrics: [], waitlist: [], exceptions: [] };
  const msg = (role: ChatMessage["role"], text: string, at: DateTime, extra?: Partial<ChatMessage>): ChatMessage => ({ role, text, at: iso(at), ...(extra ?? {}) });
  const newConv = (pid: string, cid: string, channel: Patient["channel"], first: DateTime, messages: ChatMessage[]): Conversation => ({
    id: cid, patientId: pid, channel, llmState: [], llmProvider: "mock", messages, privacyShown: true,
    handedOff: false, botPaused: false, assignedTo: null, closedAt: null, closedReason: null, createdAt: iso(first), updatedAt: iso(first),
  });
  const LABEL = { inactividad: "por inactividad", turno_confirmado: "turno confirmado", turno_cancelado: "turno cancelado", manual: "cerrada a mano" };
  const close = (c: Conversation, how: CloseHow) => {
    c.closedAt = iso(how.at);
    c.closedReason = how.reason;
    c.messages.push(msg("system", `Conversación cerrada (${LABEL[how.reason]}).`, how.at));
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const hello = (p: { profile: string | null }, channel: string) =>
    `¡Hola${p.profile && channel === "whatsapp" ? `, ${cap(p.profile.split(" ")[0]!)}` : ""}! 👋 Soy el asistente virtual de *${k.name}*.`;

  /** Primer intercambio según el motivo de la consulta: varía el texto para que no se repita. */
  const opening = (topic: string, treatment: string, p: { profile: string | null }, channel: string): Array<[ChatMessage["role"], string]> => {
    const h = hello(p, channel);
    const tr = treatment.toLowerCase().split(" (")[0];
    switch (topic) {
      case "promo": return [
        ["patient", pick([`Hola, vi la ${k.promo.name} en Instagram`, "Buenas! Sigue vigente la promo?", "Hola quería info de la promo", "Hola 😊 me pasaron la promo, ¿cómo es?"])],
        ["bot", `${h}\n\nSí, sigue vigente 🦷 *${k.promo.name}*: ${k.promo.detail}\n\n¿Le busco un turno?`],
      ];
      case "precio": return [
        ["patient", pick([`Hola, ¿cuánto sale ${tr}?`, `Buen día, precio de ${tr}?`, `Hola! Quería saber el valor de ${tr}`])],
        ["bot", `${h}\n\n*${treatment}*: ${priceOf(treatment)}. ¿Quiere que le busque un turno?`],
      ];
      case "obra": return [
        ["patient", pick(["Hola, ¿trabajan con obra social?", "Buenas tardes, atienden por seguro?", "Hola, tengo cobertura médica, ¿me sirve?"])],
        ["bot", `${h}\n\n${k.insurance}\n\n¿Le busco un turno?`],
      ];
      case "ninos": return [
        ["patient", pick(["Hola, ¿atienden niños? Mi hijo tiene 6 años", "Buenas! Hacen odontología para chicos?", "Hola, quería turno para mi hija de 8"])],
        ["bot", `${h}\n\n${k.faq?.find((f) => /niñ/i.test(f.q))?.a ?? "Sí, atendemos niños."}\n\n¿Le busco un turno?`],
      ];
      case "horario": return [
        ["patient", pick(["Hola, ¿hasta qué hora atienden?", "Buen día, abren los sábados?", "Hola, ¿qué horarios tienen?"])],
        ["bot", `${h}\n\nAtendemos ${k.hoursText.charAt(0).toLowerCase()}${k.hoursText.slice(1)}\n\n¿Le busco un turno?`],
      ];
      case "direccion": return [
        ["patient", pick(["Hola, ¿dónde quedan?", "Buenas, ¿tienen estacionamiento?", "Hola! Me pasás la dirección?"])],
        ["bot", `${h}\n\n📍 ${address}. ${k.reference}\n\n¿Le busco un turno?`],
      ];
      default: return [
        ["patient", pick([`Hola, quiero sacar un turno para ${tr}`, "Hola, necesito un turno", "Buenas, tienen turno esta semana?", "Hola! Quisiera agendar una consulta"])],
        ["bot", `${h}\n\n¡Con gusto! ¿Qué día le queda mejor? Puedo buscarle horarios de mañana o de tarde.`],
      ];
    }
  };

  // ================================================================
  // Historia de los últimos 30 días (la mayoría ya cerradas)
  // ================================================================
  for (let i = 0; i < nPatients + nUpcoming; i++) {
    const upcoming = i >= nPatients;
    const who = person();
    const channel: Patient["channel"] = chance(primary ? 0.88 : 0.8) ? "whatsapp" : "web";
    const phone = channel === "whatsapp" ? `+${phoneBase + i}` : `web:demo${(seed * 1000 + i).toString(36)}`;
    const source = pick(sources);
    let first: DateTime;
    do {
      const daysAgo = upcoming ? 1 + Math.floor(r() * 4) : 1 + Math.floor(Math.pow(r(), 1.3) * 29);
      first = today.minus({ days: daysAgo }).set({ hour: 8 + Math.floor(r() * 13), minute: Math.floor(r() * 60) });
    } while (first.weekday === 7 && chance(0.7));
    const pid = id("p", i);
    const topic = source === promoSource ? "promo" : pick(["precio", "precio", "turno", "turno", "obra", "ninos", "horario", "direccion"]);
    const books = upcoming || chance(source === promoSource ? 0.68 : 0.55);
    const kids = treatments.find((t) => /pediat|niñ/i.test(t));
    const treatment = source === promoSource ? `${k.promo.name} (promo)` : topic === "ninos" && kids ? kids : pick(treatments);
    const patient: Patient = {
      id: pid, phone, name: null, profileName: channel === "whatsapp" ? who.profile : null, contactPhone: channel === "whatsapp" ? phone : null,
      notes: "", tags: [], channel, source, createdAt: iso(first),
    };
    data.patients.push(patient);

    const at = (min: number) => first.plus({ minutes: min });
    const messages: ChatMessage[] = opening(topic, treatment, who, channel).map(([role, text], j) => msg(role, text, at(j * 0.1)));
    const conv = newConv(pid, id("c", i), channel, first, messages);
    let closedHow: CloseHow | null = null;

    if (books) {
      const got = upcoming ? freeSlot(DateTime.max(first.plus({ hours: 2 }), nowDt.plus({ hours: 3 })), 8, treatment) : freeSlot(first.plus({ hours: 2 }), 9, treatment);
      if (got) {
        const { start, prof, minutes } = got;
        patient.name = who.full;
        messages.push(msg("patient", pick(["Sí, quiero un turno", "Dale, buscame uno", "Sí por favor", `Sí, ${start.hour < 13 ? "a la mañana" : "a la tarde"} si puede ser`]), at(2)));
        messages.push(msg("bot", `Tengo libre el *${when(start)}* con ${prof.name}, entre otros horarios. ¿Le sirve?`, at(2.1)));
        messages.push(msg("patient", pick(["Sí, perfecto", "Ese me sirve", "Dale, ese", "Sí!"]), at(3)));
        messages.push(msg("bot", "¡Excelente! Para confirmar la reserva, ¿me indica su nombre y apellido?", at(3.1)));
        messages.push(msg("patient", pick([who.full, `Soy ${who.full}`, who.full.toLowerCase()]), at(4)));
        messages.push(msg("bot", `¡Listo, ${who.first}! ✅ Su turno quedó confirmado:\n\n📅 *${when(start)}*\n🦷 ${treatment}\n👩‍⚕️ ${prof.name}\n📍 ${address}\n\nLe enviaré un recordatorio el día anterior.`, at(4.1)));
        const bookedAt = at(4.1);
        closedHow = { reason: "turno_confirmado", at: bookedAt.plus({ seconds: 2 }) };
        const past = start < nowDt;
        let status: AppointmentStatus = past ? (chance(0.82) ? "asistio" : "ausente") : chance(0.85) ? "confirmada" : "pendiente";
        let cancelledAt: string | null = null;
        let confirmed = status === "asistio" || (status === "confirmada" && chance(0.5));
        // Recordatorio del día anterior (con la respuesta «Confirmo»).
        const remindAt = start.minus({ hours: 24 });
        if (remindAt > bookedAt.plus({ hours: 3 }) && remindAt < nowDt) {
          messages.push(msg("bot", `⏰ Hola ${who.first}, le recordamos su turno de mañana *${when(start)}* (${treatment}). ¿Nos confirma su asistencia?`, remindAt, { meta: { kind: "reminder24", appointmentId: id("t", i) } }));
          if (confirmed) {
            const yes = remindAt.plus({ minutes: 20 + Math.floor(r() * 200) });
            messages.push(msg("patient", pick(["Confirmo", "Sí, confirmo", "Confirmo, gracias"]), yes));
            messages.push(msg("bot", `¡Gracias, ${who.first}! ✅ Su asistencia quedó confirmada. ¡Lo esperamos!`, yes.plus({ seconds: 3 })));
            closedHow = { reason: "turno_confirmado", at: yes.plus({ seconds: 5 }) };
          } else {
            closedHow = null;
          }
        }
        if (chance(upcoming ? 0.05 : 0.13)) {
          status = "cancelada";
          confirmed = false;
          const c = DateTime.min(start.minus({ hours: 2 + Math.floor(r() * 40) }), nowDt.minus({ minutes: 30 }));
          const cAt = c > bookedAt ? c : bookedAt.plus({ hours: 3 });
          cancelledAt = iso(cAt);
          messages.push(msg("patient", pick(["Hola, no voy a poder ir, quiero cancelar", "Buenas, tengo que cancelar el turno, me surgió un viaje", "Hola, perdón, ¿puedo cancelar?"]), cAt));
          messages.push(msg("bot", "Listo, cancelé su turno y el horario quedó libre. ¿Lo reprogramamos?", cAt.plus({ seconds: 5 })));
          closedHow = { reason: "turno_cancelado", at: cAt.plus({ seconds: 7 }) };
          release(prof.id, start);
        }
        data.appointments.push({
          id: id("t", i), patientId: pid, patientName: who.full, treatment, professionalId: prof.id, start: iso(start), end: iso(start.plus({ minutes })),
          status, calendarEventId: "", confirmedByPatient: confirmed,
          reminder24Sent: past || remindAt < nowDt, reminder2Sent: past, createdAt: iso(bookedAt), cancelledAt,
        });
        if (chance(0.25)) patient.tags.push(pick(primary ? ["Promo noviembre", "Paga en cuotas", "Prefiere tarde", "Ortodoncia"] : ["Chequeo familiar", "Grupo familiar", "Prefiere mañana", "Niños"]));
        if (chance(0.12)) patient.notes = pick(["Prefiere que le escriban después de las 18 h.", "Viene con su hijo; pedir turno doble si es posible.", "Pidió factura a nombre de su empresa.", "Primera visita: llegar 10 minutos antes para la ficha."]);
      }
    } else if (chance(0.35)) {
      const fAt = at(60 * 20);
      if (fAt < nowDt) {
        messages.push(msg("bot", `Hola 👋 Le escribo de ${k.name}. Hace poco consultó por la *${k.promo.name}*. ¿Quiere que le busque un turno?`, fAt, { meta: { kind: "followup" } }));
        if (chance(0.4)) messages.push(msg("patient", "Más adelante", fAt.plus({ hours: 1 })));
      }
    }

    // Algunas pasaron por una persona: en la historia ya están resueltas.
    if (chance(0.1)) {
      const t0 = DateTime.min(DateTime.fromISO(messages.at(-1)!.at).plus({ minutes: 30 }), nowDt.minus({ days: 1, hours: 2 }));
      if (t0 > first.plus({ minutes: 5 })) {
        const clinical = chance(0.5);
        messages.push(msg("patient", clinical ? pick(["Me duele una muela desde ayer, ¿qué puedo tomar?", "Se me rompió un pedacito de diente, ¿es urgente?"]) : pick(["Prefiero hablar con una persona", "¿Me puede atender alguien de recepción?"]), t0));
        messages.push(msg("bot", clinical ? "Lamento la molestia. No puedo indicar medicamentos; le paso su consulta al equipo para que lo atiendan." : "¡Por supuesto! Ya le pasé su consulta a una persona del equipo.", t0.plus({ seconds: 6 })));
        messages.push(msg("system", `${reception} tomó la conversación: el asistente deja de responder.`, t0.plus({ minutes: 25 })));
        messages.push(msg("human", clinical ? "Hola, le habla Recepción. Le reservamos un sobreturno para hoy a las 17:00, ¿le sirve?" : "Hola, le habla Recepción. Aceptamos tarjeta en 3 cuotas sin interés. ¿Le reservo un turno?", t0.plus({ minutes: 26 }), { by: reception }));
        messages.push(msg("patient", pick(["Perfecto, gracias!", "Buenísimo, gracias", "Dale, muchas gracias"]), t0.plus({ minutes: 40 })));
        messages.push(msg("system", `${reception} devolvió la conversación al asistente.`, t0.plus({ minutes: 45 })));
        data.handoffs.push({
          id: id("h", i), conversationId: conv.id, patientId: pid, reason: clinical ? "consulta_clinica" : "pedido_del_paciente",
          summary: clinical ? "Paciente con dolor de muela; pide qué tomar. Ofrecer turno de urgencia." : "Pidió hablar con una persona sobre formas de pago.",
          status: "resuelta", createdAt: iso(t0),
        });
      }
    }

    messages.sort((a, b) => a.at.localeCompare(b.at));
    const last = DateTime.fromISO(messages.at(-1)!.at);
    // Cerrada al resolver el turno (si fue lo último) o por inactividad; si no, sigue con el bot.
    if (closedHow && closedHow.at >= last) close(conv, closedHow);
    else if (nowDt.diff(last, "hours").hours >= idle) close(conv, { reason: "inactividad", at: last.plus({ hours: idle }) });
    conv.updatedAt = conv.messages.at(-1)!.at;
    data.conversations.push(conv);
  }

  // ================================================================
  // Conversaciones de hoy en cada estado de la bandeja
  // ================================================================
  let n = 0;
  const live = (
    minutesAgo: number,
    channel: Patient["channel"],
    script: Array<[ChatMessage["role"], string, number?]>,
    opts: {
      realName?: boolean; handedOff?: boolean; botPaused?: boolean; assigned?: boolean; tags?: string[]; notes?: string; source?: string | null;
      handoff?: Pick<Handoff, "reason" | "summary">;
    } = {},
  ) => {
    const j = n++;
    const who = person();
    const pid = id("live_p", j);
    const startAt = nowDt.minus({ minutes: minutesAgo });
    const phone = channel === "whatsapp" ? `+${phoneBase + 800 + j}` : `web:demolive${seed}x${j}`;
    data.patients.push({
      id: pid, phone, name: opts.realName ? who.full : null, profileName: channel === "whatsapp" ? who.profile ?? who.first : null,
      contactPhone: channel === "whatsapp" ? phone : null, notes: opts.notes ?? "", tags: opts.tags ?? [], channel,
      source: opts.source ?? null, createdAt: iso(startAt.minus({ days: opts.realName ? 40 + j : 0 })),
    });
    let t = startAt;
    const messages = script.map(([role, text, gap]) => {
      t = t.plus({ minutes: gap ?? 0.1 });
      return msg(role, text.replace("{first}", who.first).replace("{hello}", hello(who, channel)), t, role === "human" ? { by: reception } : undefined);
    });
    const conv = newConv(pid, id("live_c", j), channel, startAt, messages);
    conv.handedOff = !!opts.handedOff;
    conv.botPaused = !!opts.botPaused;
    conv.assignedTo = opts.assigned ? reception : null;
    conv.updatedAt = messages.at(-1)!.at;
    data.conversations.push(conv);
    if (opts.handoff) data.handoffs.push({ ...opts.handoff, id: id("live_h", j), conversationId: conv.id, patientId: pid, status: "abierta", createdAt: messages[1]?.at ?? iso(startAt) });
    return conv;
  };

  // Esperan respuesta: derivadas por el bot, sin respuesta de recepción todavía.
  live(42, "whatsapp", [
    ["patient", "Hola, se me salió un empaste y me molesta al tomar frío"],
    ["bot", "{hello}\n\nLamento la molestia. No puedo darle indicaciones clínicas por aquí, pero ya le pasé su consulta al equipo para que le den un turno lo antes posible. 🙌"],
    ["patient", "Gracias, ¿hoy a la tarde podrían?", 6],
    ["bot", "Su mensaje fue recibido. Una persona del equipo le responderá a la brevedad. 🙌"],
  ], { handedOff: true, handoff: { reason: "consulta_clinica", summary: "Se le salió un empaste, sensibilidad al frío. Pregunta si hay turno hoy a la tarde." } });
  live(130, "whatsapp", [
    ["patient", "Buenas, quería saber si puedo pagar el tratamiento en cuotas con transferencia"],
    ["bot", `{hello}\n\n${k.payments} Para planes de pago a medida le paso con una persona del equipo.`],
    ["patient", "Sí, prefiero hablar con alguien", 3],
    ["bot", "¡Por supuesto! Ya le pasé su consulta a una persona del equipo, que le va a responder por este mismo chat."],
  ], { handedOff: true, handoff: { reason: "pedido_del_paciente", summary: "Quiere pagar un tratamiento en cuotas por transferencia; pide hablar con una persona." }, source: promoSource });

  // Con una persona: recepción ya respondió y espera al paciente.
  live(75, "whatsapp", [
    ["patient", "Hola, necesito cambiar el turno de mi mamá, ella no usa WhatsApp"],
    ["bot", "{hello}\n\nPara gestionar el turno de otra persona le paso con recepción. 🙌"],
    ["system", `${reception} tomó la conversación: el asistente deja de responder.`, 12],
    ["human", "Hola {first}, soy de recepción. ¿Me pasa el nombre completo de su mamá y el día del turno?", 1],
  ], { handedOff: true, assigned: true, handoff: { reason: "tomada_desde_panel", summary: `Tomada desde el panel por ${reception}.` } });

  // Pausada: recepción negocia un presupuesto y pausó el bot.
  live(60 * 20, "whatsapp", [
    ["patient", "Hola, me pasaron un presupuesto de implantes y quería ver si se puede ajustar"],
    ["bot", "{hello}\n\nLe paso con el equipo para revisar el presupuesto. 🙌"],
    ["system", `${reception} pausó el asistente en esta conversación.`, 30],
    ["human", "Hola {first}, revisamos el presupuesto con la doctora. Le mando la propuesta en un rato.", 2],
    ["patient", "Perfecto, quedo atento", 15],
    ["human", "Listo, le envié la propuesta por correo. Cualquier duda me escribe por aquí.", 60],
  ], { botPaused: true, assigned: true, realName: true, tags: ["Presupuesto"], notes: "Evaluando implantes. Recepción le envió la propuesta por correo." });

  // Con el bot: consultas de hoy que el asistente está atendiendo.
  const menuLabels = k.menu?.options.map((o) => o.label);
  live(14, "whatsapp", [
    ["patient", "Hola!"],
    ["bot", `{hello}\n\n${k.menu?.intro ?? "¿En qué le puedo ayudar?"}`],
    ["patient", menuLabels?.find((l) => /precio/i.test(l)) ?? "Precios", 1],
    ["bot", `Estos son nuestros valores:\n\n${k.treatments.slice(0, 4).map((x) => `• ${x.name}: *${x.price}*`).join("\n")}\n\n¿Le busco un turno?`],
  ], { source: "instagram" });
  live(95, "web", [
    ["patient", `Hola, ¿${k.hours.some((h) => h.weekday === 6) ? "atienden los sábados" : "atienden después de las 18"}?`],
    ["bot", `{hello}\n\nAtendemos ${k.hoursText.charAt(0).toLowerCase()}${k.hoursText.slice(1)}\n\n¿Le busco un turno?`],
  ]);
  live(6, "whatsapp", [
    ["patient", "Hola, quiero turno para una limpieza"],
    ["bot", "{hello}\n\n¡Con gusto! 📅 ¿Prefiere mañana o tarde?"],
    ["patient", "A la tarde", 2],
    ["bot", "Tengo estos horarios libres:\n\n1️⃣ 15:00\n2️⃣ 15:30\n3️⃣ 16:30\n\n¿Cuál prefiere?"],
  ], { source: promoSource });
  // El menú de la primera conversación «con el bot» muestra sus opciones en el panel.
  const withMenu = data.conversations.at(-3)!;
  if (menuLabels) withMenu.messages[1]!.options = menuLabels;

  // Métricas simuladas: un registro por cada respuesta del bot (no por los avisos automáticos).
  for (const conv of data.conversations) {
    for (const m of conv.messages.filter((x) => x.role === "bot" && !x.meta)) {
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
    const who = person();
    const pid = id("r", j);
    const visit = today.minus({ months: 7 + Math.floor(r() * 4), days: Math.floor(r() * 20) }).set({ hour: 10 + (j % 6) });
    const ph = `+${phoneBase + 500 + j}`;
    data.patients.push({
      id: pid, phone: ph, name: who.full, profileName: who.profile, contactPhone: ph,
      notes: "", tags: [], channel: "whatsapp", source: null, createdAt: iso(visit.minus({ days: 3 })),
    });
    const rtTreatment = pick(treatments);
    data.appointments.push({
      id: id("rt", j), patientId: pid, patientName: who.full, treatment: rtTreatment, professionalId: doers(rtTreatment)[0]?.id ?? null, start: iso(visit), end: iso(visit.plus({ minutes: slot })),
      status: "asistio", calendarEventId: "", confirmedByPatient: true, reminder24Sent: true, reminder2Sent: true, createdAt: iso(visit.minus({ days: 3 })),
    });
  }

  // Lista de espera: consultas que no encontraron horario (dejaron su nombre al anotarse).
  const waiting = data.patients.filter((p) => p.id.includes("_p") && !p.id.includes("live") && !data.appointments.some((a) => a.patientId === p.id)).slice(0, primary ? 4 : 2);
  waiting.forEach((p, j) => {
    const from = today.plus({ days: 1 + j });
    p.name ??= person().full;
    data.waitlist.push({
      id: id("w", j), patientId: p.id, patientName: p.name, treatment: j % 2 ? pick(treatments) : `${k.promo.name} (promo)`,
      fromDate: from.toISODate()!, toDate: from.plus({ days: 4 }).toISODate()!, franja: (["manana", "tarde", "cualquiera"] as const)[j % 3]!, professionalId: null,
      status: "esperando", offeredSlot: null, offeredAt: null, declinedSlots: [], createdAt: iso(today.minus({ days: j + 1 }).set({ hour: 11 })),
    });
  });

  // Excepciones de agenda: un día de curso con turnos afectados (para avisar por el bot) y unas vacaciones futuras.
  const upcomingActive = data.appointments.filter((a) => ["confirmada", "pendiente"].includes(a.status) && new Date(a.start) > now && a.professionalId);
  const byDay = new Map<string, number>();
  for (const a of upcomingActive) {
    const key = `${a.professionalId}|${DateTime.fromISO(a.start).setZone(tz).toISODate()}`;
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const busiest = [...byDay.entries()].filter(([k]) => k.split("|")[1]! > today.toISODate()!).sort((a, b) => b[1] - a[1])[0];
  if (busiest) {
    const [profId, date] = busiest[0].split("|") as [string, string];
    data.exceptions.push({
      id: id("x", 0), professionalId: profId, kind: "dia", fromDate: date, toDate: date, fromTime: null, toTime: null,
      reason: "Curso de actualización", createdBy: `admin@${primary ? "sonrisaclara" : "altamira"}.demo.test`, notifiedAt: null, createdAt: iso(nowDt.minus({ hours: 3 })),
    });
  }
  const other = profs.find((p) => p.id !== busiest?.[0].split("|")[0]);
  if (other) {
    const from = today.plus({ days: 21 });
    data.exceptions.push({
      id: id("x", 1), professionalId: other.id, kind: "rango", fromDate: from.toISODate()!, toDate: from.plus({ days: 6 }).toISODate()!,
      fromTime: null, toTime: null, reason: "Vacaciones", createdBy: `admin@${primary ? "sonrisaclara" : "altamira"}.demo.test`, notifiedAt: null, createdAt: iso(nowDt.minus({ days: 2 })),
    });
  }

  return data;
}
