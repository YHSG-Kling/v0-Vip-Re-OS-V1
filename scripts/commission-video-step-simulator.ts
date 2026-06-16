#!/usr/bin/env tsx
/**
 * scripts/commission-video-step-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the new commission_video sequence step builds a valid VideoSituation for the Video
 * Director (the clean keep-separate integration: D-ID `video` step stays lightweight; this routes
 * the full Director assembly — Remotion + persona hook + b-roll + tracked QR). The
 * commissionVideo call itself is covered by scripts/video-director-simulator.ts; this verifies the
 * pure step→situation mapping (kind validation/defaulting, channel, facts).
 *
 * Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/commission-video-step-simulator.ts   (npm run test:commission-video-step)
 */
import { commissionSituationForStep, DEFAULT_SITUATION_KIND } from "../lib/video/commission-situation"

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
  console.log(" ✅ commission_video step verified — valid VideoSituation built; kind validated/defaulted.")
  console.log(" COMMISSION_VIDEO_STEP_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" commission_video step → situation simulator")
  console.log("══════════════════════════════════════════════════\n")

  const valid = commissionSituationForStep({ video_situation_kind: "anniversary" }, { contactId: "c1" })
  check("a recognized kind passes through", valid.kind === "anniversary")
  check("contact id flows into facts", valid.facts.contact_id === "c1")
  check("target channel is email (feeds a later video-email send)", valid.targetChannel === "email")

  check("unknown kind → default explainer", commissionSituationForStep({ video_situation_kind: "zzz" }).kind === DEFAULT_SITUATION_KIND)
  check("missing kind → default explainer", commissionSituationForStep({}).kind === DEFAULT_SITUATION_KIND)
  check("blank/whitespace kind → default explainer", commissionSituationForStep({ video_situation_kind: "  " }).kind === DEFAULT_SITUATION_KIND)
  check("default tier is solo_agent; overridable", commissionSituationForStep({}).tier === "solo_agent" && commissionSituationForStep({}, { tier: "team" }).tier === "team")
  check("no contact → empty facts (no fabricated ids)", Object.keys(commissionSituationForStep({}).facts).length === 0)
  check("listing id flows into facts when present", commissionSituationForStep({ video_situation_kind: "new_listing" }, { listingId: "l1" }).facts.listing_id === "l1")

  report()
}

main()
