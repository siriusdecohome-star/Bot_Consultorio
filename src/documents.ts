import { chunkText } from "./services/textSearch.js";

/**
 * Convierte un documento subido desde el panel en texto y fragmentos para la búsqueda.
 * PDF con pdf-parse, Word (.docx) con mammoth, y texto plano o Markdown tal cual.
 * Las librerías se cargan solo cuando se usan.
 */

export const MAX_DOC_BYTES = 8 * 1024 * 1024;

export type DocKind = "pdf" | "docx" | "texto";

export function docKind(name: string, mime: string): DocKind | null {
  const n = name.toLowerCase();
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || n.endsWith(".docx")) return "docx";
  if (mime.startsWith("text/") || n.endsWith(".txt") || n.endsWith(".md")) return "texto";
  return null;
}

export async function extractText(buf: Buffer, kind: DocKind): Promise<string> {
  if (kind === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (kind === "docx") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: buf })).value;
  }
  return buf.toString("utf8");
}

export async function toChunks(buf: Buffer, kind: DocKind): Promise<string[]> {
  const text = (await extractText(buf, kind))
    .replace(/\u0000/g, "")
    .replace(/^-- \d+ of \d+ --$/gm, "") // marcas de página que agrega pdf-parse
    .trim();
  return chunkText(text);
}
