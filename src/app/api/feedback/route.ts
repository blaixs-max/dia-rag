import { NextRequest } from "next/server";
import { getAdminClient } from "@/lib/supabase";
import { learnSolution } from "@/lib/learn";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { conversationId, helpful, correction } = (await req.json()) as {
      conversationId: string;
      helpful: boolean;
      correction?: string;
    };
    if (!conversationId) {
      return new Response("conversationId required", { status: 400 });
    }

    const supabase = getAdminClient();

    // Load the conversation we're giving feedback on.
    const { data: conv, error: cErr } = await supabase
      .schema("dia_rag")
      .from("conversations")
      .select("id, question, screen, answer")
      .eq("id", conversationId)
      .single();
    if (cErr || !conv) {
      return new Response("conversation not found", { status: 404 });
    }

    // Decide what (if anything) to learn.
    let learned = false;
    try {
      if (helpful && conv.answer) {
        await learnSolution({
          conversationId: conv.id,
          question: conv.question || "",
          screen: conv.screen,
          solution: conv.answer,
          kind: "confirmed",
        });
        learned = true;
      } else if (!helpful && correction && correction.trim()) {
        await learnSolution({
          conversationId: conv.id,
          question: conv.question || "",
          screen: conv.screen,
          solution: correction.trim(),
          kind: "correction",
        });
        learned = true;
      }
    } catch (e) {
      // Learning is best-effort; still record the feedback.
      console.warn("learn failed:", (e as Error).message);
    }

    const { error: fErr } = await supabase
      .schema("dia_rag")
      .from("feedback")
      .insert({
        conversation_id: conversationId,
        helpful,
        correction: correction?.trim() || null,
        learned,
      });
    if (fErr) return new Response(`feedback error: ${fErr.message}`, { status: 500 });

    return Response.json({ ok: true, learned });
  } catch (e) {
    return new Response(`error: ${(e as Error).message}`, { status: 500 });
  }
}
