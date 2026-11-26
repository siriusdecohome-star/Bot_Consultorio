import type { Services } from "../services/factory.js";
import { loadClinics, type ClinicRuntime } from "./registry.js";
import type { ClinicProfile } from "./types.js";

/**
 * Clínicas cargadas en esta instancia del servidor.
 * En una sola máquina se cargan al arrancar y listo. En Vercel hay varias instancias
 * a la vez: una clínica temporal creada en otra instancia no está en este mapa, y un
 * cambio guardado desde el panel en otra instancia no se ve acá. Por eso, con Supabase:
 * - si piden una clínica que no está, se carga de la base;
 * - si la que está tiene más de `ttlMs`, se relee (precios, horarios, profesionales, líneas);
 * - si ya no existe o venció, se descarta.
 */
export class ClinicDirectory {
  private loadedAt = new Map<string, number>();

  constructor(
    readonly runtimes: Map<string, ClinicRuntime>,
    private o: {
      services: Services;
      build: (p: ClinicProfile) => ClinicRuntime;
      clock: () => Date;
      ttlMs?: number;
    },
  ) {
    for (const id of runtimes.keys()) this.loadedAt.set(id, Date.now());
  }

  private get refreshing() {
    return this.o.services.storeKind === "supabase";
  }

  /** La clínica pedida, actualizada; null si no existe o venció. */
  async get(id: string): Promise<ClinicRuntime | null> {
    const cur = this.runtimes.get(id);
    if (!this.refreshing) return cur ?? null;
    const fresh = cur && Date.now() - (this.loadedAt.get(id) ?? 0) < (this.o.ttlMs ?? 20_000);
    if (!fresh) {
      const [p] = await loadClinics(this.o.services, id);
      if (!p) this.forget(id);
      else this.upsert(p);
    }
    const rt = this.runtimes.get(id) ?? null;
    if (rt?.profile.expiresAt && new Date(rt.profile.expiresAt) <= this.o.clock()) return null;
    return rt;
  }

  /** Relee todas las clínicas (tick periódico): suma las nuevas, actualiza y saca las borradas. */
  async refreshAll(): Promise<void> {
    if (!this.refreshing) return;
    const all = await loadClinics(this.o.services);
    const ids = new Set(all.map((p) => p.id));
    for (const id of [...this.runtimes.keys()]) if (!ids.has(id)) this.forget(id);
    for (const p of all) this.upsert(p);
  }

  forget(id: string) {
    this.runtimes.delete(id);
    this.loadedAt.delete(id);
  }

  /**
   * Actualiza el perfil EN EL MISMO OBJETO (el motor, la agenda y los avisos lo comparten).
   * Si cambiaron las líneas se rearma el motor de la clínica (cada línea real tiene su cliente).
   */
  private upsert(p: ClinicProfile) {
    const cur = this.runtimes.get(p.id);
    if (cur && JSON.stringify(cur.profile.lines) === JSON.stringify(p.lines)) Object.assign(cur.profile, p);
    else this.runtimes.set(p.id, this.o.build(p));
    this.loadedAt.set(p.id, Date.now());
  }
}
