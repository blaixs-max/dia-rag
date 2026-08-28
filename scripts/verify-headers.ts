import "./_env";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { getAdminClient } from "../src/lib/supabase";
import { hasHeader } from "../src/lib/header";

async function main() {
  const sb = getAdminClient();
  const { data, error } = await sb
    .schema("dia_rag").from("documents")
    .select("id,category,title,content,embedding")
    .order("id", { ascending: true }).limit(15);
  if (error) throw new Error(error.message);
  let hdr = 0, emb = 0;
  for (const r of data!) {
    if (hasHeader(r.content)) hdr++;
    if (r.embedding != null) emb++;
  }
  console.log(`ilk 15 satır: başlıklı=${hdr}/15, embedding dolu=${emb}/15`);
  console.log("örnek içerik:", JSON.stringify(data![0].content.slice(0, 130)));

  // Count total + headered by scanning in pages (avoids tricky LIKE on '[').
  let from = 0, total = 0, headered = 0;
  for (;;) {
    const { data: page, error: e2 } = await sb
      .schema("dia_rag").from("documents").select("content").range(from, from + 999);
    if (e2) throw new Error(e2.message);
    if (!page || page.length === 0) break;
    for (const r of page) { total++; if (hasHeader(r.content)) headered++; }
    if (page.length < 1000) break;
    from += 1000;
  }
  console.log(`KORPUS: toplam=${total}, başlıklı=${headered}, kalan=${total - headered}`);
}
main().catch((e) => { console.error("HATA:", e.message); process.exit(1); });
