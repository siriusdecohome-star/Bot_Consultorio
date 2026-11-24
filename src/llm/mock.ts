import { DateTime } from "luxon";
import { kb } from "../data/knowledge.js";
import { bestSnippet } from "../services/textSearch.js";
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
  // "a la mañana", "por la mañana", "de mañana" son franjas; cualquier otro "mañana" es el día siguiente.
  if (/\bmanana\b/.test(t.replace(/\b(a la|por la|de la|de) manana\b/g, "")))
    return [now.plus({ days: 1 }), now.plus({ days: 1 })];
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
  if (has(t, "promo", "promocion")) return `Promo: ${kb().promo.name}`;
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
  constructor(readonly notice?: string) {}

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
      return `${intro.replace("{dia}", dayHeader(mem.slots))}\n\n${slotList(mem.slots)}\n\n¿Cuál le queda mejor? Respóndame con el número.`;
    };

    /**
     * El paciente pidió una fecha y hora exactas: se consulta la agenda de ese día.
     * Devuelve null si está libre, o el mensaje con alternativas si no.
     */
    const checkExact = async (key: string): Promise<string | null> => {
      const date = key.slice(0, 10);
      const r = await call("buscar_horarios_disponibles", { fecha_desde: date, fecha_hasta: date, franja: "cualquiera" });
      const free: Array<{ inicio: string }> = r.horarios;
      if (free.some((s) => s.inicio === key)) return null;
      const d = DateTime.fromISO(key, { zone: TZ() }).setLocale("es");
      const head = free.length
        ? `Las *${d.toFormat("HH:mm")}* del ${d.toFormat("cccc dd/MM")} no están disponibles.`
        : `El *${d.toFormat("cccc dd/MM")}* no tengo turnos: atendemos ${kb().hoursText.charAt(0).toLowerCase()}${kb().hoursText.slice(1)}`;
      if (free.length) return offer(d, d, "cualquiera", `${head} {dia} tengo libres:`);
      return offer(d.plus({ days: 1 }), d.plus({ days: 5 }), "cualquiera", `${head}\n\n{dia} tengo libres:`);
    };
    const timeIn = (txt: string) => {
      const hm = txt.match(/\b(\d{1,2})[:.](\d{2})\b/) ?? txt.match(/\blas (\d{1,2})\b/);
      return hm ? `${hm[1]!.padStart(2, "0")}:${hm[2] ?? "00"}` : null;
    };

    const reply = await (async (): Promise<string> => {
      // 1) Pedidos que cortan cualquier flujo
      if (has(t, "persona", "humano", "asesor", "recepcion", "operador", "hablar con alguien")) {
        await call("derivar_a_humano", { motivo: "pedido_del_paciente", resumen: `El paciente pidió hablar con una persona. Último mensaje: "${input.userText}"` });
        return "¡Por supuesto! 🙌 Ya le pasé su consulta a una persona del equipo, que le va a responder por este mismo chat en horario de atención.";
      }
      if (has(t, "dolor fuerte", "mucho dolor", "sangr", "hinchad", "golpe")) {
        await call("derivar_a_humano", { motivo: "urgencia", resumen: `Posible urgencia: "${input.userText}"` });
        return "Lamento lo que le pasa. Por lo que describe, le recomiendo acudir de inmediato a una guardia odontológica u hospital. Ya avisé al equipo para que le contacte.";
      }
      if (has(t, "cancel", "no voy a poder", "no puedo ir")) {
        const r = await call("ver_citas_paciente", {});
        if (!r.citas.length) return "No encuentro turnos activos a su nombre. ¿Quiere que le busque uno?";
        const c = r.citas[0];
        const x = await call("cancelar_cita", { cita_id: c.id, motivo: "aviso del paciente" });
        if (!x.ok) return "No pude cancelar ese turno. Si quiere, le comunico con una persona del equipo.";
        mem.treatment = c.tratamiento;
        const pref = parseDay(t, now);
        return offer(pref?.[0] ?? now, pref?.[1] ?? now.plus({ days: 4 }), "cualquiera",
          `Listo, cancelé su turno del *${c.cuando}* y el horario quedó libre.${x.aviso_ultimo_momento ? " ¡Gracias por avisar!" : ""}\n\n¿Lo reprogramamos? {dia} tengo estos horarios:`);
      }
      if (has(t, "cambiar", "reprogram", "mover", "otro horario", "otro dia") && mem.step !== "elige_horario") {
        const r = await call("ver_citas_paciente", {});
        if (r.citas.length) {
          mem.rescheduleId = r.citas[0].id;
          const pref = parseDay(t, now);
          return offer(pref?.[0] ?? now, pref?.[1] ?? now.plus({ days: 4 }), franja(t),
            `¡Claro! Su turno actual es el *${r.citas[0].cuando}*. {dia} tengo libres:`);
        }
      }

      // 2) Flujo de reserva
      if (mem.step === "elige_horario") {
        const time = timeIn(t);
        const pref = parseDay(t, now);
        const n = time ? null : t.match(/\b([1-4])\b/);
        let pick = n ? mem.slots[+n[1]! - 1] : undefined;
        if (!pick && time) {
          // Si nombró otro día ("el domingo a las 10"), la hora es de ese día, no de la lista ofrecida.
          const day = pref?.[0] ?? DateTime.fromISO(mem.slots[0]!.inicio, { zone: TZ() });
          const key = `${day.toISODate()}T${time}`;
          pick = mem.slots.find((s) => s.inicio === key);
          if (!pick) {
            const busy = await checkExact(key);
            if (busy) return busy;
            pick = { inicio: key, cuando: time };
          }
        }
        if (!pick && pref) return offer(pref[0], pref[1], franja(t), "Perfecto. {dia} tengo:");
        if (!pick) return "Disculpe, no identifiqué el horario. ¿Me responde con el número de la opción? (1, 2, 3 o 4)";
        mem.chosen = pick.inicio;
        if (mem.rescheduleId) {
          const r = await call("reprogramar_cita", { cita_id: mem.rescheduleId, nuevo_inicio: pick.inicio });
          if (!r.ok) return this.slotError(r, mem);
          mem.step = "idle"; mem.rescheduleId = undefined;
          return `¡Listo! ✅ Su turno ahora es el *${r.nueva.cuando}*. El horario anterior quedó libre.\n\nLe enviaré un recordatorio el día anterior.`;
        }
        if (!mem.name) { mem.step = "pide_nombre"; return "¡Excelente! Para confirmar la reserva, ¿me indica su nombre y apellido?"; }
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
        const time = timeIn(t);
        if (day && time) {
          // Pidió día y hora exactos: si está libre se toma directamente; si no, se explican las alternativas.
          const key = `${day[0].toISODate()}T${time}`;
          const busy = await checkExact(key);
          if (busy) return busy;
          mem.chosen = key;
          mem.step = "pide_nombre";
          const d = DateTime.fromISO(key, { zone: TZ() }).setLocale("es");
          if (mem.name) return this.book(call, mem);
          return `¡Buenas noticias! El *${d.toFormat("cccc dd/MM 'a las' HH:mm")}* está libre. Para reservarlo, ¿me indica su nombre y apellido?`;
        }
        if (!day) return offer(now, now.plus({ days: 3 }), franja(t), "¡Con gusto! 📅 {dia} tengo estos horarios libres:");
        return offer(day[0], day[1], franja(t), "¡Con gusto! 📅 {dia} tengo estos horarios libres:");
      }

      // 4) Preguntas frecuentes cargadas por el consultorio (antes que las reglas generales)
      const faq = (kb().faq ?? []).find((f) => {
        const words = norm(f.q).split(/\s+/).filter((w) => w.length > 3);
        return words.length > 0 && words.filter((w) => t.includes(w)).length >= Math.min(2, words.length);
      });
      if (faq) return `${faq.a}\n\n¿Le ayudo con algo más?`;
      // 4b) Consultas frecuentes
      if (has(t, "precio", "cuanto", "cuesta", "sale", "valor", "promo")) {
        const tr = treatmentOf(t);
        if (tr) mem.treatment = tr;
        if (has(t, "promo") || !tr) {
          return `¡Qué bueno que le interese! 🦷 *${kb().promo.name}*: ${kb().promo.detail}\n\n¿Le busco un turno? Dígame qué día le queda mejor.`;
        }
        const x = kb().treatments.find((k) => norm(k.name).includes(norm(tr).split(" ")[0]!));
        return x ? `*${x.name}*: ${x.price} (${x.duration}). ${x.notes}\n\n¿Quiere que le busque un turno?` : `${kb().promo.detail}\n\n¿Quiere que le busque un turno?`;
      }
      if (has(t, "horario", "atienden", "abren", "abierto")) return `Atendemos ${kb().hoursText.charAt(0).toLowerCase()}${kb().hoursText.slice(1)}\n\n¿Le busco un turno?`;
      if (has(t, "donde", "direccion", "ubicacion", "quedan")) return `📍 Estamos en ${kb().address}. ${kb().reference}\n\n¿Le busco un turno?`;
      if (has(t, "obra social", "prepaga", "cobertura")) return kb().insurance;
      if (has(t, "pago", "tarjeta", "cuotas", "efectivo")) return kb().payments;
      // 5) Documentos subidos por el consultorio
      if (!has(t, "hola", "buen", "gracias", "listo", "perfecto", "dale", "ok") || t.split(" ").length > 4) {
        const docs = await call("buscar_en_documentos", { consulta: input.userText });
        if (docs.resultados?.length) {
          const r0 = docs.resultados[0];
          const text = bestSnippet(r0.texto, input.userText);
          return `Según la información del consultorio (_${r0.documento}_):\n\n${text}\n\n¿Le ayudo con algo más?`;
        }
      }
      if (has(t, "hola", "buen", "info", "informacion")) return GREETING_ONLY;
      if (has(t, "gracias", "listo", "perfecto", "dale", "ok")) return "¡Gracias a usted! Si necesita algo más, aquí estoy. 😊";
      return "Disculpe, no estoy seguro de haber entendido. ¿Quiere *sacar un turno*, consultar *precios u horarios*, o *hablar con una persona*?";
    })();

    // Primer mensaje: saludo + presentación + respuesta + línea de privacidad (la indica el motor).
    let text = reply;
    if (input.turnContext.includes("PRIMER MENSAJE")) {
      const profile = input.turnContext.match(/Nombre de perfil de WhatsApp \(no confirmado\): (.+)\./)?.[1];
      const first = profile?.trim().split(/\s+/)[0];
      const hello = `¡Hola${first ? `, ${first}` : ""}! 👋 Gracias por escribir a *${kb().name}*. Soy su asistente virtual: puedo ayudarle a sacar o cambiar turnos y contarle precios y promociones.`;
      const body = reply === GREETING_ONLY ? "¿En qué puedo ayudarle hoy?" : reply;
      const privacy = input.turnContext.match(/línea exacta: «(.+)»/)?.[1];
      text = [hello, body, privacy].filter(Boolean).join("\n\n");
    } else if (reply === GREETING_ONLY) {
      text = "¡Hola de nuevo! ¿En qué puedo ayudarle? Puedo buscarle un turno, contarle precios o la promo vigente.";
    }

    const state = [...input.state, { role: "user", text: input.userText }, { role: "assistant", text, mock: mem }];
    return { text, state, usage: emptyUsage(), toolCalls, modelCalls: 0 };
  }

  private slotError(r: any, mem: Memory): string {
    mem.slots = (r.alternativas ?? []).slice(0, 4).map((s: string) => ({ inicio: s, cuando: humanKey(s) }));
    mem.step = mem.slots.length ? "elige_horario" : "idle";
    const head = r.mensaje ?? "Ese horario no está disponible.";
    if (!mem.slots.length) return `${head} ¿Le busco otro día?`;
    return `${head} Le propongo estas opciones:\n\n${slotList(mem.slots)}\n\n¿Cuál prefiere?`;
  }

  private async book(call: (n: string, a: Record<string, unknown>) => Promise<any>, mem: Memory): Promise<string> {
    const r = await call("crear_cita", { nombre_completo: mem.name, tratamiento: mem.treatment ?? "Consulta y diagnóstico", inicio: mem.chosen });
    if (!r.ok) return this.slotError(r, mem);
    mem.step = "idle";
    return [
      `¡Listo, ${mem.name!.split(" ")[0]}! ✅ Su turno quedó confirmado:`,
      "",
      `📅 *${cap(r.cita.cuando)}*`,
      `🦷 ${r.cita.tratamiento}`,
      `📍 ${kb().address.replace(" (dirección ficticia)", "")}`,
      "",
      "Le enviaré un recordatorio el día anterior. Si necesita cambiarlo, escríbame cuando quiera.",
    ].join("\n");
  }
}

