import { AsyncLocalStorage } from "node:async_hooks";
import type { ClinicProfile } from "./types.js";

/**
 * Clínica "actual" de cada pedido. El motor, los recordatorios y las rutas
 * corren dentro de runInClinic(): así la zona horaria, el horario de atención
 * y el conocimiento salen de la clínica correcta sin pasarla por cada función.
 * Fuera de un contexto se usa la clínica por defecto (la principal).
 */
const als = new AsyncLocalStorage<ClinicProfile>();
let fallback: ClinicProfile | null = null;

export function setDefaultClinic(c: ClinicProfile) {
  fallback = c;
}

export function runInClinic<T>(clinic: ClinicProfile, fn: () => T): T {
  return als.run(clinic, fn);
}

export function currentClinic(): ClinicProfile {
  const c = als.getStore() ?? fallback;
  if (!c) throw new Error("No hay clínica en contexto (falta setDefaultClinic)");
  return c;
}

/** Corre `fn` dentro de la clínica indicada, o en el contexto actual si no se indica ninguna. */
export function withClinic<T>(clinic: ClinicProfile | undefined, fn: () => T): T {
  return clinic ? als.run(clinic, fn) : fn();
}
