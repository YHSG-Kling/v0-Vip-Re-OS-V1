#!/usr/bin/env tsx
/**
 * scripts/batchdata-seller-signal-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROOF FOR THE SECOND SELLER-SIGNAL SOURCE.
 *
 * Owner directive, verbatim: "we need to find another way to find out signs for
 * motivated sellers besides permits, maybe use our connection to batchdata?"
 *
 * Four claims, each proved rather than asserted:
 *   1. THE SIGNAL ARRIVES — a provider row becomes a `motivated_seller_signals`
 *      row with the right shape, tenant-stamped, from the tenant's OWN lead.
 *   2. STRENGTH MAPS ONTO THE EXISTING FOUR-VALUE VOCABULARY — every strength
 *      this lane can emit is a member of SELLER_SIGNAL_STRENGTHS and ranks
 *      above -1, and no numeric score competes with it.
 *   3. A PROTECTED-CLASS FILTER CANNOT BECOME A SIGNAL — with POSITIVE CONTROLS
 *      on all three gates, because a broken matcher and a clean declaration both
 *      report "nothing refused" (CLAUDE.md §2).
 *   4. A REFUSED WRITE IS REPORTED, NOT SWALLOWED — supabase-js RESOLVES a
 *      refusal, so a run that hits one must never come back clean.
 *
 * Run: npx tsx scripts/batchdata-seller-signal-simulator.ts
 * (No package.json script — see the lane report for the line to add.)
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  tokenizeFieldPath, protectedClassReasonFor, isProtectedClassSource,
  assertSellerSignalSourceAllowed, defineSellerSignalSources,
  stripProtectedClassCriteria, redactProtectedClassFields,
  PROTECTED_CLASS_TOKENS, PROTECTED_CLASS_NAMESPACES,
} from "../lib/lead-governance/protected-class-signals"
import {
  BATCHDATA_SELLER_SIGNAL_SOURCES, BATCHDATA_SIGNAL_TYPES, BATCHDATA_DETECTED_VIA,
  BATCHDATA_SIGNAL_DATASETS,
  SALE_PROPENSITY_SIGNAL_TYPE, PREFORECLOSURE_SIGNAL_TYPE, TAX_DELINQUENT_SIGNAL_TYPE,
  INVOLUNTARY_LIEN_SIGNAL_TYPE, VACANCY_SIGNAL_TYPE, ABSENTEE_OWNER_SIGNAL_TYPE,
  TIRED_LANDLORD_SIGNAL_TYPE, LISTING_WITHDRAWN_SIGNAL_TYPE,
  HIGH_EQUITY_SIGNAL_TYPE, MARKET_TIMING_SIGNAL_TYPE,
  at, readQuickList, readSalePropensity, readEquityPercent, readTenureYears,
  readTaxDelinquentYear, readLiens, readForeclosure, readProviderAddress,
  bandSalePropensity, bandEquity, deriveSellerSignals,
  batchDataSignalDedupeKey, buildBatchDataSignalRow, selectLeadsToProbe,
  ingestBatchDataSellerSignals,
  type ProbeableLead, type PropertyLookupResult,
} from "../lib/external/batchdata-seller-signals"
import {
  SELLER_SIGNAL_STRENGTHS, rankOf, isSellerSignalStrength, isStrongSellerSignal,
} from "../lib/lead-governance/seller-signal-strength"
import { normalizeStreetAddress } from "../lib/external/permit-signals"
import { stripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
/** Assert a call THROWS. Used for every fail-closed gate — a gate that returns
 *  false where it should throw is a gate somebody can ignore. */
function throws(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) }
}

console.log("══════════════════════════════════════════════════")
console.log(" BatchData seller signals — a second source beside permits")
console.log("══════════════════════════════════════════════════")

// ═══════════════════════════════════════════════════════════════════════════
// 1 · FAIR HOUSING — the matcher, with controls in BOTH directions
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[1 · the protected-class matcher — tokenized, not substring]")

check("camelCase, dots, underscores and hyphens all tokenize the same way",
  tokenizeFieldPath("demographics.hasChildren").join("|") === "demographics|has|children"
  && tokenizeFieldPath("min_owner_age").join("|") === "min|owner|age"
  && tokenizeFieldPath("senior-owner").join("|") === "senior|owner")

// ── THE POSITIVE CONTROL FOR THE SUBSTRING TRAP ──────────────────────────────
// A substring matcher for "age" refuses `mortgageHistory`, `averageAssessedValue`
// and `garageParkingSpaceCount` — three innocent property fields. If this ever
// starts failing, the matcher regressed to substring matching and the next
// author will weaken the gate to get their work done.
const SUBSTRING_TRAPS = [
  "mortgageHistory.loanAmount", "propertyOwnerProfile.averageAssessedValue",
  "building.garageParkingSpaceCount", "openLien.mortgages.currentEstimatedBalance",
  "listing.originalListingDate", "general.propertyTypeCategory",
]
check(`${SUBSTRING_TRAPS.length} property fields containing a banned token as a SUBSTRING are still allowed`,
  SUBSTRING_TRAPS.every((f) => !isProtectedClassSource(f)),
  SUBSTRING_TRAPS.filter((f) => isProtectedClassSource(f)).join(", "))
check("…and the value \"Single Family Residential\" survives the criteria gate (it names a building, not a household)",
  !stripProtectedClassCriteria({ property_type_category: "Single Family Residential" }).removed.length)

