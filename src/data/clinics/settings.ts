import { config } from "../../config.js";
import type { ClinicSettings, FollowupRule } from "../../clinics/types.js";

/**
 * Reglas de seguimiento por defecto. Con estos valores el bot se comporta igual que
 * antes de que existiera la pestaña Seguimientos: recordatorios de 24 h y 2 h, seguimiento
 * del lead de la promo y reactivación. Las de 72 h, 1 h y la posterior al turno vienen
 * cargadas pero apagadas, para activarlas desde el panel.
 */
export function defaultRules(): FollowupRule[] {
  const t = config.whatsapp;
  const reminderButtons = ["✅ Confirmo", "📅 Cambiar horario", "❌ Cancelar"];
  return [
    {
      id: "antes-72", kind: "antes", hours: 72, active: false,
      text: "📅 Hola, {nombre}. Le recordamos que el *{cuando}* tiene turno en {clinica}.\n🦷 {tratamiento} con {profesional}\n\n¿Nos confirma su asistencia?",
      buttons: reminderButtons, template: t.templateReminder,
    },
    {
      id: "antes-24", kind: "antes", hours: 24, active: true,
      text: "⏰ *Recordatorio de turno*\n\nHola, {nombre}. Le recuerdo su turno de *{cuando}* en {clinica}.\n🦷 {tratamiento}\n👩‍⚕️ {profesional}\n📍 {direccion}\n\n¿Nos confirma su asistencia?",
      buttons: reminderButtons, template: t.templateReminder,
    },
    {
      id: "antes-2", kind: "antes", hours: 2, active: true,
      text: "👋 Hola, {nombre}. Su turno es *{cuando}*.\n📍 {direccion}\n\n¿Puede asistir?",
      textConfirmed: "👋 Hola, {nombre}. Le esperamos *{cuando}*.\n📍 {direccion}\n\nSi surge algo, avíseme por aquí.",
      buttons: ["✅ Confirmo", "❌ Cancelar"], template: t.templateReminder,
    },
    {
      id: "antes-1", kind: "antes", hours: 1, active: false,
      text: "👋 {nombre}, en una hora es su turno ({hora}) en {clinica}. 📍 {direccion}",
      buttons: [], template: t.templateReminder,
    },
    {
      id: "despues-1", kind: "despues", days: 1, active: false,
      text: "Hola, {nombre} 👋 ¿Cómo se sintió después de su {tratamiento}? Si tiene alguna molestia o duda, escríbanos por aquí.",
      buttons: ["😊 Todo bien", "Tengo una consulta"], template: t.templatePostVisit,
    },
    {
      id: "reactivacion", kind: "reactivacion", days: config.reactivation.months * 30, repeatDays: 90, active: config.reactivation.enabled,
      text: "Hola, {nombre} 👋 Le escribimos de {clinica}. Ya pasaron {meses} meses desde su última visita ({tratamiento}) y le recomendamos un control cada 6 meses.\n\n¿Quiere que le busque un turno?",
      buttons: ["📅 Sí, buscar turno", "Más adelante"], template: t.templateReactivation,
    },
    {
      id: "lead", kind: "lead", hours: config.reminders.followupAfterHours, active: true,
      text: "Hola, {nombre} 👋 Le escribo de {clinica}. Hace poco consultó por la *{promo}*.\n\nTodavía quedan turnos esta semana. ¿Quiere que le busque uno?",
      buttons: ["📅 Sí, buscar turno", "Más adelante"], template: t.templateFollowup,
    },
  ];
}

export function defaultSettings(): ClinicSettings {
  return { quietHours: { from: "21:00", to: "08:00" }, waitlistOfferMinutes: config.waitlist.offerMinutes, rules: defaultRules() };
}

/** Completa ajustes guardados con los valores por defecto (por ejemplo, si una base vieja no los tiene). */
export function withDefaults(s: Partial<ClinicSettings> | null | undefined): ClinicSettings {
  const d = defaultSettings();
  if (!s) return d;
  return {
    quietHours: s.quietHours === undefined ? d.quietHours : s.quietHours,
    waitlistOfferMinutes: s.waitlistOfferMinutes ?? d.waitlistOfferMinutes,
    rules: Array.isArray(s.rules) && s.rules.length ? s.rules : d.rules,
  };
}
