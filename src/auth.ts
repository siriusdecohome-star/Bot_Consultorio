import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Request } from "express";
import { config } from "./config.js";
import type { Role } from "./clinics/types.js";
import { demoUsers } from "./data/clinics/users.js";

/**
 * Acceso al panel del consultorio.
 * - Con Supabase: usuarios de Supabase Auth. La sesión guarda el token del usuario y
 *   el panel consulta la base con ese token, así la base aplica las políticas RLS.
 * - En memoria (entorno de pruebas): los mismos usuarios ficticios, con las contraseñas
 *   que `npm run seed:users` dejó en el .env, y el filtro por clínica en el código.
 * La sesión va en una cookie httpOnly firmada (HMAC) para que no se pueda alterar.
 */

export interface Membership {
  clinicId: string;
  role: Role;
}

export interface PanelUser {
  id: string;
  email: string;
  memberships: Membership[];
  /** Token de Supabase Auth (solo en modo Supabase). */
  accessToken?: string;
}

export interface AuthResult {
  user: PanelUser;
  /** Cookie nueva cuando la sesión se creó o se renovó. */
  setCookie?: string;
}

export interface AuthBackend {
  readonly kind: "supabase" | "memoria";
  login(email: string, password: string, secure: boolean): Promise<AuthResult | null>;
  fromRequest(req: Request, secure: boolean): Promise<AuthResult | null>;
  /** Demo pública: sesión de visitante, admin SOLO de su clínica temporal, sin contraseña. */
  demoLogin(clinicId: string, secure: boolean): Promise<AuthResult>;
  /** Borra los visitantes de una clínica temporal vencida. */
  forgetDemo(clinicId: string): Promise<void>;
}

/** Nombre que se muestra para el visitante de la demo pública. */
export const DEMO_VISITOR = "Visitante de la demo";

const COOKIE = "panel_sesion";
const SESSION_H = 12;
// Sin PANEL_SESSION_SECRET la clave se genera al arrancar: las sesiones se pierden al reiniciar.
const secret = config.panel.sessionSecret || randomBytes(32).toString("hex");

