import type { SupabaseClient } from "@supabase/supabase-js";
import { WebOutbox, type OutboundMessage, type Outbox } from "./notifier.js";

/**
 * Estado que tiene que ser el MISMO para todas las instancias del servidor.
 * En una sola máquina alcanza con memoria; en Vercel (funciones sin servidor) cada pedido
 * puede caer en una instancia distinta, así que se guarda en Supabase:
 * - mensajes de WhatsApp ya procesados (Meta reintenta: no responder dos veces);
 * - límites de uso por IP (chat y login);
 * - bandeja del simulador (mensajes que el bot manda por su cuenta).
 */
export interface SharedState {
  /** true la primera vez que se ve ese id de mensaje; false si ya se procesó. */
  claimMessage(id: string): Promise<boolean>;
  /** Registra un uso y dice si sigue dentro del límite (máx. `max` en la ventana). */
  hit(key: string, windowMs: number, max: number): Promise<boolean>;
  outbox: Outbox;
  /** Borra lo viejo (lo llama el tick periódico). */
  purgeOld(now: Date): Promise<void>;
}

export class MemoryShared implements SharedState {
  private seen = new Map<string, number>();
  private hits = new Map<string, number[]>();
  readonly outbox = new WebOutbox();

  async claimMessage(id: string) {
    if (this.seen.has(id)) return false;
    this.seen.set(id, Date.now());
    return true;
  }
  async hit(key: string, windowMs: number, max: number) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) return false;
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  async purgeOld(now: Date) {
    for (const [k, t] of this.seen) if (now.getTime() - t > 48 * 3_600_000) this.seen.delete(k);
    for (const [k, l] of this.hits) if (!l.some((t) => now.getTime() - t < 3_600_000)) this.hits.delete(k);
  }
}

/** Mismo estado en Supabase (tablas processed_messages, rate_hits y web_outbox; solo con la clave secreta). */
export class SupabaseShared implements SharedState {
  readonly outbox: Outbox;
  constructor(private db: SupabaseClient) {
    this.outbox = {
      push: async (box: string, msg: OutboundMessage) => {
        const r = await db.from("web_outbox").insert({ box, message: msg });
        if (r.error) throw new Error(`bandeja del simulador: ${r.error.message}`);
      },
      take: async (box: string) => {
        // Se leen y se borran: cada mensaje se entrega una sola vez.
        const r = await db.from("web_outbox").delete().eq("box", box).select("id, message");
        if (r.error) throw new Error(`bandeja del simulador: ${r.error.message}`);
        return (r.data ?? []).sort((a: any, b: any) => a.id - b.id).map((x: any) => x.message as OutboundMessage);
      },
    };
  }

  async claimMessage(id: string) {
    const r = await this.db.from("processed_messages").insert({ id });
    if (!r.error) return true;
    if (r.error.code === "23505") return false; // ya estaba: duplicado
    throw new Error(`mensajes procesados: ${r.error.message}`);
  }
  async hit(key: string, windowMs: number, max: number) {
    const since = new Date(Date.now() - windowMs).toISOString();
    const c = await this.db.from("rate_hits").select("key", { count: "exact", head: true }).eq("key", key).gte("at", since);
    if (c.error) throw new Error(`límites: ${c.error.message}`);
    if ((c.count ?? 0) >= max) return false;
    const r = await this.db.from("rate_hits").insert({ key });
    if (r.error) throw new Error(`límites: ${r.error.message}`);
    return true;
  }
  async purgeOld(now: Date) {
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    await Promise.all([
      this.db.from("processed_messages").delete().lt("at", ago(48)),
      this.db.from("rate_hits").delete().lt("at", ago(2)),
      this.db.from("web_outbox").delete().lt("created_at", ago(24)),
    ]);
  }
}
