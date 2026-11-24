/**
 * Búsqueda de texto en los documentos del consultorio (RAG sin vectores).
 * - En Supabase la hace PostgreSQL: columna tsvector en español + índice GIN + ts_rank.
 * - En memoria (entorno de pruebas) se usa una versión simple: términos normalizados
 *   y puntaje por coincidencias. Mismo contrato, para que las pruebas no dependan de la base.
 * Ver README → "Documentos y búsqueda" (cómo migrar a pgvector).
 */

const STOP = new Set(
  ("a al algo algun alguna algunas alguno algunos ante antes como con contra cual cuales cuando de del desde donde " +
    "durante e el ella ellas ellos en entre era es esa esas ese eso esos esta estan estas este esto estos fue ha hay " +
    "la las le les lo los mas me mi mis mucho muy no nos o os para pero por porque que quien se sea ser si sin sobre " +
    "son su sus tambien te tengo tiene tienen todo todos tu tus un una unas uno unos usted ustedes y ya yo quiero " +
    "puedo puede hola buenas buenos dias tardes noches gracias favor saber consulta pregunta").split(" "),
);

export const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ");

/** Términos útiles de una consulta (sin palabras vacías ni repetidos). */
export function terms(q: string): string[] {
  return [...new Set(normalize(q).split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 12);
}

/** Raíz aproximada (plural y género) para que «implantes» coincida con «implante». */
const stem = (w: string) => w.replace(/(es|s)$/, "").replace(/[ao]$/, "");

/** Puntaje de un fragmento para la versión en memoria. */
export function score(content: string, qTerms: string[]): number {
  const words = normalize(content).split(/\s+/).map(stem);
  const bag = new Map<string, number>();
  for (const w of words) bag.set(w, (bag.get(w) ?? 0) + 1);
  let s = 0;
  for (const t of qTerms) {
    const n = bag.get(stem(t)) ?? 0;
    if (n) s += 1 + Math.log(n);
  }
  return s / Math.sqrt(1 + words.length / 80);
}

/** Consulta para websearch_to_tsquery: términos unidos con "or" (si no, exige todos). */
export const tsQuery = (q: string) => terms(q).join(" or ");

/**
 * Parte el texto en fragmentos de ~maxChars respetando párrafos y oraciones:
 * así cada resultado de la búsqueda es corto y se entiende solo.
 */
export function chunkText(text: string, maxChars = 900): string[] {
  const paras = text.replace(/\r/g, "").split(/\n\s*\n+/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const p of paras) {
    if (p.length > maxChars) {
      push();
      let buf = "";
      for (const sentence of p.split(/(?<=[.!?])\s+/)) {
        if ((buf + " " + sentence).length > maxChars && buf) { out.push(buf.trim()); buf = ""; }
        buf += ` ${sentence}`;
      }
      if (buf.trim()) out.push(buf.trim());
      continue;
    }
    if ((cur + "\n\n" + p).length > maxChars) push();
    cur += (cur ? "\n\n" : "") + p;
  }
  push();
  return out;
}

/**
 * Las oraciones más relevantes de un fragmento para mostrar en una respuesta corta
 * (la usa el modo sin IA; los modelos reales reciben el fragmento completo).
 */
export function bestSnippet(content: string, query: string, maxChars = 380): string {
  const q = terms(query);
  const sentences = content.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) return content.slice(0, maxChars);
  let best = 0;
  let bestScore = -1;
  sentences.forEach((s, i) => {
    const sc = score(s, q);
    if (sc > bestScore) { bestScore = sc; best = i; }
  });
  let out = sentences[best]!;
  for (let i = best + 1; i < sentences.length && (out + " " + sentences[i]).length <= maxChars; i++) out += ` ${sentences[i]}`;
  return out.length > maxChars ? `${out.slice(0, maxChars).replace(/\s+\S*$/, "")}…` : out;
}
