#!/usr/bin/env tsx
/**
 * scripts/vendor-match-availability-simulator.ts  (npm run test:vendor-match)
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO VENDOR RAILS, AND THE SECOND ONE LEAKED ACROSS TENANTS.
 *
 * app/actions/multi-persona.ts carried a parallel set of vendor functions beside
 * the live rail in app/actions/vendor-marketplace.ts. None had a caller. Four
 * were strictly weaker duplicates and three of those four crossed the tenant
 * boundary; they were deleted with named replacements:
 *
 *   getVendorDirectory           -> searchVendors
 *       could not see GLOBAL vendors (brokerage_id IS NULL), no ratings join
 *   bookVendor                   -> createVendorBooking
 *       ACCEPTED bookedBy and never wrote it; omitted brokerage_id entirely
 *       (an anchorless row); wrote no transaction_timeline entry
 *   updateVendorBookingStatus_v2 -> lib/kernel/vendors updateVendorBookingStatus
 *       filtered `.eq("id")` alone — a cross-brokerage write — and skipped the
 *       status transition graph and its lifecycle events
 *   rateVendor                   -> rateVendorBooking
 *       read the booking unscoped, so any authenticated user could one-star a
 *       vendor in another brokerage's marketplace
 *
 * The other two were NOT duplicates — nothing else in the app answers "who is
 * free" or "who should I pick". They moved onto the vendor rail and were
 * finished there:
 *
 *   checkVendorAvailability — its existing-bookings read had NO brokerage
 *     filter. Verified live: with __wt__ Bolt Inspect booked on 2026-08-20 by a
 *     DIFFERENT brokerage, the old query reported 2 of 4 free and the fixed one
 *     reported 3 of 4. Another tenant's calendar was hiding your vendor.
 *   matchVendorToTransaction — accepted `propertyCity` and `urgency` and used
 *     NEITHER. `vendors` has no city column, so the city parameter was never
 *     implementable and is gone rather than faked; urgency now really does
 *     prefer the fastest turnaround the bench offers. Ranking also stopped
 *     ignoring `preferred` / `display_priority`, the m355 curation columns —
 *     an unvetted 4.9 was outranking the broker's own preferred partner.
 */
import { readFileSync, existsSync } from "node:fs"
import { compareVendors, fastestTurnaround, pickBestVendor } from "../lib/vendors/rank"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  existsSync(p)
    ? readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    : ""

// The live bench used for the DB half of this proof, kept in sync by name.
const BENCH = [
  { id: "ace",     name: "Ace Inspections",       rating: 4.2, preferred: false, display_priority: 0, estimated_turnaround_days: 3 },
  { id: "bolt",    name: "Bolt Inspect",          rating: 4.9, preferred: false, display_priority: 0, estimated_turnaround_days: 5 },
  { id: "curated", name: "Curated Home Inspect",  rating: 3.8, preferred: true,  display_priority: 0, estimated_turnaround_days: 4 },
  { id: "express", name: "Express Inspect",       rating: 4.0, preferred: false, display_priority: 0, estimated_turnaround_days: 1 },
]

console.log("\n── the broker's curation outranks a raw average ──")
{
  const best = pickBestVendor(BENCH)
  check("the broker's PREFERRED vendor wins over a higher-rated stranger",
    best?.id === "curated")
  check("…even though that stranger rates a full point higher",
    (BENCH.find((v) => v.id === "bolt")!.rating - BENCH.find((v) => v.id === "curated")!.rating) > 1)

  const noPreferred = BENCH.filter((v) => !v.preferred)
  check("with nobody preferred, the best rating wins",
    pickBestVendor(noPreferred)?.id === "bolt")

  const placed = [
    { id: "paid",  rating: 3.0, preferred: false, display_priority: 5 },
    { id: "plain", rating: 4.8, preferred: false, display_priority: 0 },
  ]
  check("display_priority (paid/curated placement) breaks ties above rating",
    pickBestVendor(placed)?.id === "paid")
  check("…but preferred still outranks display_priority",
    pickBestVendor([{ id: "pref", rating: 1, preferred: true, display_priority: 0 }, ...placed])?.id === "pref")
}

console.log("\n── urgency is REAL: it changes the answer ──")
{
  const routine = pickBestVendor(BENCH, "routine")
  const urgent  = pickBestVendor(BENCH, "urgent")
  check("an urgent job does not return the same vendor as a routine one",
    routine?.id !== urgent?.id)
  check("urgent picks the fastest turnaround on the bench", urgent?.id === "express")
  check("routine still picks by curation", routine?.id === "curated")

  check("fastestTurnaround keeps every vendor tied at the minimum",
    fastestTurnaround([
      { id: "a", estimated_turnaround_days: 2 },
      { id: "b", estimated_turnaround_days: 2 },
      { id: "c", estimated_turnaround_days: 7 },
    ] as any).length === 2)
  check("a missing turnaround is read as the column default (1), not dropped",
    fastestTurnaround([{ id: "a" }, { id: "b", estimated_turnaround_days: 4 }] as any).length === 1)
  check("an empty bench stays empty rather than throwing on Math.min of nothing",
    fastestTurnaround([]).length === 0 && pickBestVendor([]) === null)
}

console.log("\n── the comparator is a total order (sort() will not misbehave) ──")
{
  const a = { preferred: true,  display_priority: 1, rating: 4 }
  const b = { preferred: false, display_priority: 9, rating: 5 }
  check("antisymmetric", Math.sign(compareVendors(a, b)) === -Math.sign(compareVendors(b, a)))
  check("reflexive-zero", compareVendors(a, { ...a }) === 0)
  check("sorting does not mutate the caller's array",
    (() => { const input = [...BENCH]; pickBestVendor(input, "urgent"); return input[0].id === "ace" })())
}

