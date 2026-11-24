/**
 * Usuarios FICTICIOS del panel: un admin y una recepcionista por clínica.
 * - Genera las contraseñas que falten y las guarda en el .env (nunca en el repositorio
 *   ni en la consola). Con --nuevas las vuelve a generar todas.
 * - Genera PANEL_SESSION_SECRET si falta (firma de la cookie del panel).
 * - Con Supabase: crea o actualiza los usuarios en Supabase Auth (correo ya confirmado,
 *   sin enviar mails) y les asigna clínica y rol en `clinic_members`.
 * Uso: npm run seed:users   (después de npm run seed)
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config, ROOT } from "../src/config.js";
import { demoUsers } from "../src/data/clinics/users.js";
import { hasSupabase } from "../src/services/factory.js";

const envPath = path.join(ROOT, ".env");
const rotate = process.argv.includes("--nuevas");
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

const getVar = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
function setVar(k: string, v: string) {
  const line = `${k}=${v}`;
  env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${env.replace(/\s*$/, "")}\n${line}\n`;
  process.env[k] = v;
}
// Contraseña legible y fuerte: 4 bloques de 4 caracteres sin ambiguos (0/O, 1/l).
const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newPassword = () => Array.from({ length: 4 }, () =>
  Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join("")).join("-");

if (!env.includes("# Usuarios ficticios del panel")) env = `${env.replace(/\s*$/, "")}\n\n# Usuarios ficticios del panel (los genera npm run seed:users)\n`;
if (!getVar("PANEL_SESSION_SECRET")) setVar("PANEL_SESSION_SECRET", randomBytes(32).toString("hex"));
let generated = 0;
for (const u of demoUsers) {
  if (rotate || !getVar(u.passwordVar)) { setVar(u.passwordVar, newPassword()); generated++; }
  else process.env[u.passwordVar] = getVar(u.passwordVar);
}
// El usuario único anterior ya no se usa.
env = env.replace(/^PANEL_USER=.*\r?\n?/m, "").replace(/^PANEL_PASSWORD=.*\r?\n?/m, "");
writeFileSync(envPath, env, "utf8");
console.log(`Contraseñas en el .env: ${generated} nueva(s), ${demoUsers.length - generated} sin cambios.`);

if (!hasSupabase()) {
  console.log("Sin Supabase: los usuarios funcionan en el entorno de pruebas (memoria) con esas contraseñas.");
} else {
  const admin = createClient(config.supabase.url, config.supabase.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: list, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`Supabase Auth: ${error.message}`);
  for (const u of demoUsers) {
    const password = process.env[u.passwordVar]!;
    const existing = list.users.find((x) => x.email === u.email);
    let id = existing?.id;
    if (existing) {
      const r = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
      if (r.error) throw new Error(`${u.email}: ${r.error.message}`);
    } else {
      const r = await admin.auth.admin.createUser({ email: u.email, password, email_confirm: true, user_metadata: { demo: true } });
      if (r.error) throw new Error(`${u.email}: ${r.error.message}`);
      id = r.data.user.id;
    }
    const del = await admin.from("clinic_members").delete().eq("user_id", id!);
    if (del.error) throw new Error(`clinic_members: ${del.error.message}`);
    const ins = await admin.from("clinic_members").insert(u.memberships.map((m) => ({ user_id: id, clinic_id: m.clinicId, role: m.role })));
    if (ins.error) throw new Error(`clinic_members: ${ins.error.message} (¿ejecutó npm run seed antes?)`);
    console.log(`${existing ? "Actualizado" : "Creado"}: ${u.email} → ${u.memberships.map((m) => `${m.clinicId} (${m.role})`).join(", ")}`);
  }
}
console.log("Las contraseñas están en el .env (variables DEMO_PASS_*). Reinicie el servidor para que las tome.");
