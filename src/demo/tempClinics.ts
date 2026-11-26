import { createHash, randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import type { AuthBackend, AuthResult } from "../auth.js";
import { buildRuntimes, clinicToRow, type ClinicRuntime } from "../clinics/registry.js";
import type { ClinicProfile } from "../clinics/types.js";
import { config } from "../config.js";
import { defaultSettings } from "../data/clinics/settings.js";
import type { LlmProvider } from "../llm/types.js";
import type { Services } from "../services/factory.js";
import type { WebOutbox } from "../services/notifier.js";
import type { SupabaseStore } from "../services/supabaseStore.js";
import type { Clock } from "../services/time.js";

/**
 * Demo pública: cada visita que toca «Entrar al demo» recibe su propia clínica temporal
 * (copia de la clínica de ejemplo con 30 días de datos ficticios) y entra como admin, sin
 * contraseña. Solo ve lo suyo (la base lo aísla con RLS) y todo se borra a las DEMO_HOURS.
 * - Todos sus profesionales usan la agenda interna: la demo nunca escribe en Google Calendar.
 * - No tiene número de WhatsApp: el chat es el simulador.
 * - La IA real tiene tope por visita y por día; al agotarse responde el modo sin IA.
 */

export const DEMO_PREFIX = "demo-";
export const isTempClinic = (c: ClinicProfile) => Boolean(c.expiresAt) || c.id.startsWith(DEMO_PREFIX);

export class DemoLimitError extends Error {}

export interface DemoOptions {
  services: Services;
  runtimes: Map<string, ClinicRuntime>;
  provider: LlmProvider;
  fallback: LlmProvider;
  clock: Clock;
  outbox?: WebOutbox;
  auth: AuthBackend;
  /** Clínica de ejemplo que se copia. */
  template: ClinicProfile;
  limits?: Partial<typeof config.demo>;
}

export class DemoService {
  private byIp = new Map<string, number[]>();
  private readonly limits: typeof config.demo;

  constructor(private o: DemoOptions) {
    this.limits = { ...config.demo, ...(o.limits ?? {}) };
  }

  get enabled() {
    return this.limits.enabled;
  }

  /** Tope de IA de una clínica temporal: N mensajes por visita y M por día entre todas. */
  budgetFor(profile: ClinicProfile): (() => Promise<boolean>) | undefined {
    if (!isTempClinic(profile)) return undefined;
    const store = this.o.services.store;
    return async () => {
      const visit = await store.countRealTurnsSince("1970-01-01T00:00:00Z", profile.id);
      if (visit >= this.limits.aiPerVisit) return false;
      const today = DateTime.fromJSDate(this.o.clock()).startOf("day").toUTC().toISO()!;
      return (await store.countRealTurnsSince(today, DEMO_PREFIX)) < this.limits.aiDaily;
    };
  }

  active(): ClinicProfile[] {
    return [...this.o.runtimes.values()].map((r) => r.profile).filter(isTempClinic);
  }

  /** Crea la clínica temporal, la carga con datos de ejemplo y devuelve la sesión del visitante. */
  async start(ip: string, secure: boolean): Promise<{ clinicId: string; session: AuthResult }> {
    if (!this.limits.enabled) throw new DemoLimitError("La demo pública está desactivada.");
    if (this.active().length >= this.limits.maxActive) throw new DemoLimitError("Hay muchas demos abiertas en este momento. Probá de nuevo en un rato.");
    const owner = createHash("sha256").update(`${ip}|${config.panel.sessionSecret}`).digest("hex").slice(0, 24);
    const now = this.o.clock();
    const dayAgo = now.getTime() - 86_400_000;
    const mine = (this.byIp.get(owner) ?? []).filter((t) => t > dayAgo);
    if (mine.length >= this.limits.perIpPerDay) throw new DemoLimitError("Llegaste al límite de demos por hoy. Podés seguir usando la que ya abriste.");

    const t = this.o.template;
    const id = `${DEMO_PREFIX}${randomBytes(5).toString("hex")}`;
    const profile: ClinicProfile = {
      ...structuredClone(t),
      id, primary: false, whatsappPhoneNumberId: null, calendarTag: id,
      professionals: t.professionals.map((p) => ({ ...structuredClone(p), calendar: "interno" as const })),
      settings: defaultSettings(),
      expiresAt: new Date(now.getTime() + this.limits.hours * 3_600_000).toISOString(),
    };

    const { services } = this.o;
    if (services.storeKind === "supabase") {
      const db = (services.store as SupabaseStore).client;
      const r = await db.from("clinics").insert({ ...clinicToRow(profile), demo_owner: owner });
      if (r.error) throw new Error(`No se pudo crear la clínica de la demo: ${r.error.message}`);
    }
    const rt = buildRuntimes({
      services, clinics: [profile], provider: this.o.provider, clock: this.o.clock, outbox: this.o.outbox,
      setDefault: false, aiBudgetFor: (p) => this.budgetFor(p), fallbackProvider: this.o.fallback,
    }).get(id)!;
    this.o.runtimes.set(id, rt);
    try {
      const { loadDemoMemory, loadDemoSupabase, loadExampleDocument } = await import("../data/loadDemo.js");
      if (services.storeKind === "supabase") await loadDemoSupabase((services.store as SupabaseStore).client, null, profile, now);
      else await loadDemoMemory(rt.store, rt.calendar, profile, now);
      await loadExampleDocument(rt.store);
      const session = await this.o.auth.demoLogin(id, secure);
      this.byIp.set(owner, [...mine, now.getTime()]);
      return { clinicId: id, session };
    } catch (err) {
      await this.remove(profile).catch(() => undefined);
      throw err;
    }
  }

  /** Borra las clínicas temporales vencidas (datos en cascada, visitantes y su motor). */
  async cleanup(): Promise<number> {
    const now = this.o.clock().getTime();
    let n = 0;
    for (const p of this.active()) {
      if (p.expiresAt && new Date(p.expiresAt).getTime() <= now) {
        await this.remove(p);
        n++;
      }
    }
    return n;
  }

  private async remove(p: ClinicProfile) {
    await this.o.auth.forgetDemo(p.id).catch(() => undefined);
    if (this.o.services.storeKind === "supabase") {
      const db = (this.o.services.store as SupabaseStore).client;
      const r = await db.from("clinics").delete().eq("id", p.id);
      if (r.error) throw new Error(`No se pudo borrar ${p.id}: ${r.error.message}`);
    } else {
      await purgeMemoryClinic(this.o.services, p.id);
    }
    this.o.runtimes.delete(p.id);
  }
}

/** Base en memoria: borra todo lo de una clínica (lo que en Supabase hace el borrado en cascada). */
async function purgeMemoryClinic(services: Services, clinicId: string) {
  const mem = services.store as unknown as { purgeClinic?: (id: string) => void };
  mem.purgeClinic?.(clinicId);
}
