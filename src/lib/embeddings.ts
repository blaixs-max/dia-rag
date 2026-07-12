/**
 * Provider-agnostic embeddings.
 * Controlled by EMBEDDING_PROVIDER = "voyage" | "gemini" | "openai".
 * All providers are configured to output EMBEDDING_DIM (default 1024) dims
 * so the Supabase vector column stays fixed regardless of provider.
 */

const PROVIDER = (process.env.EMBEDDING_PROVIDER || "voyage").toLowerCase();
export const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || "1024", 10);

type InputType = "document" | "query";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST with retry/backoff on rate-limit (429) and transient 5xx. */
async function postWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  tries = 5
): Promise<Response> {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(2000 * 2 ** i, 30000);
      if (i < tries - 1) {
        await sleep(wait);
        continue;
      }
    }
    throw new Error(`${label} ${res.status}: ${await res.text()}`);
  }
  throw new Error(`${label}: retries exhausted`);
}

function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

async function embedVoyage(texts: string[], inputType: InputType): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set");
  const model = process.env.VOYAGE_EMBED_MODEL || "voyage-3.5";
  const res = await postWithRetry(
    "https://api.voyageai.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model,
        input_type: inputType,
        output_dimension: EMBEDDING_DIM,
      }),
    },
    "Voyage embeddings"
  );
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const model = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-large";
  const res = await postWithRetry(
    "https://api.openai.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: texts, model, dimensions: EMBEDDING_DIM }),
    },
    "OpenAI embeddings"
  );
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

async function embedGemini(texts: string[], inputType: InputType): Promise<number[][]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
  const taskType = inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const res = await postWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: `models/${model}`,
          content: { parts: [{ text: t }] },
          taskType,
          outputDimensionality: EMBEDDING_DIM,
        })),
      }),
    },
    "Gemini embeddings"
  );
  const json = (await res.json()) as { embeddings: { values: number[] }[] };
  // Gemini reduced-dim outputs are not normalized; normalize for cosine search.
  return json.embeddings.map((e) => l2normalize(e.values));
}

async function embed(texts: string[], inputType: InputType): Promise<number[][]> {
  if (texts.length === 0) return [];
  switch (PROVIDER) {
    case "voyage":
      return embedVoyage(texts, inputType);
    case "gemini":
      return embedGemini(texts, inputType);
    case "openai":
      return embedOpenAI(texts);
    default:
      throw new Error(`Unknown EMBEDDING_PROVIDER: ${PROVIDER}`);
  }
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return embed(texts, "document");
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embed([text], "query");
  return v;
}
