// lib/vendors/vendor-service-area.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// WHERE A VENDOR MAY WORK — COVERAGE BELONGS TO THE COMPANY, NOT TO A BENCH ROW
// ═══════════════════════════════════════════════════════════════════════════
//
// OWNER QUESTION, verbatim:
//
//   "in your expert experience when setting up a vendor marketplace how do you
//    recommended setting up multiple tenancies and thier marektplace since some
//    vendors may cover multiple territories and how can you setup vendors to pay
//    when they can clearly cross territories or even states and still offer a
//    vendor system to the tenants to make a bit more money without over charging
//    the vendors??"
//
// This module is the FIRST BUILDABLE PIECE of the answer and deliberately only
// that. It answers "where may this company work, and is it allowed to work
// there" — the fact every later pricing shape has to be computed FROM. It does
// not price anything; see PRICING_IMPLICATIONS at the bottom, which is written
// down for the owner rather than implemented (m549 already enforces
// single-platform-use billing via a DB trigger and is not weakened here).
//
// ── WHY COVERAGE HANGS OFF THE GLOBAL PROFILE ────────────────────────────────
//
// m549 established the split and it is the whole basis of this model:
//
//   vendor_marketplace_profiles  the GLOBAL vendor identity. UNIQUE on
//                                company_name, NO brokerage_id, carries
//                                subscription_tier / subscription_status /
//                                stripe_*. This IS the company.
//   vendors                      the PER-BROKERAGE bench row: that tenant's own
//                                notes, rating, preferred, display_priority,
//                                access_level, attribution. Linked up by
//                                vendors.platform_vendor_id (m549).
//
// COVERAGE IS A FACT ABOUT THE COMPANY. A title company's licensure in Arizona
// does not change because a second brokerage added them to its bench. Hanging
// coverage off `vendors` would mint one coverage answer per tenant for one real
// company — the exact many-truths shape m549 was written to end — and a vendor
// crossing territories would have to re-declare, and re-prove, the same licence
// once per brokerage that hired them.
//
// ── THE GRAIN: state + zip_code. MEASURED, NOT PICKED ────────────────────────
//
// CLAUDE.md §6 forbids inventing a third geographic vocabulary, so the grain was
// counted off the live schema rather than chosen (columns, public schema,
// 2026-08-24):
//
//   state       30 tables   contacts, listings, brokerages, farm_territories,
//                           subscriber_service_areas, leads, market_data, …
//   city        23 tables
//   zip_code    15 tables   contacts, leads, territory_metrics,
//                           subscriber_service_areas, market_data, …
//   zip          8 tables   listings, brokerages, behavioral_signals, …
//   county       0 tables
//   metro / metro_area / msa
//               0 tables
//
// So the repo's finer grain is the ZIP, and its majority spelling is `zip_code`
// (15 tables against 8 for `zip`). County and metro are not a finer grain that
// exists here — they are a vocabulary that would have to be invented, mapped and
// then kept in sync with the zip data every other table already stores. Picking
// either would be the §6 defect, not a modelling preference.
//
// The decisive precedent is `subscriber_service_areas` — the TENANT side of this
// exact question, already live as (brokerage_id, team_id, agent_user_id,
// zip_code, city, state, is_primary, active). This module is its vendor-side
// counterpart and is spelled to match it, so "does the vendor cover where this
// tenant works" is one comparison between two tables that use one vocabulary.
//
// ── LICENSURE IS A GATE, NOT A FILTER ────────────────────────────────────────
//
// Title companies, lenders and appraisers are STATE-LICENSED. A vendor that is
// not licensed in the state where the job sits is not "ranked lower"; it is not
// bookable at all. That is why `vendorGeoVerdict` returns one refusal reason per
// distinct cause and never collapses "we could not tell" into "fine".
//
// Appraisers only became expressible on the bench at m554; until then this
// sentence named a trade the vocabulary could not spell. It can now, and
// `appraiser` is on STATE_LICENSED_VENDOR_CATEGORIES below.
//
// The licence RECORD SHAPE is not a new one. `vendors.compliance_credentials`
// already carries a bag validated by the live `vendor_credential_bag_ok` /
// `vendor_credential_record_ok` functions with keys license / insurance /
// certification / bond. m551's per-state licence reuses `vendor_credential_record_ok`
// verbatim, so there is ONE credential shape in this repo and not two.
//
// ── FAIL CLOSED, AND SAY WHICH DOOR WAS SHUT ─────────────────────────────────
//
// CLAUDE.md §4: a gate that cannot run must refuse. Unknown coverage is NOT
// "bookable everywhere" — it is `vendor_coverage_unknown`, a refusal whose text
// names what would fix it. Every verdict below is a distinct reason precisely so
// that "nobody declared coverage" can never be read back as "checked and fine".

