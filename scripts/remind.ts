/**
 * Recordatorios y seguimiento desde la terminal (usa Supabase + WhatsApp del .env).
 *
 *   npm run remind                    → una revisión completa (lo mismo que hace el servidor cada minuto)
 *   npm run remind -- --latest        → recordatorio YA del próximo turno de la última conversación de WhatsApp
 *   npm run remind -- --latest --2h   → ídem, versión «2 horas antes»
 *   npm run remind -- --followup      → seguimiento YA a la última conversación de WhatsApp (lead sin turno)
 *
 * Las respuestas del paciente las procesa el servidor (npm run dev) a través del webhook.
 */
import { config } from "../src/config.js";
import { createServices } from "../src/services/factory.js";
import { systemClock } from "../src/services/time.js";
import { createProvider } from "../src/llm/index.js";
import { buildRuntimes, loadClinics } from "../src/clinics/registry.js";

const args = process.argv.slice(2);
const s = await createServices();
if (s.storeKind !== "supabase") {
  console.log("⚠ Sin Supabase el script no ve las conversaciones del servidor (cada proceso tiene su propia memoria).");
}
const { WhatsAppCloudClient } = await import("../src/channels/whatsappClient.js");
const runtimes = buildRuntimes({
  services: s, clinics: await loadClinics(s), provider: await createProvider("mock"), clock: systemClock,
  whatsappFor: (id) => (config.whatsapp.token ? new WhatsAppCloudClient(config.whatsapp.token, id) : null),
});
// WhatsApp real: la clínica que tiene el número de prueba (la principal).
const rt = [...runtimes.values()].find((r) => r.profile.whatsappPhoneNumberId) ?? [...runtimes.values()][0]!;
const store = rt.store;
const service = rt.reminders;
console.log(`Clínica: ${rt.profile.name}`);

async function latestWhatsApp() {
  const convs = (await store.listConversations())
    .filter((c) => c.channel === "whatsapp" && !c.id.startsWith("demo_"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return convs[0] ?? null;
}

if (args.includes("--latest")) {
  const conv = await latestWhatsApp();
  if (!conv) { console.log("No hay conversaciones de WhatsApp todavía."); process.exit(1); }
  const next = (await store.listAppointments({ patientId: conv.patientId, from: new Date().toISOString(), status: ["confirmada", "pendiente"] }))[0];
  if (!next) { console.log("Esa conversación no tiene turnos próximos: reservá uno por WhatsApp primero."); process.exit(1); }
  await service.remindNow(next.id, args.includes("--2h") ? "reminder2" : "reminder24");
  console.log(`✅ Recordatorio enviado (turno ${next.id}).`);
} else if (args.includes("--followup")) {
  const conv = await latestWhatsApp();
  const patient = conv ? await store.getPatient(conv.patientId) : null;
  if (!conv || !patient) { console.log("No hay conversaciones de WhatsApp todavía."); process.exit(1); }
  await service.followupNow(conv, "whatsapp", patient.phone, patient.name);
  console.log("✅ Seguimiento enviado.");
} else {
  const r = await service.sweep();
  console.log(`Recordatorios 24 h: ${r.reminder24} · 2 h: ${r.reminder2} · seguimientos: ${r.followups} · omitidos: ${r.skipped}`);
  if (r.errors.length) console.log(`Errores:\n- ${r.errors.join("\n- ")}`);
}
