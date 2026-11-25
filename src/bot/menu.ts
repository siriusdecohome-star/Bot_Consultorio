import type { ClinicKnowledge, ClinicMenu, MenuOption } from "../clinics/types.js";

/**
 * Menú inicial con botones (hasta 3 opciones) o lista interactiva de WhatsApp
 * (hasta 10). Las opciones se editan en el panel, en Aprendizaje.
 */

export interface Interactive {
  buttons?: string[];
  list?: { button: string; rows: Array<{ id: string; title: string; description?: string }> };
}

/** Límites de WhatsApp para mensajes interactivos. */
export const MENU_LIMITS = { options: 10, buttonTitle: 20, rowTitle: 24, rowDescription: 72, listButton: 20, intro: 1024 } as const;

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

export function activeMenu(k: ClinicKnowledge): ClinicMenu | null {
  return k.menu?.enabled && k.menu.options.length ? k.menu : null;
}

const GREETING_WORDS = new Set([
  "hola", "holi", "holis", "buenas", "buen", "buenos", "buena", "dia", "dias", "tardes", "noches", "hey", "que", "tal",
  "menu", "inicio", "opciones", "como", "esta", "estas", "saludos", "ola", "hello", "hi",
]);

/** «Hola», «buenas tardes», «menú»… sin otra consulta: se responde con el menú. */
export function isMenuRequest(text: string): boolean {
  const words = norm(text).split(" ").filter(Boolean);
  return words.length > 0 && words.length <= 4 && words.every((w) => GREETING_WORDS.has(w));
}

/**
 * ¿El paciente eligió una opción? Por el título del botón o fila (WhatsApp manda el
 * título), por su id, o por número si el último mensaje del bot mostró el menú.
 */
export function matchMenuOption(menu: ClinicMenu, text: string, lastOptions?: string[]): MenuOption | null {
  const t = norm(text);
  if (!t) return null;
  const byLabel = menu.options.find((o) => norm(o.label) === t || o.id === t);
  if (byLabel) return byLabel;
  if (lastOptions?.length && /^\d{1,2}$/.test(t)) {
    const label = lastOptions[Number(t) - 1];
    return menu.options.find((o) => o.label === label) ?? null;
  }
  return null;
}

/** Hasta 3 opciones van como botones; más, como lista (un botón «Ver opciones» que la abre). */
export function menuInteractive(menu: ClinicMenu): Interactive {
  const opts = menu.options.slice(0, MENU_LIMITS.options);
  if (opts.length <= 3) return { buttons: opts.map((o) => o.label.slice(0, MENU_LIMITS.buttonTitle)) };
  return {
    list: {
      button: (menu.button || "Ver opciones").slice(0, MENU_LIMITS.listButton),
      rows: opts.map((o) => ({
        id: `menu:${o.id}`,
        title: o.label.slice(0, MENU_LIMITS.rowTitle),
        ...(o.description ? { description: o.description.slice(0, MENU_LIMITS.rowDescription) } : {}),
      })),
    },
  };
}

/** Validación del menú editado en el panel. Devuelve el problema o null. */
export function validateMenu(m: any): string | null {
  if (m === undefined) return null;
  if (!m || typeof m !== "object" || typeof m.enabled !== "boolean") return "Menú inválido";
  if (typeof m.intro !== "string" || !m.intro.trim() || m.intro.length > MENU_LIMITS.intro) return "El menú necesita un texto de introducción";
  if (typeof m.button !== "string" || m.button.length > MENU_LIMITS.listButton) return `El botón del menú admite hasta ${MENU_LIMITS.listButton} caracteres`;
  if (!Array.isArray(m.options)) return "Opciones del menú inválidas";
  if (m.enabled && !m.options.length) return "Agregue al menos una opción al menú";
  if (m.options.length > MENU_LIMITS.options) return `El menú admite hasta ${MENU_LIMITS.options} opciones (límite de WhatsApp)`;
  const ids = new Set<string>();
  for (const o of m.options) {
    if (!o?.label?.trim() || !o?.text?.trim()) return "Cada opción del menú necesita título y texto";
    const max = m.options.length <= 3 ? MENU_LIMITS.buttonTitle : MENU_LIMITS.rowTitle;
    if (o.label.length > max) return `«${o.label}»: el título admite hasta ${max} caracteres (límite de WhatsApp)`;
    if (o.description && o.description.length > MENU_LIMITS.rowDescription) return `«${o.label}»: la descripción admite hasta ${MENU_LIMITS.rowDescription} caracteres`;
    if (o.kind !== "consulta" && o.kind !== "respuesta") return "Tipo de opción inválido";
    if (typeof o.id !== "string" || !/^[a-z0-9-]{1,30}$/.test(o.id) || ids.has(o.id)) return "Ids de opción inválidos o repetidos";
    ids.add(o.id);
  }
  return null;
}