import { isVendorCategory, type VendorCategory } from "@/lib/kernel/vendor-categories"

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** The live `vendor_service_areas_status_check` list, verbatim (m551).
 *  `withdrawn` is the vendor pulling out of a market; `suspended` is the
 *  platform holding them out of it. Both stop the work; keeping them distinct is
 *  the difference between a business decision and an enforcement action. */
export const VENDOR_SERVICE_AREA_STATUSES = ["active", "suspended", "withdrawn"] as const
export type VendorServiceAreaStatus = (typeof VENDOR_SERVICE_AREA_STATUSES)[number]

/**
 * The trades whose practitioners are STATE-LICENSED, so coverage in a state is
 * only real if a licence backs it.
 *
 * Every value is a `VendorCategory` — the one taxonomy in
 * lib/kernel/vendor-categories.ts that `vendors.category` and
 * `vendor_service_areas.trade_category` both CHECK against (§6: no second
 * spelling).
 *
 * WHY THESE SIX, and why the omissions are deliberate:
 *
 *   lender / refinance_lender  a mortgage originator holds a state licence per
 *                              state they lend in (NMLS state authority). This
 *                              is the single most common cross-state vendor and
 *                              the owner named it.
 *   title                      title/escrow producers are licensed state by
 *                              state; the owner named it.
 *   attorney                   admission is per state bar. An out-of-state
 *                              attorney on a closing is unauthorised practice.
 *   insurance                  producers hold per-state appointments.
 *   appraiser                  ADDED m554, on the owner ruling "an appraiser can
 *                              be another vendor type and is state licensed".
 *
 *   inspector is NOT here ON PURPOSE. Home-inspector licensure is not universal
 *   across states, so a hard refusal would refuse legitimate inspectors in every
 *   state that does not license them — a gate that is wrong in one direction is
 *   not safer than no gate, it is a gate that gets switched off.
 *
 *   APPRAISER IS THE OPPOSITE CASE, and the difference is not a judgement call:
 *   Title XI of FIRREA requires an appraisal for a federally related transaction
 *   to be performed by a state-certified or state-licensed appraiser, and every
 *   state runs a board to issue that credential. There is no state in which an
 *   unlicensed appraiser is legitimate, so the gate cannot be wrong in the
 *   direction that made `inspector` unsafe to include.
 *
 * SUPERSEDED NOTE (m551 → m554). This block previously recorded that appraiser
 * was MISSING FROM THE VOCABULARY ITSELF — `vendors.category` admitted 38 values
 * and appraiser was not among them, because appraisers were reached only through
 * lib/kernel/appraiser-packet.ts and not through the vendor bench. m554 widened
 * both live CHECKs (`vendors_category_check` and
 * `vendor_service_areas_trade_category_check`) to 39 and added the value to
 * `public.vendor_trade_requires_state_license`, which this Set mirrors exactly.
 *
 * WHAT THAT WIDENING COST, AND WHERE IT IS PAID. Benching appraisers opened NEW
 * routes to a licensed appraiser — vendor messaging, vendor communications,
 * vendor jobs, the vendor portal — and CLAUDE.md §5 forbids model-authored
 * content on any of them. That rule is NOT restated here: it lives once, at
 * lib/vendors/appraiser-independence.ts, together with the inventory of every
 * route that was walked and what each one was found to carry.
 */
export const STATE_LICENSED_VENDOR_CATEGORIES: ReadonlySet<VendorCategory> = new Set<VendorCategory>([
  "lender",
  "refinance_lender",
  "title",
  "attorney",
  "insurance",
  "appraiser",
])

/** PURE — does a job in this trade require a state licence to be bookable? */
export function isStateLicensedTrade(category: string | null | undefined): boolean {
  return isVendorCategory(category) && STATE_LICENSED_VENDOR_CATEGORIES.has(category)
}

// ─── Normalisation ───────────────────────────────────────────────────────────

/** PURE — a two-letter uppercase state, or null when the input cannot be one.
 *  Returns null rather than guessing: an unparseable state must reach the
 *  verdict as "unknown" and be refused, never silently matched. */
export function normalizeState(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const t = value.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(t) ? t : null
}