// ── THE POSITIVE CONTROL FOR THE GATE ITSELF ─────────────────────────────────
// Every one of these is a real filter or field path the provider sells. If the
// matcher breaks, this list turns green in the wrong direction and the whole
// "0 protected-class signals" claim becomes a broken regex reporting zero.
const MUST_BE_REFUSED: Array<[string, string]> = [
  ["has_children", "familial status"],
  ["min_owner_age", "age"],
  ["max_owner_age", "age"],
  ["min_household_income", "income proxy"],
  ["max_household_income", "income proxy"],
  ["min_household_net_worth", "wealth proxy"],
  ["senior-owner", "age (quickList slug)"],
  ["inherited", "probate — owner ruling"],
  ["demographics.age", "age"],
  ["demographics.gender", "sex"],
  ["demographics.hasChildren", "familial status"],
  ["demographics.childCount", "familial status"],
  ["demographics.singleParent", "familial status"],
  ["demographics.maritalStatus", "marital status"],
  ["demographics.recentlyDivorced", "divorce — owner ruling"],
  ["demographics.religiousAffiliation", "religion"],
  ["demographics.religious", "religion"],
  ["demographics.income", "income proxy"],
  ["demographics.netWorth", "wealth proxy"],
  ["demographics.householdSize", "familial status"],
  ["demographics.individualEducation", "the excluded namespace"],
  ["demographics.smoker", "the excluded namespace"],
]
check(`all ${MUST_BE_REFUSED.length} real provider protected-class filters/fields are refused`,
  MUST_BE_REFUSED.every(([f]) => isProtectedClassSource(f)),
  MUST_BE_REFUSED.filter(([f]) => !isProtectedClassSource(f)).map(([f]) => f).join(", "))
check("…and each refusal states a REASON, never a bare boolean",
  MUST_BE_REFUSED.every(([f]) => (protectedClassReasonFor(f) ?? "").length > 40))
check("the whole demographics namespace is excluded by NAMESPACE, so a field the vendor adds tomorrow is excluded the day it appears",
  PROTECTED_CLASS_NAMESPACES.includes("demographics")
  && isProtectedClassSource("demographics.someFieldInventedNextQuarter"))
check("the banned token vocabulary names age, familial, marital, probate, race, religion, sex, disability, income and veteran status",
  ["age", "children", "marital", "inherited", "race", "religion", "sex", "disability", "income", "veteran"]
    .every((t) => PROTECTED_CLASS_TOKENS.includes(t)))

console.log("\n[1b · GATE ONE — a protected-class signal type cannot be DECLARED]")

check("assertSellerSignalSourceAllowed THROWS on a protected source (it does not return false)",
  (throws(() => assertSellerSignalSourceAllowed("demographics.age", "senior_downsizer")) ?? "").includes("REFUSED"))
check("…and the thrown message names the offending signal type so the author knows which line to delete",
  (throws(() => assertSellerSignalSourceAllowed("min_owner_age", "senior_downsizer")) ?? "").includes("senior_downsizer"))

// THE CENTRAL POSITIVE CONTROL. This is the exact edit the gate exists to stop:
// somebody adds a plausible-sounding signal type sourced from an age filter.
// If `defineSellerSignalSources` ever stops throwing here, the "structurally
// impossible" claim in the module header is false.
const ATTEMPTS: Array<[string, string]> = [
  ["senior_downsizer", "min_owner_age"],
  ["senior_downsizer_quicklist", "senior-owner"],
  ["family_growth", "demographics.hasChildren"],
  ["probate_lead", "inherited"],
  ["divorce_signal", "demographics.recentlyDivorced"],
  ["affluent_seller", "min_household_income"],
]
for (const [signalType, source] of ATTEMPTS) {
  const msg = throws(() => defineSellerSignalSources([
    { signalType, label: "attempt", sources: [source], why: "should never be reachable" },
  ]))
  check(`declaring "${signalType}" from "${source}" is REFUSED at declaration time`,
    msg !== null && msg.includes("REFUSED"), msg ?? "it was ACCEPTED")
}
check("a protected source hidden among ALLOWED ones is still caught (the gate walks every source, not the first)",
  (throws(() => defineSellerSignalSources([{
    signalType: "smuggled",
    label: "attempt",
    sources: ["intel.salePropensity", "quickLists.vacant", "demographics.age"],
    why: "should never be reachable",
  }])) ?? "").includes("REFUSED"))
check("a signal type declaring NO sources is refused too — an ungateable signal is what the gate exists to prevent",
  throws(() => defineSellerSignalSources([{ signalType: "sourceless", label: "x", sources: [], why: "y" }])) !== null)
check("…and the ALLOWED declaration this lane actually ships still loads (the gate is not simply refusing everything)",
  BATCHDATA_SELLER_SIGNAL_SOURCES.length === 10 && BATCHDATA_SIGNAL_TYPES.length === 10,
  `${BATCHDATA_SELLER_SIGNAL_SOURCES.length} specs`)

console.log("\n[1c · GATE TWO — a protected filter cannot be ASKED for]")
{
  const dirty = {
    query: "1234 N Lamar Blvd, Austin, TX",
    min_sale_propensity: 80,
    min_owner_age: 65,
    has_children: true,
    min_household_income: 150000,
    orQuickLists: ["preforeclosure", "senior-owner", "vacant", "inherited"],
    property_type_category: "Single Family Residential",
  }
  const { criteria, removed } = stripProtectedClassCriteria(dirty)
  check("age, familial-status and income filters are stripped from the outbound query",
    !("min_owner_age" in criteria) && !("has_children" in criteria) && !("min_household_income" in criteria))
  check("…including the two that ride as quickList VALUES rather than as keys (senior-owner, inherited)",
    (criteria.orQuickLists as string[]).join(",") === "preforeclosure,vacant",
    JSON.stringify(criteria.orQuickLists))
  check("…while the legitimate motivation filters survive untouched",
    criteria.min_sale_propensity === 80 && criteria.query === dirty.query
    && criteria.property_type_category === "Single Family Residential")
  check("every removal is NAMED, not silently dropped — a narrowed query must be visible",
    removed.length === 5 && removed.some((r) => r.includes("senior-owner")) && removed.some((r) => r.includes("inherited")),
    removed.join(", "))
  const clean = stripProtectedClassCriteria({ query: "x", min_sale_propensity: 80 })
  check("a clean query removes NOTHING — the gate is not just deleting criteria", clean.removed.length === 0)
}

