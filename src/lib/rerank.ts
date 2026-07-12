/**
 * Optional reranking via Voyage rerank-2.5.
 * If VOYAGE_API_KEY is absent, callers should fall back to vector similarity order.
 */

export type Rerankable = { content: string };

export function rerankAvailable(): boolean {
  return !!process.env.VOYAGE_API_KEY;
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
  if (!rerankAvailable() || documents.length === 0) {
    return documents.slice(0, topK).map((_, i) => ({ index: i, score: 0 }));
  }
  const key = process.env.VOYAGE_API_KEY!;
  const model = process.env.VOYAGE_RERANK_MODEL || "rerank-2.5";
  const res = await fetch("https://api.voyageai.com/v1/rerank", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, documents, model, top_k: topK }),
  });
  if (!res.ok) {
    // Rerank is best-effort; on failure keep the incoming order.
    console.warn(`Voyage rerank ${res.status}: ${await res.text()}`);
    return documents.slice(0, topK).map((_, i) => ({ index: i, score: 0 }));
  }
  const json = (await res.json()) as {
    data: { index: number; relevance_score: number }[];
  };
  return json.data.map((d) => ({ index: d.index, score: d.relevance_score }));
}
