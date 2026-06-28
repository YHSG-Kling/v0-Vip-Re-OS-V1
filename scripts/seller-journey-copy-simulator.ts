#!/usr/bin/env tsx
/**
 * scripts/seller-journey-copy-simulator.ts   (npm run test:seller-journey-copy)
 * ─────────────────────────────────────────────────────────────────────────────
 * SELLER-JOURNEY STAGE COPY — proves the portal "Your Sale Status" copy: correct stage derivation,
 * the empathy overlay for SENSITIVE contexts (probate/divorce/foreclosure), and — critically — that
 * the overlay is FAIR-HOUSING SAFE: it never references a protected basis, and the factual fields
 * (headline / responsible / urgency) are identical whether or not the seller is in a sensitive context.
 * Pure: no I/O.
 */
import {
  deriveSellerStage,
  resolveSellerStageCopy,
  SELLER_STAGE_MEANING,
} from "../lib/portal/seller-journey-copy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Stage derivation from status + live activity]")
  check("pre_listing → PRE_LISTING", deriveSellerStage("pre_listing", 0, 0) === "PRE_LISTING")
  check("coming_soon → COMING_SOON", deriveSellerStage("coming_soon", 0, 0) === "COMING_SOON")
  check("under_contract → UNDER_CONTRACT", deriveSellerStage("under_contract", 0, 5) === "UNDER_CONTRACT")
  check("closed → CLOSED", deriveSellerStage("closed", 0, 0) === "CLOSED")
  check("active + an offer → OFFER_RECEIVED", deriveSellerStage("active", 1, 3) === "OFFER_RECEIVED")
  check("active + showings only → SHOWING_ACTIVE", deriveSellerStage("active", 0, 2) === "SHOWING_ACTIVE")
  check("active, no activity → ACTIVE", deriveSellerStage("active", 0, 0) === "ACTIVE")
  check("unknown status, no activity → ACTIVE", deriveSellerStage("weird_status", 0, 0) === "ACTIVE")

  console.log("\n[Standard vs sensitive register]")
  const stdPre = resolveSellerStageCopy("PRE_LISTING")
  const sensPre = resolveSellerStageCopy("PRE_LISTING", { sensitive: true })
  check("non-sensitive returns the standard marketing-forward copy", stdPre.whatMeans === SELLER_STAGE_MEANING.PRE_LISTING.whatMeans)
  check("sensitive swaps in a different, gentler whatMeans", sensPre.whatMeans !== stdPre.whatMeans)
  check("sensitive copy is lower-pressure (no rush / your pace)", /no rush|your pace|right for you/i.test(sensPre.whatMeans))
  const sensOffer = resolveSellerStageCopy("OFFER_RECEIVED", { sensitive: true })
  check("sensitive OFFER copy gives them time, not pressure", /take the time|no wrong|plain language/i.test(sensOffer.whatNext + sensOffer.whatMeans))

  console.log("\n[Factual fields are IDENTICAL regardless of sensitive — only warmth/pressure shift]")
  let factualMatch = true
  for (const stage of Object.keys(SELLER_STAGE_MEANING)) {
    const a = resolveSellerStageCopy(stage)
    const b = resolveSellerStageCopy(stage, { sensitive: true })
    if (a.headline !== b.headline || a.responsible !== b.responsible || a.urgency !== b.urgency) factualMatch = false
  }
  check("headline / responsible / urgency never change with sensitivity", factualMatch)

  console.log("\n[FAIR-HOUSING SAFETY — the overlay never names a protected basis]")
  // Protected bases / steering language must NOT appear in any sensitive variant.
  const banned = /\b(age|elderly|senior|young|family|families|children|kids|race|religio|nationa|disab|widow|gender|marital|ethnic|color)\b/i
  let clean = true
  let offender = ""
  for (const stage of Object.keys(SELLER_STAGE_MEANING)) {
    const c = resolveSellerStageCopy(stage, { sensitive: true })
    if (banned.test(c.whatMeans) || banned.test(c.whatNext)) { clean = false; offender = stage }
  }
  check(`no protected-basis language in any sensitive variant${clean ? "" : ` (offender: ${offender})`}`, clean)

  console.log("\n[Robustness]")
  check("unknown stage falls back to ACTIVE copy", resolveSellerStageCopy("nope").headline === SELLER_STAGE_MEANING.ACTIVE.headline)
  check("unknown stage + sensitive still returns ACTIVE (no override) safely", resolveSellerStageCopy("nope", { sensitive: true }).headline === SELLER_STAGE_MEANING.ACTIVE.headline)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SELLER_JOURNEY_COPY_FAIL"); process.exit(1) }
  console.log(" ✅ SELLER_JOURNEY_COPY_PASS — persona-adapted, lower-pressure for sensitive sellers, Fair-Housing safe")
}

main()
