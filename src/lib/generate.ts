/**
 * Provider-agnostic generation with optional image (vision) input.
 * LLM_PROVIDER = "anthropic" (default) | "gemini".
 */

const PROVIDER = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();

export type ImagePart = { mimeType: string; data: string }; // data = base64 (no prefix)
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  images?: ImagePart[];
};

/** Streaming generation — yields text deltas. */
export async function* generateStream(
  system: string,
  messages: ChatMessage[]
): AsyncGenerator<string> {
  if (PROVIDER === "gemini") yield* geminiStream(system, messages);
  else yield* anthropicStream(system, messages);
}

/** Non-streaming generation — returns the full text (used for vision→query). */
export async function generateText(
  system: string,
  messages: ChatMessage[],
  maxTokens = 600
): Promise<string> {
  let out = "";
  for await (const t of PROVIDER === "gemini"
    ? geminiStream(system, messages, maxTokens)
    : anthropicStream(system, messages, maxTokens))
    out += t;
  return out;
}

// ---------------- Anthropic ----------------
async function* anthropicStream(
  system: string,
  messages: ChatMessage[],
  maxTokens = 4096
) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey: key });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    messages: messages.map((m) => {
      if (!m.images || m.images.length === 0) {
        return { role: m.role, content: m.content };
      }
      return {
        role: m.role,
        content: [
          ...m.images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mimeType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: img.data,
            },
          })),
          { type: "text" as const, text: m.content },
        ],
      };
    }),
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}

// ---------------- Gemini ----------------
async function* geminiStream(
  system: string,
  messages: ChatMessage[],
  maxTokens = 4096
) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";

  const contents = messages.map((m) => {
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    for (const img of m.images || []) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
    parts.push({ text: m.content });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
      }),
    }
  );
  if (!res.ok || !res.body) {
    throw new Error(`Gemini generate ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const text = json?.candidates?.[0]?.content?.parts
          ?.map((p: { text?: string }) => p.text || "")
          .join("");
        if (text) yield text;
      } catch {
        /* ignore partial JSON lines */
      }
    }
  }
}
