import { DateTime } from "luxon";
import { config } from "../config.js";
import { withClinic } from "../clinics/context.js";
import type { ClinicProfile } from "../clinics/types.js";
import { kb } from "../data/knowledge.js";
import { Availability, type CalendarService } from "../services/calendar.js";
import type { Notifier, OutboundMessage } from "../services/notifier.js";
import type { Store, WaitlistEntry } from "../services/store.js";
import { human, parseLocal, toLocal, type Clock } from "../services/time.js";

/**
 * Lista de espera. Cuando se libera un horario (cancelación o reprogramación),
 * se ofrece a la primera persona en espera cuyo rango de días y franja coinciden.
 * La oferta dura unos minutos: si la rechaza o no responde, pasa a la siguiente.
 * Aceptar o rechazar se resuelve en el motor (botones «Lo tomo» / «No, gracias»).
 */
export class WaitlistService {
  constructor(
    private store: Store,
    private notifier: Notifier,
    private calendar: CalendarService,
    private clock: Clock,
    readonly clinic?: ClinicProfile,
    private offerMinutes = config.waitlist.offerMinutes,
  ) {}

  /** Se liberó `slot` (hora local YYYY-MM-DDTHH:mm): se ofrece a quien corresponda. Devuelve la entrada ofrecida. */
  onSlotFreed(slot: string): Promise<WaitlistEntry | null> {
    return withClinic(this.clinic, () => this.offer(slot));
  }

  /** La persona rechazó la oferta: sigue en espera y el horario pasa a la siguiente. */
  decline(entryId: string, slot: string): Promise<WaitlistEntry | null> {
    return withClinic(this.clinic, async () => {
      const e = (await this.store.listWaitlist()).find((x) => x.id === entryId);
      if (e && e.status === "ofrecido" && e.offeredSlot === slot) {
        await this.store.updateWaitlist(e.id, { status: "esperando", offeredSlot: null, offeredAt: null, declinedSlots: [...e.declinedSlots, slot] });
      }
      return this.offer(slot);
    });
  }

  /** Ofertas vencidas (sin respuesta): pasan a la siguiente persona. */
  sweep(): Promise<number> {
    return withClinic(this.clinic, async () => {
      const limit = this.clock().getTime() - this.offerMinutes * 60_000;
      let n = 0;
      for (const e of await this.store.listWaitlist(["ofrecido"])) {
        if (e.offeredAt && e.offeredSlot && new Date(e.offeredAt).getTime() < limit) {
          await this.decline(e.id, e.offeredSlot);
          n++;
        }
      }
      return n;
    });
  }

  private matches(e: WaitlistEntry, slot: string): boolean {
    const day = slot.slice(0, 10);
    const hour = Number(slot.slice(11, 13));
    if (day < e.fromDate || day > e.toDate) return false;
    if (e.franja === "manana" && hour >= 13) return false;
    if (e.franja === "tarde" && hour < 13) return false;
    return !e.declinedSlots.includes(slot);
  }

  private async offer(slot: string): Promise<WaitlistEntry | null> {
    const start = parseLocal(slot);
    // Que siga libre y reservable (puede haberlo tomado otra persona mientras tanto).
    if (await new Availability(this.calendar, this.clock).validate(start)) return null;
    const all = await this.store.listWaitlist(["esperando", "ofrecido"]);
    if (all.some((e) => e.status === "ofrecido" && e.offeredSlot === slot)) return null; // ya está ofrecido
    const busy = new Set(all.filter((e) => e.status === "ofrecido").map((e) => e.id));
    for (const e of all.filter((x) => x.status === "esperando" && !busy.has(x.id) && this.matches(x, slot))) {
      const patient = await this.store.getPatient(e.patientId);
      // Los pacientes de ejemplo no tienen un teléfono real al que escribir.
      if (!patient || patient.id.startsWith("demo_")) continue;
      // Si ya tiene un turno activo ese mismo día, no se le ofrece otro.
      const sameDay = await this.store.listAppointments({
        patientId: patient.id, from: start.startOf("day").toUTC().toISO()!, to: start.endOf("day").toUTC().toISO()!, status: ["confirmada", "pendiente"],
      });
      if (sameDay.length) continue;
      const msg = offerMessage(e, start, this.offerMinutes);
      await this.notifier.send(patient.channel, patient.phone, msg);
      const conv = await this.store.getOrCreateConversation(patient, patient.channel);
      conv.messages.push({ role: "bot", text: msg.text, at: this.clock().toISOString(), meta: { kind: "waitlist_offer", waitlistId: e.id, slot } });
      conv.privacyShown = true;
      await this.store.saveConversation(conv);
      return this.store.updateWaitlist(e.id, { status: "ofrecido", offeredSlot: slot, offeredAt: this.clock().toISOString() });
    }
    return null;
  }
}

const firstName = (n: string) => n.replace(/\s*\(demo\)\s*/i, "").trim().split(/\s+/)[0] ?? "";

export function offerMessage(e: WaitlistEntry, start: DateTime, minutes: number): OutboundMessage {
  const name = firstName(e.patientName);
  const when = human(toLocal(start.toISO()!));
  return {
    text: `🔔 *Se liberó un turno*\n\nHola, ${name}. Usted estaba en lista de espera y se liberó el *${when}* en ${kb().name}.\n🦷 ${e.treatment}\n\n¿Se lo reservo? Lo guardo para usted durante ${minutes} minutos.`,
    buttons: ["✅ Lo tomo", "No, gracias"],
    template: { name: config.whatsapp.templateWaitlist, params: [name || "¡hola", when] },
  };
}
