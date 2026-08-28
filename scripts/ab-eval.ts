/**
 * A/B eval: current chunking (A) vs improved contextual chunking (B) — same 15 pilot
 * videos, isolated so the ONLY variable is chunk structure.
 *   A = data/pages.jsonl records (transcript+visual) chunked via the production chunkText
 *   B = data/pilot/<id>.chunks.jsonl (contextual, merged, value-filtered)
 * For each test question: embed, retrieve top-K within each arm, answer with Gemini,
 * save side-by-side to data/pilot/ab-results.json.
 *
 * Run: NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/ab-eval.ts
 */
import "./_env";
import * as fs from "node:fs";
import * as path from "node:path";
import { chunkText } from "../src/lib/chunk";
import { embedDocuments, embedQuery } from "../src/lib/embeddings";
import { generateText, type ChatMessage } from "../src/lib/generate";

const ROOT = process.cwd();
const PILOT = path.join(ROOT, "data", "pilot");
const PAGES = path.join(ROOT, "data", "pages.jsonl");
const K = 8;

const SYSTEM = `Sen DİA ERP yazılımı için bir yardım asistanısın. SADECE sana verilen bağlamdaki bilgiye dayan; bağlamda yoksa "dökümanlarda bulamadım" de, uydurma. İşlemleri numaralı, adım adım, tıklanacak yerleri belirterek Türkçe anlat. Kısa ve pratik ol.`;

const QUESTIONS = [
  "Cari kart için etiket ve adres tasarımı nasıl yapılır, nasıl bastırılır?",
  "Cari kart etiket tasarımına barkod veya QR kod nasıl eklenir?",
  "Sipariş ve teklif tasarımı DİA'da nasıl hazırlanır?",
  "Rapor tasarımında formül alanı nasıl eklenir ve maliyet formülü nasıl yazılır?",
  "Döviz kurlarını DİA'ya nasıl eklerim?",
  "Döviz kurlarını internetten toplu olarak nasıl çekerim?",
  "Firma, şube ve depo tanımlaması nasıl yapılır?",
  "Yeni açtığım şube veya depo neden görünmüyor, kullanıcı yetkilendirmesi nasıl yapılır?",
  "Yerli üretim logolu ürün etiketi tasarımı nasıl yapılır?",
  "Stok raf yeri takibi DİA'da nasıl yapılır?",
  "Serili ürünlerin hızlı fatura girişi nasıl yapılır?",
  "Fatura girişinde toplu seri üretimi nasıl yapılır?",
  "E-Banka POS ile tahsilat ve ödeme işlemi nasıl yapılır?",
  "Kasa kartı nasıl tanımlanır ve kasa hareketleri nasıl takip edilir?",
  "Çek ve senet işlemleri DİA'da nasıl yapılır?",
  "Çekin durumunu (tahsil, ciro, teminat) nasıl değiştiririm?",
  "Enflasyon muhasebesi DİA'da nasıl hesaplanır?",
  "E-İrsaliye nasıl iptal edilir?",
  "DİA Mobil ile e-arşiv fatura nasıl gönderilir?",
  "Servis Hizmet Yönetimi modülü ne işe yarar ve nasıl kullanılır?",
];

const vidId = (url: string) => (url.match(/v=([\w-]{11})/) || [])[1];
type Chunk = { id: string; text: string };

function loadSelected(): string[] {
  return JSON.parse(fs.readFileSync(path.join(PILOT, "_selected.json"), "utf8"));
}

// Arm A: reproduce production chunks for the pilot videos from pages.jsonl.
function buildA(ids: Set<string>): Chunk[] {
  const out: Chunk[] = [];
  for (const line of fs.readFileSync(PAGES, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.category !== "video-transcript" && o.category !== "video-visual") continue;
    const id = vidId(o.url || "");
    if (!id || !ids.has(id)) continue;
    for (const c of chunkText(`${o.title}\n\n${o.text}`)) out.push({ id, text: c.content });
  }
  return out;
}