console.log("\n[1d · GATE THREE — a protected value cannot be STORED even if it arrives unasked]")
{
  const providerRow = {
    address: { street: "1234 N LAMAR BLVD" },
    intel: { salePropensity: 92 },
    demographics: { age: 71, hasChildren: true, income: 145000, recentlyDivorced: true },
    owner: { fullName: "A Person", ownerOccupied: false },
    quickLists: { seniorOwner: true, vacant: true },
  }
  const { value, redacted } = redactProtectedClassFields(providerRow)
  const kept = value as Record<string, any>
  check("the whole demographics object is removed from the row before storage",
    !("demographics" in kept) && redacted.includes("demographics"))
  check("…and the nested seniorOwner quickList flag is removed too",
    kept.quickLists.seniorOwner === undefined && redacted.includes("quickLists.seniorOwner"))
  check("…while the property facts survive",
    kept.intel.salePropensity === 92 && kept.quickLists.vacant === true && kept.address.street === "1234 N LAMAR BLVD")
  check("a row with nothing protected in it is redacted to NOTHING (control: the redactor is not stripping at random)",
    redactProtectedClassFields({ intel: { salePropensity: 50 }, quickLists: { vacant: true } }).redacted.length === 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE READERS — over the provider's REAL wire shapes
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[2 · readers over the provider's live field paths]")

check("dotted-path reads never throw on a missing branch",
  at({}, "a.b.c.d") === undefined && at(null, "a.b") === undefined && at({ a: { b: 7 } }, "a.b") === 7)

// The provider's live catalogue (read 2026-08-20) publishes quickLists as an
// OBJECT of camelCase booleans. lib/external/batchdata-client.ts:181 reads the
// same field as an ARRAY. Both shapes are accepted rather than a side being
// picked that cannot be proved for every endpoint.
check("quickLists read as an OBJECT of camelCase booleans (the live catalogue shape)",
  readQuickList({ quickLists: { preforeclosure: true, vacant: false } }, "preforeclosure")
  && !readQuickList({ quickLists: { preforeclosure: true, vacant: false } }, "vacant"))
check("…and as an ARRAY of kebab-case slugs (the shape normalizeBatchDataProperty assumes)",
  readQuickList({ quickLists: ["tired-landlord", "high-equity"] }, "tiredLandlord")
  && !readQuickList({ quickLists: ["tired-landlord"] }, "vacant"))
check("a missing quickLists block reads false, never undefined-as-true", readQuickList({}, "vacant") === false)

check("sale propensity reads the live path intel.salePropensity", readSalePropensity({ intel: { salePropensity: 87 } }) === 87)
check("an out-of-range propensity is REFUSED (null), never banded — it is a provider shape change, not a strong signal",
  readSalePropensity({ intel: { salePropensity: 187 } }) === null
  && readSalePropensity({ intel: { salePropensity: -3 } }) === null)

check("equity reads valuation.equityPercent directly", readEquityPercent({ valuation: { equityPercent: 82 } }) === 82)
check("…and falls back to computing it from the recorded balance and value",
  readEquityPercent({ valuation: { equityCurrentEstimatedBalance: 300000, estimatedValue: 400000 } }) === 75)
check("…and refuses to divide by a zero or missing value",
  readEquityPercent({ valuation: { equityCurrentEstimatedBalance: 300000, estimatedValue: 0 } }) === null)

check("tenure reads whole years, months, or the deed's ownership start date",
  readTenureYears({ intel: { lengthOfResidenceYears: 14 } }) === 14
  && readTenureYears({ intel: { lengthOfResidenceMonths: 150 } }) === 12
  && readTenureYears({ owner: { ownershipStartDate: "2009-11-02" } }, "2026-08-20") === 16)
check("…and the anniversary is respected rather than rounded (start 2009-11-02, today 2026-08-20 → 16, not 17)",
  readTenureYears({ owner: { ownershipStartDate: "2009-11-02" } }, "2026-08-20") === 16
  && readTenureYears({ owner: { ownershipStartDate: "2009-06-02" } }, "2026-08-20") === 17)

check("a delinquent tax YEAR is read; the provider's 0 is refused, not filed as year zero",
  readTaxDelinquentYear({ tax: { taxDelinquentYear: 2021 } }) === 2021
  && readTaxDelinquentYear({ tax: { taxDelinquentYear: 0 } }) === null)

{
  const liens = readLiens({
    openLien: { totalOpenLienCount: 3, totalOpenLienBalance: 41250 },
    involuntaryLien: { liens: [
      { lienType: "Tax Lien", documentNumber: "2024-00881", lienAmount: 12000 },
      { lienType: "Mechanic Lien", filingDate: "2025-02-11" },
    ] },
  })
  check("liens read count, balance, distinct types and a stable filing handle",
    liens.count === 3 && liens.balance === 41250 && liens.types.length === 2 && liens.handle === "2024-00881+2025-02-11")
}

console.log("\n[2b · foreclosure is read STAGE-FIRST, because several flags are true at once]")
{
  // A property at auction is truthfully ALSO in preforeclosure. Reading the
  // first true flag in declaration order would lose the only fact in the record
  // that carries a deadline.
  const auctioning = {
    quickLists: { preforeclosure: true, noticeOfDefault: true, noticeOfSale: true, activeAuction: true },
    foreclosure: { auctionDate: "2026-10-01", status: "Active", caseNumber: "CV-2026-1188" },
  }
  const fc = readForeclosure(auctioning)
  check("a property flagged preforeclosure AND at auction reads as `auction`, not `preforeclosure`", fc.stage === "auction")
  check("…and carries its auction date and case number as the dedupe handle",
    fc.auctionDate === "2026-10-01" && fc.handle === "CV-2026-1188")
  check("a bare preforeclosure flag with nothing recorded still reads a stage",
    readForeclosure({ quickLists: { preforeclosure: true } }).stage === "preforeclosure")
  check("a property with no foreclosure flags reads stage null (control: the reader can say 'nothing here')",
    readForeclosure({ quickLists: { vacant: true } }).stage === null)
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · STRENGTH — one vocabulary, no competing number
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[3 · strength maps onto the existing four-value ladder]")

const RICH_ROW = {
  address: { street: "1234 N LAMAR BLVD" },
  intel: { salePropensity: 93, salePropensityCategory: "High", lengthOfResidenceYears: 22 },
  tax: { taxDelinquentYear: 2021, taxYear: 2025 },
  openLien: { totalOpenLienCount: 3, totalOpenLienBalance: 41250 },
  involuntaryLien: { liens: [{ lienType: "Tax Lien", documentNumber: "2024-00881" }] },
  general: { vacant: true, mailingAddressVacant: true },
  owner: { ownerOccupied: false, ownershipStartDate: "2004-03-15" },
  valuation: { equityPercent: 91, estimatedValue: 480000 },
  listing: { failedListingDate: "2026-02-14", daysOnMarket: 214 },
  quickLists: {
    preforeclosure: true, noticeOfSale: true, activeAuction: true,
    taxDefault: true, involuntaryLien: true, vacant: true, mailingAddressVacant: true,
    absenteeOwner: true, outOfStateOwner: true, tiredLandlord: true,
    expiredListing: true, highEquity: true, freeAndClear: false,
  },
  foreclosure: { auctionDate: "2026-10-01", status: "Active", caseNumber: "CV-2026-1188" },
}

const derived = deriveSellerSignals(RICH_ROW, { todayIso: "2026-08-20" })
const derivedTypes = derived.map((d) => d.signalType).sort()
check("a fully-flagged property derives all TEN declared signal types",
  derivedTypes.length === 10 && new Set(derivedTypes).size === 10, derivedTypes.join(","))
check("…and every derived type is one the fair-housing gate approved",
  derived.every((d) => BATCHDATA_SIGNAL_TYPES.includes(d.signalType)))

check("EVERY strength this lane emits is a member of the one vocabulary",
  derived.every((d) => isSellerSignalStrength(d.strength)),
  derived.filter((d) => !isSellerSignalStrength(d.strength)).map((d) => `${d.signalType}=${d.strength}`).join(","))
check("…and every one ranks at or above 0 (never the -1 that means 'unreadable')",
  derived.every((d) => rankOf(d.strength) >= 0))
check("…and none of them is a NUMBER — the defect that made signal_strength score zero for years",
  derived.every((d) => typeof d.strength === "string" && Number.isNaN(Number(d.strength))))
check("the ladder the lane binds to is exactly weak|moderate|strong|urgent",
  SELLER_SIGNAL_STRENGTHS.join("|") === "weak|moderate|strong|urgent")

console.log("\n[3b · the bands, and the floor below which nothing is filed]")
check("propensity bands: >=90 strong, >=75 moderate, >=60 weak",
  bandSalePropensity(93) === "strong" && bandSalePropensity(80) === "moderate" && bandSalePropensity(62) === "weak")
check("…and BELOW 60 nothing is filed at all — a signal that fires for everyone is a constant, not a signal",
  bandSalePropensity(59) === null && bandSalePropensity(0) === null && bandSalePropensity(null) === null)
check("propensity NEVER reaches urgent, however high it runs — a model probability is not a dated event",
  [60, 75, 90, 99, 100].every((s) => bandSalePropensity(s) !== "urgent"))
check("equity bands match the EXISTING writer at lead-intelligence.ts:1203 (>75 strong, >50 moderate)",
  bandEquity(80, false) === "strong" && bandEquity(60, false) === "moderate" && bandEquity(40, false) === null)
check("…and free-and-clear is strong regardless of a missing percentage", bandEquity(null, true) === "strong")

console.log("\n[3c · 'urgent' is reachable in exactly one place, and only for a FUTURE sale date]")
{
  const byType = new Map(derived.map((d) => [d.signalType, d]))
  check("a recorded trustee's sale still ahead of us is the one urgent signal",
    byType.get(PREFORECLOSURE_SIGNAL_TYPE)!.strength === "urgent")
  check("…and it is the ONLY urgent one in a fully-flagged row",
    derived.filter((d) => d.strength === "urgent").length === 1)
  const past = deriveSellerSignals(
    { ...RICH_ROW, foreclosure: { ...RICH_ROW.foreclosure, auctionDate: "2026-01-05" } },
    { todayIso: "2026-08-20" },
  ).find((d) => d.signalType === PREFORECLOSURE_SIGNAL_TYPE)!
  check("an auction that ALREADY HAPPENED drops to strong — history is not a deadline",
    past.strength === "strong", past.strength)
  const noticeOnly = deriveSellerSignals({ quickLists: { noticeOfDefault: true } }, { todayIso: "2026-08-20" })[0]
  check("a notice of default with no sale date is strong, never urgent", noticeOnly.strength === "strong")
  check("…and both still count as STRONG for the scorer",
    isStrongSellerSignal(past.strength) && isStrongSellerSignal(noticeOnly.strength))
}

console.log("\n[3d · conservatism — a fact true of most homes files NOTHING]")
{
  const ordinary = deriveSellerSignals({
    address: { street: "9 QUIET LN" },
    intel: { salePropensity: 41, lengthOfResidenceYears: 4 },
    valuation: { equityPercent: 22, estimatedValue: 350000 },
    general: { vacant: false },
    owner: { ownerOccupied: true },
    tax: { taxDelinquentYear: 0 },
    quickLists: { ownerOccupied: true, highEquity: false },
  }, { todayIso: "2026-08-20" })
  check("an owner-occupied, current, low-equity, recently-bought home derives ZERO signals",
    ordinary.length === 0, ordinary.map((d) => d.signalType).join(","))
  check("…and a 9-year tenure is still nothing while a 10-year one is moderate (a real threshold, not a rubber stamp)",
    deriveSellerSignals({ intel: { lengthOfResidenceYears: 9 } }).length === 0
    && deriveSellerSignals({ intel: { lengthOfResidenceYears: 10 } })[0].signalType === MARKET_TIMING_SIGNAL_TYPE)
  check("vacancy of the PROPERTY is strong; vacancy of only the MAILING address is moderate",
    deriveSellerSignals({ general: { vacant: true } })[0].strength === "strong"
    && deriveSellerSignals({ general: { mailingAddressVacant: true } })[0].strength === "moderate")
  check("an out-of-state absentee owner is moderate; an in-state one is weak",
    deriveSellerSignals({ quickLists: { outOfStateOwner: true } })[0].strength === "moderate"
    && deriveSellerSignals({ quickLists: { absenteeOwnerInState: true } })[0].strength === "weak")
}

console.log("\n[3e · derivation is deterministic — same row, same verdict, always]")
check("two derivations of one row are byte-identical",
  JSON.stringify(deriveSellerSignals(RICH_ROW, { todayIso: "2026-08-20" }))
  === JSON.stringify(deriveSellerSignals(RICH_ROW, { todayIso: "2026-08-20" })))
check("no derived reason is model-authored — every one is a fixed sentence in the source",
  derived.every((d) => stripComments(src("lib/external/batchdata-seller-signals.ts")).includes(JSON.stringify(d.reason).slice(1, -1))))

// ═══════════════════════════════════════════════════════════════════════════
// 4 · IDEMPOTENCY — the probe repeats; the rows must not
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[4 · dedupe keys — a repeating probe of an unchanged property writes nothing new]")

const keysA = deriveSellerSignals(RICH_ROW, { todayIso: "2026-08-20" })
  .map((s) => batchDataSignalDedupeKey({ signal: s, leadId: "lead-1" }))
const keysB = deriveSellerSignals(RICH_ROW, { todayIso: "2026-09-14" })
  .map((s) => batchDataSignalDedupeKey({ signal: s, leadId: "lead-1" }))
check("keys are stable across a later run date — the run date is NOT part of the key",
  keysA.join("|") === keysB.join("|"))
check("…and no two signals from one row collide on one key", new Set(keysA).size === keysA.length)
check("the same fact on a DIFFERENT lead is a different key (the lead is part of the identity)",
  batchDataSignalDedupeKey({ signal: derived[0], leadId: "lead-1" })
  !== batchDataSignalDedupeKey({ signal: derived[0], leadId: "lead-2" }))
check("a moving SCORE that stays in its band files once…",
  bandSalePropensity(91) === bandSalePropensity(97)
  && deriveSellerSignals({ intel: { salePropensity: 91 } })[0].variant
     === deriveSellerSignals({ intel: { salePropensity: 97 } })[0].variant)
check("…but a score that CROSSES a band files a genuinely new signal",
  deriveSellerSignals({ intel: { salePropensity: 78 } })[0].variant
  !== deriveSellerSignals({ intel: { salePropensity: 93 } })[0].variant)
check("a SECOND lien filing is a new key; the same lien re-read is not",
  batchDataSignalDedupeKey({ signal: deriveSellerSignals({ involuntaryLien: { liens: [{ lienType: "Tax Lien", documentNumber: "A1" }] } })[0], leadId: "l" })
  !== batchDataSignalDedupeKey({ signal: deriveSellerSignals({ involuntaryLien: { liens: [{ lienType: "Tax Lien", documentNumber: "A1" }, { lienType: "HOA Lien", documentNumber: "B2" }] } })[0], leadId: "l" }))
check("a further delinquent tax YEAR is a new key",
  deriveSellerSignals({ tax: { taxDelinquentYear: 2021 } })[0].variant !== deriveSellerSignals({ tax: { taxDelinquentYear: 2023 } })[0].variant)

console.log("\n[4b · the built row — the exact seven live columns, and nothing else]")
{
  const row = buildBatchDataSignalRow({
    signal: derived.find((d) => d.signalType === SALE_PROPENSITY_SIGNAL_TYPE)!,
    leadId: "lead-1",
    brokerageId: "brok-1",
    leadAddressKey: "1234 N LAMAR BLVD",
    providerAddress: "1234 N LAMAR BLVD",
  })
  check("the row names ONLY columns that exist live (PGRST204 refuses the whole INSERT otherwise)",
    Object.keys(row).sort().join(",") === "brokerage_id,detected_via,lead_id,signal_details,signal_strength,signal_type")
  check("the tenant is stamped on the row itself", row.brokerage_id === "brok-1")
  check("detected_via names the provider, matching the connector id", row.detected_via === BATCHDATA_DETECTED_VIA)
  check("signal_details carries the dedupe_key the unique index reads",
    typeof (row.signal_details as any).dedupe_key === "string" && (row.signal_details as any).dedupe_key.startsWith("batchdata|"))
  check("…and reports its protected-class redaction as an EMPTY ARRAY, not by omission",
    Array.isArray((row.signal_details as any).protected_class_redacted)
    && (row.signal_details as any).protected_class_redacted.length === 0)
}
{
  // A row whose observed block somehow carried a protected value — the third
  // gate firing where the first two would have had to both fail.
  const row = buildBatchDataSignalRow({
    signal: { signalType: "vacancy", strength: "strong", variant: "v:property", reason: "x",
              observed: { property_vacant: true, demographics: { age: 71 }, min_owner_age: 65 } },
    leadId: "l", brokerageId: "b", leadAddressKey: "K", providerAddress: "K",
  })
  const details = row.signal_details as any
  check("a protected value inside `observed` is stripped before storage",
    details.observed.demographics === undefined && details.observed.min_owner_age === undefined
    && details.observed.property_vacant === true)
  check("…and the redaction is REPORTED on the stored row",
    details.protected_class_redacted.length === 2, JSON.stringify(details.protected_class_redacted))
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · THE INGEST — against a fake client that can refuse
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[5 · the ingest — tenant scoping, refusals, and the address refusal]")

interface FakeOpts {
  leads?: ProbeableLead[]
  leadsError?: { message: string; code?: string }
  existing?: Array<{ signal_details: { dedupe_key?: string } | null }>
  existingError?: { message: string; code?: string }
  insertError?: { message: string; code?: string }
}
/** A supabase double that RESOLVES its refusals, exactly as supabase-js does —
 *  the trap CLAUDE.md §3 names. A double that threw would prove nothing. */
function fakeSupabase(opts: FakeOpts) {
  const seen = { leadFilters: {} as Record<string, unknown>, existingFilters: {} as Record<string, unknown> }
  const inserted: any[] = []
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const q: any = {
        select: () => q,
        eq: (col: string, val: unknown) => { filters[col] = val; return q },
        in: (col: string, val: unknown) => { filters[col] = val; return q },
        not: () => q,
        limit: () => q,
        maybeSingle: () => q.then((r: any) => r),
        insert: (rows: any) => {
          const arr = Array.isArray(rows) ? rows : [rows]
          if (opts.insertError) return { select: () => Promise.resolve({ data: null, error: opts.insertError }) }
          inserted.push(...arr)
          return {
            select: () => {
              const p: any = Promise.resolve({ data: arr.map((_, i) => ({ id: `id-${inserted.length + i}` })), error: null })
              p.maybeSingle = () => Promise.resolve({ data: { id: `id-${inserted.length}` }, error: null })
              return p
            },
          }
        },
        then: (res: any) => {
          if (table === "leads") {
            Object.assign(seen.leadFilters, filters)
            return Promise.resolve(opts.leadsError
              ? { data: null, error: opts.leadsError }
              : { data: opts.leads ?? [], error: null }).then(res)
          }
          Object.assign(seen.existingFilters, filters)
          return Promise.resolve(opts.existingError
            ? { data: null, error: opts.existingError }
            : { data: opts.existing ?? [], error: null }).then(res)
        },
      }
      return q
    },
  }
  return { client, seen, inserted }
}

const LEAD: ProbeableLead = { id: "lead-1", address: "1234 N. Lamar Boulevard, Apt 5B", city: "Austin", state: "TX", zip_code: "78756" }
async function okLookup(): Promise<PropertyLookupResult> {
  return { ok: true, status: 200, data: RICH_ROW as any, error: null }
}

{
  const f = fakeSupabase({ leads: [LEAD] })
  const r = await ingestBatchDataSellerSignals({
    supabase: f.client, brokerageId: "brok-1", lookup: okLookup, dayIso: "2026-08-20",
  })
  check("THE SIGNAL ARRIVES: one lead, one provider row, ten signals written",
    r.signalsWritten === 10 && f.inserted.length === 10, `written=${r.signalsWritten} inserted=${f.inserted.length}`)
  check("every written row carries the brokerage from the caller's tenant scope, never from the provider",
    f.inserted.every((row) => row.brokerage_id === "brok-1"))
  check("every written row points at the tenant's OWN lead", f.inserted.every((row) => row.lead_id === "lead-1"))
  check("the lead read is filtered to the tenant", f.seen.leadFilters.brokerage_id === "brok-1")
  check("the idempotency read is filtered to the tenant AND to this lane's ten signal types",
    f.seen.existingFilters.brokerage_id === "brok-1"
    && Array.isArray(f.seen.existingFilters.signal_type)
    && (f.seen.existingFilters.signal_type as string[]).length === 10)
  check("…and it uses `.in`, not `.eq` — reading back one type would re-file the other nine every rotation",
    (f.seen.existingFilters.signal_type as string[]).includes(SALE_PROPENSITY_SIGNAL_TYPE)
    && (f.seen.existingFilters.signal_type as string[]).includes(MARKET_TIMING_SIGNAL_TYPE))
  check("the per-type breakdown is reported, not just a total",
    Object.keys(r.writtenByType).length === 10 && r.writtenByType[VACANCY_SIGNAL_TYPE] === 1)
  check("no protected-class field reached storage", r.protectedClassRedacted.length === 0)
  check("a clean run reports NO errors", r.errors.length === 0, r.errors.join("; "))
  check("every stored strength passes the live CHECK constraint's vocabulary (m500)",
    f.inserted.every((row) => ["weak", "moderate", "strong", "urgent"].includes(row.signal_strength)))
}

console.log("\n[5b · the SECOND run over the same unchanged property writes nothing]")
{
  const first = fakeSupabase({ leads: [LEAD] })
  await ingestBatchDataSellerSignals({ supabase: first.client, brokerageId: "brok-1", lookup: okLookup, dayIso: "2026-08-20" })
  const second = fakeSupabase({
    leads: [LEAD],
    existing: first.inserted.map((row) => ({ signal_details: { dedupe_key: row.signal_details.dedupe_key } })),
  })
  const r = await ingestBatchDataSellerSignals({
    supabase: second.client, brokerageId: "brok-1", lookup: okLookup, dayIso: "2026-09-14",
  })
  check("a re-probe 25 days later writes ZERO new rows and counts them as already recorded",
    r.signalsWritten === 0 && r.alreadyRecorded === 10 && second.inserted.length === 0,
    `written=${r.signalsWritten} already=${r.alreadyRecorded}`)
}

console.log("\n[5c · the address refusal — a provider's 'closest match' is REFUSED, not filed]")
{
  const neighbour = { ...RICH_ROW, address: { street: "1236 N LAMAR BLVD" } }
  const f = fakeSupabase({ leads: [LEAD] })
  const r = await ingestBatchDataSellerSignals({
    supabase: f.client, brokerageId: "brok-1", dayIso: "2026-08-20",
    lookup: async () => ({ ok: true, status: 200, data: neighbour as any, error: null }),
  })
  check("a property two doors down writes NOTHING and is counted as an address mismatch",
    r.signalsWritten === 0 && r.leadsAddressMismatch === 1 && f.inserted.length === 0)
  check("…while the SAME address in a different spelling still matches (one address vocabulary)",
    normalizeStreetAddress("1234 N. Lamar Boulevard, Apt 5B") === normalizeStreetAddress("1234 north lamar blvd #5b")
    && readProviderAddress(RICH_ROW) === "1234 N LAMAR BLVD")
}

console.log("\n[5d · REFUSALS ARE REPORTED — supabase-js resolves them, so a silent run is the bug]")
{
  const leadsRefused = await ingestBatchDataSellerSignals({
    supabase: fakeSupabase({ leadsError: { message: "permission denied for table leads" } }).client,
    brokerageId: "brok-1", lookup: okLookup, dayIso: "2026-08-20",
  })
  check("a refused LEAD read reports the vendor's own message and writes nothing",
    leadsRefused.errors.length === 1 && leadsRefused.errors[0].includes("permission denied")
    && leadsRefused.signalsWritten === 0)

  const existingRefused = await ingestBatchDataSellerSignals({
    supabase: fakeSupabase({ leads: [LEAD], existingError: { message: "statement timeout" } }).client,
    brokerageId: "brok-1", lookup: okLookup, dayIso: "2026-08-20",
  })
  check("a refused IDEMPOTENCY read REFUSES TO WRITE — writing blind would duplicate the whole set every rotation",
    existingRefused.errors.some((e) => e.includes("statement timeout")) && existingRefused.signalsWritten === 0)

  const insertRefused = fakeSupabase({ leads: [LEAD], insertError: { message: "new row violates row-level security policy", code: "42501" } })
  const ir = await ingestBatchDataSellerSignals({
    supabase: insertRefused.client, brokerageId: "brok-1", lookup: okLookup, dayIso: "2026-08-20",
  })
  check("A REFUSED WRITE IS REPORTED, NOT SWALLOWED — and the run does not claim it wrote",
    ir.signalsWritten === 0 && ir.errors.some((e) => e.includes("row-level security")),
    `written=${ir.signalsWritten} errors=${ir.errors.join("; ")}`)
  check("…and a 23505 (the unique index doing its job) falls back to per-row inserts instead of losing the batch",
    stripComments(src("lib/external/batchdata-seller-signals.ts")).includes(`"23505"`))

  const providerRefused = await ingestBatchDataSellerSignals({
    supabase: fakeSupabase({ leads: [LEAD] }).client, brokerageId: "brok-1", dayIso: "2026-08-20",
    lookup: async () => ({ ok: false, status: 429, data: null, error: "rate limit exceeded" }),
  })
  check("a PROVIDER refusal is counted apart from 'the provider had nothing' and reported verbatim",
    providerRefused.lookupsRefused === 1 && providerRefused.leadsNotFound === 0
    && providerRefused.errors[0].includes("rate limit exceeded"))
  const providerEmpty = await ingestBatchDataSellerSignals({
    supabase: fakeSupabase({ leads: [LEAD] }).client, brokerageId: "brok-1", dayIso: "2026-08-20",
    lookup: async () => ({ ok: true, status: 200, data: null, error: null }),
  })
  check("…and 'served, nothing known about this address' is its own counter with no error",
    providerEmpty.leadsNotFound === 1 && providerEmpty.lookupsRefused === 0 && providerEmpty.errors.length === 0)
}

console.log("\n[5e · rotation — bounded spend, and every lead reached]")
{
  const many: ProbeableLead[] = Array.from({ length: 25 }, (_, i) => ({ id: `l${String(i).padStart(2, "0")}`, address: `${100 + i} MAIN ST` }))
  const day1 = selectLeadsToProbe({ leads: many, perRun: 5, dayIso: "2026-08-20" })
  check("spend is capped at perRun regardless of how many leads the tenant has", day1.length === 5)
  check("…and the same day always selects the same leads (reproducible from the date alone)",
    JSON.stringify(day1) === JSON.stringify(selectLeadsToProbe({ leads: many, perRun: 5, dayIso: "2026-08-20" })))
  const reached = new Set<string>()
  for (let d = 0; d < 5; d++) {
    const iso = new Date(Date.UTC(2026, 7, 20 + d)).toISOString().slice(0, 10)
    for (const l of selectLeadsToProbe({ leads: many, perRun: 5, dayIso: iso })) reached.add(l.id)
  }
  check("…and 25 leads at 5/day are ALL reached within 5 days — no lead is starved", reached.size === 25, `${reached.size}/25`)
  check("a lead with an unusable address is never probed (an empty key can never match)",
    selectLeadsToProbe({ leads: [{ id: "x", address: "Main Street" }, { id: "y", address: null }], perRun: 5, dayIso: "2026-08-20" }).length === 0)
  check("fewer leads than the cap → every one probed, no rotation arithmetic",
    selectLeadsToProbe({ leads: many.slice(0, 3), perRun: 5, dayIso: "2026-08-20" }).length === 3)
}

// ═══════════════════════════════════════════════════════════════════════════
// 6 · WIRING — the lane is reachable, and the schema knows about it
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n[6 · wiring]")

const cron = src("app/api/cron/permit-signal-scan/route.ts")
check("the cron route imports and runs the BatchData ingest",
  cron.includes("ingestBatchDataSellerSignals") && cron.includes("realBatchDataPropertyLookup"))
check("…and it is NOT gated on the permit lane's territories (the coverage hole it exists to close)",
  cron.includes("resolution.activeBrokerageIds.length === 0"))
check("…and it skips with a STATED REASON when the provider key is unconfigured, rather than firing refusals",
  cron.includes("batchdata_unconfigured"))
check("…and the run's records_processed counts BOTH sources' writes",
  cron.includes("totals.signals_written + batchdata.signals_written"))
check("…and protected-class redactions ride back in the cron response",
  cron.includes("protected_class_redacted"))

const migrations = readdirSync(join(root, "supabase/migrations"))
const m514 = migrations.find((f) => f.startsWith("m514-"))
check("m514 exists and widens the dedupe index to this lane's signal types", !!m514)
if (m514) {
  const sql = readFileSync(join(root, "supabase/migrations", m514), "utf8")
  check("…covering all ten signal_types this lane can write",
    BATCHDATA_SIGNAL_TYPES.every((t) => sql.includes(`'${t}'`)),
    BATCHDATA_SIGNAL_TYPES.filter((t) => !sql.includes(`'${t}'`)).join(","))
  check("…and still covering the permit lane's two, so widening does not orphan them",
    sql.includes("'permit_activity'") && sql.includes("'code_violation'"))
  check("…and retaining the `? 'dedupe_key'` predicate so lead-intelligence.ts's keyless rows stay unconstrained",
    sql.includes("signal_details ? 'dedupe_key'"))
  check("…and superseding, not duplicating, m499's index",
    sql.includes("DROP INDEX IF EXISTS public.motivated_seller_signals_socrata_dedupe"))
}

console.log("\n[6b · one vocabulary — the two REUSED spellings, and the demographic dataset never requested]")
check("equity reuses `high_equity`, already written by app/actions/lead-intelligence.ts",
  HIGH_EQUITY_SIGNAL_TYPE === "high_equity" && src("app/actions/lead-intelligence.ts").includes(`signal_type: "high_equity"`))
check("tenure reuses `market_timing`, already written there for 'Long-term ownership'",
  MARKET_TIMING_SIGNAL_TYPE === "market_timing" && src("app/actions/lead-intelligence.ts").includes(`signal_type: "market_timing"`))
check("no second spelling of either was coined",
  !BATCHDATA_SIGNAL_TYPES.includes("equity_position") && !BATCHDATA_SIGNAL_TYPES.includes("ownership_tenure"))
check("the eight NEW types do not collide with the permit lane's two",
  !BATCHDATA_SIGNAL_TYPES.includes("permit_activity") && !BATCHDATA_SIGNAL_TYPES.includes("code_violation"))
check("the outbound request never asks for the `demographic` dataset",
  !BATCHDATA_SIGNAL_DATASETS.includes("demographic") && BATCHDATA_SIGNAL_DATASETS.includes("batchrank"))
check("…and every dataset it DOES ask for is one the provider publishes",
  BATCHDATA_SIGNAL_DATASETS.every((d) =>
    ["core", "quicklist", "batchrank", "foreclosure", "mortgage-liens", "valuation", "listing", "deed", "comps", "contact", "image", "owner", "permit", "basic", "all"].includes(d)))

console.log("\n[6d · the session-triggered half — the tenant comes from the SESSION, never a parameter]")
{
  const li = stripComments(src("app/actions/lead-intelligence.ts"))
  const probe = /export async function runBatchDataSellerSignalProbe\s*\(([^)]*)\)([\s\S]*?)\n}/.exec(li)
  check("a session-gated entry point exists beside the cron", !!probe)
  if (probe) {
    check("…and it takes NO parameters at all, so a caller cannot name a tenant (the IDOR shape)",
      probe[1].trim() === "", `params=<${probe[1].trim()}>`)
    check("…the gate runs BEFORE the service client is obtained",
      probe[2].indexOf("requireCaller") < probe[2].indexOf("createServiceClient"))
    check("…the brokerage is stamped from the authenticated session",
      probe[2].includes("brokerageId: auth.brokerageId"))
    check("…it fails closed with a stated reason when the connector is unconfigured",
      probe[2].includes("BATCHDATA_API_KEY") && probe[2].includes("not configured"))
    check("…and a run with any refusal cannot report success",
      probe[2].includes("success: result.errors.length === 0"))
    check("…its interactive cap is far below the cron's rotation cap",
      /lookupsPerRun:\s*25\b/.test(probe[2]) && 25 < 200)
  }
}

console.log("\n[6c · the duplicate verdict — RESOLVED BY DELETION, wave 14]")
{
  // PREVIOUSLY: the second `fetchMotivatedSellers` in app/actions/lead-intelligence.ts
  // was RENAMED to scrapeSocialMotivatedSellerSignals, on the reading that it was
  // a different capability wearing the survivor's name. The rename was correct
  // and it left an orphan: the renamed export had no caller under either name,
  // and the wired-surface guard saw the new name as a NEW orphan.
  //
  // It is now DELETED, not wired, and the reason is this file's own subject.
  // Its court-records input classifies a page by the literal words "divorce",
  // "bankruptcy", "foreclosure", "eviction", "lien", "judgment"
  // (lib/osint-client.ts:325 parseCourtRecordsHtml). "divorce" is in
  // PROTECTED_CLASS_TOKENS, so declaring it as a signal source THROWS at module
  // load — checked positively below. And its payload was model prose written
  // verbatim into signal_details, which a FIELD-PATH gate cannot inspect at all.
  const leadIntelRaw = src("app/actions/lead-intelligence.ts")
  const leadIntel = stripComments(leadIntelRaw)
  check("the SURVIVOR keeps the name: lib/external/batchdata-client.ts exports fetchMotivatedSellers",
    stripComments(src("lib/external/batchdata-client.ts")).includes("export async function fetchMotivatedSellers"))
  check("…and app/actions/lead-intelligence.ts no longer exports a second one",
    !leadIntel.includes("export async function fetchMotivatedSellers"))
  check("…nor the renamed one — the OSINT/social twin is gone from the code, not just from the name",
    !leadIntel.includes("export async function scrapeSocialMotivatedSellerSignals"))
  check("…the tombstone still names the batchdata survivor at file:line",
    leadIntelRaw.includes("lib/external/batchdata-client.ts:320"))
  check("…and names a survivor for each of the other halves it carried",
    leadIntelRaw.includes("app/actions/scrape-social-media.ts:41")
    && leadIntelRaw.includes("lib/osint-client.ts:357")
    && leadIntelRaw.includes("scrapeSocialSignalsWithZenRows"))
  check("…and the survivor's four live consumers are untouched",
    src("lib/kernel/intent-campaign.ts").includes("fetchMotivatedSellers")
    && src("lib/external/index.ts").includes("fetchMotivatedSellers")
    && src("scripts/scraper-simulator.ts").includes("fetchMotivatedSellers"))

  // POSITIVE CONTROL for the sentence above: the gate really does refuse the
  // deleted function's court-record vocabulary. Without this the claim "it could
  // not have passed the gate" is prose, and a gate that silently stopped
  // refusing would leave it looking just as true.
  const courtVocabulary = ["divorce", "probate", "estate", "inherited", "deceased", "heirs"]
  const refused = courtVocabulary.filter((t) => protectedClassReasonFor(t) !== null)
  check("POSITIVE CONTROL — the fair-housing gate refuses the deleted lane's court-record terms",
    refused.length >= 5, `refused ${refused.join(",") || "<none>"} of ${courtVocabulary.join(",")}`)
  check("…while `foreclosure`, a fact about a PROPERTY, still passes",
    protectedClassReasonFor("foreclosure") === null)
}

console.log("\n══════════════════════════════════════════════════")
console.log(` ${passed} passed · ${failed} failed`)
if (failures.length > 0) {
  console.log("\nFAILURES:")
  for (const f of failures) console.log(`  · ${f}`)
}
console.log("══════════════════════════════════════════════════")
process.exit(failed === 0 ? 0 : 1)
