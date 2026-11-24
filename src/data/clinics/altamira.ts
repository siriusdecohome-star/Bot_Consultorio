import type { ClinicKnowledge } from "../../clinics/types.js";

/**
 * Clínica B: base de conocimiento FICTICIA, distinta a propósito de la A
 * (otros precios, otra moneda, otro horario) para que se note la separación.
 */
export const altamira: ClinicKnowledge = {
  name: "Centro Odontológico Altamira",
  tagline: "Odontología familiar (demo con datos ficticios)",
  address: "Calle Los Pinos 1550, local 3 (dirección ficticia)",
  reference: "Frente al parque de la zona. Estacionamiento propio para pacientes.",
  phone: "+591 2 000-0000 (ficticio)",
  email: "agenda@altamira.demo",
  professionals: [
    "Dr. Andrés Quiroga — odontología general y endodoncia",
    "Dra. Paula Vargas — odontopediatría (atiende lunes, miércoles y viernes)",
  ],
  hours: [
    { weekday: 1, blocks: [["08:30", "12:30"], ["15:00", "19:00"]] },
    { weekday: 2, blocks: [["08:30", "12:30"], ["15:00", "19:00"]] },
    { weekday: 3, blocks: [["08:30", "12:30"], ["15:00", "19:00"]] },
    { weekday: 4, blocks: [["08:30", "12:30"], ["15:00", "19:00"]] },
    { weekday: 5, blocks: [["08:30", "12:30"], ["15:00", "19:00"]] },
  ],
  hoursText: "Lunes a viernes de 8:30 a 12:30 y de 15:00 a 19:00. Sábados, domingos y feriados, cerrado.",
  treatments: [
    { name: "Consulta general", price: "Bs 150", duration: "30 min", notes: "Incluye revisión y plan de tratamiento." },
    { name: "Limpieza dental (profilaxis)", price: "Bs 250", duration: "30 min", notes: "Con aplicación de flúor." },
    { name: "Consulta de odontopediatría", price: "Bs 180", duration: "30 min", notes: "Para niños de 2 a 14 años, con la Dra. Vargas." },
    { name: "Tratamiento de conducto (endodoncia)", price: "desde Bs 900", duration: "60 min (dos turnos seguidos)", notes: "Requiere consulta previa y radiografía." },
    { name: "Arreglo de caries (resina)", price: "desde Bs 300 por pieza", duration: "30 min", notes: "El valor final depende de la pieza." },
    { name: "Sellantes para niños", price: "Bs 120 por pieza", duration: "30 min", notes: "Previenen caries en muelas definitivas." },
  ],
  promo: {
    name: "Chequeo Familiar",
    detail: "Consulta general + limpieza a Bs 300 por persona (en lugar de Bs 400) para grupos familiares de 3 o más. Válida hasta el 31/12.",
  },
  payments: "Efectivo, QR y tarjetas de débito y crédito.",
  insurance: "Convenio con los seguros ficticios DemoVida y SaludPlus. Con otros seguros se atiende de forma particular.",
  cancellationPolicy: "Pedimos avisar con al menos 4 horas de anticipación. Reprogramar no tiene costo.",
  emergencies: "Ante dolor intenso, sangrado que no se detiene, hinchazón de la cara o un golpe fuerte, debe acudir a una guardia odontológica u hospital de inmediato.",
  tone: "Trato cercano y familiar, siempre de usted. Si el paciente menciona niños, ofrezca la consulta de odontopediatría.",
};
