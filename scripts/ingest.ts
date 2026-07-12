/**
 * Ingestion: data/pages.jsonl -> chunks -> embeddings -> Supabase dia_documents.
 *
 * - Idempotent: upserts on (url, chunk_index), so re-running is safe.
 * - Batches embeddings (EMBED_BATCH) and DB writes (DB_BATCH).
 *
 * Usage: npm run ingest
 *        npm run ingest -- --limit=100   (only first 100 pages)
 */
import "./_env";
import * as fs from "node:fs";
import * as path from "node:path";
import { chunkText } from "../src/lib/chunk";
import { embedDocuments } from "../src/lib/embeddings";
import { getAdminClient } from "../src/lib/supabase";

const IN_FILE = path.join(process.cwd(), "data", "pages.jsonl");
const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
const EMBED_BATCH = 64;
const DB_BATCH = 100;

type Page = { url: string; title: string; category: string; text: string };
type Row = {
  url: string;
  title: string;
  category: string;
  chunk_index: number;
  content: string;
  embedding: number[];
};

const argLimit = (() => {
  const a = process.argv.find((x) => x.startsWith("--limit="));
  return a ? parseInt(a.split("=")[1], 10) : Infinity;
})();

function loadPages(): Page[] {
  if (!fs.existsSync(IN_FILE)) {
    throw new Error(`Not found: ${IN_FILE}. Run "npm run crawl" first.`);
  }
  const pages: Page[] = [];
  for (const line of fs.readFileSync(IN_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      pages.push(JSON.parse(line));
    } catch {
      /* ignore malformed line */
    }
  }
  return pages;
}

/** Local markdown knowledge files (e.g. the Perplexity research) become pages. */
function loadKnowledge(): Page[] {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  const pages: Page[] = [];
  for (const file of fs.readdirSync(KNOWLEDGE_DIR)) {
    if (!file.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), "utf8");
    const h1 = raw.match(/^#\s+(.+)$/m);
    pages.push({
      // no canonical web URL; use a stable local id so upsert is idempotent.
      url: `knowledge://${file}`,
      title: h1 ? h1[1].trim() : file.replace(/\.md$/, ""),
      category: "research",
      text: raw,
    });
  }
  return pages;
}

const FORCE = process.argv.includes("--force");

/** URLs already present in the DB (paginated), so re-runs only embed new pages. */
async function existingUrls(
  supabase: ReturnType<typeof getAdminClient>
): Promise<Set<string>> {
  const urls = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .schema("dia_rag")
      .from("documents")
      .select("url")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`existingUrls: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as { url: string }[]) urls.add(r.url);
    if (data.length < pageSize) break;
  }
  return urls;
}

async function main() {
  const supabase = getAdminClient();
  let pages = [...loadPages(), ...loadKnowledge()];
  if (argLimit !== Infinity) pages = pages.slice(0, argLimit);

  // Skip pages already ingested (unless --force), so adding new sources
  // only embeds the new pages instead of the whole corpus again.
  if (!FORCE) {
    const have = await existingUrls(supabase);
    const before = pages.length;
    pages = pages.filter((p) => !have.has(p.url));
    console.log(`→ ${have.size} urls already in DB; ${before - pages.length} pages skipped, ${pages.length} new to ingest`);
  }

  // Build (page, chunk) work items.
  const items: { page: Page; chunkIndex: number; content: string }[] = [];
  for (const page of pages) {
    for (const c of chunkText(`${page.title}\n\n${page.text}`)) {
      items.push({ page, chunkIndex: c.index, content: c.content });
    }
  }
  console.log(`→ ${pages.length} pages -> ${items.length} chunks`);

  let embedded = 0;
  let pendingRows: Row[] = [];

  async function flushRows() {
    if (pendingRows.length === 0) return;
    const { error } = await supabase
      .schema("dia_rag")
      .from("documents")
      .upsert(pendingRows, { onConflict: "url,chunk_index" });
    if (error) throw new Error(`Supabase upsert: ${error.message}`);
    pendingRows = [];
  }

  for (let i = 0; i < items.length; i += EMBED_BATCH) {
    const batch = items.slice(i, i + EMBED_BATCH);
    const vectors = await embedDocuments(batch.map((b) => b.content));
    for (let j = 0; j < batch.length; j++) {
      const b = batch[j];
      pendingRows.push({
        url: b.page.url,
        title: b.page.title,
        category: b.page.category,
        chunk_index: b.chunkIndex,
        content: b.content,
        embedding: vectors[j],
      });
    }
    embedded += batch.length;
    if (pendingRows.length >= DB_BATCH) await flushRows();
    if (embedded % (EMBED_BATCH * 5) === 0 || embedded === items.length) {
      console.log(`  …embedded ${embedded}/${items.length}`);
    }
  }
  await flushRows();

  const { count } = await supabase
    .schema("dia_rag")
    .from("documents")
    .select("*", { count: "exact", head: true });
  console.log(`✓ Ingest complete. dia_rag.documents now has ${count} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
