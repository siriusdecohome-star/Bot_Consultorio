/**
 * Crea en Meta las dos plantillas que usa el bot cuando la ventana de 24 h está cerrada.
 * Meta las revisa (suele tardar de minutos a horas). Uso: npm run wa:templates
 * Requiere WHATSAPP_TOKEN y WHATSAPP_WABA_ID en el .env.
 *
 * Si la ventana de 24 h está abierta (el paciente escribió hace menos de 24 h),
 * el bot NO usa plantillas: envía el mensaje con botones directamente.
 */
import { config } from "../src/config.js";

const { token, graphVersion, templateReminder, templateFollowup, templateLang } = config.whatsapp;
const waba = (process.env.WHATSAPP_WABA_ID ?? "").trim();
if (!token || !waba) {
  console.log("Faltan WHATSAPP_TOKEN o WHATSAPP_WABA_ID en el .env");
  process.exit(1);
}

// npm run wa:templates -- --status → solo muestra el estado de revisión
if (process.argv.includes("--status")) {
  for (const name of [templateReminder, templateFollowup]) {
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
];

for (const t of templates) {
  const res = await fetch(`https://graph.facebook.com/${graphVersion}/${waba}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(t),
  });
  const data = (await res.json()) as any;
  if (res.ok) console.log(`✅ ${t.name}: enviada a revisión (estado: ${data.status ?? "?"})`);
  else console.log(`❌ ${t.name}: ${data?.error?.error_user_msg ?? data?.error?.message ?? res.status}`);
}
