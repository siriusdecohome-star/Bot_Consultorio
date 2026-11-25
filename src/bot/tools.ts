import { DateTime } from "luxon";
import { config } from "../config.js";
import type { ToolDef } from "../llm/types.js";
import type { CalendarService, Franja } from "../services/calendar.js";
import {
  Availability, activeProfessionals, candidatesFor, findTreatment, minutesFor, professionalById, specialtiesList, treatmentIdOf,
} from "../services/availability.js";
import type { Professional } from "../clinics/types.js";
import { SlotTakenError, type Appointment, type Conversation, type Patient, type Store } from "../services/store.js";
import { human, localKey, parseLocal, toLocal, type Clock } from "../services/time.js";
import { kb } from "../data/knowledge.js";

/**
 * Herramientas que el modelo puede llamar. Toda acción real (consultar agenda,
 * reservar, cancelar, derivar) pasa por acá y se valida en código:
 * el modelo propone, el backend decide.
 */
export const toolDefs: ToolDef[] = [
  {
    name: "guardar_nombre_paciente",
    description:
      "Guarda el nombre y apellido REAL del paciente apenas lo diga (por ejemplo, cuando se lo pide para agendar). No use el nombre del perfil de WhatsApp sin que el paciente lo confirme. El nombre se ve en la agenda y en la ficha del paciente.",
    parameters: {
      type: "object",
      properties: { nombre_completo: { type: "string", description: "Nombre y apellido tal como los dio el paciente." } },
      required: ["nombre_completo"],
      additionalProperties: false,
    },
  },
  {
    name: "listar_profesionales",
    description:
      "Devuelve las especialidades que se pueden agendar y los profesionales que atienden un tratamiento o una especialidad (con su id y días de atención). Úsela para preguntar con quién quiere atenderse cuando hay más de un profesional.",
    parameters: {
      type: "object",
      properties: {
        especialidad: { type: "string", description: "Especialidad, p. ej. 'Ortodoncia'. Opcional." },
        tratamiento: { type: "string", description: "Tratamiento, p. ej. 'Limpieza dental'. Opcional." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "buscar_horarios_disponibles",
    description:
      "Consulta la agenda real de los profesionales y devuelve horarios libres, cada uno con el profesional que atiende. Úsela SIEMPRE antes de ofrecer horarios; nunca ofrezca un horario que no haya devuelto esta herramienta. Indique el tratamiento (o la especialidad) para que use la duración y los profesionales correctos.",
    parameters: {
      type: "object",
      properties: {
        fecha_desde: { type: "string", description: "Primer día a buscar, formato YYYY-MM-DD (hora local del consultorio)." },
        fecha_hasta: { type: "string", description: "Último día a buscar, formato YYYY-MM-DD. Igual a fecha_desde para un solo día." },
        franja: { type: "string", enum: ["manana", "tarde", "cualquiera"], description: "Preferencia horaria del paciente." },
        tratamiento: { type: "string", description: "Tratamiento que necesita. Opcional pero recomendado." },
        especialidad: { type: "string", description: "Especialidad, si todavía no se sabe el tratamiento. Opcional." },
        profesional_id: { type: "string", description: "Id del profesional elegido (de listar_profesionales), o 'cualquiera' para el primero disponible." },
      },
      required: ["fecha_desde", "fecha_hasta", "franja"],
      additionalProperties: false,
    },
  },
  {
    name: "crear_cita",
    description:
      "Reserva un turno en la agenda para el paciente de esta conversación. Requiere nombre completo, tratamiento y un horario devuelto por buscar_horarios_disponibles. Confirme con el paciente antes de llamarla.",
    parameters: {
      type: "object",
      properties: {
        nombre_completo: { type: "string", description: "Nombre y apellido del paciente." },
        tratamiento: { type: "string", description: "Motivo o tratamiento, p. ej. 'Limpieza dental (promo)'." },
        inicio: { type: "string", description: "Inicio del turno en hora local, formato YYYY-MM-DDTHH:mm." },
        profesional_id: { type: "string", description: "Id del profesional del horario elegido (lo devuelve buscar_horarios_disponibles). Si falta, se asigna el primero disponible." },
      },
      required: ["nombre_completo", "tratamiento", "inicio"],
      additionalProperties: false,
    },
  },
  {
    name: "ver_citas_paciente",
    description: "Lista los próximos turnos activos del paciente de esta conversación (con su id).",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "cancelar_cita",
    description:
      "Cancela un turno del paciente y libera el horario en la agenda. Después de cancelar, ofrezca reprogramar.",
    parameters: {
      type: "object",
      properties: {
        cita_id: { type: "string", description: "Id del turno (de ver_citas_paciente)." },
        motivo: { type: "string", description: "Motivo breve que dio el paciente, o 'sin motivo'." },
      },
      required: ["cita_id", "motivo"],
      additionalProperties: false,
    },
  },
  {
    name: "reprogramar_cita",
    description:
      "Mueve un turno existente a un nuevo horario libre (devuelto por buscar_horarios_disponibles). Reserva el nuevo y libera el anterior.",
    parameters: {
      type: "object",
      properties: {
        cita_id: { type: "string", description: "Id del turno a mover." },
        nuevo_inicio: { type: "string", description: "Nuevo inicio en hora local, formato YYYY-MM-DDTHH:mm." },
        profesional_id: { type: "string", description: "Id de otro profesional, solo si el paciente pide cambiar de profesional." },
      },
      required: ["cita_id", "nuevo_inicio"],
      additionalProperties: false,
    },
  },
  {
    name: "confirmar_asistencia",
    description: "Registra que el paciente confirmó que asistirá a un turno (por ejemplo, al responder un recordatorio).",
    parameters: {
      type: "object",
      properties: { cita_id: { type: "string", description: "Id del turno (de ver_citas_paciente o del recordatorio)." } },
      required: ["cita_id"],
      additionalProperties: false,
    },
  },
  {
    name: "derivar_a_humano",
    description:
      "Deriva la conversación a una persona del consultorio con un resumen. Úsela si el paciente lo pide, si hay una consulta clínica, una queja, una urgencia o algo que no sabe responder.",
    parameters: {
      type: "object",
      properties: {
        motivo: { type: "string", enum: ["pedido_del_paciente", "consulta_clinica", "urgencia", "queja", "sin_informacion", "otro"] },
        resumen: { type: "string", description: "Resumen breve para la persona que toma la conversación: quién es, qué necesita y qué se hizo." },
      },
      required: ["motivo", "resumen"],
      additionalProperties: false,
    },
  },
  {
    name: "anotar_lista_espera",
    description:
      "Anota al paciente en la lista de espera cuando no hay horarios libres que le sirvan. Si se libera un turno en su rango de días y franja, el sistema se lo ofrece automáticamente por este chat. Confirme el rango con el paciente antes de llamarla.",
    parameters: {
      type: "object",
      properties: {
        nombre_completo: { type: "string", description: "Nombre y apellido del paciente." },
        tratamiento: { type: "string", description: "Motivo o tratamiento." },
        fecha_desde: { type: "string", description: "Primer día aceptable, YYYY-MM-DD." },
        fecha_hasta: { type: "string", description: "Último día aceptable, YYYY-MM-DD." },
        franja: { type: "string", enum: ["manana", "tarde", "cualquiera"] },
        profesional_id: { type: "string", description: "Id del profesional si el paciente quiere uno en particular; si no, omítalo." },
      },
      required: ["nombre_completo", "tratamiento", "fecha_desde", "fecha_hasta", "franja"],
      additionalProperties: false,
    },
  },
  {
    name: "buscar_en_documentos",
    description:
      "Busca en los documentos que subió el consultorio (protocolos, indicaciones, preguntas frecuentes ampliadas). Úsela cuando la pregunta no se responde con la información del prompt, antes de decir que no sabe. Responda solo con lo que devuelva.",
    parameters: {
      type: "object",
      properties: { consulta: { type: "string", description: "Qué buscar, con las palabras clave de la pregunta del paciente." } },
      required: ["consulta"],
      additionalProperties: false,
    },
  },
];

/** Normaliza un nombre dicho por el paciente: sin espacios de más, máx. 80 caracteres, con mayúscula inicial. */
export function cleanName(raw: string): string {
  const s = raw.replace(/\s+/g, " ").replace(/[^\p{L}\p{M} .'-]/gu, "").trim().slice(0, 80);
  if (s.length < 2) return "";
  return s.split(" ").map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

/**
 * Cambia el nombre real del paciente y lo propaga a sus turnos y a la lista de espera:
 * así el cambio se ve igual en el chat, la agenda y la lista de pacientes.
 */
export async function renamePatient(store: Store, patientId: string, name: string): Promise<Patient> {
  const p = await store.updatePatient(patientId, { name });
  for (const a of await store.listAppointments({ patientId })) {
    if (a.patientName !== name) await store.updateAppointment(a.id, { patientName: name });
  }
  for (const w of await store.listWaitlist(["esperando", "ofrecido"])) {
    if (w.patientId === patientId && w.patientName !== name) await store.updateWaitlist(w.id, { patientName: name });
  }
  return p;
}

/** Cerrojo simple: evita que dos reservas simultáneas tomen el mismo horario. */
let bookingChain: Promise<unknown> = Promise.resolve();
function withBookingLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = bookingChain.then(fn, fn);
  bookingChain = run.catch(() => undefined);
  return run;
}

export interface ToolContext {
  store: Store;
  calendar: CalendarService;
  clock: Clock;
  patient: Patient;
  conversation: Conversation;
  /** Se liberó un horario (hora local YYYY-MM-DDTHH:mm) de un profesional: se ofrece a la lista de espera. */
  onSlotFreed?: (slot: string, professionalId: string | null) => void;
}

const view = (a: Appointment) => ({
  id: a.id,
  tratamiento: a.treatment,
  inicio: localKey(toLocal(a.start)),
  cuando: human(toLocal(a.start)),
  profesional: professionalById(a.professionalId)?.name ?? null,
  estado: a.status,
});

const motivos: Record<string, string> = {
  fecha_invalida: "La fecha u hora no es válida.",
  horario_pasado_o_muy_proximo: "Ese horario ya pasó o falta menos de 1 hora; no se puede reservar.",
  fuera_de_horario: "Ese horario está fuera del horario de atención de ese profesional.",
  profesional_no_atiende: "Ese profesional no atiende en ese horario (ausencia o vacaciones).",
  horario_ocupado: "Ese horario ya está ocupado.",
  sin_profesional: "No hay un profesional libre para ese tratamiento en ese horario.",
};

const daysText = (p: Professional) => {
  const names = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
  return p.hours.map((h) => `${names[h.weekday - 1]} ${h.blocks.map(([a, b]) => `${a}-${b}`).join(" y ")}`).join(", ");
};

export { findTreatment };

export function makeExecutor(ctx: ToolContext) {
  const avail = new Availability(ctx.calendar, ctx.clock, ctx.store);

  async function suggestNear(start: DateTime, treatment?: string | null, professionalId?: string | null) {
    const d = start.isValid ? start : toLocal(ctx.clock());
    const slots = await avail.freeSlots({ fromDate: d.toISODate()!, toDate: d.plus({ days: 3 }).toISODate()!, franja: "cualquiera", treatment, professionalId, limit: 4 });
    return slots.map((s) => ({ inicio: s.inicio, profesional_id: s.professionalId, profesional: s.professional }));
  }

  /**
   * Reserva en dos pasos: (1) la base "toma" el horario (su restricción por profesional
   * impide la doble reserva) y (2) si el profesional usa Google Calendar, se crea el evento.
   * Si el calendario falla, se deshace el paso 1 para no dejar datos inconsistentes.
   */
  async function book(name: string, treatment: string, start: DateTime, p: Professional, minutes: number): Promise<Appointment> {
    const end = start.plus({ minutes });
    const appt = await ctx.store.createAppointment({
      patientId: ctx.patient.id,
      patientName: name,
      treatment,
      professionalId: p.id,
      start: start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
      status: "confirmada",
      calendarEventId: "",
      confirmedByPatient: false,
      reminder24Sent: false,
      reminder2Sent: false,
    });
    if (p.calendar !== "google") return appt;
    try {
      const ev = await ctx.calendar.createEvent({
        start: start.toISO()!,
        end: end.toISO()!,
        summary: `${treatment} — ${name}`,
        description: `Paciente: ${name}\nProfesional: ${p.name}\nTeléfono: ${ctx.patient.phone}\nCanal: ${ctx.conversation.channel}\nId de cita: ${appt.id}\nReservado por el asistente virtual.`,
      }, { professional: p.id });
      return await ctx.store.updateAppointment(appt.id, { calendarEventId: ev.id });
    } catch (err) {
      await ctx.store.deleteAppointment(appt.id);
      throw err;
    }
  }

  /** Ejecuta una reserva y traduce la doble reserva a un resultado entendible para el modelo. */
  async function tryBook<T>(start: DateTime, treatment: string, professionalId: string | null, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SlotTakenError) {
        return { ok: false, error: "horario_ocupado", mensaje: motivos.horario_ocupado, alternativas: await suggestNear(start, treatment, professionalId) };
      }
      throw err;
    }
  }

  async function ownAppointment(id: string) {
    const a = await ctx.store.getAppointment(id);
    if (!a || a.patientId !== ctx.patient.id) return null;
    return a;
  }

  /** Profesional para un horario: el pedido (si se indicó) o el primero libre que haga el tratamiento. */
  async function resolveProfessional(start: DateTime, treatment: string, wanted: unknown, excludeId?: string) {
    const id = typeof wanted === "string" && wanted && wanted !== "cualquiera" ? wanted : null;
    if (id) {
      const p = candidatesFor({ professionalId: id })[0];
      return p ? { p, err: await avail.validate(start, p, minutesFor(p, treatment), excludeId) } : { p: null, err: "sin_profesional" };
    }
    const p = await avail.pick(start, treatment, null, excludeId);
    if (p) return { p, err: null };
    // Nadie libre: se informa el motivo del primero que hace el tratamiento (fuera de horario, ocupado…).
    const first = candidatesFor({ treatment })[0];
    return { p: null, err: first ? (await avail.validate(start, first, minutesFor(first, treatment), excludeId)) ?? "sin_profesional" : "sin_profesional" };
  }

  return async function execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "guardar_nombre_paciente": {
        const nombre = cleanName(String(input.nombre_completo ?? ""));
        if (!nombre) return { ok: false, error: "nombre_invalido", mensaje: "Pida el nombre y apellido nuevamente." };
        ctx.patient = await renamePatient(ctx.store, ctx.patient.id, nombre);
        return { ok: true, nombre };
      }

      case "listar_profesionales": {
        const list = input.especialidad || input.tratamiento
          ? candidatesFor({ treatment: input.tratamiento as string, specialty: input.especialidad as string })
          : activeProfessionals();
        const tName = (id: string) => kb().treatments.find((t) => treatmentIdOf(t) === id)?.name ?? id;
        return {
          especialidades: specialtiesList(),
          profesionales: list.map((p) => ({ id: p.id, nombre: p.name, especialidad: p.specialty, tratamientos: p.treatments.map((t) => tName(t.id)), atiende: daysText(p) })),
          nota: list.length > 1 ? "Hay más de un profesional: pregunte con quién prefiere atenderse y ofrezca también «el primero disponible»." : "Hay un solo profesional para esto: no hace falta preguntar.",
        };
      }

      case "buscar_horarios_disponibles": {
        const slots = await avail.freeSlots({
          fromDate: String(input.fecha_desde), toDate: String(input.fecha_hasta), franja: (input.franja as Franja) ?? "cualquiera",
          treatment: input.tratamiento as string | undefined, specialty: input.especialidad as string | undefined,
          professionalId: input.profesional_id as string | undefined,
        });
        return {
          horarios: slots.map((s) => ({ inicio: s.inicio, cuando: human(parseLocal(s.inicio)), profesional_id: s.professionalId, profesional: s.professional, minutos: s.minutes })),
          nota: slots.length ? "Ofrezca solo estos horarios y diga con qué profesional es cada uno." : "No hay horarios libres en ese rango; proponga buscar otros días u otro profesional, o la lista de espera.",
        };
      }

      case "crear_cita": {
        const start = parseLocal(String(input.inicio));
        const treatment = String(input.tratamiento);
        return withBookingLock(async () => {
          const { p, err } = await resolveProfessional(start, treatment, input.profesional_id);
          if (err || !p) return { ok: false, error: err, mensaje: motivos[err ?? "sin_profesional"], alternativas: await suggestNear(start, treatment) };
          const nombre = String(input.nombre_completo).trim();
          return tryBook(start, treatment, p.id, async () => {
            const a = await book(nombre, treatment, start, p, minutesFor(p, treatment));
            if (!ctx.patient.name) ctx.patient = await ctx.store.updatePatient(ctx.patient.id, { name: nombre });
            return { ok: true, cita: view(a), politica: kb().cancellationPolicy };
          });
        });
      }

      case "ver_citas_paciente": {
        const list = await ctx.store.listAppointments({
          patientId: ctx.patient.id,
          from: toLocal(ctx.clock()).toUTC().toISO()!,
          status: ["confirmada", "pendiente"],
        });
        return { citas: list.map(view) };
      }

      case "cancelar_cita": {
        const a = await ownAppointment(String(input.cita_id));
        if (!a) return { ok: false, error: "cita_no_encontrada" };
        if (a.status === "cancelada") return { ok: false, error: "ya_cancelada" };
        if (a.calendarEventId) await ctx.calendar.deleteEvent(a.calendarEventId);
        await ctx.store.updateAppointment(a.id, { status: "cancelada", cancelledAt: ctx.clock().toISOString() });
        ctx.onSlotFreed?.(localKey(toLocal(a.start)), a.professionalId);
        const start = toLocal(a.start);
        const lastMinute = start.diff(toLocal(ctx.clock()), "hours").hours < 2;
        return {
          ok: true,
          cancelada: view({ ...a, status: "cancelada" }),
          aviso_ultimo_momento: lastMinute,
          siguiente_paso: "Ofrezca reprogramar ahora mismo con buscar_horarios_disponibles.",
        };
      }

      case "reprogramar_cita": {
        const a = await ownAppointment(String(input.cita_id));
        if (!a || a.status === "cancelada") return { ok: false, error: "cita_no_encontrada" };
        const start = parseLocal(String(input.nuevo_inicio));
        const wanted = input.profesional_id ?? a.professionalId;
        return withBookingLock(async () => {
          // Mismo profesional salvo que el paciente pida otro; el turno actual no cuenta como ocupado.
          let { p, err } = await resolveProfessional(start, a.treatment, wanted, a.id);
          if ((err || !p) && !input.profesional_id && a.professionalId) ({ p, err } = await resolveProfessional(start, a.treatment, null, a.id));
          if (err || !p) return { ok: false, error: err, mensaje: motivos[err ?? "sin_profesional"], alternativas: await suggestNear(start, a.treatment, a.professionalId) };
          // Primero se libera el turno viejo en la base (para que no choque consigo mismo) y se reserva el nuevo;
          // si algo falla, el viejo vuelve a quedar activo: el paciente nunca se queda sin turno.
          await ctx.store.updateAppointment(a.id, { status: "reprogramada" });
          const r = await tryBook(start, a.treatment, p.id, async () => {
            const nueva = await book(a.patientName, a.treatment, start, p!, minutesFor(p!, a.treatment));
            return { ok: true as const, anterior: view(a), nueva: view(nueva) };
          }).catch(async (err) => { await ctx.store.updateAppointment(a.id, { status: a.status }); throw err; });
          if (!r.ok) { await ctx.store.updateAppointment(a.id, { status: a.status }); return r; }
          if (a.calendarEventId) await ctx.calendar.deleteEvent(a.calendarEventId);
          ctx.onSlotFreed?.(localKey(toLocal(a.start)), a.professionalId);
          return r;
        });
      }

      case "confirmar_asistencia": {
        const a = await ownAppointment(String(input.cita_id));
        if (!a || !["confirmada", "pendiente"].includes(a.status)) return { ok: false, error: "cita_no_encontrada" };
        await ctx.store.updateAppointment(a.id, { confirmedByPatient: true, status: "confirmada" });
        return { ok: true, cita: view(a) };
      }

      case "derivar_a_humano": {
        const h = await ctx.store.createHandoff({
          conversationId: ctx.conversation.id,
          patientId: ctx.patient.id,
          reason: String(input.motivo),
          summary: String(input.resumen),
        });
        ctx.conversation.handedOff = true;
        return { ok: true, derivacion_id: h.id, mensaje: "Una persona del equipo continuará la conversación en horario de atención." };
      }

      case "anotar_lista_espera": {
        const today = toLocal(ctx.clock()).toISODate()!;
        let desde = String(input.fecha_desde ?? "");
        let hasta = String(input.fecha_hasta ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || desde < today) desde = today;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta) || hasta < desde) hasta = DateTime.fromISO(desde).plus({ days: 7 }).toISODate()!;
        const nombre = String(input.nombre_completo ?? "").trim() || ctx.patient.name || "Paciente";
        const prev = (await ctx.store.listWaitlist(["esperando", "ofrecido"])).find((w) => w.patientId === ctx.patient.id);
        if (prev) await ctx.store.updateWaitlist(prev.id, { status: "cancelado" });
        const franja = (["manana", "tarde", "cualquiera"].includes(String(input.franja)) ? input.franja : "cualquiera") as "manana" | "tarde" | "cualquiera";
        const profId = typeof input.profesional_id === "string" && professionalById(input.profesional_id) ? input.profesional_id : null;
        const e = await ctx.store.addWaitlist({ patientId: ctx.patient.id, patientName: nombre, treatment: String(input.tratamiento ?? "Consulta"), fromDate: desde, toDate: hasta, franja, professionalId: profId });
        if (!ctx.patient.name && nombre !== "Paciente") ctx.patient = await ctx.store.updatePatient(ctx.patient.id, { name: nombre });
        return { ok: true, lista_espera_id: e.id, desde, hasta, franja, profesional: professionalById(profId)?.name ?? "cualquiera", mensaje: "Si se libera un horario en ese rango, se le ofrece por este chat." };
      }

      case "buscar_en_documentos": {
        const hits = await ctx.store.searchDocuments(String(input.consulta ?? ""), 3);
        return hits.length
          ? { resultados: hits.map((h) => ({ documento: h.name, texto: h.content })), nota: "Responda solo con esta información, resumida." }
          : { resultados: [], nota: "No hay información en los documentos. Dígalo con honestidad y ofrezca derivar a una persona." };
      }

      default:
        return { error: `herramienta_desconocida: ${name}` };
    }
  };
}
