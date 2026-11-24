/**
 * CSV que Excel abre bien en español sin importar nada:
 * - UTF-8 con BOM: Excel reconoce los acentos y la ñ.
 * - Separador «;» y decimales con coma: es la configuración regional de Excel en
 *   español (con «,» Excel pondría todo en una sola columna).
 * - Fin de línea CRLF.
 * - Celdas que empiezan con = + - @ se prefijan con ' para que Excel no las
 *   ejecute como fórmulas (inyección de fórmulas en CSV). Excepción: un teléfono
 *   en formato internacional (+ y solo dígitos) va como ="+549…" para que se vea igual.
 * Sin librerías: es texto plano.
 */

export type Cell = string | number | boolean | null | undefined;

const BOM = "﻿";

function cell(v: Cell): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number"
    ? (Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")).replace(".", ",")
    : typeof v === "boolean" ? (v ? "sí" : "no") : String(v);
  // Teléfonos (+5491100001001): como texto fijo ="…", así Excel no los vuelve número (5,49E+12) ni muestra un apóstrofo.
  if (typeof v === "string" && /^\+\d{6,15}$/.test(s)) s = `="${s}"`;
  else if (/^[=+\-@\t\r]/.test(s) && typeof v !== "number") s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  return BOM + [headers, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}
