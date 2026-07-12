// QA test harness for the LIVE public DİA RAG assistant.
// Runs a battery of Turkish questions against the deployed /api/chat endpoint,
// reads the full streamed answer + base64 x-sources header, and asserts basic
// RAG health invariants. Read-only: never calls /api/feedback.
//
// Run:  node tests/rag-tests.mjs

const BASE = process.env.DIA_BASE || "https://dia-rag.vercel.app";
const ENDPOINT = `${BASE}/api/chat`;
const DELAY_MS = 1500;       // polite gap between calls
const TIMEOUT_MS = 60000;    // per-request ceiling
const MAX_RETRIES = 2;       // retry transient cold-start failures

// category: how-to | dev | error | mevzuat | module | screen | guardrail | edge
const CASES = [
  { id: "howto-efatura",   cat: "how-to",    q: "e-Fatura göndermek için firma kartında hangi ayarları yapmalıyım?" },
  { id: "howto-stok",      cat: "how-to",    q: "Stok kartı nasıl oluşturulur?" },
  { id: "howto-ekstre",    cat: "how-to",    q: "Cari hesap ekstresi nasıl alınır?" },
  { id: "dev-login",       cat: "dev",       q: "DİA web servisine login çağrısı nasıl yapılır?" },
  { id: "dev-stoklistele", cat: "dev",       q: "scf_stokkart_listele servisi ne işe yarar?" },
  { id: "err-efatura",     cat: "error",     q: "e-Fatura gönderilemedi hatası neden olur?" },
  { id: "err-muhur",       cat: "error",     q: "mali mühür imzalama aracına erişilemedi hatası nasıl çözülür?" },
  { id: "mevzuat-earsiv",  cat: "mevzuat",   q: "2026'da e-Arşiv fatura sınırı ne oldu?" },
  { id: "mod-recete",      cat: "module",    q: "Üretim reçetesi nasıl tanımlanır?" },
  { id: "mod-folyo",       cat: "module",    q: "Otel modülünde folyo nedir?" },
  { id: "screen-sis3000",  cat: "screen",    q: "sis3000 firmalar ekranında ne yapabilirim?" },
  { id: "edge-kdvtevkifat",cat: "edge",      q: "KDV tevkifatı DİA'da nasıl işlenir?" },
  { id: "guard-hava",      cat: "guardrail", q: "Bugün hava nasıl?" },
  { id: "guard-restoran",  cat: "guardrail", q: "İstanbul'da iyi bir restoran öner" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeSources(headerVal) {
  if (!headerVal) return [];
  try {
    const json = Buffer.from(headerVal, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null; // signal decode failure distinctly from "empty"
  }
}

// Heuristic: did the guardrail case stay on-topic (decline / point back to DİA)
// rather than hallucinate weather/restaurant facts?
function guardrailHeldFirm(answer) {
  const a = (answer || "").toLocaleLowerCase("tr");
  // Held firm = it identifies as a DİA assistant / says it can't answer off-topic.
  const onTopic = /d[iı]a|asistan|yard[iı]mc|kapsam|d[oö]k[uü]man|yaln[iı]zca|sadece|ilgili de[gğ]il|bilgi bulamad|bilgim yok/.test(a);
  // Leaked = it actually delivered the off-topic content:
  //   weather -> concrete conditions/temperature for today
  const gaveWeather = /\d+\s*derece|\d+\s*°|bug[uü]n hava (güneşli|bulutlu|ya[gğ]murlu|aç[iı]k)|s[iı]cakl[iı]k \d/.test(a);
  //   restaurant -> names/recommends an actual eatery (not DİA's restaurant MODULE)
  const gaveRestaurant = /(tavsiye ederim|öneririm|gidebilirsiniz|deneyebilirsiniz).{0,40}(restoran|lokanta|mekan)/.test(a)
    || /(şu|bu) restoran(ı|lar)/.test(a);
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
    const sourcesHdr = res.headers.get("x-sources");
    const convId = res.headers.get("x-conversation-id");
    const answer = await res.text(); // fully drain the streamed body
    return {
      ok: true,
      status: res.status,
      answer,
      sources: decodeSources(sourcesHdr),
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
      if (attempt < MAX_RETRIES) await sleep(2000 * (attempt + 1));
    }
  }
  return { ok: false, status: 0, answer: "", sources: [], convId: null, ms: 0, error: String(lastErr && lastErr.message || lastErr) };
}

function evaluate(c, r) {
  const checks = {};
  checks.http200 = r.status === 200;
  checks.answerLen = (r.answer || "").length > 60;

  const isGuardrail = c.cat === "guardrail";
  if (isGuardrail) {
    // Sources are optional for guardrail; instead verify it did not hallucinate.
    const g = guardrailHeldFirm(r.answer);
    checks.guardrailOnTopic = g.onTopic && !g.leaked;
  } else {
    checks.hasSource = Array.isArray(r.sources) && r.sources.length >= 1;
  }

  const pass = Object.values(checks).every(Boolean) && r.ok;
  return { pass, checks };
}

function fmtChecks(checks) {
  return Object.entries(checks)
    .map(([k, v]) => `${v ? "✓" : "✗"}${k}`)
    .join(" ");
}

async function main() {
  console.log(`\nDİA RAG QA — target: ${ENDPOINT}`);
  console.log(`Cases: ${CASES.length}  |  delay ${DELAY_MS}ms  |  ${new Date().toISOString()}\n`);

  const rows = [];
  for (const c of CASES) {
    const r = await callWithRetry(c.q);
    const { pass, checks } = evaluate(c, r);
    rows.push({ c, r, pass, checks });

    const tag = pass ? "PASS" : "FAIL";
    const srcN = Array.isArray(r.sources) ? r.sources.length : "ERR";
    console.log(
      `[${tag}] ${c.id.padEnd(16)} ${String(r.status).padStart(3)} ` +
      `len=${String((r.answer || "").length).padStart(4)} src=${String(srcN).padStart(2)} ` +
      `${String(r.ms).padStart(5)}ms  ${fmtChecks(checks)}`
    );
    if (r.error) console.log(`         └─ request error: ${r.error}`);
    await sleep(DELAY_MS);
  }

  // Summary table
  console.log("\n" + "=".repeat(78));
  console.log("SUMMARY");
  console.log("=".repeat(78));
  console.log(
    "ID".padEnd(17) + "CAT".padEnd(11) + "RESULT".padEnd(8) +
    "HTTP".padEnd(6) + "LEN".padEnd(6) + "SRC".padEnd(5) + "ms"
  );
  console.log("-".repeat(78));
  let pass = 0;
  const failures = [];
  const latencies = [];
  for (const { c, r, pass: p, checks } of rows) {
    if (p) pass++; else failures.push({ c, r, checks });
    if (r.ms) latencies.push(r.ms);
    const srcN = Array.isArray(r.sources) ? r.sources.length : "ERR";
    console.log(
      c.id.padEnd(17) + c.cat.padEnd(11) + (p ? "PASS" : "FAIL").padEnd(8) +
      String(r.status).padEnd(6) + String((r.answer || "").length).padEnd(6) +
      String(srcN).padEnd(5) + String(r.ms)
    );
  }
  console.log("-".repeat(78));
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const max = latencies.length ? Math.max(...latencies) : 0;
  console.log(`Passed: ${pass}/${rows.length}   Failed: ${rows.length - pass}`);
  console.log(`Latency: avg ${avg}ms, max ${max}ms`);

  if (failures.length) {
    console.log("\nFAILURES:");
    for (const { c, r, checks } of failures) {
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ");
      console.log(`  - ${c.id} (${c.cat}): failed [${failed}]`);
      console.log(`      Q: ${c.q}`);
      console.log(`      A: ${(r.answer || "").replace(/\s+/g, " ").slice(0, 160)}${r.answer && r.answer.length > 160 ? "…" : ""}`);
    }
  }

  // Guardrail spotlight
  console.log("\nGUARDRAIL CASES:");
  for (const { c, r } of rows.filter((x) => x.c.cat === "guardrail")) {
    const g = guardrailHeldFirm(r.answer);
    console.log(`  - ${c.id}: onTopic=${g.onTopic} leaked=${g.leaked} src=${Array.isArray(r.sources) ? r.sources.length : "ERR"}`);
    console.log(`      A: ${(r.answer || "").replace(/\s+/g, " ").slice(0, 180)}`);
  }

  console.log("");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal harness error:", e);
  process.exit(2);
});
