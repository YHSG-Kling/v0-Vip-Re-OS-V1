#!/usr/bin/env tsx
/**
 * scripts/source-conversion-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE SOURCE-CONVERSION LEARNER — which lead SOURCES actually convert (lead→contact→close)
 * so spend flows to winners and money-pits get flagged. Mirrors format_learning: a sample-gated,
 * honest-on-thin-data, ADVISORY recommender (humans keep enabled_sources). Pure core.
 *
 * Run: npx tsx scripts/source-conversion-simulator.ts   (npm run test:source-conversion)
 */
import { scoreSourceConversions, recommendSourceAllocation, MIN_SOURCE_SAMPLE, type SourceConversionRow } from "../lib/lead-pipeline/source-conversion-learning"

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
  console.log(" ✅ Source-conversion learner verified — winners surfaced, thin data held, advisory only.")
  console.log(" SOURCE_CONVERSION_PASS")
}

const rows: SourceConversionRow[] = [
  { source: "zenrows_zillow",  leadCount: 50, contactCount: 20, closedCount: 4, revenue: 80000, spend: 5000 }, // strong, enabled
  { source: "craigslist_fsbo", leadCount: 30, contactCount: 9,  closedCount: 2, revenue: 40000, spend: 3000 }, // strong, NOT enabled
  { source: "facebook_group",  leadCount: 40, contactCount: 2,  closedCount: 0, revenue: 0,     spend: 8000 }, // money-pit, enabled
  { source: "reddit_intent",   leadCount: 3,  contactCount: 1,  closedCount: 0, revenue: 0,     spend: 200 },  // thin sample
  { source: "osint_signal",    leadCount: 10, contactCount: 3,  closedCount: 0, revenue: 0,     spend: 0 },    // free, no spend
]

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Source-conversion learner simulator")
  console.log("══════════════════════════════════════════════════")

  const scored = scoreSourceConversions(rows)

  console.log("\n[Scoring]")
  check("rates computed (zenrows 40% lead→contact)", Math.abs(scored.sources["zenrows_zillow"].leadToContactRate - 0.4) < 1e-9)
  check(`trusted requires ≥${MIN_SOURCE_SAMPLE} leads (reddit@3 is untrusted)`, scored.sources["reddit_intent"].trusted === false && scored.sources["zenrows_zillow"].trusted === true)
  check("untrusted source scores 0 (unknown, not 'bad')", scored.sources["reddit_intent"].score === 0)
  check("no-spend source → roiMultiple null (can't judge ROI)", scored.sources["osint_signal"].roiMultiple === null)
  check("ROI computed where spend exists (zenrows = 16x)", scored.sources["zenrows_zillow"].roiMultiple === 16)
  check("ranked worst→best is sorted by score descending", scored.ranked.every((s, i) => i === 0 || scored.ranked[i - 1].score >= s.score))
  check("a strong source outranks the money-pit", scored.sources["zenrows_zillow"].score > scored.sources["facebook_group"].score)

  console.log("\n[Allocation — advisory, honest on thin data]")
  const rec = recommendSourceAllocation(scored, ["zenrows_zillow", "facebook_group"])
  check("a thin-sample source is HELD, never flipped (honest on thin data)", rec.hold.includes("reddit_intent") && !rec.enable.includes("reddit_intent") && !rec.disable.includes("reddit_intent"))
  check("a trusted winner not enabled → ENABLE (craigslist_fsbo)", rec.enable.includes("craigslist_fsbo"))
  check("a trusted money-pit that's enabled → DISABLE (facebook_group)", rec.disable.includes("facebook_group"))
  check("a strong already-enabled source is kept (not disabled)", !rec.disable.includes("zenrows_zillow"))
  check("every recommendation carries a why", Object.keys(rec.reasons).length === rows.length && /ROI|leads|holding/i.test(rec.reasons["facebook_group"]))

  console.log("\n[Empty]")
  const none = scoreSourceConversions([])
  check("no data → empty scored, empty allocation (no fabrication)", none.ranked.length === 0 && recommendSourceAllocation(none, []).enable.length === 0)

  report()
}

main()
