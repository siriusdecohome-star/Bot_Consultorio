import { chunkText } from "./services/textSearch.js";

/**
 * Convierte un documento subido desde el panel en texto y fragmentos para la búsqueda.
 * PDF con pdf-parse, Word (.docx) con mammoth, y texto plano o Markdown tal cual.
 * Las librerías se cargan solo cuando se usan.
 */

// En Vercel el cuerpo de un pedido tiene un máximo de 4,5 MB y el archivo viaja en base64 (+33 %): 3 MB.
export const MAX_DOC_BYTES = (process.env.VERCEL ? 3 : 8) * 1024 * 1024;
export const MAX_DOC_MB = MAX_DOC_BYTES / (1024 * 1024);

export type DocKind = "pdf" | "docx" | "texto";

export function docKind(name: string, mime: string): DocKind | null {
  const n = name.toLowerCase();
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || n.endsWith(".docx")) return "docx";
  if (mime.startsWith("text/") || n.endsWith(".txt") || n.endsWith(".md")) return "texto";
  return null;
}

/**
 * PDF.js crea al cargarse objetos de dibujo (DOMMatrix, Path2D, ImageData) que en Node vienen
 * del paquete opcional @napi-rs/canvas. En Vercel ese paquete puede no estar, y PDF.js falla
 * al importarse aunque solo se quiera el texto. Para extraer texto no se dibuja nada: si
 * faltan, se definen versiones vacías (no se tocan si ya existen).
 */
function textOnlyPdfGlobals() {
  const g = globalThis as Record<string, unknown>;
  class DOMMatrixStub {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    multiplySelf() { return this; }
    preMultiplySelf() { return this; }
    translateSelf() { return this; }
    scaleSelf() { return this; }
    invertSelf() { return this; }
  }
  g.DOMMatrix ??= DOMMatrixStub;
  g.Path2D ??= class Path2DStub {};
  g.ImageData ??= class ImageDataStub {};
}

export async function extractText(buf: Buffer, kind: DocKind): Promise<string> {
  if (kind === "pdf") {
    textOnlyPdfGlobals();
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
