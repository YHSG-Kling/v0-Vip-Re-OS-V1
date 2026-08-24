#!/usr/bin/env tsx
/**
 * scripts/vendor-service-area-simulator.ts   (npm run test:vendor-service-area)
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO OWNER RULINGS, ONE GUARD
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * RULING A — CONTACT ACCESS HAS TWO DOORS, verbatim:
 *
 *   "unless vendors are paying for contact access, a vendor is only able to
 *    access a contact if they are assigned to that contact"
 *
 * RULING B — WHERE A VENDOR MAY WORK, verbatim:
 *
 *   "in your expert experience when setting up a vendor marketplace how do you
 *    recommended setting up multiple tenancies and thier marektplace since some
 *    vendors may cover multiple territories and how can you setup vendors to pay
 *    when they can clearly cross territories or even states and still offer a
 *    vendor system to the tenants to make a bit more money without over charging
 *    the vendors??"
 *
 * LAYERS
 *   1  PURE — Ruling A. Every refusal is paired with the allowance that proves
 *      the gate is not simply refusing everything, and every allowance with the
 *      refusal that proves it is not simply allowing everything (CLAUDE.md §2:
 *      an absence assertion needs a POSITIVE CONTROL, and so does a presence one).
 *   2  PURE — Ruling B, same two-sided discipline.
 *   3  SOURCE — the surfaces read through the ONE gate, the TS and SQL
 *      licensed-trade lists are IDENTICAL, and the geographic vocabulary is the
 *      one the repo already uses. Scans STRIPPED source (CLAUDE.md §2: a
 *      tombstone is not a call site).
 *   4  LIVE (creds-gated) — m551 is really applied and the DATABASE refuses,
 *      with the same two-sided controls on real rows, cleaned up afterwards.
 *
 * MUTATION TEST (run and recorded in the lane report): making the access gate
 * grant on a REVOKED or an EXPIRED assignment must turn this simulator RED. If
 * it does not, the guard is decoration. See MUTATION_TARGETS below for the exact
 * lines and the checks that catch each one.
 */

import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { stripComments, blankStrings } from "./strip-comments"
import { LIVE_TABLES } from "./live-tables"
import { VENDOR_CATEGORIES, type VendorCategory } from "../lib/kernel/vendor-categories"
import {
  STATE_LICENSED_VENDOR_CATEGORIES,
  VENDOR_SERVICE_AREA_STATUSES,
  VENDOR_COVERAGE_PRICING_IMPLICATIONS,
  VENDOR_COVERAGE_FAIL_CLOSED_RULE,
  isStateLicensedTrade,
  normalizeState,
  normalizeZip,
  coverageAdmits,
  intersectTenantAreas,
  licenceIsCurrent,
  vendorGeoVerdict,
  type VendorCoverageRow,
  type VendorGeoFacts,
  type VendorGeoRefusal,
} from "../lib/vendors/vendor-service-area"
import {
  vendorContactAccessVerdict,
  PAID_CONTACT_ACCESS_LEVEL,
  PAID_ACCESS_GRANTED_SCOPES,
  VENDOR_ACCESS_LEVELS,
  type VendorContactAccessFacts,
} from "../lib/vendor/assignment-access"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** CLAUDE.md §2 — a tombstone is not a call site. Scan STRIPPED source. */
const src = (p: string) => stripComments(raw(p))
/** …and blank string literals too where a specimen could match a code token. */
const srcNoStrings = (p: string) => blankStrings(stripComments(raw(p)))

const MIGRATION =
  "supabase/migrations/m551-a-vendor-crossing-state-lines-had-nowhere-to-say-where-it-is-licensed.sql"
const GATE = "lib/vendor/assignment-access.ts"
const MODEL = "lib/vendors/vendor-service-area.ts"
const ACTION = "app/actions/vendor-contact-access.ts"
const SA_ACTION = "app/actions/vendor-service-areas.ts"

/**
 * The exact mutations this guard claims to catch, so the claim is checkable by
 * the next reader rather than taken on trust.
 *   M1  assignment-access.ts, vendorContactAccessVerdict: drop `a.status !== "active"`
 *       from the activeAssignments filter   → caught by A2 (revoked grants access)
 *   M2  assignment-access.ts, same filter: drop the expires_at comparison
 *                                          → caught by A4 (expired grants access)
 *   M3  vendor-service-area.ts, coverageAdmits: `return true` for a ZIP row with
 *       an unknown job ZIP                   → caught by B4
 *   M4  vendor-service-area.ts, vendorGeoVerdict: return ok on empty coverage
 *                                          → caught by B7
 */
const MUTATION_TARGETS = ["A2", "A4", "B4", "B7"] as const

