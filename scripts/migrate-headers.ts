/**
 * Migrate the live corpus to paraphrase-free contextual headers (variant C).
 * For each chunk: prepend the header to `content` (body verbatim) and RE-EMBED
 * (the header must be in the embedded text to help retrieval), then upsert.
 *
 * - Idempotent: rows that already have a header are skipped (safe to re-run).
 * - Resumable: a killed shard just re-runs; done rows are skipped.
 * - Sharded by id-range so agents can run disjoint slices in parallel:
 *     npx tsx scripts/migrate-headers.ts --shard=0 --shards=8
 *   Test a few rows first:
 *     npx tsx scripts/migrate-headers.ts --shard=0 --shards=1 --limit=15
 *
 * Run with IPv4 (this machine's IPv6 to googleapis.com times out):
 *   NODE_OPTIONS=--dns-result-order=ipv4first
 */
import "./_env";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { embedDocuments } from "../src/lib/embeddings";
import { getAdminClient } from "../src/lib/supabase";
import { withHeader, hasHeader } from "../src/lib/header";

const argNum = (k: string, d: number) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? parseInt(a.split("=")[1], 10) : d;
};
const SHARD = argNum("shard", 0);
const SHARDS = argNum("shards", 1);
const LIMIT = argNum("limit", Infinity);
const EMBED_BATCH = 64; // embedding API batch
const DB_BATCH = 20;    // upsert batch — small to avoid Supabase statement-timeout (HNSW index update per row)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = {
  id: number;
  url: string;
  title: string | null;
  category: string;
  chunk_index: number;
  content: string;
};

async function main() {
  const sb = getAdminClient();

  const { data: mn, error: e1 } = await sb
    .schema("dia_rag").from("documents").select("id").order("id", { ascending: true }).limit(1);
  const { data: mx, error: e2 } = await sb
    .schema("dia_rag").from("documents").select("id").order("id", { ascending: false }).limit(1);
  if (e1 || e2 || !mn?.length || !mx?.length) throw new Error(`min/max id: ${e1?.message || e2?.message}`);
  const minId = mn[0].id as number;
  const maxId = mx[0].id as number;
  const span = Math.ceil((maxId - minId + 1) / SHARDS);
  const lo = minId + SHARD * span;
  const hi = Math.min(maxId + 1, lo + span);
  console.log(`shard ${SHARD}/${SHARDS}: id [${lo}, ${hi})  (corpus ${minId}..${maxId})`);

  let last = lo - 1;
  let processed = 0, skipped = 0, updated = 0, failed = 0;
  let pending: Row[] = [];

  async function flush() {
    if (!pending.length) return;
    const texts = pending.map((r) => withHeader(r.category, r.title, r.content));
    let vecs: number[][];
    try {
      vecs = await embedDocuments(texts);
    } catch (e) {
      failed += pending.length;
      console.log(`  embed FAIL (${pending.length} rows): ${(e as Error).message}`);
      pending = [];
      return;
    }
    const rows = pending.map((r, i) => ({
      url: r.url,
      title: r.title,
      category: r.category,
      chunk_index: r.chunk_index,
      content: texts[i],
      embedding: vecs[i],
    }));
    // Upsert in small slices with retry — big batches hit the statement timeout
    // (each row re-writes a 1024-d HNSW index entry).
    for (let i = 0; i < rows.length; i += DB_BATCH) {
      const slice = rows.slice(i, i + DB_BATCH);
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        const { error } = await sb
          .schema("dia_rag").from("documents").upsert(slice, { onConflict: "url,chunk_index" });
        if (!error) { ok = true; break; }
        if (attempt < 3) await sleep(1500 * (attempt + 1));
        else console.log(`  upsert FAIL (${slice.length}): ${error.message}`);
      }
      if (ok) updated += slice.length; else failed += slice.length;
    }
    pending = [];
  }

  while (processed < LIMIT) {
    const { data, error } = await sb
      .schema("dia_rag").from("documents")
      .select("id,url,title,category,chunk_index,content")
      .gte("id", last + 1).lt("id", hi)
      .order("id", { ascending: true }).limit(500);
    if (error) throw new Error(`fetch: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const r of data as Row[]) {
      last = r.id;
      processed++;
      if (hasHeader(r.content)) { skipped++; continue; }
      pending.push(r);
      if (pending.length >= EMBED_BATCH) await flush();
      if (processed >= LIMIT) break;
    }
    if (processed % 2000 === 0) console.log(`  …processed ${processed}, updated ${updated}, skipped ${skipped}`);
  }
  await flush();

  console.log(`[shard ${SHARD}] DONE processed=${processed} updated=${updated} skipped=${skipped} failed=${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
