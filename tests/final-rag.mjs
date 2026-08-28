// Final acceptance test for the LIVE public DİA RAG assistant.
// Target: https://dia-rag.vercel.app  ->  POST /api/chat
//   body:   {"messages":[{"role":"user","content":"<q>"}]}
//   resp:   streamed text/plain body
//           + x-sources          (base64 of JSON array of {n,url,title,category})
//           + x-conversation-id
//
// Checks:
//   1. Content cases: HTTP 200, answer >= 60 chars, >= 1 source.
//   2. UTF-8 / Turkish source-title regression: decode x-sources with
//      Buffer.from(hdr,'base64').toString('utf8') then JSON.parse; assert NO
//      title contains mojibake bytes (/[ÃÄÅ]/) and Turkish-char titles look OK.
//   3. Video coverage: some sources from youtube.com; note any url ending #visual.
//   4. Guardrail: off-topic (weather / restaurant) questions must decline.
//
// Read-only. NEVER calls /api/feedback. Run:  node tests/final-rag.mjs

const BASE = process.env.DIA_BASE || "https://dia-rag.vercel.app";
const ENDPOINT = `${BASE}/api/chat`;
const DELAY_MS = 1500;      // polite gap between calls
const TIMEOUT_MS = 60000;   // per-request ceiling
const MAX_RETRIES = 1;      // retry once on cold-start "fetch failed"

// category: how-to | api | error | mevzuat | module | screen | guardrail
const CASES = [
  { id: "howto-stok-fiyat", cat: "how-to",    q: "stok kartında fiyat nasıl tanımlanır" },
  { id: "howto-efatura",    cat: "how-to",    q: "e-fatura nasıl kesilir" },
  { id: "howto-ekstre",     cat: "how-to",    q: "cari ekstre nasıl alınır" },
  { id: "api-login",        cat: "api",       q: "web servise login nasıl yapılır" },
  { id: "err-muhur",        cat: "error",     q: "mali mühür hatası nasıl çözülür" },
  { id: "mevzuat-earsiv",   cat: "mevzuat",   q: "2026 e-arşiv sınırı" },
  { id: "mod-recete",       cat: "module",    q: "üretim reçetesi nasıl tanımlanır" },
  { id: "mod-folyo",        cat: "module",    q: "otel folyo nedir" },
  { id: "screen-sis3000",   cat: "screen",    q: "sis3000 firmalar ekranı" },
  { id: "guard-hava",       cat: "guardrail", q: "Bugün hava nasıl?" },
  { id: "guard-restoran",   cat: "guardrail", q: "İstanbul'da restoran öner" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Decode the x-sources header exactly as the spec prescribes.
// Returns { sources: [...] } or { error: "..." } on decode/parse failure.
function decodeSources(hdr) {
  if (!hdr) return { sources: [], error: "missing header" };
  let json;
  try {
    json = Buffer.from(hdr, "base64").toString("utf8");
  } catch (e) {
    return { sources: [], error: `base64: ${e.message}` };
  }
  try {
    const parsed = JSON.parse(json);
    return { sources: Array.isArray(parsed) ? parsed : [] };
  } catch (e) {
    return { sources: [], error: `json: ${e.message}` };
  }
}

// Mojibake detection: classic UTF-8-decoded-as-Latin1 artifacts start with
// Ã / Ä / Å lead bytes (e.g. "Ã§" for ç, "Ä±" for ı, "Åž" for Ş).
const MOJIBAKE_RE = /[ÃÄÅ]/;
// Correctly-decoded Turkish-specific letters.
const TURKISH_RE = /[İıŞşÇçÜüÖöĞğ]/;

function inspectTitle(title) {
  const t = title || "";
  return {
    title: t,
    mojibake: MOJIBAKE_RE.test(t),
    hasTurkish: TURKISH_RE.test(t),
  };
}

// Guardrail: did the assistant stay on DİA / decline rather than fabricate?
function guardrailHeldFirm(answer) {
  const a = (answer || "").toLocaleLowerCase("tr");
  const onTopic = /d[iı]a|asistan|yard[iı]mc|kapsam|d[oö]k[uü]man|yaln[iı]zca|sadece|ilgili de[gğ]il|bilgi bulamad|bilgim yok|yard[iı]mc[iı] olamam/.test(a);
  const gaveWeather = /\d+\s*derece|\d+\s*°|bug[uü]n hava (güneşli|bulutlu|ya[gğ]murlu|aç[iı]k)|s[iı]cakl[iı]k \d/.test(a);
  // A genuine restaurant leak recommends a real eatery WITHOUT the DİA framing.
  // The correct decline always references DİA / its module / its docs, so exclude
  // answers that mention modül / dia / döküman / "bulamadım" as on-topic redirects.
  const recommends = /(tavsiye ederim|öneririm|gidebilirsiniz|deneyebilirsiniz)/.test(a)
    && /(restoran|lokanta|mekan)/.test(a);
  const namedVenue = /(şu|bu) restoran(ı|lar)/.test(a);
  const diaFramed = /mod[uü]l|d[iı]a|d[oö]k[uü]man|bulamad|kaps[aı]m|asistan/.test(a);
  const gaveRestaurant = (recommends || namedVenue) && !diaFramed;
  return { onTopic, leaked: gaveWeather || gaveRestaurant };
}

async function callOnce(q) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
      signal: ctrl.signal,
    });
    const hdr = res.headers.get("x-sources");
    const convId = res.headers.get("x-conversation-id");
    const answer = await res.text(); // fully drain the streamed body
    const dec = decodeSources(hdr);
    return {
      ok: true,
      status: res.status,
      answer,
      sources: dec.sources,
      srcDecodeError: dec.error || null,
      convId,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetry(q) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callOnce(q);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) await sleep(2500 * (attempt + 1));
    }
  }
  return {
    ok: false, status: 0, answer: "", sources: [], srcDecodeError: null,
    convId: null, ms: 0, error: String((lastErr && lastErr.message) || lastErr),
  };
}

