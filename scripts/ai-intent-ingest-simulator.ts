#!/usr/bin/env tsx
/**
 * scripts/ai-intent-ingest-simulator.ts  (npm run test:ai-intent-ingest)
 *
 * Proves AI INTENT AT INGEST (#2): the scrape pipeline now reads a record's CONTENT with the
 * LLM and FUSES that intent into the lead fields promotion already writes — no new columns
 * (verified vs the live `leads` schema: lead_score / lead_type / urgency_level /
 * motivation_confidence). All scoring is pure; the model call is behind an injectable seam, so
 * this runs deterministically with ZERO model spend and no creds.
 *
 * Asserts: intent→type mapping, urgency+confidence→score, fusion weighting (confident high
 * intent LIFTS a generic source baseline; low-confidence barely moves it; null leaves it
 * untouched — the source score is always the floor), lead_type fill on ambiguous sources, and
 * the content-too-short skip (no spend on structured sources).
 */
import {
  intentToType, aiIntentScore, normalizeAiIntent, fuseLeadScore, resolveLeadType,
  classifyRawRecordIntent, assembleRecordContent, MIN_CONTENT_CHARS, MAX_AI_WEIGHT,
  type LeadAnalyzer,
} from "../lib/lead-pipeline/ai-intent-classifier"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

async function main(): Promise<void> {
  console.log("\n[intent mapping · pure]")
  check("'selling' ⇒ seller", intentToType("selling") === "seller")
  check("'motivated_seller' ⇒ seller", intentToType("motivated_seller") === "seller")
  check("'buying' ⇒ buyer", intentToType("buying") === "buyer")
  check("'relocating' ⇒ buyer", intentToType("relocating") === "buyer")
  check("'research' ⇒ unknown", intentToType("research") === "unknown")

  console.log("\n[urgency+confidence → score · pure]")
  check("max urgency, full confidence ⇒ 100", aiIntentScore(5, 1) === 100)
  check("low urgency, full confidence ⇒ 20", aiIntentScore(1, 1) === 20)
  check("any urgency, zero confidence ⇒ neutral 50", aiIntentScore(5, 0) === 50)
  check("score clamps out-of-range inputs", aiIntentScore(99, 9) === 100)

  console.log("\n[fusion · pure — source score is the floor on a generic baseline]")
  const hot = { score: 100, confidence: 1 }
  check("confident high intent lifts a generic source (40) upward", fuseLeadScore(40, hot) > 40)
  check("lift is capped by MAX_AI_WEIGHT (40 → ≤70 at full weight)", fuseLeadScore(40, hot) === Math.round(40 * (1 - MAX_AI_WEIGHT) + 100 * MAX_AI_WEIGHT))
  check("low-confidence read barely moves the source", Math.abs(fuseLeadScore(40, { score: 100, confidence: 0.1 }) - 40) <= 3)
  check("null AI ⇒ source score unchanged (always the floor)", fuseLeadScore(63, null) === 63)
  check("fused score clamps to 0–100", fuseLeadScore(95, { score: 100, confidence: 1 }) <= 100)

  console.log("\n[lead_type refinement · pure]")
  check("known source type is kept (AI does not override seller)", resolveLeadType("seller", "buyer") === "seller")
  check("ambiguous source defers to AI (the social/search value-add)", resolveLeadType("unknown", "seller") === "seller")
  check("ambiguous source + unknown AI stays unknown", resolveLeadType("unknown", "unknown") === "unknown")

  console.log("\n[content assembly · pure]")
  check("assembles from raw_data text fields", assembleRecordContent({ raw_data: { post_content: "need to sell my house fast, relocating for work" } }).includes("relocating"))
  check("joins intentSignals from the preview", assembleRecordContent({ normalized_preview: { intentSignals: ["must sell", "FSBO"] } }).includes("FSBO"))
  check("empty record ⇒ empty content", assembleRecordContent({}) === "")

  console.log("\n[classifier wiring · injected analyzer, no model spend]")
  const fakeSeller: LeadAnalyzer = async ({ content }) => ({
    intent: content.includes("sell") ? "motivated_seller" : "research",
    urgencyScore: 5, confidence: 0.9, summary: "seller intent",
  })
  const ai = await classifyRawRecordIntent({ content: "We NEED to sell ASAP, job transfer out of state." }, fakeSeller)
  check("classifies content-bearing record as confident seller", !!ai && ai.intentType === "seller" && ai.confidence === 0.9 && ai.score > 80)
  const skip = await classifyRawRecordIntent({ content: "short" }, fakeSeller)
  check(`skips content under ${MIN_CONTENT_CHARS} chars (no model spend on structured sources)`, skip === null)
  const boom: LeadAnalyzer = async () => { throw new Error("model down") }
  const safe = await classifyRawRecordIntent({ content: "a".repeat(50) }, boom)
  check("model failure ⇒ null (best-effort; source score stands)", safe === null)

  // End-to-end: ambiguous social source (baseline 40) + confident seller content.
  const fused = fuseLeadScore(40, normalizeAiIntent({ intent: "motivated_seller", urgencyScore: 5, confidence: 0.9 }))
  const type = resolveLeadType("unknown", normalizeAiIntent({ intent: "motivated_seller", urgencyScore: 5, confidence: 0.9 }).intentType)
  check("end-to-end: ambiguous social lead is lifted AND typed as seller", fused > 40 && type === "seller")

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ AI_INTENT_INGEST_FAIL"); process.exit(1) }
  console.log(" ✅ AI_INTENT_INGEST_PASS — content-read intent fuses into the source score at ingest")
}

main().catch((e) => { console.error(e); process.exit(1) })
