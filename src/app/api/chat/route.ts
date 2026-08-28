import { NextRequest } from "next/server";
import { embedQuery } from "@/lib/embeddings";
import { rerank } from "@/lib/rerank";
import { generateStream, type ChatMessage, type ImagePart } from "@/lib/generate";
import { analyzeScreenshot } from "@/lib/vision";
import { getAdminClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const MATCH_COUNT = 100;
const RERANK_TOP = 14;

type MatchRow = {
  id: number;
  url: string;
  title: string;
  category: string;
  content: string;
  similarity: number;
};

type Source = { n: number; url: string; title: string; category: string };

const SYSTEM = `Sen DİA ERP yazılımı için bir yardım asistanısın. Kullanıcılar DİA ekran görüntüsü atıp yardım isteyebilir. Görevin, DİA dökümanlarına dayanarak Türkçe, net ve ADIM ADIM yönlendirme yapmak.

Kurallar:
- Ekran görüntüsü varsa, kullanıcının ekranında gördüğün öğelere (menü, buton, alan adları) atıfla konuş.
- SADECE aşağıdaki bağlamdaki bilgiye dayan. Bağlamda yoksa "Bu konuda dökümanlarda kesin bilgi bulamadım, ama genel olarak…" diyerek dikkatli ol; uydurma.
- İşlemleri numaralı liste halinde, tıklanacak yerleri belirterek anlat.
- Kaynak numaralarını [1], [2] şeklinde ver.
- Kısa, pratik ve nazik ol.`;

function parseDataUrl(dataUrl: string): ImagePart | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

function buildContext(rows: MatchRow[]) {
  const sources: Source[] = [];
  const byKey = new Map<string, number>();
  const parts: string[] = [];
  for (const r of rows) {
    const key = r.url || `t:${r.title}`;
    let n = byKey.get(key);
    if (!n) {
      n = sources.length + 1;
      byKey.set(key, n);
      const url = /^https?:\/\//.test(r.url) ? r.url : "";
      sources.push({ n, url, title: r.title, category: r.category });
    }
    parts.push(`[${n}] ${r.title}\n${r.content}`);
  }
  return { context: parts.join("\n\n---\n\n"), sources };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      messages: ChatMessage[];
      image?: string;
      sessionId?: string;
    };
    const { messages, image, sessionId } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response("messages required", { status: 400 });
    }
    const userText =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    const images: ImagePart[] = [];
    if (image) {
      const p = parseDataUrl(image);
      if (p) images.push(p);
    }
    if (!userText && images.length === 0) {
      return new Response("empty message", { status: 400 });
    }

    // 1) If there's a screenshot, analyze it to get a good search query + screen.
    let searchQuery = userText;
    let screen: string | null = null;
    if (images.length > 0) {
      try {
        const a = await analyzeScreenshot(images, userText);
        searchQuery = a.searchQuery || userText || "DİA genel kullanım";
        screen = a.screen || null;
      } catch {
        searchQuery = userText || "DİA genel kullanım yardım";
      }
    }

    // 2) Embed + vector search + rerank
    const qvec = await embedQuery(searchQuery);
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .schema("dia_rag")
      .rpc("match_documents", { query_embedding: qvec, match_count: MATCH_COUNT });
    if (error) return new Response(`retrieval error: ${error.message}`, { status: 500 });
    const rows = (data || []) as MatchRow[];

    let top = rows;
    if (rows.length > 0) {
      const ranked = await rerank(searchQuery, rows.map((r) => r.content), RERANK_TOP);
      top = ranked.map((r) => rows[r.index]).filter(Boolean);
    }
    const { context, sources } = buildContext(top);

    // 3) Build the augmented prompt (history + context + screenshot)
    const history = messages.slice(-6);
    const userTurn: ChatMessage = {
      role: "user",
      content:
        (screen ? `Kullanıcının ekranı: ${screen}\n\n` : "") +
        (context
          ? `Bağlam (DİA dökümanları):\n\n${context}\n\n---\n\n`
          : "İlgili döküman bulunamadı.\n\n") +
        `Kullanıcının mesajı: ${userText || "(sadece ekran görüntüsü gönderildi)"}`,
      images,
    };
    const augmented: ChatMessage[] = [...history.slice(0, -1), userTurn];

    // 4) Create the conversation row up front so we can return its id.
    let conversationId = "";
    const { data: conv } = await supabase
      .schema("dia_rag")
      .from("conversations")
      .insert({
        session_id: sessionId || null,
        question: userText || null,
        has_image: images.length > 0,
        screen,
        answer: "",
        sources,
      })
      .select("id")
      .single();
    conversationId = conv?.id || "";

    // 5) Stream the answer; persist it when done.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let answer = "";
        try {
          for await (const delta of generateStream(SYSTEM, augmented)) {
            answer += delta;
            controller.enqueue(encoder.encode(delta));
          }
        } catch (e) {
          const msg = `\n\n[Hata: ${(e as Error).message}]`;
          answer += msg;
          controller.enqueue(encoder.encode(msg));
        } finally {
          controller.close();
          if (conversationId) {
            await supabase
              .schema("dia_rag")
              .from("conversations")
              .update({ answer })
              .eq("id", conversationId);
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "x-sources": Buffer.from(JSON.stringify(sources)).toString("base64"),
        "x-conversation-id": conversationId,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response(`error: ${(e as Error).message}`, { status: 500 });
  }
}