/** PURE — a 5-digit ZIP, or null. ZIP+4 is truncated to its 5-digit prefix,
 *  which is the grain every other table in this repo stores. */
export function normalizeZip(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const m = value.trim().match(/^(\d{5})(?:-\d{4})?$/)
  return m ? m[1] : null
}

// ─── The facts a verdict is computed from ────────────────────────────────────

/** One declared coverage row on the GLOBAL vendor identity (m551
 *  vendor_service_areas). `zipCode === null` means STATEWIDE. */
export interface VendorCoverageRow {
  state: string
  /** null = the whole state; otherwise this ZIP only. */
  zipCode: string | null
  tradeCategory: string
  status: VendorServiceAreaStatus | string
  /** The per-state licence, same record shape as
   *  vendors.compliance_credentials -> 'license'. null = none on file. */
  license: { expiry?: string | null; verified_at?: string | null; policy_number?: string | null } | null
  /**
   * The declaring operator's own note on this coverage row — "north of the river
   * only", "licence renewal filed 3 Aug". Free text, no vocabulary.
   *
   * WIRED BECAUSE IT WAS WRITTEN AND READ BY NOBODY (§1.2). m551 created the
   * column and `declareVendorServiceArea` writes it, but the coverage read
   * selected six columns and this was not one of them, so every note an operator
   * typed was stored and never shown back to anyone — which is worse than no
   * field at all, because the operator believes the caveat has been recorded
   * where the next person will see it.
   *
   * It carries NO weight in `vendorGeoVerdict`, deliberately: bookability is
   * decided by state, ZIP, status and licence, and letting prose into that
   * decision would make a compliance gate depend on something unparseable.
   */
  notes: string | null
}

/** One place the TENANT works — a `subscriber_service_areas` row, or the
 *  brokerage's own registered address when the tenant has declared none. */
export interface TenantServiceArea {
  state: string
  zipCode: string | null
}

export interface VendorGeoFacts {
  /**
   * FALSE when the coverage read was REFUSED or could not run. Distinct from
   * "no rows": a refused read must never be scored as "this vendor declared
   * nothing", because the two have opposite fixes.
   */
  resolved: boolean
  /** The trade the job is for — `vendors.category` vocabulary. */
  tradeCategory: string | null
  /** Where the job sits. */
  jobState: string | null
  jobZip: string | null
  /**
   * TRUE when this bench row has NO platform identity
   * (vendors.platform_vendor_id IS NULL) — a row the tenant added by hand for
   * their own market, not a marketplace company crossing territories. The
   * cross-territory question does not arise for it; the LICENCE question still
   * does, and is answered from the bench row's own credential bag.
   */
  localBenchRow: boolean
  /** Declared coverage on the global identity. Empty = declared nothing. */
  coverage: VendorCoverageRow[]
  /** Where the tenant works. Empty = the tenant declared nothing. */
  tenantAreas: TenantServiceArea[]
  /** For a LOCAL bench row only: vendors.compliance_credentials -> 'license'.
   *  It carries no state, so it can prove a licence exists, never which state
   *  it is for — the verdict says exactly that rather than pretending. */
  benchLicense?: { expiry?: string | null; verified_at?: string | null } | null
}

export type VendorGeoRefusal =
  | "read_refused"
  | "job_state_unknown"
  | "vendor_coverage_unknown"
  | "tenant_service_area_unknown"
  | "no_overlap"
  | "coverage_not_active"
  | "licence_missing"
  | "licence_expired"

export type VendorGeoVerdict =
  | {
      ok: true
      reason: "covered" | "local_bench_row"
      /** How well the licence question was answered where it was asked. */
      licence: "not_required" | "verified_in_state" | "on_file_state_unknown"
      /** The coverage row that admitted the job, when there was one. */
      matched?: VendorCoverageRow
    }
  | { ok: false; reason: VendorGeoRefusal; message: string }

const REFUSAL_TEXT: Record<VendorGeoRefusal, string> = {
  read_refused:
    "Could not read this vendor's service areas just now — refusing rather than assuming coverage. Please retry.",
  job_state_unknown:
    "This job has no state on it, so no coverage or licence check can be made. Add the property state.",
  vendor_coverage_unknown:
    "This vendor has not declared where it works, so it cannot be booked. Ask the vendor to add a service area.",
  tenant_service_area_unknown:
    "Your brokerage has not declared where it works, so no vendor can be matched to it. Add a service area in settings.",
  no_overlap:
    "This vendor does not cover where this job is.",
  coverage_not_active:
    "This vendor's coverage for this area is suspended or withdrawn.",
  licence_missing:
    "This trade is state-licensed and this vendor has no licence on file for this state, so it cannot be booked here.",
  licence_expired:
    "This vendor's licence for this state has expired, so it cannot be booked here.",
}

