/**
 * Crawler for diaakademi.com.
 *
 * - Reads sitemap_index.xml -> content sub-sitemaps -> page URLs.
 * - Fetches each page with an honest, identifiable User-Agent and a polite
 *   rate limit (CRAWL_CONCURRENCY + CRAWL_DELAY_MS). No bot-detection evasion.
 * - Extracts the main WordPress content, strips chrome, writes JSONL.
 * - Resumable: skips URLs already present in data/pages.jsonl.
 *
 * Usage: npm run crawl            (all content sitemaps)
 *        npm run crawl -- --limit=50   (smoke test)
 */
import "./_env";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import pLimit from "p-limit";

const BASE = "https://www.diaakademi.com";
const SITEMAP_INDEX = `${BASE}/sitemap_index.xml`;
const OUT_DIR = path.join(process.cwd(), "data");
const OUT_FILE = path.join(OUT_DIR, "pages.jsonl");

const UA =
  process.env.CRAWL_USER_AGENT ||
  "DiaRagBot/1.0 (+personal reference assistant)";
const CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY || "4", 10);
const DELAY_MS = parseInt(process.env.CRAWL_DELAY_MS || "400", 10);

// Sitemaps that hold real content (skip taxonomy/category listing sitemaps).
const CONTENT_SITEMAPS: Record<string, string> = {
  "post-sitemap.xml": "post",
  "post-sitemap2.xml": "post",
  "post-sitemap3.xml": "post",
  "post-sitemap4.xml": "post",
  "page-sitemap.xml": "page",
  "manual_kb-sitemap.xml": "kb",
  "manual_faq-sitemap.xml": "faq",
  "manual_portfolio-sitemap.xml": "portfolio",
};

const argLimit = (() => {
  const a = process.argv.find((x) => x.startsWith("--limit="));
  return a ? parseInt(a.split("=")[1], 10) : Infinity;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string, tries = 3): Promise<string> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,application/xml" },
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
  throw new Error("unreachable");
}

function locsFromXml(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("loc")
    .map((_, el) => $(el).text().trim())
    .get();
}

function extractContent(html: string, url: string) {
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    $("title").text().trim();

  // Remove non-content chrome (semantic tags + class/id patterns).
  $(
    "script, style, noscript, nav, header, footer, aside, form, iframe, svg, " +
      "[class*='menu'], [class*='nav-'], [class*='breadcrumb'], [class*='sidebar'], " +
      "[class*='widget'], [class*='popup'], [class*='search'], [class*='related'], " +
      "[class*='share'], [class*='footer'], [class*='header'], [id*='popup'], " +
      ".manual-views, .manual_doc_count, .manual_doc_unlike_count, " +
      "#comments, .comments-area"
  ).remove();

  // Prefer known DİA Akademi / WordPress content containers (docs use these).
  const candidates = [
    ".kb-single .entry-content",
    ".entry-content",
    ".kb-single",
    ".manual-content",
    ".elementor-widget-theme-post-content .elementor-widget-container",
    "article",
    "main",
  ];
  let text = "";
  for (const sel of candidates) {
    const node = $(sel).first();
    if (node.length) {
      const t = node.text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (t.length > text.length) text = t;
      if (text.length > 400) break;
    }
  }
  if (text.length < 200) {
    text = $("body").text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  return { title, text, url };
}

function loadDoneSet(): Set<string> {
  if (!fs.existsSync(OUT_FILE)) return new Set();
  const done = new Set<string>();
  for (const line of fs.readFileSync(OUT_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      done.add(JSON.parse(line).url);
    } catch {
      /* ignore */
    }
  }
  return done;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("→ Reading sitemap index…");
  const indexXml = await fetchText(SITEMAP_INDEX);
  const subSitemaps = locsFromXml(indexXml).filter((u) =>
    Object.keys(CONTENT_SITEMAPS).some((name) => u.endsWith(name))
  );

  // Collect all content URLs with their category.
  const urls: { url: string; category: string }[] = [];
  for (const sm of subSitemaps) {
    const name = sm.split("/").pop()!;
    const category = CONTENT_SITEMAPS[name] || "other";
    const xml = await fetchText(sm);
    for (const u of locsFromXml(xml)) urls.push({ url: u, category });
    console.log(`  ${name}: +${locsFromXml(xml).length}`);
  }

  const done = loadDoneSet();
  let todo = urls.filter((u) => !done.has(u.url));
  if (argLimit !== Infinity) todo = todo.slice(0, argLimit);

  console.log(
    `→ ${urls.length} total, ${done.size} already done, crawling ${todo.length}…`
  );

  const out = fs.createWriteStream(OUT_FILE, { flags: "a" });
  const limit = pLimit(CONCURRENCY);
  let ok = 0;
  let fail = 0;
  let n = 0;

  await Promise.all(
    todo.map((item) =>
      limit(async () => {
        try {
          const html = await fetchText(item.url);
          const { title, text } = extractContent(html, item.url);
          if (text && text.length > 120) {
            out.write(
              JSON.stringify({
                url: item.url,
                title,
                category: item.category,
                text,
              }) + "\n"
            );
            ok++;
          } else {
            fail++;
          }
        } catch (e) {
          fail++;
          console.warn(`  ✗ ${item.url}: ${(e as Error).message}`);
        } finally {
          n++;
          if (n % 50 === 0)
            console.log(`  …${n}/${todo.length} (ok ${ok}, skip/fail ${fail})`);
          await sleep(DELAY_MS);
        }
      })
    )
  );

  out.end();
  console.log(`✓ Done. ok=${ok}, fail/skip=${fail}. Output: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
