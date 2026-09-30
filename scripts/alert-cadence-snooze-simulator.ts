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
 *
 * LANE 91C — the SEND LEDGER and RECENCY. Owner: the alert cron sends only NEW or price-changed
 * listings since the last send (no repeats), and "we should only pull more recent data". The pure
 * rule (alert-cadence.ts selectNewOrRepricedMatches) is driven through consecutive sweeps against a
 * ledger that enforces the LIVE UNIQUE (alert_id, mls_number); the pre-91 rule is run through the
 * same ledger as the positive control (it misses a RentCast cut and collides on a flagged one).
 * The recency window (alertListingRecencyDays) is pinned per alert shape.
 */
import { readFileSync } from "node:fs"
import {
  isSnoozed, selectNewOrRepricedMatches, alertListingRecencyDays,
  BUYER_LISTING_RECENCY_DAYS, ALERT_PRICE_WATCH_DAYS, type SentAlertRow,
} from "../lib/property-alerts/alert-cadence"
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

  sendLedgerLayer(engine)
  recencyLayer()

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ALERT_CADENCE_SNOOZE_FAIL"); process.exit(1) }
  console.log(" ✅ ALERT_CADENCE_SNOOZE_PASS — one engine, one clock; buyer snooze auto-resumes and is honoured")
}

// ─── Lane 91C — owner: the property-alert cron sends only NEW or price-changed
// listings since the last send (no repeats). Proved by driving the pure ledger
// rule through consecutive sweeps against a ledger that enforces the LIVE
// constraint: UNIQUE (alert_id, mls_number). ─────────────────────────────────

type Home = { mls_number: string; property_address: string; list_price: number }

/** A ledger with the live UNIQUE (alert_id, mls_number) — an insert of an
 *  existing key THROWS, exactly as the database refuses it (23505). */
class UniqueLedger {
  rows = new Map<string, SentAlertRow>()
  insert(h: Home) {
    if (this.rows.has(h.mls_number)) throw new Error(`23505 duplicate key (alert_id, mls_number)=${h.mls_number}`)
    this.rows.set(h.mls_number, { mls_number: h.mls_number, list_price: h.list_price, property_address: h.property_address })
  }
  update(key: string, h: Home) {
    const prev = this.rows.get(key)
    if (!prev) return 0
    this.rows.delete(key)
    this.rows.set(h.mls_number, { ...prev, mls_number: h.mls_number, list_price: h.list_price, property_address: h.property_address })
    return 1
  }
  list() { return [...this.rows.values()] }
}

/** One sweep exactly as alert-engine.ts runs it: decide, record (insert new /
 *  update repriced), deliver only what was recorded. Returns what was mailed. */
function sweep(ledger: UniqueLedger, homes: Home[], crit: { include_price_reductions?: boolean; price_reduction_min_percent?: number } = {}) {
  const decisions = selectNewOrRepricedMatches(homes, ledger.list(), crit)
  const mailed: string[] = []
  for (const d of decisions) {
    if (d.kind === "new") { ledger.insert(d.item); mailed.push(`new:${d.item.mls_number}`) }
    else if (ledger.update(d.ledgerKey, d.item) === 1) mailed.push(`cut:${d.item.mls_number}@${d.previousPrice}->${d.item.list_price}`)
  }
  return mailed
}

