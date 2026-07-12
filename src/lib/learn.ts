/**
 * Learning loop: fold a confirmed/corrected solution back into the corpus.
 * Stored in dia_rag.documents with category='learned' so the same
 * match_documents() retrieval surfaces it for similar future questions.
 */
import { embedDocuments } from "./embeddings";
import { getAdminClient } from "./supabase";

type LearnInput = {
  conversationId: string;
  question: string;
  screen?: string | null;
  // The verified solution text: either the confirmed answer or the user's correction.
  solution: string;
  kind: "confirmed" | "correction";
};

export async function learnSolution(input: LearnInput): Promise<void> {
  const { conversationId, question, screen, solution, kind } = input;
  const title = question?.trim()
    ? question.trim().slice(0, 200)
    : "Öğrenilmiş çözüm";

  // Compose a self-contained doc: the question/context + the verified answer.
  const content = [
    `Soru: ${question || "(ekran görüntüsünden)"}`,
    screen ? `Ekran: ${screen}` : "",
    kind === "correction"
      ? `Doğru çözüm (kullanıcı düzeltmesi): ${solution}`
      : `Doğrulanmış çözüm: ${solution}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const [embedding] = await embedDocuments([content]);
  const supabase = getAdminClient();

  const { error } = await supabase
    .schema("dia_rag")
    .from("documents")
    .upsert(
      {
        url: `learned://${conversationId}`,
        title,
        category: "learned",
        chunk_index: 0,
        content,
        embedding,
      },
      { onConflict: "url,chunk_index" }
    );
  if (error) throw new Error(`learnSolution: ${error.message}`);
}
