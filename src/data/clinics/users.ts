import type { Role } from "../../clinics/types.js";
import { CLINIC_A, CLINIC_B } from "./index.js";

/**
 * Usuarios FICTICIOS del panel. `npm run seed:users` genera sus contraseñas en el .env
 * (variable `passwordVar`) y, si hay Supabase, los crea en Supabase Auth.
 * El dominio .test está reservado: nunca llega un correo real.
 */
export interface DemoUser {
  email: string;
  passwordVar: string;
  memberships: Array<{ clinicId: string; role: Role }>;
}

export const demoUsers: DemoUser[] = [
  {
    email: "admin@sonrisaclara.demo.test",
    passwordVar: "DEMO_PASS_ADMIN_SONRISA",
    // Dueño de las dos clínicas: así se puede mostrar el selector de clínica del panel.
    memberships: [{ clinicId: CLINIC_A, role: "admin" }, { clinicId: CLINIC_B, role: "admin" }],
  },
  { email: "recepcion@sonrisaclara.demo.test", passwordVar: "DEMO_PASS_RECEPCION_SONRISA", memberships: [{ clinicId: CLINIC_A, role: "recepcion" }] },
  { email: "admin@altamira.demo.test", passwordVar: "DEMO_PASS_ADMIN_ALTAMIRA", memberships: [{ clinicId: CLINIC_B, role: "admin" }] },
  { email: "recepcion@altamira.demo.test", passwordVar: "DEMO_PASS_RECEPCION_ALTAMIRA", memberships: [{ clinicId: CLINIC_B, role: "recepcion" }] },
];