function sendLedgerLayer(engine: string) {
  console.log("\n[Send ledger — only NEW or PRICE-REDUCED since the last send, never a repeat]")
  const A = { mls_number: "rentcast-A", property_address: "1 Elm St, Frisco, TX", list_price: 450000 }
  const B = { mls_number: "rentcast-B", property_address: "2 Oak Ave, Frisco, TX", list_price: 430000 }
  const C = { mls_number: "internal-C", property_address: "3 Pine Rd, Frisco, TX", list_price: 440000 }
  const L = new UniqueLedger()
  const run1 = sweep(L, [A, B, C])
  check("sweep 1: all three homes are new and sent", run1.length === 3)
  const run2 = sweep(L, [A, B, C])
  check("sweep 2: same market, NOTHING re-sent (no repeats)", run2.length === 0)
  const Acut = { ...A, list_price: 427500 }         // −5% → a real reduction
  const Bnudge = { ...B, list_price: 426000 }       // −0.93% → under the 2% threshold
  const Crise = { ...C, list_price: 455000 }        // a rise → not news to a buyer
  const D = { mls_number: "rentcast-D", property_address: "4 Birch Ln, Frisco, TX", list_price: 445000 }
  const run3 = sweep(L, [Acut, Bnudge, Crise, D])
  check("sweep 3: the 5% cut is sent as a REDUCTION from the price the buyer last saw", run3.includes("cut:rentcast-A@450000->427500"))
  check("sweep 3: the new listing is sent", run3.includes("new:rentcast-D"))
  check("sweep 3: a sub-threshold nudge and a price RISE are not sent", run3.length === 2)
  const run4 = sweep(L, [Acut, Bnudge, Crise, D])
  check("sweep 4: the same reduction is NEVER sent twice (the ledger row now holds 427,500)", run4.length === 0)
  const Acut2 = { ...A, list_price: 405000 }
  check("sweep 5: a SECOND reduction on the same home is sent (measured from the last-sent price)", sweep(L, [Acut2]).join() === "cut:rentcast-A@427500->405000")
  const alias = { mls_number: "idx-99", property_address: "2 OAK AVE,  Frisco TX", list_price: 430000 }
  check("the same home under another source's key (same address) is NOT new", sweep(L, [alias]).length === 0)
  check("price reductions switched off → a cut is not sent", selectNewOrRepricedMatches([{ ...D, list_price: 400000 }], L.list(), { include_price_reductions: false }).length === 0)
  const dismissed: SentAlertRow[] = [{ mls_number: "rentcast-D", list_price: 445000, property_address: D.property_address, buyer_dismissed: true }]
  check("a home the buyer DISMISSED is not re-sent on a price cut", selectNewOrRepricedMatches([{ ...D, list_price: 400000 }], dismissed, {}).length === 0)
  check("two copies of one home in one sweep → sent once", selectNewOrRepricedMatches([D, { ...D, mls_number: "idx-D" }], [], {}).length === 1)

  // POSITIVE CONTROL — the PRE-91 rule, driven through the same unique ledger,
  // exhibits both defects this lane fixed: a RentCast cut is never seen (no
  // provider flag), and a flagged cut is a second INSERT that the live UNIQUE
  // key refuses — which refused the whole batch and made every home repeat.
  const oldRule = (homes: Array<Home & { is_price_reduction?: boolean }>, sent: Map<string, { is_price_reduction: boolean }>) =>
    homes.filter((h) => { const p = sent.get(h.mls_number); return !p || (h.is_price_reduction && !p.is_price_reduction) })
  const oldSent = new Map([[A.mls_number, { is_price_reduction: false }]])
  check("[control] old rule: a RentCast price cut (no provider flag) is NEVER sent", oldRule([Acut], oldSent).length === 0)
  const L2 = new UniqueLedger(); L2.insert(A)
  let refused = false
  try { for (const h of oldRule([{ ...Acut, is_price_reduction: true }], oldSent)) L2.insert(h) } catch { refused = true }
  check("[control] old rule: a flagged cut re-INSERTED hits the UNIQUE key (23505) — the batch-refusal defect", refused)

  console.log("\n[The engine applies the ledger rule — stripped source]")
  check("engine dedups through selectNewOrRepricedMatches (the pure rule above)", /selectNewOrRepricedMatches\(/.test(engine))
  check("the ledger read's ERROR is read and the run REFUSES (a refused read never becomes 'nothing sent yet')",
    /error:\s*ledgerError\s*\}\s*=\s*await supabase\s*\.from\("property_alert_results"\)/.test(engine) && /if \(ledgerError\)\s*\{[\s\S]{0,600}success:\s*false/.test(engine))
  check("a repriced home is an UPDATE of its one ledger row (never a second insert), counted with .select()",
    /\.update\(\{\s*\.\.\.ledgerRow\(p\)[\s\S]{0,200}\.eq\("mls_number", p\.__ledgerKey!\)\s*\.select\("id"\)/.test(engine))
  check("delivery is handed ONLY what the ledger recorded",
    /deliverAlertResults\(alert, recorded,/.test(engine) && !/deliverAlertResults\(alert, capped,/.test(engine))
  // POSITIVE CONTROL for the delivery finder: the pre-91 call shape is recognised.
  check("[control] the finder recognises the pre-91 'deliver everything' shape", /deliverAlertResults\(alert, capped,/.test("await deliverAlertResults(alert, capped, brokerageId, batchId)"))
}

function recencyLayer() {
  console.log("\n[Recency — every alert pull is windowed (owner: 'only pull more recent data')]")
  const now = new Date("2026-09-30T08:00:00Z")
  check(`price-watching alert (default) → ${ALERT_PRICE_WATCH_DAYS}-day window (a cut lands on a listing that has sat)`,
    alertListingRecencyDays({}, now) === ALERT_PRICE_WATCH_DAYS)
  check("new-listings-only alert, last run yesterday → 2 days (1 day + 1 overlap)",
    alertListingRecencyDays({ include_price_reductions: false, last_run_at: "2026-09-29T08:00:00Z" }, now) === 2)
  check(`new-listings-only alert never run → the buyer window (${BUYER_LISTING_RECENCY_DAYS} days)`,
    alertListingRecencyDays({ include_price_reductions: false, last_run_at: null }, now) === BUYER_LISTING_RECENCY_DAYS)
  check("a long-dormant new-listings-only alert is capped at the buyer window",
    alertListingRecencyDays({ include_price_reductions: false, last_run_at: "2026-01-01T00:00:00Z" }, now) === BUYER_LISTING_RECENCY_DAYS)
  check("the buyer's OWN max_days_on_market wins", alertListingRecencyDays({ max_days_on_market: 14 }, now) === 14)
  check("every window is ≥ 1 day (RentCast's daysOld minimum)",
    alertListingRecencyDays({ include_price_reductions: false, last_run_at: now.toISOString() }, now) >= 1)
}

main()
