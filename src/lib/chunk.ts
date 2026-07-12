/**
 * Simple, robust text chunker.
 * Splits on paragraph boundaries and packs into ~maxChars windows with overlap.
 * Char-based (not token-based) to avoid a tokenizer dependency; ~4 chars/token,
 * so ~2800 chars ≈ ~700 tokens — a good chunk size for retrieval.
 */

export type Chunk = { content: string; index: number };

const MAX_CHARS = 2800;
const OVERLAP_CHARS = 300;

export function chunkText(text: string): Chunk[] {
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];

  const paras = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let cur = "";

  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };

  for (const p of paras) {
    // A single very long paragraph: hard-split it.
    if (p.length > MAX_CHARS) {
      flush();
      for (let i = 0; i < p.length; i += MAX_CHARS - OVERLAP_CHARS) {
        chunks.push(p.slice(i, i + MAX_CHARS).trim());
      }
      continue;
    }
    if (cur.length + p.length + 2 > MAX_CHARS) {
      flush();
      // carry overlap from the tail of the previous chunk
      const prev = chunks[chunks.length - 1] || "";
      cur = prev.slice(-OVERLAP_CHARS) + "\n\n" + p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  flush();

  return chunks
    .map((c) => c.trim())
    .filter((c) => c.length > 40) // drop tiny fragments
    .map((content, index) => ({ content, index }));
}