// Arm C: paraphrase-free context header — arm A body VERBATIM, only a header line
// prepended so every chunk (not just the first) carries its video/source context.
function buildC(ids: Set<string>): Chunk[] {
  const out: Chunk[] = [];
  for (const line of fs.readFileSync(PAGES, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.category !== "video-transcript" && o.category !== "video-visual") continue;
    const id = vidId(o.url || "");
    if (!id || !ids.has(id)) continue;
    const header = `[Video: ${o.title} | Kaynak: DİA eğitim videosu]`;
    for (const c of chunkText(`${o.title}\n\n${o.text}`)) out.push({ id, text: `${header}\n${c.content}` });
  }
  return out;
}

// Arm B: improved contextual chunks produced by the agents.
function buildB(ids: string[]): Chunk[] {
  const out: Chunk[] = [];
  for (const id of ids) {
    const f = path.join(PILOT, `${id}.chunks.jsonl`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.text) out.push({ id, text: o.text }); } catch {}
    }
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // embeddings are L2-normalized upstream
}

async function embedAll(chunks: Chunk[]): Promise<number[][]> {
  const vecs: number[][] = [];
  const B = 64;
  for (let i = 0; i < chunks.length; i += B) {
    const part = await embedDocuments(chunks.slice(i, i + B).map((c) => c.text));
    vecs.push(...part);
  }
  return vecs;
}

function topK(qv: number[], chunks: Chunk[], vecs: number[][]) {
  return chunks
    .map((c, i) => ({ c, score: cosine(qv, vecs[i]) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, K);
}

// Direct Gemini call with thinking DISABLED (thinkingBudget:0) and a generous
// output budget — the earlier harness used gemini "thinking" which leaked
// reasoning into the answer and/or exhausted the token budget (empty answers).
const GKEY = process.env.GEMINI_API_KEY!;
const GMODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
async function answer(context: string, question: string): Promise<string> {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Bağlam (DİA dökümanları):\n\n${context}\n\n---\n\nKullanıcının sorusu: ${question}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent?key=${GKEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) return `[HATA ${res.status}: ${(await res.text()).slice(0, 120)}]`;
  const j: any = await res.json();
  const text = (j?.candidates?.[0]?.content?.parts || [])
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text || "")
    .join("")
    .trim();
  return text || `[BOŞ finishReason=${j?.candidates?.[0]?.finishReason}]`;
}

async function main() {
  const ids = loadSelected();
  const idSet = new Set(ids);
  const A = buildA(idSet);
  const B = buildB(ids);
  const C = buildC(idSet);
  console.log(`A (mevcut) chunk: ${A.length} | B (parafraz) chunk: ${B.length} | C (başlık) chunk: ${C.length}`);
  if (B.length === 0) throw new Error("B chunk yok — önce improve workflow'u bitmeli.");

  console.log("Embedding A...");
  const vA = await embedAll(A);
  console.log("Embedding B...");
  const vB = await embedAll(B);
  console.log("Embedding C...");
  const vC = await embedAll(C);

  const results: any[] = [];
  for (const q of QUESTIONS) {
    const qv = await embedQuery(q);
    const tA = topK(qv, A, vA);
    const tB = topK(qv, B, vB);
    const tC = topK(qv, C, vC);
    const [ansA, ansB, ansC] = await Promise.all([
      answer(tA.map((x) => x.c.text).join("\n\n---\n\n"), q),
      answer(tB.map((x) => x.c.text).join("\n\n---\n\n"), q),
      answer(tC.map((x) => x.c.text).join("\n\n---\n\n"), q),
    ]);
    results.push({
      question: q,
      answerA: ansA,
      answerB: ansB,
      answerC: ansC,
      retrA: tA.map((x) => ({ id: x.c.id, score: +x.score.toFixed(3) })),
      retrB: tB.map((x) => ({ id: x.c.id, score: +x.score.toFixed(3) })),
      retrC: tC.map((x) => ({ id: x.c.id, score: +x.score.toFixed(3) })),
    });
    console.log(`✓ soru işlendi: ${q.slice(0, 50)}…`);
  }

  fs.writeFileSync(path.join(PILOT, "ab-results.json"), JSON.stringify({ counts: { A: A.length, B: B.length, C: C.length }, results }, null, 2));
  console.log(`\n✓ Sonuçlar yazıldı: data/pilot/ab-results.json (${results.length} soru)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
