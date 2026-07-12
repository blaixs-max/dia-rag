/**
 * Extra sources crawler — appends to the same data/pages.jsonl as crawl.ts.
 *
 *  A) dia.com.tr  → product/solution/module pages (WordPress .entry-content)
 *  B) doc.dia.com.tr → DİA Web Servis API v3 reference (DokuWiki, BFS over the
 *                      "gelistirici:" namespace)
 *
 * Usage: npm run crawl:extra
 *        npm run crawl:extra -- --limit=20
 */
import "./_env";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import pLimit from "p-limit";

const OUT_DIR = path.join(process.cwd(), "data");
const OUT_FILE = path.join(OUT_DIR, "pages.jsonl");

const UA =
  process.env.CRAWL_USER_AGENT ||
  "DiaRagBot/1.0 (+personal reference assistant)";
const CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY || "4", 10);
const DELAY_MS = parseInt(process.env.CRAWL_DELAY_MS || "400", 10);
const DOC_MAX_PAGES = 500;

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
  return $("loc").map((_, el) => $(el).text().trim()).get();
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

type Rec = { url: string; title: string; category: string; text: string };

// ---------- A) dia.com.tr (WordPress) ----------
function extractWp(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    $("title").text().trim();
  // Elementor-safe removal: dia.com.tr product pages build ALL content inside
  // .elementor-widget-* wrappers, so we must NOT strip [class*='widget'].
  // Remove only real chrome (menus, breadcrumbs, site header/footer regions).
  $(
    "script, style, noscript, iframe, svg, form, " +
      ".elementor-nav-menu, .elementor-widget-nav-menu, [class*='menu-item'], " +
      "[class*='breadcrumb'], .site-header, .site-footer, " +
      ".elementor-location-header, .elementor-location-footer, header#masthead"
  ).remove();
  let text = "";
  for (const sel of [
    ".entry-content",
    ".elementor-widget-theme-post-content .elementor-widget-container",
    "article",
    "main",
  ]) {
    const n = $(sel).first();
    if (n.length) {
      const t = n.text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (t.length > text.length) text = t;
      if (text.length > 400) break;
    }
  }
  return { title, text };
}

async function crawlDiaComTr(done: Set<string>): Promise<Rec[]> {
  const sitemaps = ["cozum", "modul", "page"];
  const urls: string[] = [];
  for (const sm of sitemaps) {
    const xml = await fetchText(`https://www.dia.com.tr/${sm}-sitemap.xml`);
    urls.push(...locsFromXml(xml));
  }
  let todo = urls.filter((u) => !done.has(u));
  if (argLimit !== Infinity) todo = todo.slice(0, argLimit);
  console.log(`  dia.com.tr: ${urls.length} urls, crawling ${todo.length}`);

  const limit = pLimit(CONCURRENCY);
  const out: Rec[] = [];
  await Promise.all(
    todo.map((url) =>
      limit(async () => {
        try {
          const { title, text } = extractWp(await fetchText(url));
          if (text.length > 120)
            out.push({ url, title, category: "product", text });
        } catch (e) {
          console.warn(`    ✗ ${url}: ${(e as Error).message}`);
        } finally {
          await sleep(DELAY_MS);
        }
      })
    )
  );
  return out;
}

// ---------- B) doc.dia.com.tr (DokuWiki BFS) ----------
function extractDoku(html: string): { title: string; text: string; links: string[] } {
  const $ = cheerio.load(html);
  const title =
    $("#dokuwiki__content h1").first().text().trim() ||
    $("h1").first().text().trim() ||
    $("title").text().trim();

  const links: string[] = [];
  $('a[href*="doku.php?id=gelistirici:wsapi:"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/id=(gelistirici:wsapi:[a-z0-9_:.-]+)/i);
    if (m) links.push(`https://doc.dia.com.tr/doku.php?id=${m[1]}`);
  });

  // Remove TOC + chrome, then prefer the actual page body container.
  $(
    "#dw__toc, .dw-toc, .toc-panel, .nav.toc, .dw-page-icons, .docInfo, " +
      ".secedit, .a11y, script, style, .breadcrumbs, .pageId"
  ).remove();
  const content =
    $("#dokuwiki__content .dw-content-page").first().length
      ? $("#dokuwiki__content .dw-content-page").first()
      : $("#dokuwiki__content").first();
  const text = content
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, links: [...new Set(links)] };
}

async function crawlDocDia(done: Set<string>): Promise<Rec[]> {
  const seed = "https://doc.dia.com.tr/doku.php?id=gelistirici:wsapi:anasayfa";
  const queue = [seed];
  const visited = new Set<string>();
  const out: Rec[] = [];
  const cap = argLimit !== Infinity ? argLimit : DOC_MAX_PAGES;

  while (queue.length && visited.size < cap) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const { title, text, links } = extractDoku(await fetchText(url));
      const denied = /Yetki Reddedildi|devam etmek için yetkiniz yok/i.test(text);
      if (text.length > 120 && !denied && !done.has(url))
        out.push({ url, title, category: "api-doc", text });
      for (const l of links) if (!visited.has(l)) queue.push(l);
    } catch (e) {
      console.warn(`    ✗ ${url}: ${(e as Error).message}`);
    }
    if (visited.size % 25 === 0)
      console.log(`  doc.dia.com.tr: visited ${visited.size}, collected ${out.length}`);
    await sleep(DELAY_MS);
  }
  console.log(`  doc.dia.com.tr: ${out.length} pages collected`);
  return out;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const done = loadDoneSet();
  const outStream = fs.createWriteStream(OUT_FILE, { flags: "a" });

  console.log("→ A) dia.com.tr product/solution/module pages…");
  const a = await crawlDiaComTr(done);
  console.log("→ B) doc.dia.com.tr Web Servis API reference…");
  const b = await crawlDocDia(done);

  let written = 0;
  for (const rec of [...a, ...b]) {
    if (done.has(rec.url)) continue;
    outStream.write(JSON.stringify(rec) + "\n");
    done.add(rec.url);
    written++;
  }
  outStream.end();
  console.log(`✓ Extra crawl done. Wrote ${written} new records to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
