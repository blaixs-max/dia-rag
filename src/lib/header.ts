/**
 * Paraphrase-free contextual header for RAG chunks.
 *
 * Every chunk gets a small header line prepended so chunks past #0 still carry
 * their source/screen context (validated to improve retrieval without touching
 * the body — A/B golden score C 8.65 vs current 8.30, zero regressions).
 *
 * The body is NEVER modified — only a header line is prepended. Fully idempotent.
 */

// Matches ONLY our own header lines: "[Video: ...]\n" or "[Kaynak: ...]\n".
// Deliberately specific so it never mistakes body tags like "[Müzik]" / "[Alkış]"
// (which appear in transcripts) for a header.
export const HEADER_RE = /^\[(?:Video|Kaynak):[^\n]*\]\n/;

export function contextualHeader(category: string, title: string | null): string {
  const t = (title && title.trim()) || "DİA";
  if (category === "video-transcript" || category === "video-visual") {
    return `[Video: ${t} | Kaynak: DİA eğitim videosu]`;
  }
  return `[Kaynak: ${t}]`;
}

export function hasHeader(content: string): boolean {
  return HEADER_RE.test(content);
}

/** Prepend the header to `body`; strips any pre-existing header first (idempotent). */
export function withHeader(category: string, title: string | null, body: string): string {
  const stripped = body.replace(HEADER_RE, "");
  return `${contextualHeader(category, title)}\n${stripped}`;
}
