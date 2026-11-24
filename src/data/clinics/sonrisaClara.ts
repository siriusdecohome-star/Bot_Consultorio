import type { ClinicKnowledge } from "../../clinics/types.js";

/** Clínica A: base de conocimiento FICTICIA (solo para la demo). */
export const sonrisaClara: ClinicKnowledge = {
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
  ],
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
};