function evaluate(c, r) {
  const checks = {};
  checks.http200 = r.status === 200;
  checks.answer60 = (r.answer || "").length >= 60;

  if (c.cat === "guardrail") {
    const g = guardrailHeldFirm(r.answer);
    checks.declines = g.onTopic && !g.leaked;
  } else {
    checks.hasSource = Array.isArray(r.sources) && r.sources.length >= 1;
    checks.srcDecoded = !r.srcDecodeError;
    // No mojibake in any source title returned by this case.
    const bad = (r.sources || []).filter((s) => MOJIBAKE_RE.test(s.title || ""));
    checks.noMojibake = bad.length === 0;
  }

  const pass = Object.values(checks).every(Boolean) && r.ok;
  return { pass, checks };
}

function fmtChecks(checks) {
  return Object.entries(checks).map(([k, v]) => `${v ? "OK" : "XX"}:${k}`).join(" ");
}

async function main() {
  console.log(`\nDİA RAG — FINAL ACCEPTANCE TEST`);
  console.log(`Target: ${ENDPOINT}`);
  console.log(`Cases: ${CASES.length} | delay ${DELAY_MS}ms | ${new Date().toISOString()}\n`);

  const rows = [];
  for (const c of CASES) {
    const r = await callWithRetry(c.q);
    const { pass, checks } = evaluate(c, r);
    rows.push({ c, r, pass, checks });
    const srcN = Array.isArray(r.sources) ? r.sources.length : "ERR";
    console.log(
      `[${pass ? "PASS" : "FAIL"}] ${c.id.padEnd(16)} ${String(r.status).padStart(3)} ` +
      `len=${String((r.answer || "").length).padStart(4)} src=${String(srcN).padStart(2)} ` +
      `${String(r.ms).padStart(5)}ms  ${fmtChecks(checks)}`
    );
    if (r.error) console.log(`         └─ request error: ${r.error}`);
    if (r.srcDecodeError) console.log(`         └─ x-sources decode error: ${r.srcDecodeError}`);
    await sleep(DELAY_MS);
  }

  // ---- PASS/FAIL table ----
  console.log("\n" + "=".repeat(80));
  console.log("PASS / FAIL TABLE");
  console.log("=".repeat(80));
  console.log("ID".padEnd(17) + "CAT".padEnd(11) + "RESULT".padEnd(8) + "HTTP".padEnd(6) + "LEN".padEnd(6) + "SRC".padEnd(5) + "ms");
  console.log("-".repeat(80));
  let passCount = 0;
  const failures = [];
  for (const { c, r, pass, checks } of rows) {
    if (pass) passCount++; else failures.push({ c, r, checks });
    const srcN = Array.isArray(r.sources) ? r.sources.length : "ERR";
    console.log(
      c.id.padEnd(17) + c.cat.padEnd(11) + (pass ? "PASS" : "FAIL").padEnd(8) +
      String(r.status).padEnd(6) + String((r.answer || "").length).padEnd(6) +
      String(srcN).padEnd(5) + String(r.ms)
    );
  }
  console.log("-".repeat(80));
  console.log(`Passed: ${passCount}/${rows.length}   Failed: ${rows.length - passCount}`);

  // ---- (2) UTF-8 / Turkish mojibake audit across ALL sources ----
  console.log("\n" + "=".repeat(80));
  console.log("UTF-8 / TURKISH SOURCE-TITLE AUDIT (the key regression)");
  console.log("=".repeat(80));
  const allTitles = [];
  const seen = new Set();
  for (const { r } of rows) {
    for (const s of r.sources || []) {
      const key = `${s.title}||${s.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allTitles.push(inspectTitle(s.title));
    }
  }
  const mojibaked = allTitles.filter((t) => t.mojibake);
  const turkishOK = allTitles.filter((t) => t.hasTurkish && !t.mojibake);
  console.log(`Unique source titles inspected: ${allTitles.length}`);
  console.log(`Titles with Turkish chars (clean): ${turkishOK.length}`);
  console.log(`Titles flagged as MOJIBAKE: ${mojibaked.length}`);
  if (mojibaked.length) {
    console.log("MOJIBAKED TITLES (REGRESSION STILL PRESENT):");
    for (const t of mojibaked) console.log(`   ✗ ${t.title}`);
  } else {
    console.log("No mojibake detected — titles decode as clean UTF-8.");
  }
  if (turkishOK.length) {
    console.log("Sample clean Turkish-char titles:");
    for (const t of turkishOK.slice(0, 6)) console.log(`   ✓ ${t.title}`);
  }

  // ---- (3) Video / visual coverage ----
  console.log("\n" + "=".repeat(80));
  console.log("VIDEO + VISUAL COVERAGE");
  console.log("=".repeat(80));
  const allUrls = [];
  const seenUrl = new Set();
  for (const { r } of rows) {
    for (const s of r.sources || []) {
      if (!s.url || seenUrl.has(s.url)) continue;
      seenUrl.add(s.url);
      allUrls.push(s.url);
    }
  }
  const youtube = allUrls.filter((u) => /youtube\.com|youtu\.be/i.test(u));
  const visual = allUrls.filter((u) => /#visual$/.test(u));
  console.log(`Unique source URLs: ${allUrls.length}`);
  console.log(`YouTube (training video) sources: ${youtube.length}`);
  for (const u of youtube.slice(0, 6)) console.log(`   ▶ ${u}`);
  console.log(`Gemini visual-analysis (#visual) sources: ${visual.length}`);
  for (const u of visual.slice(0, 6)) console.log(`   ◉ ${u}`);
  const videoOK = youtube.length > 0;
  console.log(videoOK
    ? "Video coverage: PRESENT (audio transcripts retrievable)."
    : "Video coverage: NONE FOUND across these queries.");
  console.log(visual.length
    ? "Visual coverage: PRESENT (#visual records retrievable → audio+visual both work)."
    : "Visual coverage: no #visual records surfaced in these queries.");

  // ---- (4) Guardrail spotlight ----
  console.log("\n" + "=".repeat(80));
  console.log("GUARDRAIL BEHAVIOR");
  console.log("=".repeat(80));
  for (const { c, r } of rows.filter((x) => x.c.cat === "guardrail")) {
    const g = guardrailHeldFirm(r.answer);
    console.log(`- ${c.id}: onTopic=${g.onTopic} leaked=${g.leaked} -> ${g.onTopic && !g.leaked ? "HELD" : "BREACH"}`);
    console.log(`    A: ${(r.answer || "").replace(/\s+/g, " ").slice(0, 200)}`);
  }

  // ---- Failure detail ----
  if (failures.length) {
    console.log("\n" + "=".repeat(80));
    console.log("FAILURE DETAIL");
    console.log("=".repeat(80));
    for (const { c, r, checks } of failures) {
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ");
      console.log(`- ${c.id} (${c.cat}): failed [${failed}]`);
      console.log(`    Q: ${c.q}`);
      console.log(`    A: ${(r.answer || "").replace(/\s+/g, " ").slice(0, 180)}`);
    }
  }

  // ---- Summary ----
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(`Content+guardrail cases: ${passCount}/${rows.length} passed.`);
  console.log(`Mojibaked source titles: ${mojibaked.length} ${mojibaked.length ? "(REGRESSION!)" : "(none — fix holds)"}`);
  console.log(`YouTube sources: ${youtube.length}, #visual sources: ${visual.length}.`);
  const guardRows = rows.filter((x) => x.c.cat === "guardrail");
  const guardHeld = guardRows.filter((x) => x.pass).length;
  console.log(`Guardrail: ${guardHeld}/${guardRows.length} held firm.`);
  console.log("");

  // Exit non-zero if any hard failure OR mojibake regression.
  process.exit(failures.length || mojibaked.length ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal harness error:", e);
  process.exit(2);
});