function refuse(reason: VendorGeoRefusal): VendorGeoVerdict {
  return { ok: false, reason, message: REFUSAL_TEXT[reason] }
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * PURE — does a declared coverage row admit a point (state, zip)?
 *
 * A statewide row (zipCode null) admits every ZIP in its state. A ZIP row admits
 * only that ZIP. A row with an unparseable state admits nothing: garbage must
 * never widen coverage.
 */
export function coverageAdmits(
  row: Pick<VendorCoverageRow, "state" | "zipCode">,
  point: { state: string | null; zip: string | null },
): boolean {
  const rowState = normalizeState(row.state)
  const jobState = normalizeState(point.state)
  if (!rowState || !jobState || rowState !== jobState) return false
  if (row.zipCode === null || row.zipCode === undefined) return true
  const rowZip = normalizeZip(row.zipCode)
  const jobZip = normalizeZip(point.zip)
  if (!rowZip) return false
  // A ZIP-scoped row cannot admit a job whose ZIP is unknown — that would be
  // "probably in range", which is the fail-open this model exists to prevent.
  return !!jobZip && rowZip === jobZip
}

/**
 * PURE — the coverage rows that intersect ANY of the tenant's own service areas.
 *
 * This is the bench-surfacing rule: a tenant may only see a vendor where the
 * vendor's coverage meets the tenant's own market. Statewide coverage meets a
 * tenant ZIP in that state; a ZIP-scoped tenant area is met by that ZIP or by
 * the state it sits in.
 */
export function intersectTenantAreas(
  coverage: readonly VendorCoverageRow[],
  tenantAreas: readonly TenantServiceArea[],
): VendorCoverageRow[] {
  return coverage.filter((row) =>
    tenantAreas.some((area) =>
      coverageAdmits(row, { state: area.state, zip: area.zipCode }) ||
      // A tenant area with no ZIP is a whole-state presence: a vendor holding
      // ANY coverage inside that state intersects it.
      (area.zipCode === null && normalizeState(area.state) === normalizeState(row.state)),
    ),
  )
}

/** PURE — is a licence record present and unexpired at `now`?
 *  A record with no expiry is treated as present-and-current: the live
 *  credential shape makes `expiry` optional, and inventing an expiry the vendor
 *  never gave would refuse a valid licence. */
export function licenceIsCurrent(
  license: { expiry?: string | null } | null | undefined,
  now: number,
): "missing" | "expired" | "current" {
  if (!license || typeof license !== "object") return "missing"
  const expiry = license.expiry
  if (!expiry) return "current"
  const t = Date.parse(expiry)
  if (Number.isNaN(t)) return "expired" // unreadable expiry fails CLOSED
  return t > now ? "current" : "expired"
}

// ─── The verdict ─────────────────────────────────────────────────────────────

/**
 * PURE — may this vendor be surfaced and booked for a job in this place?
 *
 * Order matters and is deliberate: the things that make the question
 * UNANSWERABLE are checked before the things that answer it "no", so an operator
 * is told "nobody declared this" rather than "this vendor does not cover you".
 */
export function vendorGeoVerdict(facts: VendorGeoFacts, now: number = Date.now()): VendorGeoVerdict {
  if (!facts.resolved) return refuse("read_refused")

  const jobState = normalizeState(facts.jobState)
  if (!jobState) return refuse("job_state_unknown")

  const licenceRequired = isStateLicensedTrade(facts.tradeCategory)

  // ── A LOCAL bench row: the tenant added this company themselves, for their
  // own market. No cross-territory claim is being made, so there is no coverage
  // to intersect. The LICENCE question still applies — answered from the bench
  // row's own credential bag, which carries no state, so the best it can ever
  // say is "on file, state unknown". Saying so is the point.
  if (facts.localBenchRow) {
    if (!licenceRequired) return { ok: true, reason: "local_bench_row", licence: "not_required" }
    const state = licenceIsCurrent(facts.benchLicense, now)
    if (state === "missing") return refuse("licence_missing")
    if (state === "expired") return refuse("licence_expired")
    return { ok: true, reason: "local_bench_row", licence: "on_file_state_unknown" }
  }

  if (facts.coverage.length === 0) return refuse("vendor_coverage_unknown")
  if (facts.tenantAreas.length === 0) return refuse("tenant_service_area_unknown")

  // The bench-surfacing rule first: the vendor has to meet the tenant's market
  // at all before the job's own location is asked about.
  const surfaced = intersectTenantAreas(facts.coverage, facts.tenantAreas)
  if (surfaced.length === 0) return refuse("no_overlap")

  // Then the job itself, restricted to the trade being booked. A title company
  // licensed in AZ is not thereby a lender in AZ.
  const admitting = surfaced.filter(
    (row) =>
      (!facts.tradeCategory || row.tradeCategory === facts.tradeCategory) &&
      coverageAdmits(row, { state: jobState, zip: facts.jobZip }),
  )
  if (admitting.length === 0) return refuse("no_overlap")

  const active = admitting.filter((row) => row.status === "active")
  if (active.length === 0) return refuse("coverage_not_active")

  if (!licenceRequired) {
    return { ok: true, reason: "covered", licence: "not_required", matched: active[0] }
  }

  // Licensed trade: at least one ACTIVE admitting row must carry a current
  // licence. A vendor with three covered ZIPs and one valid licence is licensed;
  // a vendor with three covered ZIPs and three expired licences is not.
  const licensed = active.find((row) => licenceIsCurrent(row.license, now) === "current")
  if (licensed) return { ok: true, reason: "covered", licence: "verified_in_state", matched: licensed }

  const anyOnFile = active.some((row) => !!row.license)
  return refuse(anyOnFile ? "licence_expired" : "licence_missing")
}

// ─── Written down, deliberately NOT implemented ──────────────────────────────

/**
 * PRICING IMPLICATIONS OF THIS MODEL — FOR THE OWNER, NOT BUILT.
 *
 * The lane was told not to build per-state pricing tiers and not to change what
 * anybody is charged, so nothing below is implemented anywhere in this repo.
 * m549's single-platform-use trigger is untouched. This constant exists so the
 * shape the coverage model IMPLIES is recorded in code next to the model, rather
 * than lost in a report.
 *
 * The owner's constraint was "make a bit more money without over charging the
 * vendors". The coverage rows make that arithmetic possible for the first time,
 * because `vendor_service_areas` is now a COUNTABLE unit of reach:
 *
 *  1. THE BILLABLE UNIT SHOULD BE REACH, NOT TENANCY. Today a vendor's cost
 *     scales with how many brokerages happen to add them — which is exactly the
 *     double-charge m549 had to forbid with a trigger. Counting declared
 *     coverage instead (states, or ZIPs) means a vendor working one metro pays
 *     once no matter how many tenants bench them, and a vendor working six
 *     states pays for six states. That is the same fix m549 made, generalised
 *     from "twice" to "N times".
 *
 *  2. THE TENANT'S CUT SHOULD RIDE ON THE INTRODUCTION, NOT ON THE TERRITORY.
 *     A brokerage should earn from vendors it actually puts in front of clients
 *     — bookings, placement — not from owning a bench row. Charging per tenancy
 *     re-creates the over-charge; `vendor_bookings` already counts the events
 *     that reflect real value delivered.
 *
 *  3. STATEWIDE MUST COST MORE THAN A ZIP, OR THE GRAIN IS DECORATIVE. If both
 *     price the same every vendor declares statewide, coverage stops meaning
 *     anything, and the licence gate loses the per-state precision it depends
 *     on.
 *
 *  4. LICENCE VERIFICATION IS A COST AND ARGUABLY A LINE ITEM. Checking a title
 *     or lender licence per state is real work; if it is free, it will not be
 *     done, and an unverified licence gate is theatre.
 *
 * NONE OF THIS IS PRICED HERE. It needs the owner's sign-off on price shape.
 */
export const VENDOR_COVERAGE_PRICING_IMPLICATIONS = [
  "bill_by_declared_reach_not_by_tenant_count",
  "tenant_revenue_rides_on_bookings_not_on_bench_rows",
  "statewide_must_price_above_single_zip",
  "per_state_licence_verification_is_a_real_cost",
] as const

/** The one sentence this module refuses to let drift: what UNKNOWN means. */
export const VENDOR_COVERAGE_FAIL_CLOSED_RULE =
  "Unknown coverage is NOT bookable everywhere — it is not bookable at all, and the refusal names the missing declaration."
