#!/usr/bin/env tsx
/**
 * scripts/offer-email-intake-simulator.ts   (npm run test:offer-email-intake)
 * ─────────────────────────────────────────────────────────────────────────────
 * EMAIL → OFFER LOOKOUT — proves the inbound-email offer detector: recognizes an offer by signals,
 * matches it to an in-house listing by street number + name (not the sender), and gates conservatively
 * (auto only when the buyer is a known contact; else confirm; else skip). Never fabricates an offer.
 * Pure: no I/O.
 */
import { looksLikeOffer, matchListingByAddress, assessOfferIntake, type ListingLite } from "../lib/inbound-mail/offer-detect"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const listings: ListingLite[] = [
  { id: "L1", address: "123 Oak Street, Austin, TX 78704", agent_id: "A1" },
  { id: "L2", address: "9 Elm Ct", agent_id: "A2" },
]

function main() {
  console.log("\n[Offer signal detection]")
  check("'Purchase Agreement' subject → offer", looksLikeOffer("Purchase Agreement for your listing", null, null))
  check("'offer to purchase' body → offer", looksLikeOffer(null, null, "Please find attached our offer to purchase."))
  check("RPA filename → offer", looksLikeOffer(null, "CAR_RPA_signed.pdf", null))
  check("plain newsletter → NOT an offer", looksLikeOffer("Monthly market update", "flyer.pdf", "Here's what's happening") === false)

  console.log("\n[Address match — street number + name, not the sender]")
  check("body mentioning '123 Oak' → matches L1", matchListingByAddress("We'd like to offer on 123 Oak St", listings)?.id === "L1")
  check("subject with '9 Elm' → matches L2", matchListingByAddress("Offer — 9 Elm Court", listings)?.id === "L2")
  check("wrong number '125 Oak' → no match", matchListingByAddress("125 Oak Street", listings) === null)
  check("no address → no match", matchListingByAddress("our client is interested", listings) === null)

  console.log("\n[Confidence gate — conservative, confirm-first]")
  check("offer + listing + KNOWN buyer → auto", assessOfferIntake({ looksLikeOffer: true, listingMatched: true, senderIsKnownContact: true }) === "auto")
  check("offer + listing + UNKNOWN buyer (outside agent) → confirm", assessOfferIntake({ looksLikeOffer: true, listingMatched: true, senderIsKnownContact: false }) === "confirm")
  check("looks like offer but NO listing match → skip", assessOfferIntake({ looksLikeOffer: true, listingMatched: false, senderIsKnownContact: true }) === "skip")
  check("listing match but NOT offer-shaped → skip", assessOfferIntake({ looksLikeOffer: false, listingMatched: true, senderIsKnownContact: false }) === "skip")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ OFFER_EMAIL_INTAKE_FAIL"); process.exit(1) }
  console.log(" ✅ OFFER_EMAIL_INTAKE_PASS — the listing-agent email lookout detects offers by address, gates safely (confirm-first)")
}

main()
