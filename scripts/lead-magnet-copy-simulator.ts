#!/usr/bin/env tsx
/**
 * scripts/lead-magnet-copy-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves LEAD-MAGNET + LANDING COPY — the AI writes the capture page AND the deliverable the user
 * gets for filling out the form (the missing piece: a magnet that actually DELIVERS something). The
 * deterministic copy is REAL content (never a stub) and Fair-Housing-safe; the gate seam can block.
 *
 * Layer 1 (shell, pure): landing copy per magnet type, deliverable content, FH-safety, the gate. No
 * mocks. (The delivery runner's DB record is exercised by the live wiring in captureFormSubmission.)
 *
 * Run: npx tsx scripts/lead-magnet-copy-simulator.ts   (npm run test:lead-magnet-copy)
 */
import { landingPageCopy, magnetDeliverableCopy, magnetHasDeliverable, prepareMagnetDeliverable, landingPageCopyFromTopics, type MagnetType } from "../lib/marketing/lead-magnet-copy"
import { extractContentTopics, topicSearchQuery } from "../lib/marketing/content-topics"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Lead-magnet copy verified — landing + deliverable written, Fair-Housing-safe, gate-able.")
  console.log(" LEAD_MAGNET_COPY_PASS")
  process.exit(0)
}

const ALL: MagnetType[] = ["home_valuation", "buyer_guide", "seller_guide", "market_report", "listing_alert", "open_house", "generic_form"]
// Fair-Housing / steering terms that must NEVER appear in marketing copy.
const FH_BANNED = /\b(family|families|kids|children|safe neighborhood|perfect for|christian|church|no kids|adults only|ideal for (a )?famil|exclusive neighborhood|great for retirees)\b/i

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead-magnet + landing copy simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[landing copy — every magnet type]")
  for (const m of ALL) {
    const c = landingPageCopy(m, { area: "Austin", brand: "Acme Realty" })
    check(`${m}: headline + subhead + CTA + bullets`, !!c.headline && !!c.subhead && !!c.cta && c.bullets.length >= 1)
  }
  const hv = landingPageCopy("home_valuation", { area: "Austin", brand: "Acme Realty" })
  check("landing copy localizes area + brand", /Austin/.test(hv.subhead) && /Acme Realty/.test(hv.subhead))

  console.log("\n[deliverable content — the thing the user receives]")
  check("a buyer_guide has REAL deliverable content (not a stub)", magnetDeliverableCopy("buyer_guide").body.length > 120 && /pre-approved/.test(magnetDeliverableCopy("buyer_guide").body))
  check("home_valuation deliverable offers a precise CMA", /CMA|comparative market/i.test(magnetDeliverableCopy("home_valuation").body))
  check("generic_form ships no downloadable deliverable", !magnetHasDeliverable("generic_form"))
  check("open_house IS event info (has a deliverable)", magnetHasDeliverable("open_house"))

  console.log("\n[Fair-Housing safety — across ALL copy]")
  const allText = ALL.flatMap((m) => {
    const l = landingPageCopy(m, { area: "Austin" })
    const d = magnetHasDeliverable(m) ? magnetDeliverableCopy(m) : { subject: "", title: "", body: "" }
    return [l.headline, l.subhead, ...l.bullets, d.subject, d.title, d.body]
  }).join("  ")
  check("no Fair-Housing / steering language in any copy", !FH_BANNED.test(allText), allText.match(FH_BANNED)?.[0])

  console.log("\n[prepare deliverable — gated]")
  const prepared = await prepareMagnetDeliverable("seller_guide", { brand: "Acme" }, {})
  check("prepares the deliverable with the deterministic copy", !!prepared && /pricing strategy/i.test(prepared.body) && /Acme/.test(prepared.body))
  const blocked = await prepareMagnetDeliverable("seller_guide", undefined, { gate: async () => ({ allowed: false, violations: ["test block"] }) })
  check("a failing gate blocks delivery (returns null)", blocked === null)
  const noDeliverable = await prepareMagnetDeliverable("generic_form", undefined, {})
  check("generic_form prepares no deliverable", noDeliverable === null)

  console.log("\n[content topics — built from REAL demand, not hardcoded]")
  check("topic query targets what people actually ask (per magnet)", /first time home buyer/i.test(topicSearchQuery("buyer_guide")) && /reddit|forum/i.test(topicSearchQuery("buyer_guide")))
  // Simulated web-search texts (Reddit/forum-style) — the kind the gated rail returns.
  const searchTexts = [
    "How much do I need for a down payment on my first home?",
    "What closing costs should a first-time buyer expect?",
    "Should I get pre-approved before I start looking at houses?",
    "How much do I need for a down payment on my first home?", // exact dup → recurrence ranks it first
    "The weather was nice today and I went for a walk.", // noise → dropped (no intent)
    "Is this a good neighborhood for families with kids?", // FH steering → dropped
  ]
  const topics = extractContentTopics(searchTexts, { limit: 5 })
  check("extracts real buyer questions from search texts", topics.some((t) => /down payment/i.test(t.topic)) && topics.some((t) => /pre-?approv/i.test(t.topic)))
  check("noise (non-real-estate) is dropped", !topics.some((t) => /weather|walk/i.test(t.topic)))
  check("Fair-Housing steering topic is dropped", !topics.some((t) => /families|kids/i.test(t.topic)))
  check("a recurring question ranks higher", topics[0] && /down payment/i.test(topics[0].topic))

  // The AI landing copy is BUILT from those real topics (injected generator echoes them).
  const echoGen = async (req: any) => ({ body: `Real answers to: ${req.facts.slice(0, 2).join("; ")}` })
  const aiLanding = await landingPageCopyFromTopics("buyer_guide", topics, { brand: "Acme" }, { copyGenerator: echoGen })
  check("landing subhead is AI-written from the real topics", aiLanding.fromTopics && /down payment|pre-?approv/i.test(aiLanding.subhead))
  check("value bullets become the top real questions", aiLanding.bullets.some((b) => /down payment/i.test(b)))
  // No topics / no generator → safe deterministic fallback (never a blank).
  const fb = await landingPageCopyFromTopics("buyer_guide", [], undefined, {})
  check("no topics → falls back to safe deterministic copy", !fb.fromTopics && !!fb.headline && !!fb.subhead)
  // Deliverable grounded in topics.
  const aiDeliverable = await prepareMagnetDeliverable("buyer_guide", undefined, { topics, copyGenerator: echoGen })
  check("deliverable is grounded in the real topics", !!aiDeliverable && /down payment|pre-?approv/i.test(aiDeliverable.body))

  console.log("\n[AI visibility (GEO) — FAQ + schema.org FAQPage JSON-LD]")
  const { buildFaqFromTopics, faqPageJsonLd, faqJsonLdScript } = await import("../lib/marketing/geo-faq")
  const ansGen = async (req: any) => ({ body: `Here's a clear answer: ${req.facts[0]}` })
  const faq = await buildFaqFromTopics(topics, "buyer_guide", { brand: "Acme" }, { copyGenerator: ansGen })
  check("FAQ is built from the real questions", faq.length >= 2 && faq.every((f) => f.question.endsWith("?") && f.answer.length > 0))
  check("each FAQ item pairs a real question with an answer", faq.some((f) => /down payment/i.test(f.question)) && faq.some((f) => /down payment/i.test(f.answer)))
  const ld = faqPageJsonLd(faq, { brand: "Acme", url: "https://acme.example/buyer-guide" })
  check("emits a schema.org FAQPage (the AI-search citation structure)", (ld as any)["@type"] === "FAQPage" && Array.isArray((ld as any).mainEntity) && (ld as any).mainEntity[0]["@type"] === "Question" && (ld as any).mainEntity[0].acceptedAnswer["@type"] === "Answer")
  check("JSON-LD serializes for a <script> tag", (() => { try { const o = JSON.parse(faqJsonLdScript(faq, { brand: "Acme" })); return o["@type"] === "FAQPage" } catch { return false } })())
  check("no topics → no FAQ (honest, no fabricated Q&A)", (await buildFaqFromTopics([], "buyer_guide", undefined, {})).length === 0)
  // A non-question topic is still framed as a clean question for AI search.
  const framed = await buildFaqFromTopics([{ topic: "closing costs for buyers", score: 3 }], "buyer_guide", undefined, {})
  check("a non-question topic is framed as a question", framed[0]?.question.endsWith("?"))

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
