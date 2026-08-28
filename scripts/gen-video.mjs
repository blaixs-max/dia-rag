// Generate DİA training-video RAG records via Gemini directly from the YouTube URL.
//   node gen-video.mjs transcript <id> [<id> ...]
//   node gen-video.mjs visual <id> [<id> ...]
// Appends JSONL rows {url,title,category,text} to data/gen-<mode>.jsonl.
// Titles are looked up from data/channel-videos.json (falls back to id).
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";

// This machine has broken IPv6 to googleapis.com (UND_ERR_CONNECT_TIMEOUT); force IPv4.
dns.setDefaultResultOrder("ipv4first");

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), ".."));
function loadEnv() {
  const f = path.join(ROOT, ".env.local");
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
if (!KEY) throw new Error("GEMINI_API_KEY missing");

// Two invocation forms:
//   node gen-video.mjs <transcript|visual> <id> [<id> ...]
//   node gen-video.mjs shard <transcript|visual> <shardIndex> <shardCount>
//     -> reads data/missing.json[mode], picks ids where (i % shardCount === shardIndex),
//        writes to data/gen-<mode>-<shardIndex>.jsonl
let mode, ids;
if (process.argv[2] === "shard") {
  mode = process.argv[3];
  const shardIndex = parseInt(process.argv[4], 10);
  const shardCount = parseInt(process.argv[5], 10);
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "missing.json"), "utf8"))[mode] || [];
  ids = all.filter((_, i) => i % shardCount === shardIndex);
  process.env.OUT_FILE = process.env.OUT_FILE || path.join(ROOT, "data", `gen-${mode}-${shardIndex}.jsonl`);
  console.log(`[shard ${shardIndex}/${shardCount}] ${mode}: ${ids.length} ids`);
} else {
  mode = process.argv[2];
  ids = process.argv.slice(3);
}
if (!["transcript", "visual"].includes(mode) || ids.length === 0) {
  console.error("usage: node gen-video.mjs <transcript|visual> <id>... | shard <mode> <idx> <count>");
  process.exit(1);
}

const titleMap = new Map();
try {
  const arr = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "channel-videos.json"), "utf8"));
  for (const v of arr) titleMap.set(v.id, v.title);
} catch {}

const TRANSCRIPT_PROMPT =
  "Bu bir DİA ERP eğitim videosudur. Videonun SESLİ anlatımını (konuşmayı) baştan sona, " +
  "eksiksiz ve akıcı Türkçe ile yazıya dök. Konuşma dışındaki sesleri/efektleri yazma. " +
  "Sadece transkript metnini ver, başka açıklama ekleme.";
const VISUAL_PROMPT =
  "Bu bir DİA ERP eğitim videosudur. Ekranda YAPILAN işlemleri adım adım Türkçe anlat: " +
  "hangi menüye girildi, hangi butona tıklandı, hangi alanlar dolduruldu, hangi ekranlar açıldı. " +
  "Menü > buton > alan isimlerini birebir yaz. Numaralı adımlar halinde, net ve pratik ver.";

async function gen(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const isVisual = mode === "visual";
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: { fileUri: url },
            // Long webinars exceed the ~10800-frame cap at default 1fps; sample sparsely.
            // DİA UI changes slowly, so 0.2fps (1 frame/5s) captures menu/button steps and
            // handles multi-hour videos. (fps 0.5 is rejected as invalid by the API; 0.2 works.)
            ...(isVisual ? { videoMetadata: { fps: 0.2 } } : {}),
          },
          { text: isVisual ? VISUAL_PROMPT : TRANSCRIPT_PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8192,
      ...(isVisual ? { mediaResolution: "MEDIA_RESOLUTION_LOW" } : {}),
    },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let res, lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
    } catch (e) {
      lastErr = `fetch ${e.message}`;
      await sleep(Math.min(2000 * 2 ** attempt, 20000));
      continue;
    }
    if (res.ok) break;
    if (res.status === 429 || res.status >= 500) {
      lastErr = `HTTP ${res.status}`;
      await sleep(Math.min(2000 * 2 ** attempt, 20000));
      continue;
    }
    const t = await res.text();
    return { id, ok: false, error: `HTTP ${res.status}: ${t.slice(0, 300)}` };
  }
  if (!res || !res.ok) return { id, ok: false, error: `retries exhausted (${lastErr})` };
  const j = await res.json();
  const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  const finish = j?.candidates?.[0]?.finishReason;
  if (!text) return { id, ok: false, error: `empty (finishReason=${finish}) ${JSON.stringify(j).slice(0, 200)}` };
  return {
    id,
    ok: true,
    finish,
    len: text.length,
    row: {
      url: isVisual ? `${url}#visual` : url,
      title: titleMap.get(id) || id,
      category: isVisual ? "video-visual" : "video-transcript",
      text,
    },
  };
}

// Skip near-empty / "no meaningful speech" results (promo/event clips).
function isJunk(text) {
  if (text.length < 120) return true;
  return /anlamlı (bir )?konuşma.*bulunma|konuşma veya sesli anlatım bulunma/i.test(text);
}

const OUT = process.env.OUT_FILE || path.join(ROOT, "data", `gen-${mode}.jsonl`);
let okN = 0, junkN = 0, failN = 0;
for (const id of ids) {
  try {
    const r = await gen(id);
    if (r.ok && mode === "transcript" && isJunk(r.row.text)) {
      junkN++;
      console.log(`~ ${id} [${mode}] skipped (junk/empty, ${r.len} chars)`);
      continue;
    }
    if (r.ok) {
      fs.appendFileSync(OUT, JSON.stringify(r.row) + "\n");
      okN++;
      console.log(`✓ ${id} [${mode}] ${r.len} chars (finish=${r.finish})`);
    } else {
      failN++;
      console.log(`✗ ${id} [${mode}] ${r.error}`);
    }
  } catch (e) {
    failN++;
    console.log(`✗ ${id} [${mode}] EXC ${e.message}`);
  }
}
console.log(`[done ${mode}] ok=${okN} junk=${junkN} fail=${failN} -> ${OUT}`);
