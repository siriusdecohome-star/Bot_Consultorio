import { DateTime } from "luxon";
import { clinic } from "../data/knowledge.js";
import { TZ } from "../services/time.js";
import { emptyUsage, type LlmProvider, type ToolCallLog, type TurnInput, type TurnResult } from "./types.js";

/**
 * Proveedor "mock": reglas simples, sin IA y sin costo.
 * Sirve para (1) probar el proyecto sin claves, (2) que un cliente vea la demo
 * aunque no haya saldo de API y (3) pruebas deterministas de herramientas y agenda.
 * Usa EXACTAMENTE las mismas herramientas que los modelos reales.
 */

interface Memory {
  step: "idle" | "elige_horario" | "pide_nombre" | "confirma" | "elige_cita_cancelar";
  slots: Array<{ inicio: string; cuando: string }>;
  chosen?: string;
  treatment?: string;
  name?: string;
  rescheduleId?: string;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const has = (t: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}`).test(t));

function nowFromContext(ctx: string): DateTime {
  const m = ctx.match(/\((\d{4}-\d{2}-\d{2})\)/);
  const hm = ctx.match(/ (\d{2}):(\d{2}) \(/);
  const d = DateTime.fromISO(m?.[1] ?? DateTime.now().toISODate()!, { zone: TZ() });
  return hm ? d.set({ hour: +hm[1]!, minute: +hm[2]! }) : d;
}

const weekdays: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7 };

/** Interpreta "mañana", "el jueves", "25/11", "la semana que viene". */
function parseDay(t: string, now: DateTime): [DateTime, DateTime] | null {
  if (has(t, "pasado manana")) return [now.plus({ days: 2 }), now.plus({ days: 2 })];
  if (/\bmanana\b/.test(t) && !/\bmanana (a la|por la) tarde\b|\bde manana\b|\bpor la manana\b|\ba la manana\b/.test(t))
    return [now.plus({ days: 1 }), now.plus({ days: 1 })];
  if (/manana (a la|por la) tarde/.test(t)) return [now.plus({ days: 1 }), now.plus({ days: 1 })];
  if (has(t, "hoy")) return [now, now];
  if (has(t, "semana que viene", "proxima semana")) {
    const mon = now.plus({ weeks: 1 }).startOf("week");
    return [mon, mon.plus({ days: 5 })];
  }
  for (const [w, n] of Object.entries(weekdays)) {
    if (new RegExp(`\\b${w}\\b`).test(t)) {
      let d = now.set({ weekday: n as 1 });
      if (d <= now.startOf("day")) d = d.plus({ weeks: 1 });
      return [d, d];
    }
  }
  const m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    let d = now.set({ day: +m[1]!, month: +m[2]! });
    if (d < now.startOf("day")) d = d.plus({ years: 1 });
    return [d, d];
  }
  return null;
}

function franja(t: string): "manana" | "tarde" | "cualquiera" {
  if (has(t, "tarde")) return "tarde";
  if (/(por|a) la manana|de manana|temprano/.test(t)) return "manana";
  return "cualquiera";
}

function treatmentOf(t: string): string | undefined {
  if (has(t, "promo", "promocion")) return "Limpieza + control (Promo Sonrisa Noviembre)";
  if (has(t, "limpieza")) return "Limpieza dental";
  if (has(t, "blanque")) return "Blanqueamiento (consulta previa)";
  if (has(t, "caries", "arreglo")) return "Arreglo de caries";
  if (has(t, "ortodon", "bracket", "brackets")) return "Consulta de ortodoncia";
  if (has(t, "implante")) return "Evaluación para implantes";
  if (has(t, "extrac", "sacar una muela", "sacar un diente")) return "Extracción simple";
  if (has(t, "control", "consulta", "revision")) return "Consulta y diagnóstico";
  return undefined;
}

export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "reglas-v1";

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const prev = [...input.state].reverse().find((x) => (x as { mock?: Memory }).mock) as { mock: Memory } | undefined;
    const mem: Memory = prev ? structuredClone(prev.mock) : { step: "idle", slots: [] };
    const toolCalls: ToolCallLog[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const t0 = performance.now();
      const output = (await input.executeTool(name, args)) as any;
      toolCalls.push({ name, input: args, output, ms: performance.now() - t0 });
      return output;
    };
    const t = norm(input.userText);
    const now = nowFromContext(input.turnContext);
    const knownName = input.turnContext.match(/Nombre registrado: (.+)\./)?.[1];
    if (knownName && knownName !== "desconocido") mem.name ??= knownName;

    const offer = async (from: DateTime, to: DateTime, fr: string, intro: string) => {
      const r = await call("buscar_horarios_disponibles", {
        fecha_desde: from.toISODate(), fecha_hasta: to.toISODate(), franja: fr,
      });
      mem.slots = r.horarios.slice(0, 4);
      if (!mem.slots.length) {
        mem.step = "idle";
        return "No encuentro horarios libres en ese rango. ¿Le busco otro día?";
      }
      mem.step = "elige_horario";
      return `${intro}\n${mem.slots.map((s, i) => `${i + 1}. ${cap(s.cuando)}`).join("\n")}\n¿Cuál le queda mejor?`;
    };

    const reply = await (async (): Promise<string> => {
      // 1) Pedidos que cortan cualquier flujo
      if (has(t, "persona", "humano", "asesor", "recepcion", "operador", "hablar con alguien")) {
        await call("derivar_a_humano", { motivo: "pedido_del_paciente", resumen: `El paciente pidió hablar con una persona. Último mensaje: "${input.userText}"` });
        return "Por supuesto. Ya le pasé su consulta a una persona del equipo, que le responderá en horario de atención. ¡Gracias por su paciencia!";
      }
      if (has(t, "dolor fuerte", "mucho dolor", "sangr", "hinchad", "golpe")) {
        await call("derivar_a_humano", { motivo: "urgencia", resumen: `Posible urgencia: "${input.userText}"` });
        return "Lamento lo que le pasa. Por lo que describe, le recomiendo acudir de inmediato a una guardia odontológica u hospital. Ya avisé al equipo para que le contacte.";
      }
      if (has(t, "cancel", "no voy a poder", "no puedo ir")) {
        const r = await call("ver_citas_paciente", {});
        if (!r.citas.length) return "No encuentro turnos activos a su nombre. ¿Desea agendar uno?";
        const c = r.citas[0];
        const x = await call("cancelar_cita", { cita_id: c.id, motivo: "aviso del paciente" });
        if (!x.ok) return "No pude cancelar ese turno. Le comunico con una persona si lo desea.";
        mem.treatment = c.tratamiento;
        const pref = parseDay(t, now);
        return offer(pref?.[0] ?? now, pref?.[1] ?? now.plus({ days: 4 }), "cualquiera",
          `Listo, cancelé su turno del ${c.cuando}. El horario quedó liberado.${x.aviso_ultimo_momento ? " Gracias por avisar." : ""} ¿Quiere reprogramarlo? Tengo estos horarios:`);
      }
      if (has(t, "cambiar", "reprogram", "mover", "otro horario", "otro dia") && mem.step !== "elige_horario") {
        const r = await call("ver_citas_paciente", {});
        if (r.citas.length) {
          mem.rescheduleId = r.citas[0].id;
          const pref = parseDay(t, now);
          return offer(pref?.[0] ?? now, pref?.[1] ?? now.plus({ days: 4 }), franja(t),
            `Claro. Su turno actual es el ${r.citas[0].cuando}. Estos horarios están libres:`);
        }
      }

      // 2) Flujo de reserva
      if (mem.step === "elige_horario") {
        const n = t.match(/\b([1-4])\b/);
        const hm = t.match(/\b(\d{1,2})[:.](\d{2})\b/) ?? t.match(/\blas (\d{1,2})\b/);
        let pick = n ? mem.slots[+n[1]! - 1] : undefined;
        if (!pick && hm) {
          const hh = hm[1]!.padStart(2, "0");
          const mm = hm[2] ?? "00";
          pick = mem.slots.find((s) => s.inicio.endsWith(`T${hh}:${mm}`));
          if (!pick) {
            // Horario pedido que no estaba en la lista: se intenta igual y la herramienta valida.
            const day = parseDay(t, now)?.[0] ?? DateTime.fromISO(mem.slots[0]!.inicio, { zone: TZ() });
            pick = { inicio: `${day.toISODate()}T${hh}:${mm}`, cuando: `${hh}:${mm}` };
          }
        }
        const pref = parseDay(t, now);
        if (!pick && pref) return offer(pref[0], pref[1], franja(t), "Perfecto, para ese día tengo:");
        if (!pick) return "Disculpe, no identifiqué el horario. ¿Me indica el número de la opción (1, 2, 3 o 4)?";
        mem.chosen = pick.inicio;
        if (mem.rescheduleId) {
          const r = await call("reprogramar_cita", { cita_id: mem.rescheduleId, nuevo_inicio: pick.inicio });
          if (!r.ok) return this.slotError(r, mem);
          mem.step = "idle"; mem.rescheduleId = undefined;
          return `Listo ✅ Su turno quedó para el ${r.nueva.cuando}. El horario anterior quedó liberado.`;
        }
        if (!mem.name) { mem.step = "pide_nombre"; return "Perfecto. ¿Me indica su nombre y apellido para la reserva?"; }
        return this.book(call, mem);
      }
      if (mem.step === "pide_nombre") {
        mem.name = input.userText.replace(/^(soy|me llamo|mi nombre es)\s+/i, "").trim();
        return this.book(call, mem);
      }

      // 3) Intención de agendar
      const day = parseDay(t, now);
      if (has(t, "turno", "cita", "agendar", "reservar", "sacar", "quiero ir", "disponib", "lugar") || (day && mem.step === "idle" && has(t, "puedo", "tiene", "hay"))) {
        mem.treatment = treatmentOf(t) ?? mem.treatment ?? "Consulta y diagnóstico";
        if (!day) return offer(now, now.plus({ days: 3 }), franja(t), "¡Con gusto! Estos son los próximos horarios libres:");
        return offer(day[0], day[1], franja(t), "¡Con gusto! Para ese día tengo estos horarios libres:");
      }

      // 4) Consultas frecuentes
      if (has(t, "precio", "cuanto", "cuesta", "sale", "valor", "promo")) {
        const tr = treatmentOf(t);
        if (tr) mem.treatment = tr;
        if (has(t, "promo") || !tr) return `${clinic.promo.name}: ${clinic.promo.detail} ¿Le reservo un turno?`;
        const x = clinic.treatments.find((k) => norm(k.name).includes(norm(tr).split(" ")[0]!));
        return x ? `${x.name}: ${x.price}. ${x.notes} ¿Desea agendar?` : `${clinic.promo.detail} ¿Desea agendar?`;
      }
      if (has(t, "horario", "atienden", "abren", "abierto")) return `Atendemos ${clinic.hoursText.charAt(0).toLowerCase()}${clinic.hoursText.slice(1)} ¿Le busco un turno?`;
      if (has(t, "donde", "direccion", "ubicacion", "quedan")) return `Estamos en ${clinic.address}. ${clinic.reference}`;
      if (has(t, "obra social", "prepaga", "cobertura")) return clinic.insurance;
      if (has(t, "pago", "tarjeta", "cuotas", "efectivo")) return clinic.payments;
      if (has(t, "hola", "buen", "info", "informacion")) return `¡Hola! Bienvenido/a a ${clinic.name}. Puedo ayudarle a sacar un turno, contarle precios y la promo vigente, o resolver dudas. ¿Qué necesita?`;
      if (has(t, "gracias", "listo", "perfecto", "dale", "ok")) return "¡Gracias a usted! Si necesita algo más, aquí estoy. 😊";
      return "Disculpe, no estoy seguro de haber entendido. ¿Desea sacar un turno, consultar precios u horarios, o hablar con una persona?";
    })();

    const state = [...input.state, { role: "user", text: input.userText }, { role: "assistant", text: reply, mock: mem }];
    return { text: reply, state, usage: emptyUsage(), toolCalls, modelCalls: 0 };
  }

  private slotError(r: any, mem: Memory): string {
    mem.slots = (r.alternativas ?? []).slice(0, 4).map((s: string) => ({ inicio: s, cuando: humanKey(s) }));
    mem.step = mem.slots.length ? "elige_horario" : "idle";
    const head = r.mensaje ?? "Ese horario no está disponible.";
    if (!mem.slots.length) return `${head} ¿Le busco otro día?`;
    return `${head} Le propongo:\n${mem.slots.map((s, i) => `${i + 1}. ${cap(s.cuando)}`).join("\n")}`;
  }

  private async book(call: (n: string, a: Record<string, unknown>) => Promise<any>, mem: Memory): Promise<string> {
    const r = await call("crear_cita", { nombre_completo: mem.name, tratamiento: mem.treatment ?? "Consulta y diagnóstico", inicio: mem.chosen });
    if (!r.ok) return this.slotError(r, mem);
    mem.step = "idle";
    return `Listo, ${mem.name!.split(" ")[0]} ✅ Su turno quedó reservado para el ${r.cita.cuando} (${r.cita.tratamiento}). Le enviaré un recordatorio el día anterior. Si no puede asistir, avíseme con 2 h de anticipación.`;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const humanKey = (k: string) => DateTime.fromISO(k, { zone: TZ() }).setLocale("es").toFormat("cccc dd/MM 'a las' HH:mm");