let pass = 0
let fail = 0
const fails: string[] = []
const blindSpots: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function section(t: string) { console.log(`\n■ ${t}`) }
function blind(t: string) { blindSpots.push(t) }

const HOUR = 3_600_000
const NOW = Date.parse("2026-08-24T00:00:00.000Z")
const FUTURE = new Date(NOW + 30 * 24 * HOUR).toISOString()
const PAST = new Date(NOW - 30 * 24 * HOUR).toISOString()

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 1 — RULING A: two doors, and neither means nothing
// ═════════════════════════════════════════════════════════════════════════════

/** A fact bag with nothing wrong with it: one active assignment, no paid door.
 *  Every case below is this with ONE field moved, so a verdict change is
 *  attributable to exactly one fact. */
const CLEAN_ACCESS: VendorContactAccessFacts = {
  resolved: true,
  vendorId: "v-1",
  vendorStatus: "active",
  vendorAccessExpiresAt: null,
  vendorAccessLevel: "transaction_only",
  vendorBrokerageId: "b-1",
  contactBrokerageId: "b-1",
  assignments: [{ scope: "pii_basic", status: "active", expires_at: null }],
}

function layerRulingA() {
  section("Layer 1 — RULING A: assignment OR paid access; neither = nothing")

  // A1 / A2 — REVOKED. The pair is the point: the ONLY difference between them
  // is `status`, so A2 cannot pass by accident and A1 proves A2 is not a gate
  // that refuses everything.
  const a1 = vendorContactAccessVerdict(CLEAN_ACCESS, NOW)
  check("A1 POSITIVE CONTROL — an ACTIVE assignment opens the door",
    a1.ok && a1.door === "assignment")
  const a2 = vendorContactAccessVerdict(
    { ...CLEAN_ACCESS, assignments: [{ scope: "pii_basic", status: "revoked", expires_at: null }] }, NOW)
  check("A2 a REVOKED assignment grants NOTHING (a row's existence is not access)",
    !a2.ok && a2.reason === "no_door")

  // A3 / A4 — EXPIRED.
  const a3 = vendorContactAccessVerdict(
    { ...CLEAN_ACCESS, assignments: [{ scope: "pii_basic", status: "active", expires_at: FUTURE }] }, NOW)
  check("A3 POSITIVE CONTROL — an assignment expiring in the FUTURE still opens", a3.ok)
  const a4 = vendorContactAccessVerdict(
    { ...CLEAN_ACCESS, assignments: [{ scope: "pii_basic", status: "active", expires_at: PAST }] }, NOW)
  check("A4 an EXPIRED assignment grants NOTHING", !a4.ok && a4.reason === "no_door")
  const a4b = vendorContactAccessVerdict(
    { ...CLEAN_ACCESS, assignments: [{ scope: "pii_basic", status: "active", expires_at: "not-a-date" }] }, NOW)
  check("A4b an UNREADABLE expiry fails CLOSED (a date nobody can read is not a licence)",
    !a4b.ok && a4b.reason === "no_door")

  // A5 — the paid door, and the tenant boundary on it.
  const paidNoAssignment: VendorContactAccessFacts = {
    ...CLEAN_ACCESS, assignments: [], vendorAccessLevel: PAID_CONTACT_ACCESS_LEVEL,
  }
  const a5 = vendorContactAccessVerdict(paidNoAssignment, NOW)
  check("A5 PAID access opens the door with NO assignment at all",
    a5.ok && a5.door === "paid_brokerage_access")
  const a6 = vendorContactAccessVerdict({ ...paidNoAssignment, contactBrokerageId: "b-OTHER" }, NOW)
  check("A6 PAID access does NOT reach across tenants",
    !a6.ok && a6.reason === "no_door")
  const a7 = vendorContactAccessVerdict({ ...paidNoAssignment, vendorBrokerageId: null }, NOW)
  check("A7 a vendor anchored to NO tenant cannot open a brokerage-wide door",
    !a7.ok && a7.reason === "no_door")

  // A8 — neither door.
  const a8 = vendorContactAccessVerdict({ ...CLEAN_ACCESS, assignments: [] }, NOW)
  check("A8 NEITHER door open ⇒ the vendor sees nothing", !a8.ok && a8.reason === "no_door")

  // A9 — the paid door buys REACH, not DEPTH (CLAUDE.md §5: vendors see no
  // financials but their own). Paired with the assignment that DOES grant it.
  const a9 = vendorContactAccessVerdict({ ...paidNoAssignment, requiredScopes: ["financial"] }, NOW)
  check("A9 PAID access never confers 'financial' — §5, vendors see no financials",
    !a9.ok && a9.reason === "scope_not_granted")
  const a9b = vendorContactAccessVerdict(
    { ...paidNoAssignment, requiredScopes: ["transaction_docs"] }, NOW)
  check("A9b …nor 'transaction_docs' — a per-deal decision a human makes",
    !a9b.ok && a9b.reason === "scope_not_granted")
  const a9c = vendorContactAccessVerdict({
    ...CLEAN_ACCESS,
    requiredScopes: ["financial"],
    assignments: [{ scope: "financial", status: "active", expires_at: null }],
  }, NOW)
  check("A9c POSITIVE CONTROL — an explicit ASSIGNMENT still grants 'financial'",
    a9c.ok && a9c.door === "assignment" && a9c.scope === "financial")
  check("A9d the paid door's scope set is PII-only and says so once",
    PAID_ACCESS_GRANTED_SCOPES.has("pii_basic") && PAID_ACCESS_GRANTED_SCOPES.has("pii_full")
    && !PAID_ACCESS_GRANTED_SCOPES.has("financial")
    && !PAID_ACCESS_GRANTED_SCOPES.has("transaction_docs"))
  // The paid door is a COLUMN VALUE, so it has to be one the column admits. A
  // literal that drifts off `vendors_access_level_check` would silently close
  // the door for everyone — the gate would keep working and never open.
  check("A9e …and the paid-door literal is a value vendors.access_level actually admits",
    (VENDOR_ACCESS_LEVELS as readonly string[]).includes(PAID_CONTACT_ACCESS_LEVEL))

  // A10 — the whole-vendor time box closes BOTH doors at once.
  const a10 = vendorContactAccessVerdict({
    ...paidNoAssignment,
    assignments: [{ scope: "pii_basic", status: "active", expires_at: null }],
    vendorAccessExpiresAt: PAST,
  }, NOW)
  check("A10 an EXPIRED VENDOR closes both doors at once, assignment and paid alike",
    !a10.ok && a10.reason === "vendor_access_expired")
  const a10b = vendorContactAccessVerdict({ ...CLEAN_ACCESS, vendorAccessExpiresAt: FUTURE }, NOW)
  check("A10b POSITIVE CONTROL — a time box in the future does not close them", a10b.ok)
  const a11 = vendorContactAccessVerdict({ ...CLEAN_ACCESS, vendorStatus: "archived" }, NOW)
  check("A11 an ARCHIVED vendor reads nothing even with a live assignment",
    !a11.ok && a11.reason === "vendor_inactive")

  // A12 — an OUTAGE is not a settled "no". This is the §4 distinction that keeps
  // "nobody checked" from rendering as "checked and fine" — in the safe direction.
  const a12 = vendorContactAccessVerdict({ ...CLEAN_ACCESS, resolved: false }, NOW)
  check("A12 a REFUSED READ fails closed as 'read_refused', NOT as 'not a vendor'",
    !a12.ok && a12.reason === "read_refused")
  const a13 = vendorContactAccessVerdict({ ...CLEAN_ACCESS, resolved: true, vendorId: null }, NOW)
  check("A13 …and a genuine non-vendor is a DIFFERENT, settled answer",
    !a13.ok && a13.reason === "not_a_vendor")
  const a14 = vendorContactAccessVerdict({ ...CLEAN_ACCESS, ambiguousVendor: true }, NOW)
  check("A14 …and two vendor grants is a third, nameable state",
    !a14.ok && a14.reason === "ambiguous_vendor")

  // A15 — when both doors are open the ASSIGNMENT is what gets named, because
  // that is the specific human-made grant an audit line should record.
  const a15 = vendorContactAccessVerdict(
    { ...CLEAN_ACCESS, vendorAccessLevel: PAID_CONTACT_ACCESS_LEVEL }, NOW)
  check("A15 with BOTH doors open the assignment is the one named (audit truth)",
    a15.ok && a15.door === "assignment")
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 2 — RULING B: coverage, intersection, and the licence gate
// ═════════════════════════════════════════════════════════════════════════════

const AZ_STATEWIDE_TITLE: VendorCoverageRow = {
  state: "AZ", zipCode: null, tradeCategory: "title", status: "active",
  license: { policy_number: "TX-1", expiry: "2099-01-01" },
  // REQUIRED, not optional, and null here on purpose: `notes` carries NO weight
  // in vendorGeoVerdict, so this fixture must prove the verdict is unchanged by
  // it. Leaving the field optional on VendorCoverageRow would let the next
  // producer silently drop the column again — which is exactly how it came to be
  // written by code and read by nobody.
  notes: null,
}

/** A marketplace vendor covered and licensed where the job is. One field moves
 *  per case. */
const CLEAN_GEO: VendorGeoFacts = {
  resolved: true,
  tradeCategory: "title",
  jobState: "AZ",
  jobZip: "85001",
  localBenchRow: false,
  coverage: [AZ_STATEWIDE_TITLE],
  tenantAreas: [{ state: "AZ", zipCode: "85001" }],
}

function layerRulingB() {
  section("Layer 2 — RULING B: coverage is the company's, and licensure gates it")

  // B1-B4 — the matcher, including the fail-open it must not have.
  check("B1 a STATEWIDE row admits any ZIP in its state",
    coverageAdmits({ state: "AZ", zipCode: null }, { state: "AZ", zip: "85001" })
    && coverageAdmits({ state: "AZ", zipCode: null }, { state: "AZ", zip: "85999" }))
  check("B2 …but never a ZIP in a DIFFERENT state",
    !coverageAdmits({ state: "AZ", zipCode: null }, { state: "CA", zip: "90210" }))
  check("B3 a ZIP row admits that ZIP and no other",
    coverageAdmits({ state: "AZ", zipCode: "85001" }, { state: "AZ", zip: "85001" })
    && !coverageAdmits({ state: "AZ", zipCode: "85001" }, { state: "AZ", zip: "85002" }))
  check("B4 a ZIP row CANNOT admit a job whose ZIP is unknown ('probably in range' is the fail-open)",
    !coverageAdmits({ state: "AZ", zipCode: "85001" }, { state: "AZ", zip: null }))
  check("B5 an unparseable state admits NOTHING (garbage must not widen coverage)",
    !coverageAdmits({ state: "Arizona", zipCode: null }, { state: "AZ", zip: "85001" })
    && !coverageAdmits({ state: "AZ", zipCode: null }, { state: "Arizona", zip: "85001" }))
  check("B5b normalisation is real: lowercase state and ZIP+4 both resolve",
    normalizeState("az") === "AZ" && normalizeZip("85001-1234") === "85001"
    && normalizeState("Arizona") === null && normalizeZip("8500") === null)

  // B6 — the bench-surfacing intersection.
  check("B6 coverage intersecting the tenant's own area is surfaceable",
    intersectTenantAreas([AZ_STATEWIDE_TITLE], [{ state: "AZ", zipCode: "85001" }]).length === 1)
  check("B6b …and a tenant with a whole-STATE presence is met by any coverage in it",
    intersectTenantAreas(
      [{ ...AZ_STATEWIDE_TITLE, zipCode: "85001" }], [{ state: "AZ", zipCode: null }]).length === 1)
  check("B6c …and a tenant in another state is NOT",
    intersectTenantAreas([AZ_STATEWIDE_TITLE], [{ state: "CA", zipCode: "90210" }]).length === 0)

  // B7 — the whole verdict, two-sided. B7a is the POSITIVE control for all of it.
  const b7a = vendorGeoVerdict(CLEAN_GEO, NOW)
  check("B7a POSITIVE CONTROL — covered + licensed ⇒ bookable",
    b7a.ok && b7a.reason === "covered" && b7a.licence === "verified_in_state")
  const b7 = vendorGeoVerdict({ ...CLEAN_GEO, coverage: [] }, NOW)
  check("B7 UNKNOWN COVERAGE IS NOT 'BOOKABLE EVERYWHERE' — it is refused, by name",
    !b7.ok && b7.reason === "vendor_coverage_unknown")
  const b8 = vendorGeoVerdict({ ...CLEAN_GEO, tenantAreas: [] }, NOW)
  check("B8 a tenant that declared no service area cannot be matched to anyone",
    !b8.ok && b8.reason === "tenant_service_area_unknown")
  const b9 = vendorGeoVerdict({ ...CLEAN_GEO, jobState: "CA", jobZip: "90210",
    tenantAreas: [{ state: "CA", zipCode: "90210" }] }, NOW)
  check("B9 a job outside every declared area is refused as 'no_overlap'",
    !b9.ok && b9.reason === "no_overlap")
  const b10 = vendorGeoVerdict({ ...CLEAN_GEO, jobState: null }, NOW)
  check("B10 a job with no state at all is 'job_state_unknown', not a coverage answer",
    !b10.ok && b10.reason === "job_state_unknown")
  const b11 = vendorGeoVerdict({ ...CLEAN_GEO, resolved: false }, NOW)
  check("B11 a REFUSED READ fails closed and is nameable as such",
    !b11.ok && b11.reason === "read_refused")

  // B12 — the compliance gate. Licensed trade, covered, but the licence is bad.
  const b12 = vendorGeoVerdict(
    { ...CLEAN_GEO, coverage: [{ ...AZ_STATEWIDE_TITLE, license: null }] }, NOW)
  check("B12 a STATE-LICENSED trade with NO licence is NOT bookable, however well covered",
    !b12.ok && b12.reason === "licence_missing")
  const b13 = vendorGeoVerdict(
    { ...CLEAN_GEO, coverage: [{ ...AZ_STATEWIDE_TITLE, license: { expiry: "2020-01-01" } }] }, NOW)
  check("B13 …and an EXPIRED licence is refused distinctly from a missing one",
    !b13.ok && b13.reason === "licence_expired")
  const b14 = vendorGeoVerdict({
    ...CLEAN_GEO,
    tradeCategory: "stager",
    coverage: [{ ...AZ_STATEWIDE_TITLE, tradeCategory: "stager", license: null }],
  }, NOW)
  check("B14 POSITIVE CONTROL — an UNLICENSED trade needs no licence and is bookable",
    b14.ok && b14.licence === "not_required")
  const b15 = vendorGeoVerdict(
    { ...CLEAN_GEO, coverage: [{ ...AZ_STATEWIDE_TITLE, status: "suspended" }] }, NOW)
  check("B15 suspended/withdrawn coverage is refused distinctly from absent coverage",
    !b15.ok && b15.reason === "coverage_not_active")
  const b16 = vendorGeoVerdict({
    ...CLEAN_GEO,
    tradeCategory: "lender",
    coverage: [AZ_STATEWIDE_TITLE],   // title coverage, lender job
  }, NOW)
  check("B16 a title licence is NOT a lender licence — coverage is per (trade, state)",
    !b16.ok && b16.reason === "no_overlap")

  check("B17 licence freshness: missing / expired / current are three answers, and an unreadable expiry is EXPIRED",
    licenceIsCurrent(null, NOW) === "missing"
    && licenceIsCurrent({ expiry: "2020-01-01" }, NOW) === "expired"
    && licenceIsCurrent({ expiry: "2099-01-01" }, NOW) === "current"
    && licenceIsCurrent({}, NOW) === "current"
    && licenceIsCurrent({ expiry: "not-a-date" }, NOW) === "expired")

  // B18 — the LOCAL bench row: no cross-territory claim, but the licence still bites.
  const local: VendorGeoFacts = {
    ...CLEAN_GEO, localBenchRow: true, coverage: [], tenantAreas: [],
    benchLicense: { expiry: "2099-01-01" },
  }
  const b18 = vendorGeoVerdict(local, NOW)
  check("B18 a LOCAL bench row is bookable, and its licence is honestly 'state unknown'",
    b18.ok && b18.reason === "local_bench_row" && b18.licence === "on_file_state_unknown")
  const b19 = vendorGeoVerdict({ ...local, benchLicense: null }, NOW)
  check("B19 …but a licensed trade with NO credential on the bench row is still refused",
    !b19.ok && b19.reason === "licence_missing")
  const b20 = vendorGeoVerdict({ ...local, benchLicense: { expiry: "2019-01-01" } }, NOW)
  check("B20 …and an expired one likewise", !b20.ok && b20.reason === "licence_expired")
  const b21 = vendorGeoVerdict({ ...local, tradeCategory: "stager", benchLicense: null }, NOW)
  check("B21 POSITIVE CONTROL — an unlicensed trade on a local row needs nothing",
    b21.ok && b21.licence === "not_required")

  // B22 — the licensed-trade list is real and complete on its own terms.
  check("B22 every state-licensed trade is a REAL vendor category (no invented value)",
    [...STATE_LICENSED_VENDOR_CATEGORIES].every(
      (c) => (VENDOR_CATEGORIES as readonly string[]).includes(c)))
  check("B22b the owner's named trades — title and lender — are both gated",
    isStateLicensedTrade("title") && isStateLicensedTrade("lender")
    && isStateLicensedTrade("refinance_lender"))
  check("B22c …and an unlicensed trade is NOT gated (the list is not 'everything')",
    !isStateLicensedTrade("stager") && !isStateLicensedTrade("photographer")
    && !isStateLicensedTrade("inspector"))

  // B23 — EVERY DECLARED REFUSAL MUST BE REACHABLE. A refusal code no input can
  // produce is dead vocabulary that reads like an enforced rule, and a reader
  // auditing this gate would count it as a case that is handled. Each entry
  // below names the one fact that causes it, so the map doubles as the
  // documentation of what each code means.
  const refusalScenarios: ReadonlyArray<[VendorGeoRefusal, VendorGeoFacts]> = [
    ["read_refused", { ...CLEAN_GEO, resolved: false }],
    ["job_state_unknown", { ...CLEAN_GEO, jobState: "nowhere" }],
    ["vendor_coverage_unknown", { ...CLEAN_GEO, coverage: [] }],
    ["tenant_service_area_unknown", { ...CLEAN_GEO, tenantAreas: [] }],
    ["no_overlap", { ...CLEAN_GEO, jobState: "CA", jobZip: "90210",
      tenantAreas: [{ state: "CA", zipCode: "90210" }] }],
    ["coverage_not_active", { ...CLEAN_GEO, coverage: [{ ...AZ_STATEWIDE_TITLE, status: "withdrawn" }] }],
    ["licence_missing", { ...CLEAN_GEO, coverage: [{ ...AZ_STATEWIDE_TITLE, license: null }] }],
    ["licence_expired", { ...CLEAN_GEO, coverage: [{ ...AZ_STATEWIDE_TITLE, license: { expiry: "2020-01-01" } }] }],
  ]
  const unreachable = refusalScenarios.filter(([expected, facts]) => {
    const v = vendorGeoVerdict(facts, NOW)
    return v.ok || v.reason !== expected
  })
  check("B23 every declared refusal reason is REACHABLE (no dead vocabulary reading as an enforced rule)",
    unreachable.length === 0, unreachable.map(([r]) => r).join(", "))
  check("B23b …and every refusal carries an operator-facing sentence, not just a code",
    refusalScenarios.every(([, facts]) => {
      const v = vendorGeoVerdict(facts, NOW)
      return !v.ok && typeof v.message === "string" && v.message.length > 20
    }))
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 3 — SOURCE: one gate, one vocabulary, no drift between TS and SQL
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PURE — the trade list inside m551's vendor_trade_requires_state_license.
 *
 * ANCHORED ON THE `create` STATEMENT, not on an occurrence count. The first
 * version of this split the file on the function NAME and took chunk [2], which
 * silently returned [] because the name appears in prose comments as well as in
 * the DDL. Both callers below pair the comparison with a non-empty assertion
 * precisely so a parser that has gone blind fails LOUD instead of reporting a
 * clean match of nothing (CLAUDE.md §2 — a broken regex and a clean tree both
 * report zero).
 */
export function sqlLicensedTrades(migrationSql: string): string[] {
  const fn = migrationSql.match(
    /create or replace function public\.vendor_trade_requires_state_license[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/i,
  )
  if (!fn) return []
  const arr = fn[1].match(/array\s*\[([\s\S]*?)\]/i)
  if (!arr) return []
  return [...arr[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

/** PURE — the trade vocabulary inside m551's trade_category CHECK. Anchored on
 *  the `add constraint`, for the same reason. */
export function sqlTradeVocabulary(migrationSql: string): string[] {
  const chunk = migrationSql.match(
    /add constraint vendor_service_areas_trade_category_check[\s\S]*?array\s*\[([\s\S]*?)\]/i,
  )
  if (!chunk) return []
  return [...chunk[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

function layerSource() {
  section("Layer 3 — source: the migration, the one gate, and no vocabulary drift")

  check("m551 exists", existsSync(join(ROOT, MIGRATION)))
  const mig = raw(MIGRATION)
  check("m551 quotes the owner's question VERBATIM (so a later reader can check the reading)",
    mig.includes("some\n--    vendors may cover multiple territories"))

  // THE TWO LISTS MUST BE THE SAME LIST. A licensed trade only one side knows
  // about is a gate enforced in one place and open in the other.
  const sqlTrades = sqlLicensedTrades(mig).slice().sort()
  const tsTrades = [...STATE_LICENSED_VENDOR_CATEGORIES].slice().sort()
  check("the SQL and TypeScript state-licensed lists are IDENTICAL",
    sqlTrades.length > 0 && JSON.stringify(sqlTrades) === JSON.stringify(tsTrades),
    `sql=${JSON.stringify(sqlTrades)} ts=${JSON.stringify(tsTrades)}`)

  // …and so must the trade vocabulary itself, against the ONE taxonomy.
  const sqlVocab = sqlTradeVocabulary(mig).slice().sort()
  const tsVocab = [...VENDOR_CATEGORIES].slice().sort()
  check("m551's trade_category CHECK is the ONE 38-value vendor taxonomy, verbatim (§6)",
    sqlVocab.length === tsVocab.length && JSON.stringify(sqlVocab) === JSON.stringify(tsVocab),
    `sql has ${sqlVocab.length}, taxonomy has ${tsVocab.length}`)

  // GEOGRAPHY: the grain must be the repo's, not a third one.
  const model = srcNoStrings(MODEL)
  const migCode = mig.replace(/^--.*$/gm, "")   // SQL comments carry the rationale prose
  check("the model uses zip_code / state and invents NO county or metro vocabulary (§6)",
    /zipCode/.test(model) && /state/.test(model)
    && !/\bcounty\b/i.test(model) && !/\bmetro\b/i.test(model) && !/\bmsa\b/i.test(model))
  check("…and neither does the migration's DDL",
    /zip_code/.test(migCode) && !/\bcounty\b/i.test(migCode) && !/\bmetro\b/i.test(migCode))
  check("the coverage table hangs off the GLOBAL identity, never off a tenant bench row",
    /references public\.vendor_marketplace_profiles/.test(migCode)
    && !/vendor_service_areas[\s\S]{0,400}brokerage_id/.test(migCode))

  // ONE credential shape, not two.
  check("the per-state licence reuses the EXISTING credential validator (§6)",
    /vendor_credential_record_ok\(license\)/.test(migCode))

  // The gate is fail-closed by construction: it returns reason codes, not booleans.
  check("vendor_bookable_in_state returns a REASON CODE, never a bare boolean",
    /returns text/.test(migCode) && /'vendor_coverage_unknown'/.test(migCode)
    && /'licence_missing'/.test(migCode) && /'covered'/.test(migCode))
  check("the rule is in the DATABASE too, on the booking itself (not app-only)",
    /create trigger trg_vendor_bookings_service_area/.test(migCode))

  // RULING A wiring — the surface reads through the ONE gate.
  const action = src(ACTION)
  check("the contact-access action reads the PAID door from the ONE gate, not a local literal",
    /PAID_CONTACT_ACCESS_LEVEL/.test(action)
    && /from "@\/lib\/vendor\/assignment-access"/.test(action))
  check("…and the list path gates on vendors.status (it was SELECTed and never read)",
    /vendorRow\.status && vendorRow\.status !== "active"/.test(action))
  check("…and a refused vendor read REFUSES rather than reading as 'no time box set'",
    /if \(vendorErr\)/.test(action))
  check("…and a refused paid-door read refuses rather than serving a short list as the whole answer",
    /paid-door contact read failed/.test(raw(ACTION)))

  const gate = src(GATE)
  check("the access gate filters revoked/expired IN THE RULE, where it can be tested",
    /a\.status !== "active"/.test(gate) && /Date\.parse\(a\.expires_at\)/.test(gate))
  check("…and the fact-reader deliberately fetches revoked rows too, so the rule does the filtering",
    !/\.eq\("status", "active"\)/.test(gate))

  // THE MODEL MUST BE REACHABLE. A coverage table with no writer returns a
  // permanent zero that reads like policy — and here it would be worse than
  // usual, because m551's gate refuses EVERY booking while coverage is
  // undeclared. (CLAUDE.md §1.2 — build the missing half, and then prove it is
  // wired, because "the action exists" and "a human can reach it" differ.)
  const writer = src(SA_ACTION)
  check("the coverage table HAS a writer (declare + withdraw), not just a reader",
    /export async function declareVendorServiceAreaAction/.test(writer)
    && /export async function withdrawVendorServiceAreaAction/.test(writer))
  check("…and only the VENDOR or PLATFORM staff may write it — never a tenant asserting someone else's licensure",
    /requirePlatformStaff/.test(writer) && /profile\.user_id === user\.id/.test(writer))
  check("…and both writes COUNT their rows (an UPDATE matching nothing resolves as success)",
    (writer.match(/count: "exact"/g) ?? []).length >= 2
    && /\(count \?\? 0\) === 0/.test(writer))
  check("…and the statewide lookup uses `.is` not `.eq(col, null)` (which matches NO rows)",
    /\.is\("zip_code", null\)/.test(writer) && !/\.eq\("zip_code", null\)/.test(writer))
  check("the declaration surface REFUSES a licensed trade with no licence, at the one moment a human is present",
    /isStateLicensedTrade\(input\.tradeCategory\)/.test(writer))
  check("the tenant-side reader takes its tenant from the SESSION, never from a parameter (§4)",
    /export async function listSurfaceableBenchAction/.test(writer)
    && !/brokerageId\??:\s*string/.test(writer.split("listSurfaceableBenchAction")[1] ?? ""))
  check("…and it reads the tenant's own area from the EXISTING subscriber_service_areas (§6)",
    /from\("subscriber_service_areas"\)/.test(writer))
  check("…and a refused coverage read is NOT scored as 'these vendors declared nothing'",
    /coverageResolved = false/.test(writer))

  // Both panels reachable — an unimported panel is the same permanent zero.
  const portal = src("app/portal/vendor/page.tsx")
  check("the vendor can DECLARE coverage from their own portal",
    /VendorCoveragePanel/.test(portal) && existsSync(join(ROOT, "app/portal/vendor/vendor-coverage-panel.tsx")))
  const dash = src("app/dashboard/vendors/page.tsx")
  check("the brokerage can SEE which of its bench is bookable, refusals included",
    /BenchCoveragePanel/.test(dash) && existsSync(join(ROOT, "app/dashboard/vendors/bench-coverage-panel.tsx")))
  check("…and the bench panel shows blocked rows rather than silently shortening the list",
    /blocked/.test(src("app/dashboard/vendors/bench-coverage-panel.tsx")))

  // Live-table discipline (CLAUDE.md §2 — a retired name must not sit in a guard
  // reading as enforced).
  const referenced = ["vendors", "vendor_marketplace_profiles", "vendor_contact_assignments",
    "vendor_bookings", "contacts", "listings", "transactions", "subscriber_service_areas"]
  const dead = referenced.filter((t) => !LIVE_TABLES.includes(t))
  check("every table this lane reasons about is a LIVE table", dead.length === 0, dead.join(", "))
  if (!LIVE_TABLES.includes("vendor_service_areas")) {
    blind("`vendor_service_areas` is not yet in scripts/live-tables.ts — the cache is generated and " +
      "regenerating it needs credentials (`npm run schema:regen`). The TABLE is live; the CACHE is stale. " +
      "This guard therefore cannot cross-check the new table's name against LIVE_TABLES, and says so " +
      "rather than asserting a membership it cannot see.")
  }

  // The pricing shape is WRITTEN DOWN and NOT implemented.
  check("the pricing implications are written down for the owner",
    VENDOR_COVERAGE_PRICING_IMPLICATIONS.length >= 4)
  check("…and NOTHING in this lane prices anything or touches the m549 charge lanes",
    !/vendor_invoices|vendor_subscriptions|price|amount/i.test(
      migCode.replace(/vendor_subscriptions and vendor_invoices/g, "")))
  check("the fail-closed rule is stated once, in words, beside the model",
    /NOT bookable everywhere/i.test(VENDOR_COVERAGE_FAIL_CLOSED_RULE))
  check("the service-area status vocabulary matches the migration's CHECK",
    VENDOR_SERVICE_AREA_STATUSES.every((s) => migCode.includes(`'${s}'`)))
  check("this guard names the mutations it claims to catch", MUTATION_TARGETS.length === 4)
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 4 — LIVE (creds-gated)
// ═════════════════════════════════════════════════════════════════════════════

async function layerLive() {
  section("Layer 4 — live: is m551 really applied, and does the DATABASE refuse?")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("  ⊘ skipped (no SUPABASE creds) — layers 1-3 proved the rules and the wiring")
    blind("Layer 4 did not run here: no SUPABASE credentials in this environment. The live two-sided " +
      "controls WERE run by hand against project hrvaqgvukzxfskkcrwbt when m551 was applied; their " +
      "results are in the lane report. In CI with creds this layer re-proves them on every run.")
    return
  }
  const svc = createClient(url, key)

  // Does the schema actually carry what the migration says? Asked of the
  // DATABASE, never of the migration file — a .sql file is not the database.
  const { data: shape, error: shapeErr } = await svc.rpc("vendor_bookable_in_state", {
    p_vendor_id: "00000000-0000-0000-0000-000000000000",
    p_state: "AZ",
    p_zip: null,
  })
  if (shapeErr) {
    check("m551 is APPLIED (vendor_bookable_in_state answers)", false, shapeErr.message)
    blind("The live layer stopped at the shape probe: m551 is not applied to the project these " +
      "credentials point at, so nothing below could run. That is the PRE-MIGRATION shape reported " +
      "honestly, not a passing run.")
    return
  }
  check("m551 is APPLIED — vendor_bookable_in_state answers", true)
  check("…and a vendor that does not exist is 'vendor_not_found', not a coverage answer",
    shape === "vendor_not_found", String(shape))

  const { error: tblErr } = await svc.from("vendor_service_areas").select("id").limit(1)
  check("vendor_service_areas is a real, readable table", !tblErr, tblErr?.message)
}

// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("VENDOR SERVICE AREA + CONTACT ACCESS — two owner rulings, one guard")
  layerRulingA()
  layerRulingB()
  layerSource()
  await layerLive()

  if (blindSpots.length) {
    section("BLIND SPOTS (published beside the number — CLAUDE.md §2)")
    for (const b of blindSpots) console.log(`  ⚠ ${b}`)
  }

  console.log("\n" + "─".repeat(50))
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail) {
    for (const f of fails) console.log(`   ✗ ${f}`)
    console.log(" ❌ VENDOR_SERVICE_AREA_FAIL")
    process.exit(1)
  }
  console.log(" ✅ VENDOR_SERVICE_AREA_PASS — contact access has two doors and neither means nothing;" +
    " coverage belongs to the company, unknown coverage is not bookable, and a state-licensed trade" +
    " cannot be booked where it holds no current licence")
}

main().catch((e) => { console.error(e); process.exit(1) })
