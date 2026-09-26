#!/usr/bin/env tsx
/**
 * scripts/alert-cadence-snooze-simulator.ts   (npm run test:alert-cadence-snooze)
 * ─────────────────────────────────────────────────────────────────────────────
 * BUYER ALERT CADENCE + SNOOZE — proves the engine honors the buyer's chosen cadence (instant vs
 * daily vs weekly) and a temporary, AUTO-RESUMING snooze (skip while snoozed_until is future, then
 * resume on its own — the search is never deactivated). Pure: no I/O, deterministic clocks.
 *
 * WHERE THE CADENCE LIVES NOW. This file used to exercise a `shouldRunNow(frequency, now)` clock
 * inside lib/alerts/ — the second property-alert engine, which ran /api/alerts/cron on its own
 * schedule over the same three tables as lib/property-alerts/ and re-derived when each frequency
 * was due. Two clocks for one cadence is the drift; CRON_REGISTRY is the surviving one, calling
 * /api/property-alerts/run with the frequency it is due for. So the cadence assertions below are
 * made against the REGISTRY — the thing that actually fires — rather than a second copy of the
 * rule. The snooze, which the surviving engine did NOT honour, moved across and is pinned here.
 */
import { readFileSync } from "node:fs"
import { isSnoozed } from "../lib/property-alerts/alert-cadence"
import { alertListingType, PROPERTY_ALERT_LISTING_TYPES } from "../lib/property-alerts/alert-matcher"
import { CRON_REGISTRY, isDue } from "../lib/kernel/cron-dispatch"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// Fixed clocks (UTC): Monday 08:00, Tuesday 13:00, Tuesday 17:00.
const monday8   = new Date("2026-06-29T08:00:00Z") // getUTCDay()===1
const tues1pm   = new Date("2026-06-30T13:00:00Z")
const tues5pm   = new Date("2026-06-30T17:00:00Z")

/** The schedule the ONE registry declares for a given alert frequency. */
function scheduleFor(frequency: string): string | null {
  const entry = CRON_REGISTRY.find((e) => e.path === `/api/property-alerts/run?frequency=${frequency}`)
  return entry?.schedule ?? null
}
const runsAt = (frequency: string, at: Date) => {
  const s = scheduleFor(frequency)
  return s ? isDue(s, at) : false
}

