import { DateTime } from "luxon";
import { config } from "../config.js";
import type { ToolDef } from "../llm/types.js";
import { Availability, type CalendarService, type Franja } from "../services/calendar.js";
import { SlotTakenError, type Appointment, type Conversation, type Patient, type Store } from "../services/store.js";
import { human, localKey, parseLocal, slotMinutes, toLocal, type Clock } from "../services/time.js";

/**
 * Herramientas que el modelo puede llamar. Toda acción real (consultar agenda,
 * reservar, cancelar, derivar) pasa por acá y se valida en código:
 * el modelo propone, el backend decide.
 */
export const toolDefs: ToolDef[] = [
  {
    name: "buscar_horarios_disponibles",
    description:
      "Consulta la agenda real del consultorio y devuelve horarios libres. Úsela SIEMPRE antes de ofrecer horarios; nunca ofrezca un horario que no haya devuelto esta herramienta.",
    parameters: {
      type: "object",
      properties: {
        fecha_desde: { type: "string", description: "Primer día a buscar, formato YYYY-MM-DD (hora local del consultorio)." },
        fecha_hasta: { type: "string", description: "Último día a buscar, formato YYYY-MM-DD. Igual a fecha_desde para un solo día." },
        franja: { type: "string", enum: ["manana", "tarde", "cualquiera"], description: "Preferencia horaria del paciente." },
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
];

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
}

const view = (a: Appointment) => ({
  id: a.id,
  tratamiento: a.treatment,
  inicio: localKey(toLocal(a.start)),
  cuando: human(toLocal(a.start)),
  estado: a.status,
});

const motivos: Record<string, string> = {
  fecha_invalida: "La fecha u hora no es válida.",
  horario_pasado_o_muy_proximo: "Ese horario ya pasó o falta menos de 1 hora; no se puede reservar.",
  fuera_de_horario: "Ese horario está fuera del horario de atención.",
  horario_ocupado: "Ese horario ya está ocupado.",
};

export function makeExecutor(ctx: ToolContext) {
  const avail = new Availability(ctx.calendar, ctx.clock);
  const slot = slotMinutes();

  async function suggestNear(start: DateTime) {
    const d = start.isValid ? start : toLocal(ctx.clock());
    return avail.freeSlots(d.toISODate()!, d.plus({ days: 3 }).toISODate()!, "cualquiera", 4);
  }

  /**
   * Reserva en dos pasos: (1) la base "toma" el horario (su índice único impide
   * la doble reserva) y (2) se crea el evento en el calendario. Si el calendario
   * falla, se deshace el paso 1 para no dejar datos inconsistentes.
   */
  async function book(name: string, treatment: string, start: DateTime): Promise<Appointment> {
    const end = start.plus({ minutes: slot });
    const appt = await ctx.store.createAppointment({
      patientId: ctx.patient.id,
      patientName: name,
      treatment,
      start: start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
      status: "confirmada",
      calendarEventId: "",
      confirmedByPatient: false,
      reminder24Sent: false,
      reminder2Sent: false,
    });
    try {
      const ev = await ctx.calendar.createEvent({
        start: start.toISO()!,
        end: end.toISO()!,
        summary: `${treatment} — ${name}`,
        description: `Paciente: ${name}\nTeléfono: ${ctx.patient.phone}\nCanal: ${ctx.conversation.channel}\nId de cita: ${appt.id}\nReservado por el asistente virtual (demo).`,
      });
      return await ctx.store.updateAppointment(appt.id, { calendarEventId: ev.id });
    } catch (err) {
      await ctx.store.deleteAppointment(appt.id);
      throw err;
    }
  }

  /** Ejecuta una reserva y traduce la doble reserva a un resultado entendible para el modelo. */
  async function tryBook<T>(start: DateTime, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SlotTakenError) {
        return { ok: false, error: "horario_ocupado", mensaje: motivos.horario_ocupado, alternativas: await suggestNear(start) };
      }
      throw err;
    }
  }

  async function ownAppointment(id: string) {
    const a = await ctx.store.getAppointment(id);
    if (!a || a.patientId !== ctx.patient.id) return null;
    return a;
  }

  return async function execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "buscar_horarios_disponibles": {
        const slots = await avail.freeSlots(
          String(input.fecha_desde), String(input.fecha_hasta), (input.franja as Franja) ?? "cualquiera",
        );
        return {
          horarios: slots.map((s) => ({ inicio: s, cuando: human(parseLocal(s)) })),
          nota: slots.length ? "Ofrezca solo estos horarios." : "No hay horarios libres en ese rango; proponga buscar otros días.",
        };
      }

      case "crear_cita": {
        const start = parseLocal(String(input.inicio));
        return withBookingLock(async () => {
          const err = await avail.validate(start);
          if (err) return { ok: false, error: err, mensaje: motivos[err], alternativas: await suggestNear(start) };
          const nombre = String(input.nombre_completo).trim();
          return tryBook(start, async () => {
            const a = await book(nombre, String(input.tratamiento), start);
            if (!ctx.patient.name) ctx.patient = await ctx.store.updatePatient(ctx.patient.id, { name: nombre });
            return { ok: true, cita: view(a), politica: "Avisar con 2 h de anticipación si no puede asistir." };
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
        await ctx.store.updateAppointment(a.id, { status: "cancelada" });
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
        return withBookingLock(async () => {
          const err = await avail.validate(start);
          if (err) return { ok: false, error: err, mensaje: motivos[err], alternativas: await suggestNear(start) };
          // Primero se reserva el nuevo horario y recién después se libera el viejo:
          // si algo falla, el paciente nunca se queda sin turno.
          return tryBook(start, async () => {
            const nueva = await book(a.patientName, a.treatment, start);
            if (a.calendarEventId) await ctx.calendar.deleteEvent(a.calendarEventId);
            await ctx.store.updateAppointment(a.id, { status: "reprogramada" });
            return { ok: true, anterior: view(a), nueva: view(nueva) };
          });
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

      default:
        return { error: `herramienta_desconocida: ${name}` };
    }
  };
}
