/**
 * Reranking of retrieved candidates before they reach the LLM.
 *
 * Order of preference:
 *   1. Voyage rerank-2.5      (cross-encoder, best quality) — if VOYAGE_API_KEY set
 *   2. Gemini listwise rerank (uses the existing billed Gemini key) — if GEMINI_API_KEY set
 *   3. Identity order         (fall back to raw vector-similarity order)
 *
 * The reranker's job: from the (large) candidate pool, pick the `topK` chunks
 * that ACTUALLY answer the query — not just the ones that look topically similar.
 */

export type Rerankable = { content: string };

export function rerankAvailable(): boolean {
  return !!process.env.VOYAGE_API_KEY || !!process.env.GEMINI_API_KEY;
}

/**
 * Returns the indices of `documents` ordered by relevance to `query`,
 * truncated to topK. Falls back to identity order if reranking is unavailable.
 */
export async function rerank(
  query: string,
  documents: string[],
  topK: number
): Promise<{ index: number; score: number }[]> {
  if (documents.length === 0) return [];
  try {
    if (process.env.VOYAGE_API_KEY) return await rerankVoyage(query, documents, topK);
    if (process.env.GEMINI_API_KEY) return await rerankGemini(query, documents, topK);
  } catch (e) {
    // Rerank is best-effort; on any failure keep the incoming (vector) order.
    console.warn(`rerank failed, using vector order: ${(e as Error).message}`);
  }
  return identity(documents, topK);
}

/** Fall back to the incoming vector-similarity order, truncated to topK. */
function identity(documents: string[], topK: number) {
  return documents.slice(0, topK).map((_, i) => ({ index: i, score: 0 }));
}

/**
 * Ensure min(topK, N) chunks are returned: keep the reranker's ordering first,
 * then top up with any not-yet-included candidates in their original
 * (vector-similarity) order. Preserves recall if the reranker returns fewer
 * items than topK.
 */
function fillToTopK(
  ordered: { index: number; score: number }[],
  total: number,
  topK: number
): { index: number; score: number }[] {
  const seen = new Set(ordered.map((o) => o.index));
  const out = [...ordered];
  for (let i = 0; i < total && out.length < topK; i++) {
    if (!seen.has(i)) {
      out.push({ index: i, score: 0 });
      seen.add(i);
    }
  }
  return out.slice(0, topK);
}

// ---------------- Voyage (cross-encoder) ----------------
async function rerankVoyage(query: string, documents: string[], topK: number) {
  const key = process.env.VOYAGE_API_KEY!;
  const model = process.env.VOYAGE_RERANK_MODEL || "rerank-2.5";
  const res = await fetch("https://api.voyageai.com/v1/rerank", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, documents, model, top_k: topK }),
  });
  if (!res.ok) {
    console.warn(`Voyage rerank ${res.status}: ${await res.text()}`);
    return identity(documents, topK);
  }
  const json = (await res.json()) as {
    data: { index: number; relevance_score: number }[];
  };
  const ordered = json.data.map((d) => ({ index: d.index, score: d.relevance_score }));
  return fillToTopK(ordered, documents.length, topK);
}

// ---------------- Gemini (listwise LLM rerank) ----------------
async function rerankGemini(query: string, documents: string[], topK: number) {
  const key = process.env.GEMINI_API_KEY!;
  const model =
    process.env.GEMINI_RERANK_MODEL || process.env.GEMINI_MODEL || "gemini-flash-latest";

  // Number each candidate and cap its length so the whole set stays cheap.
  const numbered = documents
    .map((d, i) => `[${i}] ${d.replace(/\s+/g, " ").slice(0, 700)}`)
    .join("\n");
  const prompt =
    `Kullanıcının sorusu: "${query}"\n\n` +
    `Aşağıda numaralı DİA döküman parçaları var. Bu soruyu yanıtlamak için ` +
    `en yararlı olan parçaları EN alakalıdan aza doğru sırala. ` +
    `Sadece bir JSON tamsayı dizisi döndür (parça numaraları), en fazla ${topK} eleman. ` +
    `Örnek: [4,0,11,2]. Başka hiçbir açıklama yazma.\n\n` +
    `Parçalar:\n${numbered}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 200,
          responseMimeType: "application/json",
        },
      }),
    }
  );
  if (!res.ok) {
    console.warn(`Gemini rerank ${res.status}: ${await res.text()}`);
    return identity(documents, topK);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text =
    json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\[[\d,\s]*\]/);
    parsed = m ? JSON.parse(m[0]) : [];
  }
  const raw = Array.isArray(parsed) ? parsed : [];

  const seen = new Set<number>();
  const ordered: { index: number; score: number }[] = [];
  for (const v of raw) {
    const i = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isInteger(i) && i >= 0 && i < documents.length && !seen.has(i)) {
      seen.add(i);
      ordered.push({ index: i, score: 1 - ordered.length / Math.max(topK, 1) });
      if (ordered.length >= topK) break;
    }
  }
  if (ordered.length === 0) return identity(documents, topK);
  return fillToTopK(ordered, documents.length, topK);
}
