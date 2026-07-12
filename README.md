# DİA RAG Agent

DİA Akademi (diaakademi.com) dökümanları üzerine RAG tabanlı Türkçe yardım asistanı.
Next.js + Supabase (pgvector) + Vercel. Üretim için Claude, embedding + rerank için Voyage
(veya ücretsiz Gemini alternatifi).

## Mimari

```
crawl.ts   → data/pages.jsonl        (sitemap → temiz metin)
ingest.ts  → Supabase.dia_documents  (chunk → embedding → pgvector)
/api/chat  → embed(query) → match_dia_documents → Voyage rerank → Claude (stream)
page.tsx   → sohbet arayüzü + kaynak linkleri
```

## Kurulum

### 1. API anahtarları — `.env.local` doldur
| Değişken | Nereden |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard > Project Settings > API > service_role |
| `ANTHROPIC_API_KEY` | console.anthropic.com > API Keys |
| `VOYAGE_API_KEY` | dashboard.voyageai.com > API Keys |

> Tamamen ücretsiz istersen: `GEMINI_API_KEY` (aistudio.google.com) ekle,
> `EMBEDDING_PROVIDER=gemini` ve `LLM_PROVIDER=gemini` yap.

### 2. Veritabanı şeması
`supabase/migrations/0001_dia_rag_init.sql` içeriğini Supabase Dashboard > SQL Editor'a
yapıştırıp çalıştır.

### 3. Bağımlılıklar
```
npm install
```

### 4. Dökümanları çek + indeksle
```
npm run crawl               # diaakademi.com ~4600 sayfa → data/pages.jsonl
npm run crawl:extra         # dia.com.tr (ürün/modül) + doc.dia.com.tr (Web Servis API v3)
npm run crawl -- --limit=30 # önce küçük test
npm run ingest              # chunk + embed + Supabase'e yaz (knowledge/*.md dahil)
```

Ek kaynaklar (ana taramadan sonra):
```
npm run crawl:more          # doc.dia.com.tr models: + diateknoloji.com bilgi bankası/eğitim
```

**Veri kaynakları:**
| Kaynak | İçerik | Kategori |
|---|---|---|
| diaakademi.com | Bilgi bankası, SSS, manuel dökümanlar | `kb`, `faq`, `portfolio`, `post`, `page` |
| dia.com.tr | Ürün/çözüm/modül sayfaları | `product` |
| doc.dia.com.tr `wsapi:` | Web Servis API v3 referansı (DokuWiki) | `api-doc` |
| doc.dia.com.tr `models:` | DİA Model Dokümantasyonu (DB yapısı) | `model-doc` |
| diateknoloji.com | İş ortağı bilgi bankası + eğitim (Echo KB) | `partner-kb` |
| knowledge/*.md | Perplexity DİA ERP araştırması vb. | `research` |

> `ingest` varsayılan olarak DB'de zaten olan URL'leri atlar (sadece yeni sayfaları embed'ler). Baştan yapmak için `npm run ingest -- --force`.

### 5. Çalıştır
```
npm run dev                 # http://localhost:3000
```

## Deploy (Vercel)
`.env.local`'deki tüm değişkenleri Vercel proje ayarlarına ekle, sonra:
```
vercel --prod
```
Crawl + ingest yereldir; sadece Next.js uygulaması deploy edilir.

## Notlar
- Crawler dürüst bir User-Agent ve hız limiti kullanır; bot koruması atlatmaz.
- Yeniden çalıştırma güvenli: crawl resume eder, ingest (url, chunk_index) üzerinde upsert yapar.