const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function encodeCookie(data: unknown, secure: boolean): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_H * 3600}${secure ? "; Secure" : ""}`;
}

function readCookie<T>(req: Request): T | null {
  const raw = (req.header("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !safeEq(sig, sign(payload))) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as T;
  } catch {
    return null;
  }
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

// ---------------------------------------------------------------------------
// Entorno de pruebas (memoria)
// ---------------------------------------------------------------------------

export class MemoryAuth implements AuthBackend {
  readonly kind = "memoria" as const;
  /** Visitantes de la demo: id → clínica temporal. */
  private visitors = new Map<string, string>();

  async demoLogin(clinicId: string, secure: boolean) {
    const id = `visitante:${randomBytes(8).toString("hex")}`;
    this.visitors.set(id, clinicId);
    const exp = Date.now() + SESSION_H * 3600_000;
    return { user: this.visitor(id, clinicId), setCookie: encodeCookie({ visitor: id, exp }, secure) };
  }

  async forgetDemo(clinicId: string) {
    for (const [id, c] of this.visitors) if (c === clinicId) this.visitors.delete(id);
  }

  private visitor(id: string, clinicId: string): PanelUser {
    return { id, email: DEMO_VISITOR, memberships: [{ clinicId, role: "admin" }] };
  }

  async login(email: string, password: string, secure: boolean) {
    const u = demoUsers.find((x) => x.email === email.trim().toLowerCase());
    const expected = u ? process.env[u.passwordVar] : undefined;
    if (!u || !expected || !safeEq(password, expected)) return null;
    const exp = Date.now() + SESSION_H * 3600_000;
    return { user: this.toUser(u.email), setCookie: encodeCookie({ email: u.email, exp }, secure) };
  }

  async fromRequest(req: Request) {
    const c = readCookie<{ email?: string; visitor?: string; exp: number }>(req);
    if (!c || c.exp < Date.now()) return null;
    if (c.visitor) {
      const clinicId = this.visitors.get(c.visitor);
      return clinicId ? { user: this.visitor(c.visitor, clinicId) } : null;
    }
    return c.email && demoUsers.some((u) => u.email === c.email) ? { user: this.toUser(c.email) } : null;
  }

  private toUser(email: string): PanelUser {
    const u = demoUsers.find((x) => x.email === email)!;
    return { id: `demo:${email}`, email, memberships: u.memberships };
  }
}

// ---------------------------------------------------------------------------
// Supabase Auth
// ---------------------------------------------------------------------------

interface SupabaseSession {
  at: string; // access token (JWT, ~1 h)
  rt: string; // refresh token
  exp: number; // vencimiento del access token (ms)
}

export class SupabaseAuth implements AuthBackend {
  readonly kind = "supabase" as const;
  /** Usuario validado por token, para no consultar Supabase Auth en cada pedido. */
  private cache = new Map<string, { user: PanelUser; until: number }>();

  constructor(private url: string, private publishableKey: string, private secretKey = "") {}

  /**
   * Visitante de la demo: usuario ANÓNIMO de Supabase Auth (hay que activar «Allow anonymous
   * sign-ins» en Supabase) con rol admin solo en su clínica temporal. La base lo aísla con
   * las mismas políticas RLS que a cualquier usuario.
   */
  async demoLogin(clinicId: string, secure: boolean) {
    const { data, error } = await this.client().auth.signInAnonymously();
    if (error || !data.session || !data.user) {
      throw new Error(/anonymous/i.test(error?.message ?? "")
        ? "Falta activar los inicios de sesión anónimos en Supabase (Authentication → Sign In / Providers → Allow anonymous sign-ins)."
        : `No se pudo crear la sesión de la demo: ${error?.message ?? "sin sesión"}`);
    }
    const admin = createClient(this.url, this.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const m = await admin.from("clinic_members").insert({ user_id: data.user.id, clinic_id: clinicId, role: "admin" });
    if (m.error) throw new Error(`No se pudo asignar la clínica de la demo: ${m.error.message}`);
    const r = await this.fromSession(data.session.access_token, data.session.refresh_token, data.session.expires_at, secure);
    if (!r) throw new Error("No se pudo validar la sesión de la demo");
    return r;
  }

  /** Borra los usuarios anónimos de una clínica temporal (sus membresías se borran en cascada). */
  async forgetDemo(clinicId: string) {
    const admin = createClient(this.url, this.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data } = await admin.from("clinic_members").select("user_id").eq("clinic_id", clinicId);
    for (const row of data ?? []) await admin.auth.admin.deleteUser(row.user_id).catch(() => undefined);
  }

  private client(accessToken?: string) {
    return createClient(this.url, this.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
    });
  }

  async login(email: string, password: string, secure: boolean) {
    const { data, error } = await this.client().auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error || !data.session) return null;
    return this.fromSession(data.session.access_token, data.session.refresh_token, data.session.expires_at, secure);
  }

  async fromRequest(req: Request, secure: boolean) {
    const s = readCookie<SupabaseSession>(req);
    if (!s) return null;
    if (s.exp - 60_000 > Date.now()) {
      const user = await this.userFor(s.at);
      return user ? { user } : null;
    }
    // Token vencido: se renueva con el refresh token y se reescribe la cookie.
    const { data, error } = await this.client().auth.refreshSession({ refresh_token: s.rt });
    if (error || !data.session) return null;
    return this.fromSession(data.session.access_token, data.session.refresh_token, data.session.expires_at, secure);
  }

  private async fromSession(at: string, rt: string, expiresAt: number | undefined, secure: boolean): Promise<AuthResult | null> {
    const user = await this.userFor(at);
    if (!user) return null;
    const exp = (expiresAt ?? Math.floor(Date.now() / 1000) + 3600) * 1000;
    return { user, setCookie: encodeCookie({ at, rt, exp } satisfies SupabaseSession, secure) };
  }

  /** Valida el token con Supabase Auth y lee las clínicas del usuario (con su token: RLS). */
  private async userFor(at: string): Promise<PanelUser | null> {
    const hit = this.cache.get(at);
    if (hit && hit.until > Date.now()) return hit.user;
    const db = this.client(at);
    const { data, error } = await db.auth.getUser(at);
    if (error || !data.user) return null;
    const { data: rows, error: e2 } = await db.from("clinic_members").select("clinic_id, role").eq("user_id", data.user.id);
    if (e2) throw new Error(`Supabase: ${e2.message}`);
    const user: PanelUser = {
      id: data.user.id,
      email: data.user.email || (data.user.is_anonymous ? DEMO_VISITOR : ""),
      accessToken: at,
      memberships: (rows ?? []).map((r: any) => ({ clinicId: r.clinic_id, role: r.role })),
    };
    this.cache.set(at, { user, until: Date.now() + 60_000 });
    for (const [k, v] of this.cache) if (v.until < Date.now()) this.cache.delete(k);
    return user;
  }
}

export function createAuth(storeKind: "supabase" | "memoria"): AuthBackend {
  if (storeKind === "supabase") {
    if (!config.supabase.publishableKey) throw new Error("Falta SUPABASE_PUBLISHABLE_KEY en el .env (la usa el login del panel).");
    return new SupabaseAuth(config.supabase.url, config.supabase.publishableKey, config.supabase.secretKey);
  }
  return new MemoryAuth();
}

/** ¿El pedido llega por https (directo o detrás del túnel)? Define la marca Secure de la cookie. */
export const isSecure = (req: Request) =>
  req.protocol === "https" || req.header("x-forwarded-proto") === "https" || Boolean(req.header("cf-connecting-ip"));
