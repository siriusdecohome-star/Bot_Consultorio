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
import { ChannelNotifier } from "../src/services/notifier.js";
import { followupMessage, ReminderService } from "../src/bot/reminders.js";
import { systemClock } from "../src/services/time.js";

const args = process.argv.slice(2);
const s = await createServices();
if (s.storeKind !== "supabase") {
  console.log("⚠ Sin Supabase el script no ve las conversaciones del servidor (cada proceso tiene su propia memoria).");
}
let whatsapp = null;
if (config.whatsapp.token && config.whatsapp.phoneNumberId) {
  const { WhatsAppCloudClient } = await import("../src/channels/whatsappClient.js");
  whatsapp = new WhatsAppCloudClient();
}
const notifier = new ChannelNotifier({ whatsapp });
const service = new ReminderService(s.store, notifier, systemClock);

async function latestWhatsApp() {
  const convs = (await s.store.listConversations())
    .filter((c) => c.channel === "whatsapp" && !c.id.startsWith("demo_"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return convs[0] ?? null;
}

if (args.includes("--latest")) {
  const conv = await latestWhatsApp();
  if (!conv) { console.log("No hay conversaciones de WhatsApp todavía."); process.exit(1); }
  const next = (await s.store.listAppointments({ patientId: conv.patientId, from: new Date().toISOString(), status: ["confirmada", "pendiente"] }))[0];
  if (!next) { console.log("Esa conversación no tiene turnos próximos: reservá uno por WhatsApp primero."); process.exit(1); }
  await service.remindNow(next.id, args.includes("--2h") ? "reminder2" : "reminder24");
  console.log(`✅ Recordatorio enviado (turno ${next.id}).`);
} else if (args.includes("--followup")) {
  const conv = await latestWhatsApp();
  const patient = conv ? await s.store.getPatient(conv.patientId) : null;
  if (!conv || !patient) { console.log("No hay conversaciones de WhatsApp todavía."); process.exit(1); }
  const msg = followupMessage(patient.name);
  const how = await notifier.send("whatsapp", patient.phone, msg);
  conv.messages.push({ role: "bot", text: msg.text, at: new Date().toISOString(), meta: { kind: "followup" } });
  await s.store.saveConversation(conv);
  console.log(`✅ Seguimiento ${how}.`);
} else {
  const r = await service.sweep();
  console.log(`Recordatorios 24 h: ${r.reminder24} · 2 h: ${r.reminder2} · seguimientos: ${r.followups} · omitidos: ${r.skipped}`);
  if (r.errors.length) console.log(`Errores:\n- ${r.errors.join("\n- ")}`);
}
