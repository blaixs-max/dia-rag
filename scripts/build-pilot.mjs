// Build the A/B pilot set: pick videos that have BOTH transcript + visual,
// diverse by topic, and dump raw text to data/pilot/<id>.json.
// Source is the LOCAL data/pages.jsonl (no DB / no re-download needed).
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), ".."));
const PAGES = path.join(ROOT, "data", "pages.jsonl");
const OUTDIR = path.join(ROOT, "data", "pilot");
fs.mkdirSync(OUTDIR, { recursive: true });

const vidId = (url) => (url.match(/v=([\w-]{11})/) || [])[1];

const byId = new Map(); // id -> {id,title,transcript,visual}
for (const line of fs.readFileSync(PAGES, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.category !== "video-transcript" && o.category !== "video-visual") continue;
  const id = vidId(o.url || "");
  if (!id) continue;
  const rec = byId.get(id) || { id, title: o.title, transcript: "", visual: "" };
  if (o.category === "video-transcript") rec.transcript += (o.text || "") + "\n";
  else rec.visual += (o.text || "") + "\n";
  if (o.title && o.title.length > rec.title.length) rec.title = o.title;
  byId.set(id, rec);
}

// Keep only videos with BOTH signals and a real (non-promo) transcript.
const both = [...byId.values()].filter(
  (v) => v.transcript.trim().length > 600 && v.visual.trim().length > 200
);

// Diversify by topic: bucket by the first matching keyword, take round-robin.
const TOPICS = [
  "fatura", "sipariş", "irsaliye", "stok", "cari", "üretim", "muhasebe",
  "e-fatura", "kasa", "banka", "teklif", "maliyet", "satın alma", "servis",
  "depo", "rapor", "çek", "senet", "e-arşiv", "kur",
];
const topicOf = (t) => {
  const low = t.toLocaleLowerCase("tr");
  for (const k of TOPICS) if (low.includes(k)) return k;
  return "diğer";
};

const buckets = new Map();
for (const v of both) {
  const t = topicOf(v.title);
  if (!buckets.has(t)) buckets.set(t, []);
  buckets.get(t).push(v);
}
// Round-robin across topic buckets for diversity.
const picked = [];
const order = [...buckets.keys()].filter((k) => k !== "diğer");
let i = 0;
while (picked.length < 15 && order.length) {
  const k = order[i % order.length];
  const arr = buckets.get(k);
  if (arr && arr.length) picked.push(arr.shift());
  else { order.splice(i % order.length, 1); continue; }
  i++;
}

for (const v of picked) {
  const url = `https://www.youtube.com/watch?v=${v.id}`;
  fs.writeFileSync(
    path.join(OUTDIR, `${v.id}.json`),
    JSON.stringify({ id: v.id, url, title: v.title, transcript: v.transcript.trim(), visual: v.visual.trim() }, null, 2)
  );
}

console.log(`Havuz: ${both.length} video (her ikisi de var). Seçilen: ${picked.length}`);
for (const v of picked) console.log(`  ${v.id}  [${topicOf(v.title)}]  ${v.title.slice(0, 60)}  (tr:${v.transcript.length} vs:${v.visual.length})`);
fs.writeFileSync(path.join(OUTDIR, "_selected.json"), JSON.stringify(picked.map((v) => v.id), null, 2));