function main() {
  console.log("\n[Cadence gate — the buyer's chosen frequency is honored by the ONE registry]")
  for (const f of ["instant", "daily", "weekly", "twice_daily"]) {
    check(`${f} has exactly one registry schedule (${scheduleFor(f) ?? "MISSING"})`, scheduleFor(f) !== null)
  }
  check("instant always runs (every 15 min)",
    runsAt("instant", monday8) && runsAt("instant", new Date("2026-06-30T13:15:00Z")))
  check("daily runs at 08:00 UTC", runsAt("daily", monday8) === true)
  check("daily does NOT run at 13:00", runsAt("daily", tues1pm) === false)
  check("twice_daily runs at 08 and 17", runsAt("twice_daily", monday8) && runsAt("twice_daily", tues5pm))
  check("twice_daily skips 13:00", runsAt("twice_daily", tues1pm) === false)
  check("weekly runs Monday 08:00", runsAt("weekly", monday8) === true)
  check("weekly skips Tuesday", runsAt("weekly", tues1pm) === false)
  check("an unknown frequency has no schedule, so it never fires (safe default)",
    runsAt("whenever", monday8) === false)

  console.log("\n[One engine — the second scheduled path is retired]")
  check("no /api/alerts/cron entry remains in the registry",
    !CRON_REGISTRY.some((e) => e.path === "/api/alerts/cron"))

  // ── Rental alerts ride the SAME engine (m657, lane 77C) ──────────────────
  // property_alerts.listing_type = 'rent' is swept by RentCast's RENTAL
  // endpoint only; a renter's monthly budget is never scored against for-sale
  // list prices, and the enrolment writer no longer skips renters.
  console.log("\n[Rental alerts — m657 listing_type, one engine, the rental source only]")
  check("the code-side vocabulary is exactly sale|rent (what m657's CHECK admits, sorted as the generator writes it)",
    JSON.stringify([...PROPERTY_ALERT_LISTING_TYPES]) === JSON.stringify(["rent", "sale"]))
  check("alertListingType: 'rent' → rent", alertListingType({ listing_type: "rent" }) === "rent")
  check("alertListingType: 'sale' / absent / null / unknown → sale (a pre-m657 row is a FOR-SALE search)",
    alertListingType({ listing_type: "sale" }) === "sale" && alertListingType({}) === "sale"
      && alertListingType({ listing_type: null }) === "sale" && alertListingType({ listing_type: "lease" }) === "sale")

  const search = stripComments(readFileSync("lib/property-alerts/idx-alert-search.ts", "utf8"))
  const rentBranch = /if \(alertListingType\(criteria\) === "rent"\) \{\s*return searchRentalsForAlert\(/.exec(search)
  const idxTier = search.indexOf("resolveListingSource(")
  check("idx-alert-search: a 'rent' alert is routed BEFORE any IDX/listing-source tier is consulted",
    !!rentBranch && idxTier > 0 && rentBranch.index < idxTier)
  const rentalFn = search.slice(search.indexOf("async function searchRentalsForAlert("))
  check("searchRentalsForAlert calls the RENTAL endpoint and never the sale endpoint, the IDX client or the for-sale listings table",
    rentalFn.length > 200 && /searchRentcastRentalListings\(/.test(rentalFn)
      && !/searchRentcastSaleListings\(/.test(rentalFn) && !/IDXBrokerClient/.test(rentalFn) && !/\.from\("listings"\)/.test(rentalFn))
  check("searchRentalsForAlert refuses (never records a zero) when no source / no area / every area failed",
    /refusal: "no_listing_source"/.test(rentalFn) && /refusal: "no_search_area"/.test(rentalFn) && /refusal: "provider_error"/.test(rentalFn))
  // POSITIVE CONTROL: the same scan flags a rental function that fell through to the sale endpoint.
  const leakyFixture = `async function searchRentalsForAlert(a, c, ctx, s) {\n  const rc = await searchRentcastRentalListings({ brokerageId: ctx.brokerageId })\n  if (!rc.listings.length) return searchRentcastSaleListings({ brokerageId: ctx.brokerageId })\n}`
  check("[control] a rental sweep that falls through to the SALE endpoint IS caught by the scan",
    /searchRentcastSaleListings\(/.test(leakyFixture.slice(leakyFixture.indexOf("async function searchRentalsForAlert("))))

  const tools = stripComments(readFileSync("lib/ai-isa/customer-context-tools.ts", "utf8"))
  const enroll = tools.slice(tools.indexOf("function buildSendMatchingListingsTool("))
  check("send_matching_listings enrols a renter too (no `!forRent` guard on the property_alerts insert) and writes listing_type from the rent/sale flag",
    !/ctx\.contactId && !forRent/.test(enroll) && /listing_type:\s*listingType/.test(enroll) && /forRent \? "rent" : "sale"/.test(enroll))
  check("send_matching_listings READS the enrolment insert's error (a PGRST204 before m657 applies is logged, not swallowed)",
    /error:\s*enrollError\s*\}\s*=\s*await svc\.from\("property_alerts"\)\.insert\(/.test(enroll) && /if \(enrollError\)/.test(enroll))

  console.log("\n[Snooze — temporary mute that auto-resumes, search never deactivated]")
  const future = new Date("2026-07-15T00:00:00Z").toISOString()
  const past   = new Date("2026-06-01T00:00:00Z").toISOString()
  check("snoozed_until in the future → snoozed (skip)", isSnoozed(future, tues1pm) === true)
  check("snoozed_until in the past → NOT snoozed (auto-resumed)", isSnoozed(past, tues1pm) === false)
  check("null → not snoozed (default)", isSnoozed(null, tues1pm) === false)
  check("empty string → not snoozed", isSnoozed("", tues1pm) === false)
  check("garbage timestamp → not snoozed (never silently mutes forever)", isSnoozed("not-a-date", tues1pm) === false)

  console.log("\n[Combined: a daily search snoozed today is skipped even at its run hour]")
  const eligible = (freq: string, snooze: string | null, now: Date) => runsAt(freq, now) && !isSnoozed(snooze, now)
  check("daily @08:00 but snoozed → skipped", eligible("daily", future, monday8) === false)
  check("daily @08:00 not snoozed → runs", eligible("daily", null, monday8) === true)
  check("daily @08:00 snooze expired → runs again (auto-resume)", eligible("daily", past, monday8) === true)

  console.log("\n[The surviving engine actually APPLIES the snooze it inherited]")
  const engine = stripComments(readFileSync("lib/property-alerts/alert-engine.ts", "utf8"))
  check("runAlert refuses a snoozed alert", /isSnoozed\(\(alert as any\)\.snoozed_until\)/.test(engine))
  check("runAllActiveAlerts filters snoozed alerts out of the batch",
    /!isSnoozed\(a\.snoozed_until, now\)/.test(engine))
  check("the per-run cap reports what it deferred instead of dropping it silently",
    /RUN_BATCH_LIMIT/.test(engine) && /deferred to the next run/.test(engine))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ALERT_CADENCE_SNOOZE_FAIL"); process.exit(1) }
  console.log(" ✅ ALERT_CADENCE_SNOOZE_PASS — one engine, one clock; buyer snooze auto-resumes and is honoured")
}

main()
