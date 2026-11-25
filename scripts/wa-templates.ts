/**
 * Crea en Meta las plantillas que usa el bot cuando la ventana de 24 h está cerrada:
 * recordatorio, seguimiento de la promo, turno liberado (lista de espera), reactivación
 * aviso de reprogramación (cuando un profesional no va a atender) y seguimiento posterior al turno.
 * Meta las revisa (suele tardar de minutos a horas).
 * Uso: npm run wa:templates                       → crea las que falten
 *      npm run wa:templates -- --status            → estado de revisión de todas
 * Requiere WHATSAPP_TOKEN y WHATSAPP_WABA_ID en el .env.
 *
 * Si la ventana de 24 h está abierta (el paciente escribió hace menos de 24 h),
 * el bot NO usa plantillas: envía el mensaje con botones directamente.
 */
import { config } from "../src/config.js";

const { token, graphVersion, templateReminder, templateFollowup, templateWaitlist, templateReactivation, templateReschedule, templatePostVisit, templateLang } = config.whatsapp;
const ALL = [templateReminder, templateFollowup, templateWaitlist, templateReactivation, templateReschedule, templatePostVisit];
const waba = (process.env.WHATSAPP_WABA_ID ?? "").trim();
if (!token || !waba) {
  console.log("Faltan WHATSAPP_TOKEN o WHATSAPP_WABA_ID en el .env");
  process.exit(1);
}

// npm run wa:templates -- --status → solo muestra el estado de revisión
if (process.argv.includes("--status")) {
  for (const name of ALL) {
    const res = await fetch(`https://graph.facebook.com/${graphVersion}/${waba}/message_templates?name=${name}&fields=name,status,category,language,rejected_reason`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as any;
    const t = data?.data?.find((x: any) => x.name === name && x.language === templateLang);
    console.log(t ? `${t.status === "APPROVED" ? "✅" : t.status === "REJECTED" ? "❌" : "⏳"} ${name} (${t.category}): ${t.status}${t.rejected_reason && t.rejected_reason !== "NONE" ? ` · motivo: ${t.rejected_reason}` : ""}` : `⚪ ${name}: no existe`);
  }
  process.exit(0);
}

const templates = [
  {
    name: templateReminder,
    language: templateLang,
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hola, {{1}}. Le recordamos su turno de {{2}} en Clínica Dental Sonrisa Clara ({{3}}). ¿Nos confirma su asistencia?",
        example: { body_text: [["Ana", "mañana, miércoles 25/11 a las 10:00", "Limpieza dental"]] },
      },
      { type: "FOOTER", text: "Demo con datos ficticios" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Confirmo" },
          { type: "QUICK_REPLY", text: "Cambiar horario" },
          { type: "QUICK_REPLY", text: "Cancelar" },
        ],
      },
    ],
  },
  {
    name: templateFollowup,
    language: templateLang,
    category: "MARKETING",
    components: [
      {
        type: "BODY",
        text: "Hola, {{1}}. Le escribimos de Clínica Dental Sonrisa Clara por la promo de limpieza + control. Todavía quedan turnos esta semana. ¿Quiere que le busquemos uno?",
        example: { body_text: [["Ana"]] },
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Sí, buscar turno" },
          { type: "QUICK_REPLY", text: "Más adelante" },
        ],
      },
    ],
  },
  {
    name: templateWaitlist,
    language: templateLang,
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hola, {{1}}. Usted está en la lista de espera de Clínica Dental Sonrisa Clara y se liberó un turno: {{2}}. ¿Quiere que se lo reservemos?",
        example: { body_text: [["Ana", "miércoles 25/11 a las 10:00"]] },
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Lo tomo" },
          { type: "QUICK_REPLY", text: "No, gracias" },
        ],
      },
    ],
  },
  {
    name: templateReactivation,
    language: templateLang,
    category: "MARKETING",
    components: [
      {
        type: "BODY",
        text: "Hola, {{1}}. Le escribimos de Clínica Dental Sonrisa Clara: ya pasaron varios meses desde su última visita y le recomendamos un control. ¿Quiere que le busquemos un turno?",
        example: { body_text: [["Ana"]] },
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Sí, buscar turno" },
          { type: "QUICK_REPLY", text: "Más adelante" },
        ],
      },
    ],
  },
  {
    name: templateReschedule,
    language: templateLang,
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hola, {{1}}. Le escribimos de Clínica Dental Sonrisa Clara: {{3}} no podrá atender en el horario de su turno ({{2}}). ¿Quiere que lo reprogramemos?",
        example: { body_text: [["Ana", "viernes 27/11 a las 10:00", "la Dra. Laura Méndez"]] },
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Reprogramar" },
          { type: "QUICK_REPLY", text: "Cancelar turno" },
        ],
      },
    ],
  },
  {
    name: templatePostVisit,
    language: templateLang,
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hola, {{1}}. Le escribimos de Clínica Dental Sonrisa Clara para saber cómo se sintió después de su {{2}}. Si tiene alguna molestia o duda, responda este mensaje.",
        example: { body_text: [["Ana", "limpieza dental"]] },
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Todo bien" },
          { type: "QUICK_REPLY", text: "Tengo una consulta" },
        ],
      },
    ],
  },
];

// Solo se crean las que todavía no existen en la cuenta.
const existing = new Set<string>();
for (const name of ALL) {
  const r = await fetch(`https://graph.facebook.com/${graphVersion}/${waba}/message_templates?name=${name}&fields=name,language`, { headers: { Authorization: `Bearer ${token}` } });
  const d = (await r.json()) as any;
  if (d?.data?.some((x: any) => x.name === name && x.language === templateLang)) existing.add(name);
}

for (const t of templates) {
  if (existing.has(t.name)) { console.log(`⚪ ${t.name}: ya existe, no se vuelve a crear`); continue; }
  const res = await fetch(`https://graph.facebook.com/${graphVersion}/${waba}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(t),
  });
  const data = (await res.json()) as any;
  if (res.ok) console.log(`✅ ${t.name}: enviada a revisión (estado: ${data.status ?? "?"})`);
  else console.log(`❌ ${t.name}: ${data?.error?.error_user_msg ?? data?.error?.message ?? res.status}`);
}
