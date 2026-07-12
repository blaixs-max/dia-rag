/**
 * Download DİA PDF manuals, extract text, append to data/pages.jsonl.
 * Then `npm run ingest` chunks + embeds them like any other page.
 *
 * Usage: npm run ingest:pdf            (append to pages.jsonl)
 *        npm run ingest:pdf -- --dry   (extract + report, no write)
 */
import "./_env";
import * as fs from "node:fs";
import * as path from "node:path";
import { PDFParse } from "pdf-parse";

const OUT_DIR = path.join(process.cwd(), "data");
const OUT_FILE = path.join(OUT_DIR, "pages.jsonl");
const UA = process.env.CRAWL_USER_AGENT || "DiaRagBot/1.0 (+personal reference assistant)";
const DRY = process.argv.includes("--dry");

// Comprehensive DİA manuals discovered via research.
const PDFS: { url: string; title: string; category: string }[] = [
  {
    url: "https://dia.ist/wp-content/uploads/2019/03/Dia-Kullan%C4%B1m-Klavuzu.pdf",
    title: "DİA Kullanım Kılavuzu (Komple Set)",
    category: "manual-pdf",
  },
];

function loadDoneSet(): Set<string> {
  if (!fs.existsSync(OUT_FILE)) return new Set();
  const done = new Set<string>();
  for (const line of fs.readFileSync(OUT_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).url); } catch { /* ignore */ }
  }
  return done;
}

async function extractPdf(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  return (result.text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const done = loadDoneSet();
  const out = DRY ? null : fs.createWriteStream(OUT_FILE, { flags: "a" });
  let written = 0;

  for (const pdf of PDFS) {
    if (done.has(pdf.url)) {
      console.log(`  skip (already have): ${pdf.title}`);
      continue;
    }
    try {
      console.log(`→ ${pdf.title}`);
      const text = await extractPdf(pdf.url);
      console.log(`  extracted ${text.length} chars`);
      if (text.length < 500) {
        console.warn(`  ✗ too little text, skipping`);
        continue;
      }
      if (!DRY && out) {
        out.write(JSON.stringify({ url: pdf.url, title: pdf.title, category: pdf.category, text }) + "\n");
        written++;
      }
    } catch (e) {
      console.warn(`  ✗ ${pdf.url}: ${(e as Error).message}`);
    }
  }

  if (out) out.end();
  console.log(DRY ? "✓ Dry run complete (no write)." : `✓ Wrote ${written} PDF record(s) to ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
