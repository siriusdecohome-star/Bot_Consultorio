/**
 * Base de conocimiento FICTICIA del consultorio (solo para la demo).
 * Es corta, así que va completa en el prompt de sistema (cacheado):
 * evita una ronda extra de herramientas y baja la latencia.
 */

export interface OpeningHours {
  /** 1 = lunes … 7 = domingo (como Luxon) */
  weekday: number;
  /** Bloques de atención en hora local, "HH:mm" */
  blocks: Array<[string, string]>;
}

export const clinic = {
  name: "Clínica Dental Sonrisa Clara",
  tagline: "Consultorio odontológico (demo con datos ficticios)",
  address: "Av. Siempreviva 742, piso 2, consultorio B (dirección ficticia)",
  reference: "A media cuadra de la plaza central. Hay estacionamiento medido en la cuadra.",
  phone: "+54 11 0000-0000 (ficticio)",
  email: "turnos@sonrisaclara.demo",
  professionals: [
    "Dra. Laura Méndez — odontología general y estética",
    "Dr. Martín Ríos — ortodoncia (atiende los martes y jueves)",
  ],
  hours: [
    { weekday: 1, blocks: [["09:00", "13:00"], ["14:00", "18:00"]] },
    { weekday: 2, blocks: [["09:00", "13:00"], ["14:00", "18:00"]] },
    { weekday: 3, blocks: [["09:00", "13:00"], ["14:00", "18:00"]] },
    { weekday: 4, blocks: [["09:00", "13:00"], ["14:00", "18:00"]] },
    { weekday: 5, blocks: [["09:00", "13:00"], ["14:00", "18:00"]] },
    { weekday: 6, blocks: [["09:00", "13:00"]] },
  ] as OpeningHours[],
  hoursText: "Lunes a viernes de 9:00 a 13:00 y de 14:00 a 18:00. Sábados de 9:00 a 13:00. Domingos y feriados, cerrado.",
  treatments: [
    { name: "Consulta y diagnóstico", price: "USD 25", duration: "30 min", notes: "Incluye revisión general y plan de tratamiento." },
    { name: "Limpieza dental (profilaxis)", price: "USD 40", duration: "30 min", notes: "Recomendada cada 6 meses." },
    { name: "Blanqueamiento en consultorio", price: "USD 180", duration: "60 min (se agenda en dos turnos seguidos)", notes: "Requiere consulta previa." },
    { name: "Arreglo de caries (resina)", price: "desde USD 50 por pieza", duration: "30 min", notes: "El valor final depende de la pieza." },
    { name: "Extracción simple", price: "USD 60", duration: "30 min", notes: "Las extracciones complejas se evalúan en consulta." },
    { name: "Consulta de ortodoncia", price: "USD 30", duration: "30 min", notes: "Con el Dr. Ríos, martes y jueves." },
    { name: "Evaluación para implantes", price: "sin cargo", duration: "30 min", notes: "El presupuesto se entrega en la evaluación." },
  ],
  promo: {
    name: "Promo Sonrisa Noviembre",
    detail: "Limpieza dental + consulta de control a USD 29 (en lugar de USD 65). Válida para pacientes nuevos hasta el 31/12.",
  },
  payments: "Efectivo, transferencia y tarjetas de débito y crédito (hasta 3 cuotas sin interés con tarjetas seleccionadas).",
  insurance: "Trabajamos con las obras sociales ficticias DemoSalud y PlanSonrisa. Con otras coberturas, se atiende de forma particular y se entrega factura para reintegro.",
  cancellationPolicy: "Pedimos avisar con al menos 2 horas de anticipación si no puede asistir. Reprogramar no tiene costo.",
  emergencies: "Ante dolor intenso, sangrado que no se detiene, hinchazón de la cara o un golpe fuerte, debe acudir a una guardia odontológica u hospital de inmediato.",
} as const;

/** Texto de la base de conocimiento para el prompt de sistema. */
export function knowledgeText(): string {
  const t = clinic.treatments
    .map((x) => `- ${x.name}: ${x.price}. Duración: ${x.duration}. ${x.notes}`)
    .join("\n");
  return [
    `Nombre: ${clinic.name} (${clinic.tagline})`,
    `Dirección: ${clinic.address}. ${clinic.reference}`,
    `Teléfono: ${clinic.phone}. Correo: ${clinic.email}`,
    `Profesionales:\n- ${clinic.professionals.join("\n- ")}`,
    `Horario de atención: ${clinic.hoursText}`,
    `Tratamientos y precios:\n${t}`,
    `Promoción vigente: ${clinic.promo.name}. ${clinic.promo.detail}`,
    `Medios de pago: ${clinic.payments}`,
    `Coberturas: ${clinic.insurance}`,
    `Política de cancelación: ${clinic.cancellationPolicy}`,
    `Urgencias: ${clinic.emergencies}`,
  ].join("\n\n");
}

/** Versión breve que va al final del primer saludo (modo "inline"). */
export const privacyLine =
  "_🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._";

export const privacyNotice =
  `🔒 Aviso de privacidad: soy el asistente virtual de ${clinic.name}. ` +
  "Uso sus datos (nombre y teléfono) solo para gestionar sus turnos y la conversación queda registrada de forma confidencial. " +
  "No comparta información médica sensible por este medio. Si en algún momento prefiere hablar con una persona, escriba «persona». " +
  "(Demo con datos ficticios.)";
