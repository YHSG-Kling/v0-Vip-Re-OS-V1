#!/usr/bin/env tsx
/**
 * scripts/lead-signal-ingest-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the PURE core behind the now-wired lead-signal-ingest server actions:
 *
 *   • interestLevelToSignalScale() — the mapping used when converting an
 *     open-house attendee to a contact (seller-open-house.ts) to translate the
 *     stored "hot"/"warm"/"cold" interest_level into the 1..5 signal scale.
 *   • buildOfferLostSignal / buildOpenHouseAttendeeSignal — the SignalDelta
 *     builders the actions delegate to (offer-lost wired into rejectOffer,
 *     open-house wired into convertAttendeeToContact).
 *
 * Pure functions only — no DB, no mocks. Real assertions.
 *
 * Run: npx tsx scripts/lead-signal-ingest-simulator.ts
 */
// ── test-only shim ──────────────────────────────────────────────────────────
// signal-extensions.ts imports `server-only` (it also exports the pure DB-free
// builders we test here). Neutralize the require-cache entry BEFORE importing it
// so the pure builders load outside a Server Component.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
// ─────────────────────────────────────────────────────────────────────────────

import { interestLevelToSignalScale } from "../lib/lead-intelligence/interest-level"

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
  console.log(" ✅ Lead-signal-ingest pure core verified.")
  console.log(" LEAD_SIGNAL_INGEST_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead signal ingest simulator")
  console.log("══════════════════════════════════════════════════\n")

  // Loaded dynamically AFTER the server-only shim above has executed.
  const { buildOfferLostSignal, buildOpenHouseAttendeeSignal } = await import(
    "../lib/lead-intelligence/signal-extensions"
  )

  console.log("[interestLevelToSignalScale]")
  check("'hot' → 5", interestLevelToSignalScale("hot") === 5)
  check("'warm' → 3", interestLevelToSignalScale("warm") === 3)
  check("'cold' → 1", interestLevelToSignalScale("cold") === 1)
  check("case/space insensitive ('  HOT ')", interestLevelToSignalScale("  HOT ") === 5)
  check("numeric string '4' → 4", interestLevelToSignalScale("4") === 4)
  check("raw number 2 → 2", interestLevelToSignalScale(2) === 2)
  check("numeric above range 9 clamps → 5", interestLevelToSignalScale(9) === 5)
  check("numeric below range 0 clamps → 1", interestLevelToSignalScale(0) === 1)
  check("null → undefined (builder default)", interestLevelToSignalScale(null) === undefined)
  check("undefined → undefined", interestLevelToSignalScale(undefined) === undefined)
  check("empty string → undefined", interestLevelToSignalScale("") === undefined)
  check("unknown label → undefined", interestLevelToSignalScale("lukewarm") === undefined)

  console.log("\n[buildOpenHouseAttendeeSignal]")
  const hotAttendee = buildOpenHouseAttendeeSignal({
    contactId: "c1", attendeeId: "a1", listingId: "L1", interestLevel: 5,
  })
  check("source is open_house_attendee", hotAttendee.source === "open_house_attendee")
  check("hot interest only pushes UP (positive boosts)",
    (hotAttendee.boosts.overall ?? 0) > 0 && (hotAttendee.boosts.engagement ?? 0) > 0 && (hotAttendee.boosts.intent ?? 0) > 0)
  check("interest 5 → readiness hot", hotAttendee.setReadinessAtLeast === "hot")
  check("evidenceId carries attendeeId", hotAttendee.evidenceId === "a1")
  check("evidence carries listingId + interest", (hotAttendee.evidence as any)?.listingId === "L1" && (hotAttendee.evidence as any)?.interestLevel === 5)

  const defaultAttendee = buildOpenHouseAttendeeSignal({
    contactId: "c2", attendeeId: "a2", listingId: "L2",
  })
  check("missing interest defaults to 3 → readiness warming", defaultAttendee.setReadinessAtLeast === "warming")
  check("default attendee engagement boost = 6 + 3*2 = 12", defaultAttendee.boosts.engagement === 12)

  const coolAttendee = buildOpenHouseAttendeeSignal({
    contactId: "c3", attendeeId: "a3", listingId: "L3", interestLevel: 1,
  })
  check("interest 1 → no readiness override (undefined)", coolAttendee.setReadinessAtLeast === undefined)

  console.log("\n[buildOfferLostSignal]")
  const offerLost = buildOfferLostSignal({ contactId: "c4", offerId: "o1", offerAmount: 525000 })
  check("source is offer_lost", offerLost.source === "offer_lost")
  check("offer lost forces readiness hot", offerLost.setReadinessAtLeast === "hot")
  check("offer lost boosts intent + motivation",
    (offerLost.boosts.intent ?? 0) > 0 && (offerLost.boosts.motivation ?? 0) > 0)
  check("reason includes formatted amount", offerLost.reason.includes("$525,000"))
  check("evidenceId carries offerId", offerLost.evidenceId === "o1")

  const offerLostNoAmount = buildOfferLostSignal({ contactId: "c5", offerId: "o2", offerAmount: 0 })
  check("zero amount → 'amount unknown' reason", offerLostNoAmount.reason.includes("amount unknown"))

  report()
}

main()
