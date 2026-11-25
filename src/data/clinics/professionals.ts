import type { OpeningHours, Professional } from "../../clinics/types.js";

/**
 * Profesionales de ejemplo. Solo la Dra. Méndez usa un Google Calendar real
 * (el de GOOGLE_CALENDAR_ID); el resto usa la agenda interna del sistema.
 * En producción cada profesional conecta su propio calendario y el sistema
 * lee solo ocupado/libre (ver README, «Calendarios por profesional»).
 */

const days = (weekdays: number[], blocks: Array<[string, string]>): OpeningHours[] => weekdays.map((weekday) => ({ weekday, blocks }));

export const sonrisaProfessionals: Professional[] = [
  {
    id: "prof-mendez", name: "Dra. Laura Méndez", specialty: "Odontología general", color: "#25d366",
    hours: [...days([1, 2, 3, 4, 5], [["09:00", "13:00"], ["14:00", "18:00"]]), ...days([6], [["09:00", "13:00"]])],
    treatments: [
      { id: "consulta", minutes: 30 }, { id: "limpieza", minutes: 30 }, { id: "caries", minutes: 30 },
      { id: "extraccion", minutes: 30 }, { id: "implantes", minutes: 30 },
    ],
    calendar: "google", active: true,
  },
  {
    id: "prof-rios", name: "Dr. Martín Ríos", specialty: "Ortodoncia", color: "#59b8ff",
    hours: days([2, 4], [["09:00", "13:00"], ["14:00", "18:00"]]),
    treatments: [{ id: "ortodoncia", minutes: 30 }],
    calendar: "interno", active: true,
  },
  {
    id: "prof-paredes", name: "Dra. Sofía Paredes", specialty: "Estética dental", color: "#d38cff",
    hours: days([1, 3, 5], [["14:00", "18:00"]]),
    treatments: [{ id: "blanqueamiento", minutes: 60 }, { id: "limpieza", minutes: 45 }],
    calendar: "interno", active: true,
  },
];

export const altamiraProfessionals: Professional[] = [
  {
    id: "prof-quiroga", name: "Dr. Andrés Quiroga", specialty: "Odontología general y endodoncia", color: "#25d366",
    hours: days([1, 2, 3, 4, 5], [["08:30", "12:30"], ["15:00", "19:00"]]),
    treatments: [{ id: "consulta-general", minutes: 30 }, { id: "limpieza", minutes: 30 }, { id: "caries", minutes: 30 }, { id: "endodoncia", minutes: 60 }],
    calendar: "interno", active: true,
  },
  {
    id: "prof-vargas", name: "Dra. Paula Vargas", specialty: "Odontopediatría", color: "#ffb547",
    hours: days([1, 3, 5], [["08:30", "12:30"], ["15:00", "19:00"]]),
    treatments: [{ id: "odontopediatria", minutes: 30 }, { id: "sellantes", minutes: 30 }],
    calendar: "interno", active: true,
  },
  {
    id: "prof-choque", name: "Dr. Luis Choque", specialty: "Odontología general", color: "#59b8ff",
    hours: [...days([2, 4], [["15:00", "19:00"]]), ...days([5], [["08:30", "12:30"]])],
    treatments: [{ id: "consulta-general", minutes: 30 }, { id: "limpieza", minutes: 40 }, { id: "caries", minutes: 30 }],
    calendar: "interno", active: true,
  },
];
