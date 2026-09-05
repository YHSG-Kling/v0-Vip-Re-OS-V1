#!/usr/bin/env tsx
/**
 * scripts/autonomous-artifact-set-guard.ts   (npm run test:artifact-set) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AUTONOMOUS PRE-LISTING RUN PRODUCES THE ARTIFACTS THE OWNER NAMED.
 *
 * Owner's ruling, verbatim (2026-09-05):
 *
 *   "the original autonomous should be cma + marketing plan + presentation/slide
 *    deck (packet is for printouts) turned into chapter reels"
 *
 * Three claims live in that sentence and this proof holds all three:
 *   1. the autonomous run produces a CMA, a MARKETING PLAN and a SLIDE DECK;
 *   2. those artifacts are what become CHAPTER REELS;
 *   3. the listing-agreement PACKET is a printout and is NOT in that set.
 *
 * ── WHY THIS EXISTS WHEN test:listing-appt-prep ALREADY PASSES ───────────────
 *
 * It passed THROUGHOUT the defect, and could not have failed. That proof injects
 * fakes for the three money-spending leaves — that is its whole design, and a
 * correct one: CI must not spend AVM or D-ID credits. But a fake presentation
 * producer returns a well-formed object no matter what the real producer writes,
 * so the assertion "step 2 succeeded" says nothing about which COLUMNS reached
 * the database. The defect lived exactly in that blind spot for as long as it
 * existed. This guard therefore reads the REAL producer's source rather than
 * running the chain — a different question needs a different instrument.
 *
 * ── THE DEFECT IT LOCKS OUT ─────────────────────────────────────────────────
 *
 * The chain called generateAiListingPresentation, which writes a
 * listing_presentations row carrying only an AI narrative and leaves
 * cma_low_value / cma_mid_value / cma_high_value / cma_narrative /
 * marketing_plan / slide_deck / net_sheet NULL. Three surfaces read exactly
 * those columns, and the agent's viewer coerces with `Number(… ?? 0)`, so a
 * seller won by that presentation was shown a $0 value range.
 *
 * It was self-concealing, which is the part worth remembering. The
 * listing-presentation-prep cron is idempotent by APPOINTMENT — it skips any
 * appointment that already has a listing_presentations row — so the incomplete
 * row did not merely arrive first, it PERMANENTLY BLOCKED the complete builder
 * from ever running for that seller. Two producers writing one table in two
 * shapes is the §6 defect; the idempotency key is what turned it into a
 * permanent one.
 *
 * ── BLIND SPOTS, PUBLISHED BESIDE THE RESULT (§2) ────────────────────────────
 *
 *   · STATIC. This reads source and proves which producer the chain NAMES and
 *     which columns that producer WRITES. It does not run a build, so it cannot
 *     prove a row landed — only that the code cannot land the wrong shape.
 *   · It asserts the column NAMES appear in the producer's insert. A producer
 *     that wrote them as literal nulls would still pass; that is a narrower
 *     claim than "the numbers are right", and no static check can make the
 *     wider one.
 *   · The reel-input assertion is about what the chain HANDS the video step, not
 *     about what the model then says. Script content is governed elsewhere
 *     (lib/video/script-compliance, and §5's compliance-first rule).
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const CHAIN    = src("lib/workflow-orchestrator/chains/listing-appt-prep.ts")
const BUILDER  = src("lib/workflow/intelligence/listing-presentation-builder.ts")
const NARRATOR = src("lib/listing-presentation/generate-ai-presentation.ts")
const CRON     = src("app/api/cron/listing-presentation-prep/route.ts")

console.log("══════════════════════════════════════════════════")
console.log(" The autonomous run produces the owner's artifact set")
console.log("══════════════════════════════════════════════════")

// The owner's set, named once here and derived everywhere below (§2 — a second
// hand-typed list in each assertion is a second vocabulary waiting to drift).
const ARTIFACT_COLUMNS = ["cma_low_value", "cma_mid_value", "cma_high_value", "cma_narrative", "marketing_plan", "slide_deck"] as const

console.log("\n── 1 · one producer, and it is the one that writes the set ──")
check("the autonomous chain builds through buildListingPresentation",
  /buildListingPresentation/.test(CHAIN))
check("…and no longer through the narrative-only producer",
  !/generateAiListingPresentation/.test(CHAIN))
check("the cron uses the SAME producer, so 'which ran first' cannot decide the shape",
  /buildListingPresentation/.test(CRON))

for (const col of ARTIFACT_COLUMNS) {
  check(`the survivor writes ${col}`, new RegExp(`${col}\\s*:`).test(BUILDER))
}
check("…and the narrative-only producer writes NONE of them (which is why it could not be the autonomous one)",
  ARTIFACT_COLUMNS.every((c) => !new RegExp(`${c}\\s*:`).test(NARRATOR)),
  ARTIFACT_COLUMNS.filter((c) => new RegExp(`${c}\\s*:`).test(NARRATOR)).join(", "))

console.log("\n── 2 · the artifacts are what become chapter reels ──")
check("the deck the builder produced supplies the chapter list",
  /slideDeck/.test(CHAIN) && /chapters/.test(CHAIN))
check("the reel step is handed the presentation, not raw property data alone",
  /presentationId:\s*presentation\.presentationId/.test(CHAIN) && /presentationContent/.test(CHAIN))

console.log("\n── 3 · the packet is a printout, and stays out of the reel path ──")
check("the builder still produces the packet (it is not lost — it is just not a reel input)",
  /packet_document_id/.test(BUILDER))
check("the chapter-video generator names no packet",
  !/packet/i.test(src("lib/video/chapter-video-generator.ts")))
check("the chain hands no packet to the reel step",
  !/packet[\s\S]{0,80}generateChapterVideos/.test(CHAIN))

console.log("\n── 4 · id classes are not crossed on the way in (§3) ──")
check("the chain passes agentUserId (users.id) to the builder, which is what it takes",
  /agentUserId:\s*args\.agentUserId/.test(CHAIN) && /agentUserId/.test(BUILDER))
check("…and the agents.id it resolved for the CMA still travels separately",
  /agentId:\s*agent\.id/.test(CHAIN))

console.log("\n── CONTROLS — a finder that matched nothing would pass all of the above ──")
check("POSITIVE CONTROL: the column finder recognises a written column in a specimen",
  /cma_mid_value\s*:/.test('{ cma_mid_value: cma.estimatedValueMid }'))
check("NEGATIVE CONTROL: …and does NOT fire on a column merely being read",
  !/cma_mid_value\s*:/.test('.select("cma_mid_value, cma_low_value")'))
check("POSITIVE CONTROL: the producer finder recognises the narrative-only producer by name",
  /generateAiListingPresentation/.test("await generateAiListingPresentation(args)"))
check("NEGATIVE CONTROL: the packet finder fires when a packet IS handed to the reel step",
  /packet[\s\S]{0,80}generateChapterVideos/.test("packetDocumentId, then generateChapterVideos({"))
check("BLINDNESS CONTROL: the scans read comment-STRIPPED source",
  // This file's OWN subject matter is written in prose in the chain's header, so a
  // raw read would find `generateAiListingPresentation` there and fail assertion 2
  // forever — a tombstone is not a call site (§2).
  !stripComments("// generateAiListingPresentation used to be called here\n").includes("generateAiListingPresentation"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static — proves which producer is NAMED and which")
console.log(" columns it WRITES, not that a row landed. A producer writing these")
console.log(" columns as literal nulls would still pass. Script CONTENT is governed")
console.log(" by lib/video/script-compliance and §5, not here.")
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
if (fails.length > 0) { console.log(" ❌ ARTIFACT_SET_FAIL"); process.exit(1) }
console.log(" ✅ ARTIFACT_SET_PASS — the autonomous run produces the CMA, the marketing plan and the slide deck, and the packet stays a printout")
