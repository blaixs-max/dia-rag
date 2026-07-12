/**
 * Ingest DİA reference exports (screen/menu/field lists) from Excel/CSV.
 * Drop .xlsx / .xls / .csv files into the `reference/` folder, then run this;
 * each sheet's rows are grouped into readable records appended to
 * data/pages.jsonl, so `npm run ingest` embeds them like any other page.
 *
 * Usage: npm run ingest:ref            (append)
 *        npm run ingest:ref -- --dry   (preview, no write)
 */
import "./_env";
import * as fs from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";

const REF_DIR = path.join(process.cwd(), "reference");
const OUT_FILE = path.join(process.cwd(), "data", "pages.jsonl");
const ROWS_PER_RECORD = 30; // rows grouped into one retrievable record
const DRY = process.argv.includes("--dry");

function loadDone(): Set<string> {
  if (!fs.existsSync(OUT_FILE)) return new Set();
  const done = new Set<string>();
  for (const line of fs.readFileSync(OUT_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).url); } catch { /* ignore */ }
  }
  return done;
}

function rowToText(row: Record<string, unknown>): string {
  return Object.entries(row)
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `${k}: ${String(v).trim()}`)
    .join(" | ");
}

async function main() {
  fs.mkdirSync(REF_DIR, { recursive: true });
  const files = fs
    .readdirSync(REF_DIR)
    .filter((f) => /\.(xlsx|xls|csv)$/i.test(f));

  if (files.length === 0) {
    console.log(`Hiç dosya yok. Excel/CSV dosyalarını şuraya koy: ${REF_DIR}`);
    return;
  }

  const done = loadDone();
  const out = DRY ? null : fs.createWriteStream(OUT_FILE, { flags: "a" });
  let written = 0;

  for (const file of files) {
    const wb = XLSX.readFile(path.join(REF_DIR, file));
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
        wb.Sheets[sheetName],
        { defval: "" }
      );
      if (rows.length === 0) continue;

      for (let i = 0; i < rows.length; i += ROWS_PER_RECORD) {
        const group = rows.slice(i, i + ROWS_PER_RECORD);
        const body = group.map(rowToText).filter(Boolean).join("\n");
        if (body.trim().length < 60) continue;
        const start = i + 1;
        const end = Math.min(i + ROWS_PER_RECORD, rows.length);
        const title = `${file} — ${sheetName} (satır ${start}-${end})`;
        const url = `reference://${encodeURIComponent(file)}#${encodeURIComponent(
          sheetName
        )}-${start}`;
        const text = `DİA referans (${sheetName}):\n${body}`;
        if (done.has(url)) continue;
        console.log(`  + ${title} (${group.length} satır)`);
        if (!DRY && out) {
          out.write(
            JSON.stringify({ url, title, category: "reference", text }) + "\n"
          );
          written++;
          done.add(url);
        }
      }
    }
  }

  if (out) out.end();
  console.log(
    DRY
      ? "✓ Dry run (yazılmadı)."
      : `✓ ${written} referans kaydı yazıldı → ${OUT_FILE}. Şimdi: npm run ingest`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
