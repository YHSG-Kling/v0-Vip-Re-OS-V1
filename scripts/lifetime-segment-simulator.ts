#!/usr/bin/env tsx
/**
 * scripts/lifetime-segment-simulator.ts   (npm run test:lifetime-segment)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the lifetime nurture-lane split (lifetimeCardPlan): a local_owner sees
 * the home-ownership cards (wealth / maintenance / next-move / ask-your-home); a
 * relocated past client does NOT (they can't use them) and instead gets the
 * referral-out + stay-in-touch lane. Relationship cards (referral/testimonial)
 * show for both. Segment normalization is defensive. Pure: no I/O.
 */
import { normalizeLifetimeSegment, isRelocatedSegment, lifetimeCardPlan } from "../lib/portal/lifetime-segment"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[segment normalization is defensive]")
  check("'relocated' → relocated", normalizeLifetimeSegment("relocated") === "relocated")
  check("'local_owner' → local_owner", normalizeLifetimeSegment("local_owner") === "local_owner")
  check("null → local_owner (default)", normalizeLifetimeSegment(null) === "local_owner")
  check("garbage → local_owner", normalizeLifetimeSegment("whatever") === "local_owner")
  check("isRelocatedSegment true only for relocated", isRelocatedSegment("relocated") && !isRelocatedSegment("local_owner") && !isRelocatedSegment(undefined))

  console.log("\n[local owner sees the home-ownership lane]")
  const owner = lifetimeCardPlan("local_owner")
  check("wealth story on", owner.showWealthStory)
  check("maintenance on", owner.showMaintenance)
  check("next move on", owner.showNextMove)
  check("ask your home on", owner.showAskYourHome)
  check("relocation referral OFF", !owner.showRelocationReferral)
  check("stay-in-touch OFF", !owner.showStayInTouch)

  console.log("\n[relocated client gets the referral-out lane, not the owner cards]")
  const reloc = lifetimeCardPlan("relocated")
  check("wealth story OFF", !reloc.showWealthStory)
  check("maintenance OFF", !reloc.showMaintenance)
  check("next move OFF", !reloc.showNextMove)
  check("ask your home OFF", !reloc.showAskYourHome)
  check("relocation referral ON", reloc.showRelocationReferral)
  check("stay-in-touch ON", reloc.showStayInTouch)

  console.log("\n[relationship cards show for BOTH segments]")
  check("referral ask both", owner.showReferralAsk && reloc.showReferralAsk)
  check("testimonial both", owner.showTestimonial && reloc.showTestimonial)

  console.log("\n[no owner-only card leaks to a relocated client]")
  const ownerOnly: (keyof typeof reloc)[] = ["showWealthStory", "showMaintenance", "showNextMove", "showAskYourHome"]
  check("every owner-only card is off when relocated", ownerOnly.every((k) => reloc[k] === false))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LIFETIME_SEGMENT_FAIL"); process.exit(1) }
  console.log(" ✅ LIFETIME_SEGMENT_PASS — owner vs relocated nurture lanes split cleanly")
}
main()