const GREETING_ONLY = "__saludo__";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];

/** "el *jueves 26/11*" si todas las opciones son del mismo día; si no, "En los próximos días". */
function dayHeader(slots: Array<{ inicio: string }>): string {
  const days = new Set(slots.map((s) => s.inicio.slice(0, 10)));
  if (days.size !== 1) return "En los próximos días";
  const d = DateTime.fromISO(slots[0]!.inicio, { zone: TZ() }).setLocale("es");
  return `Para el *${d.toFormat("cccc dd/MM")}*`;
}

/** Lista con 1️⃣ 2️⃣…: solo horas si es un único día; día + hora si son varios. */
function slotList(slots: Array<{ inicio: string }>): string {
  const sameDay = new Set(slots.map((s) => s.inicio.slice(0, 10))).size === 1;
  return slots.map((s, i) => {
    const d = DateTime.fromISO(s.inicio, { zone: TZ() }).setLocale("es");
    return `${KEYCAPS[i]} ${sameDay ? d.toFormat("HH:mm") : cap(d.toFormat("ccc dd/MM · HH:mm"))}`;
  }).join("\n");
}
const humanKey = (k: string) => DateTime.fromISO(k, { zone: TZ() }).setLocale("es").toFormat("cccc dd/MM 'a las' HH:mm");