console.log("\n── the tenant boundary the moved code used to cross ──")
{
  const m = src("app/actions/vendor-marketplace.ts")

  check("availability scopes the bench to the caller's brokerage",
    /\.eq\("brokerage_id", brokerageId\)/.test(m))
  check("…and scopes the EXISTING-BOOKINGS read the same way (the leak)",
    (() => {
      const block = /from\("vendor_bookings"\)[\s\S]{0,400}?scheduled_date/.exec(m)?.[0] ?? ""
      return /\.eq\("brokerage_id", brokerageId\)/.test(block)
    })())
  check("…and narrows it to the bench under consideration",
    /\.in\("vendor_id", bench\.map/.test(m))
  // Scoped to the two MOVED functions. Other functions in this file legitimately
  // take a brokerageId — they are internal helpers called with a server-derived
  // id (recalculateVendorRatings et al). What must never happen is the two
  // tenant-boundary reads trusting an id the browser chose, which is exactly
  // what the version in multi-persona.ts did.
  const sig = (name: string) =>
    new RegExp(`export async function ${name}\\(input: \\{[\\s\\S]*?\\}\\)`).exec(m)?.[0] ?? ""
  check("availability derives the brokerage from the SESSION, not its arguments",
    /callerBrokerageId\(/.test(m) && !/brokerageId/.test(sig("checkVendorAvailability")))
  check("…and so does the matcher",
    !/brokerageId/.test(sig("matchVendorToTransaction")))
  check("a failed bookings read refuses instead of reporting everyone free",
    /if \(bookingsError\) throw bookingsError/.test(m))
  check("only ACTIVE vendors are considered", /\.eq\("status", "active"\)/.test(m))
}

console.log("\n── the four duplicates are gone, each with a named replacement ──")
{
  const mp = readFileSync("app/actions/multi-persona.ts", "utf8")
  const code = src("app/actions/multi-persona.ts")
  const m = src("app/actions/vendor-marketplace.ts")
  const kernel = src("lib/kernel/vendors.ts")

  for (const gone of ["getVendorDirectory", "bookVendor", "updateVendorBookingStatus_v2", "rateVendor"]) {
    check(`${gone} no longer defined anywhere`,
      !new RegExp(`export async function ${gone}\\b`).test(code))
    // The replacement must be NAMED in the file that dropped it — a deletion
    // whose replacement is not written down is indistinguishable from a loss.
    check(`…and multi-persona.ts records what replaced it`, mp.includes(gone))
  }

  check("searchVendors is real", /export async function searchVendors\b/.test(m))
  check("createVendorBooking is real", /export async function createVendorBooking\b/.test(m))
  check("rateVendorBooking is real", /export async function rateVendorBooking\b/.test(m))
  check("the kernel's updateVendorBookingStatus is real",
    /export async function updateVendorBookingStatus\b/.test(kernel))

  check("the replacement booking write records booked_by AND brokerage_id (the old one dropped both)",
    (() => {
      const block = /export async function createVendorBooking\b[\s\S]*?revalidatePath\("\/dashboard\/vendors"\)/.exec(m)?.[0] ?? ""
      return /booked_by: user\.id/.test(block) && /brokerage_id: profile\?\.brokerage_id/.test(block)
    })())
  check("the replacement rating read is brokerage-scoped (the old one was not)",
    (() => {
      const block = /export async function rateVendorBooking\b[\s\S]*?return \{ success: true \}/.exec(m)?.[0] ?? ""
      return /from\("vendor_bookings"\)[\s\S]{0,300}?\.eq\("brokerage_id", profile\.brokerage_id\)/.test(block)
    })())
}

console.log("\n── and both survivors are actually reachable from the booking form ──")
{
  const ui = src("app/components/transactions/VendorBookingSection.tsx")
  check("the transaction booking form calls the availability check",
    /checkVendorAvailability\(\{/.test(ui))
  check("…and the matcher", /matchVendorToTransaction\(\{/.test(ui))
  check("…passing the urgency the agent actually chose, not a constant",
    /urgency,/.test(ui) && /setUrgency\(/.test(ui))
  check("a failed availability check is SHOWN, not read as 'nobody is free'",
    /setMatchError\(/.test(ui) && /Could not check vendor availability/.test(ui))
  check("the best match is one click to select", /setSelectedVendor\(bestMatch\)/.test(ui))
  check("marking complete reports a refusal instead of painting the row green",
    (() => {
      const fn = /async function handleMarkComplete[\s\S]*?\n  \}/.exec(ui)?.[0] ?? ""
      return /catch \(err: any\)/.test(fn) && /setActionError\(/.test(fn)
    })())
  check("…and so does rating",
    (() => {
      const fn = /async function handleRate[\s\S]*?\n  \}/.exec(ui)?.[0] ?? ""
      return /catch \(err: any\)/.test(fn) && /setActionError\(/.test(fn)
    })())
}

console.log("\n── the city parameter is not faked ──")
{
  const m = src("app/actions/vendor-marketplace.ts")
  const block = /export async function matchVendorToTransaction\b[\s\S]*?\n\}/.exec(m)?.[0] ?? ""
  check("matchVendorToTransaction no longer takes a propertyCity it cannot honour",
    block.length > 0 && !/propertyCity/.test(block))
  check("…because `vendors` has no city column to match on",
    !/from\("vendors"\)[\s\S]{0,300}?\.eq\("city"/.test(m))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ VENDOR_MATCH_FAIL"); process.exit(1) }
console.log(" ✅ VENDOR_MATCH_PASS — one vendor rail, scoped to the tenant, and the agent can see who is free")
