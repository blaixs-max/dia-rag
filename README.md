# DİA RAG Agent

DİA ERP dökümanları + resmi eğitim videoları üzerine RAG tabanlı Türkçe yardım asistanı.
Next.js 15 (App Router) + Supabase (pgvector, `dia_rag` şeması) + Vercel.

**Canlı:** https://dia-rag.vercel.app
**Sağlayıcı (canlı):** LLM + embedding = **Gemini** (`LLM_PROVIDER=gemini`, `EMBEDDING_PROVIDER=gemini`, `gemini-embedding-001`, 1024 boyut). Kod sağlayıcı-bağımsızdır; Anthropic/Voyage/OpenAI yollarına env ile geçilebilir.

## Mimari

```
crawl*.ts       → data/pages.jsonl          (siteler → temiz metin, JSONL)
gen-video.mjs   → data/gen-*.jsonl          (YouTube URL → Gemini transkript + görsel analiz)
ingest.ts       → dia_rag.documents         (chunk → BAĞLAM BAŞLIĞI → embedding → pgvector)
/api/chat       → embed(query) → match_documents (ef_search=200) → rerank → Gemini (stream)
page.tsx        → sohbet arayüzü + kaynak linkleri + 👍/👎 öğrenme
```

### Retrieval hattı (önemli ayarlar)
- `MATCH_COUNT=100` aday → **rerank** → `RERANK_TOP=14` chunk modele gider (`src/app/api/chat/route.ts`).
- **Rerank fallback zinciri** (`src/lib/rerank.ts`): Voyage rerank-2.5 → yoksa **Gemini listwise rerank** → yoksa vektör sırası.
- `match_documents` fonksiyonu `hnsw.ef_search=200` ile çalışır (recall için; migration `0003`).
- **Bağlamsal başlık (contextual header):** her chunk'ın gövdesine dokunulmadan başına `[Video: {başlık} | Kaynak: DİA eğitim videosu]` veya `[Kaynak: {başlık}]` eklenir (`src/lib/header.ts`). Golden A/B ile doğrulandı (parafrazsız, hata riski sıfır). Yeni ingest'ler otomatik ekler; mevcut korpus `migrate-headers.ts` ile geçirildi.

## Kurulum

### 1. `.env.local`
| Değişken | Nereden |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard > Project Settings > API > service_role |
| `GEMINI_API_KEY` | aistudio.google.com (canlı sağlayıcı — faturalı) |
| (opsiyonel) `ANTHROPIC_API_KEY` / `VOYAGE_API_KEY` / `OPENAI_API_KEY` | ilgili sağlayıcıya geçmek için |

> ⚠️ Bu makinede googleapis.com'a IPv6 zaman aşımı yaşanır. Gemini'ye giden script'ler
> `NODE_OPTIONS=--dns-result-order=ipv4first` ile çalıştırılmalı. `.env.local` CRLF satır
> sonlu; script'ler değer sonundaki `\r`'yi temizler.

### 2. Veritabanı şeması
`supabase/migrations/` içindeki SQL'leri Supabase Dashboard > SQL Editor'da sırayla çalıştır:
`0001` (şema + `match_documents`), `0002` (feedback/learning), `0003` (`ef_search=200`).

### 3. Bağımlılıklar + çalıştır
```
npm install
npm run dev                 # http://localhost:3000
```

## Veri hattı

```
npm run crawl               # diaakademi.com → data/pages.jsonl
npm run crawl:extra         # dia.com.tr + doc.dia.com.tr (wsapi + models)
npm run crawl:more          # diateknoloji + bilgi bankası/eğitim
npm run ingest:pdf          # dia.ist PDF manuel
npm run ingest              # chunk + BAŞLIK + embed → Supabase (mevcut URL'leri atlar; --force ile baştan)
```

**Eğitim videoları** (resmi kanal `youtube.com/DegisimeIlkAdim`, 691 video — %100 görsel, %96 transkript):
```
node scripts/gen-video.mjs transcript <videoId>...        # sesli anlatım → metin
node scripts/gen-video.mjs visual <videoId>...            # ekran adımları (fps 0.2, uzun videolar için)
node scripts/gen-video.mjs shard <mode> <i> <n>           # missing.json'dan shard işle
# üretilen data/gen-*.jsonl'leri pages.jsonl'e ekleyip `npm run ingest`
```

**Korpus (~10.5k chunk, 18 kategori):** diaakademi/dia.com.tr/doc.dia.com.tr, PDF manuel, 691 eğitim videosu (transkript + görsel), Perplexity araştırması, öğrenilen cevaplar.

## Bakım script'leri
```
NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/migrate-headers.ts --shard=0 --shards=1
                            # tüm korpusa bağlamsal başlık ekle + yeniden embed (idempotent, resumable)
                            # ⚠️ küçük DB_BATCH + düşük eş-zamanlılık — HNSW re-index statement-timeout'a girer
npx tsx scripts/verify-headers.ts        # başlık kapsamasını doğrula
```

## Değerlendirme (Golden Eval)
`scripts/ab-eval.ts` + `data/pilot/` — sabit sorular ve tam kaynaktan üretilmiş "golden" referans
cevaplarla herhangi bir RAG değişikliğini önce/sonra ölçmek için. Chunk yapısı A/B testleri
buradan yürütüldü (bağlamsal başlık kazancı burada doğrulandı).

## Deploy (Vercel)
`.env.local`'deki değişkenleri Vercel proje ayarlarına ekle, sonra:
```
vercel --prod
```
Crawl/ingest/migrasyon yereldir; sadece Next.js uygulaması deploy edilir. DB değişiklikleri
(başlık migrasyonu vb.) anında canlıdır, redeploy gerektirmez.

## Notlar
- Crawler dürüst User-Agent + hız limiti kullanır; bot koruması atlatmaz.
- Yeniden çalıştırma güvenli: crawl resume eder, ingest `(url, chunk_index)` upsert yapar, migrate-headers başlıklı satırları atlar.
- ⚠️ **Uygulama public + auth yok + faturalı Gemini anahtarı** → maliyet/istismar açık. AI Studio'da bütçe limiti + rate-limit/şifre önerilir.
