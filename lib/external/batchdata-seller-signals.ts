/**
 * lib/external/batchdata-seller-signals.ts
 *
 * A SECOND SELLER-SIGNAL SOURCE BESIDE PERMITS — and NOT a second lane.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Owner directive, verbatim: "we need to find another way to find out signs for
 * motivated sellers besides permits, maybe use our connection to batchdata?"
 *
 * lib/external/permit-signals.ts is the current seller-signal source and it has
 * a hard ceiling nobody can code around: a city building permit is only visible
 * where a city publishes one. That lane's registry covers a fixed list of
 * portals, and measured live on 2026-08-20 the tenant table it draws its markets
 * from (`lead_scraping_markets`) holds ZERO rows — so its coverage over the live
 * tenants is not "thin", it is empty, and no amount of work inside that lane
 * changes that. BatchData is national, address-keyed, and already connected
 * (lib/external/batchdata-client.ts, live consumer at lib/kernel/intent-campaign.ts:29).
 *
 * ── WHAT IT IS, AND THE LINE IT DOES NOT CROSS ───────────────────────────────
 * This is a SIGNAL lane, not a sourcing lane. It reads the leads the brokerage
 * ALREADY OWNS, looks each one's own address up at the provider, and files what
 * it finds into the ONE existing signal table — `motivated_seller_signals`, the
 * same table permit-signals writes and lead scoring reads. It creates no lead,
 * no contact, and no raw scraped record; lead SOURCING belongs to
 * lib/lead-pipeline and its consent/territory gates and is untouched here.
 *
 * That direction — from OUR lead outward to the provider, never from the
 * provider's market inward — is what keeps the two apart, and it also removes
 * the class of error permit-signals spends a page refusing: there is no
 * market-wide row set to fuzzy-match against, because the query IS the lead's
 * address. The returned property is still checked for EXACT address-key equality
 * (the same `normalizeStreetAddress` the permit lane uses, so there is one
 * address vocabulary), because a provider that "helpfully" returns the nearest
 * match would otherwise attach a neighbour's foreclosure to our lead's record,
 * and every downstream score would then treat it as observed fact.
 *
 * ── FAIR HOUSING IS STRUCTURAL HERE, NOT ADVISORY ────────────────────────────
 * The provider sells a `demographics` dataset — age, gender, hasChildren,
 * singleParent, maritalStatus, recentlyDivorced, religiousAffiliation, income,
 * netWorth (32 fields, read live from its own catalogue on 2026-08-20) — in the
 * same request body and the same response row as the motivation data we want.
 * `min_owner_age: 70` is the same shape of edit as `min_sale_propensity: 70`.
 *
 * So every signal type below is DECLARED through `defineSellerSignalSources`
 * (lib/lead-governance/protected-class-signals.ts), which runs the
 * protected-class gate over every field the type names as its source AT MODULE
 * LOAD. Adding a signal sourced from `demographics.age`, `senior-owner`,
 * `inherited` or `min_household_income` makes THIS MODULE THROW ON IMPORT — the
 * cron, the type check and the simulator all stop. The same file gates the
 * outbound query (`stripProtectedClassCriteria`) and redacts the stored row
 * (`redactProtectedClassFields`), so a protected value cannot be asked for,
 * cannot arrive unasked and be kept, and cannot become a signal type.
 * scripts/batchdata-seller-signal-simulator.ts carries the positive control.
 *
 * ── ONE VOCABULARY ───────────────────────────────────────────────────────────
 * `signal_strength` is the four-value ladder owned by
 * lib/lead-governance/seller-signal-strength.ts — weak | moderate | strong |
 * urgent — and nothing here invents a competing number. (m500 made that a live
 * CHECK constraint; verified against project hrvaqgvukzxfskkcrwbt on
 * 2026-08-20.) The provider's own 0-100 sale-propensity score is READ as a
 * number and BANDED onto that ladder before storage; the raw number rides in
 * signal_details where a reader can see it, never in the strength column.
 *
 * Two of the ten signal types below are DELIBERATELY NOT NEW: `high_equity` and
 * `market_timing` are already written by app/actions/lead-intelligence.ts:1197
 * and :1180 for exactly these facts, with exactly these thresholds. A second
 * spelling of one idea is the defect CLAUDE.md §6 names, so this lane reuses
 * theirs rather than adding `equity_position` and `ownership_tenure` beside them.
 */

import { normalizeStreetAddress } from "./permit-signals"
import type { SellerSignalStrength } from "@/lib/lead-governance/seller-signal-strength"
import {
  defineSellerSignalSources, stripProtectedClassCriteria, redactProtectedClassFields,
  type SellerSignalSourceSpec,
} from "@/lib/lead-governance/protected-class-signals"

// ─────────────────────────────────────────────────────────────────────────────
// THE SIGNAL TYPES — declared through the fair-housing gate
// ─────────────────────────────────────────────────────────────────────────────

export const SALE_PROPENSITY_SIGNAL_TYPE = "sale_propensity"
export const PREFORECLOSURE_SIGNAL_TYPE = "preforeclosure"
export const TAX_DELINQUENT_SIGNAL_TYPE = "tax_delinquent"
export const INVOLUNTARY_LIEN_SIGNAL_TYPE = "involuntary_lien"
export const VACANCY_SIGNAL_TYPE = "vacancy"
export const ABSENTEE_OWNER_SIGNAL_TYPE = "absentee_owner"
export const TIRED_LANDLORD_SIGNAL_TYPE = "tired_landlord"
export const LISTING_WITHDRAWN_SIGNAL_TYPE = "listing_withdrawn"
/** REUSED, not coined — app/actions/lead-intelligence.ts:1197 already writes it. */
export const HIGH_EQUITY_SIGNAL_TYPE = "high_equity"
/** REUSED, not coined — app/actions/lead-intelligence.ts:1180 already writes it
 *  for "Long-term ownership" at the same 120-month threshold. */
export const MARKET_TIMING_SIGNAL_TYPE = "market_timing"

/**
 * EVERY signal type this lane may write, with the EXACT provider field paths it
 * is derived from. Field paths were read live from the provider's own dataset
 * catalogue on 2026-08-20 (`list_property_dataset_fields` for core, quicklist,
 * batchrank, foreclosure, mortgage-liens, valuation, listing).
 *
 * `defineSellerSignalSources` gates every one of these strings at module load.
 * That call is the enforcement; this array is the thing enforced.
 */
export const BATCHDATA_SELLER_SIGNAL_SOURCES: readonly SellerSignalSourceSpec[] =
  defineSellerSignalSources([
    {
      signalType: SALE_PROPENSITY_SIGNAL_TYPE,
      label: "Sale propensity",
      sources: ["intel.salePropensity", "intel.salePropensityCategory", "min_sale_propensity"],
      why: "The provider's purpose-built probability-of-sale model, 0-100. It is a prediction about a TRANSACTION, trained on transaction history — the single most direct answer to 'is this property likely to sell', and the reason this lane exists at all.",
    },
    {
      signalType: PREFORECLOSURE_SIGNAL_TYPE,
      label: "Foreclosure filing",
      sources: [
        "quickLists.preforeclosure", "quickLists.noticeOfDefault", "quickLists.noticeOfLisPendens",
        "quickLists.noticeOfSale", "quickLists.activeAuction",
        "foreclosure.status", "foreclosure.auctionDate", "foreclosure.recordingDate",
        "foreclosure.caseNumber", "foreclosure.documentNumber",
      ],
      why: "A recorded legal proceeding against the PROPERTY with a public filing date and, at auction stage, a public sale date. Dated, verifiable, and the strongest non-speculative reason a sale is coming.",
    },
    {
      signalType: TAX_DELINQUENT_SIGNAL_TYPE,
      label: "Property tax delinquency",
      sources: ["tax.taxDelinquentYear", "tax.taxYear", "quickLists.taxDefault", "min_tax_delinquent_year"],
      why: "Unpaid property tax is a public assessor record attached to the parcel. Multiple delinquent years is carrying cost the owner has stopped paying — pressure on the property, not a judgement about the person.",
    },
    {
      signalType: INVOLUNTARY_LIEN_SIGNAL_TYPE,
      label: "Involuntary lien",
      sources: [
        "quickLists.involuntaryLien", "involuntaryLien.liens.lienType",
        "involuntaryLien.liens.lienAmount", "involuntaryLien.liens.filingDate",
        "involuntaryLien.liens.documentNumber",
        "openLien.totalOpenLienCount", "openLien.totalOpenLienBalance",
        "involuntary_lien_type", "min_total_open_lien_count", "min_total_open_lien_balance",
      ],
      why: "A tax, mechanic, HOA or judgment lien is filed AGAINST THE PARCEL by a third party and clouds title. It must be cleared to sell, which is why an owner carrying one talks to an agent.",
    },
    {
      signalType: VACANCY_SIGNAL_TYPE,
      label: "Vacancy",
      sources: ["general.vacant", "quickLists.vacant", "general.mailingAddressVacant", "quickLists.mailingAddressVacant"],
      why: "A vacant home is carrying cost with no occupant and no income. USPS-derived and recorded against the address.",
    },
    {
      signalType: ABSENTEE_OWNER_SIGNAL_TYPE,
      label: "Absentee owner",
      sources: [
        "quickLists.absenteeOwner", "quickLists.absenteeOwnerOutOfState",
        "quickLists.absenteeOwnerInState", "quickLists.outOfStateOwner",
        "owner.ownerOccupied", "owner.mailingAddress.state",
      ],
      why: "The owner's mailing address is not the property's. A comparison of two recorded ADDRESSES — it says where mail goes, and nothing whatsoever about who the owner is.",
    },
    {
      signalType: TIRED_LANDLORD_SIGNAL_TYPE,
      label: "Tired landlord",
      sources: ["quickLists.tiredLandlord"],
      why: "The provider's own composite over long-held non-owner-occupied rentals. A property-holding pattern, and a well-understood listing trigger.",
    },
    {
      signalType: LISTING_WITHDRAWN_SIGNAL_TYPE,
      label: "Listing withdrawn unsold",
      sources: [
        "quickLists.expiredListing", "quickLists.canceledListing", "quickLists.failedListing",
        "listing.failedListingDate", "listing.status", "listing.statusCategory",
        "listing.daysOnMarket", "listing.originalListingDate", "min_days_on_market",
      ],
      why: "The owner ALREADY tried to sell and it did not complete. Demonstrated intent, evidenced by a real MLS record rather than inferred from anything.",
    },
    {
      signalType: HIGH_EQUITY_SIGNAL_TYPE,
      label: "Equity position",
      sources: [
        "valuation.equityPercent", "valuation.equityCurrentEstimatedBalance", "valuation.estimatedValue",
        "quickLists.highEquity", "quickLists.freeAndClear", "min_equity_percent", "max_equity_percent",
      ],
      why: "Equity is the CAPACITY to transact — a seller underwater usually cannot move even when they want to. Computed from the parcel's assessed value and its recorded open liens.",
    },
    {
      signalType: MARKET_TIMING_SIGNAL_TYPE,
      label: "Ownership tenure",
      sources: [
        "intel.lengthOfResidenceYears", "intel.lengthOfResidenceMonths",
        "owner.lengthOfResidenceYears", "owner.ownershipStartDate",
        "min_length_of_residence_years",
      ],
      why: "Years since the recorded ownership start date. Tenure past the typical holding period is when a move becomes statistically likely — a date arithmetic on a deed, carrying no information about the owner.",
    },
  ] as const)

/** Every signal_type this lane writes — the set the idempotency read and the
 *  m514 unique index cover. Adding a kind above without adding it to the index
 *  is how a repeating probe starts duplicating (the defect m499 fixed for the
 *  permit lane, arriving here for the same reason). */
export const BATCHDATA_SIGNAL_TYPES: readonly string[] =
  BATCHDATA_SELLER_SIGNAL_SOURCES.map((s) => s.signalType)

/** `detected_via` — the provider. Matches the connector id used by
 *  lib/agentic-os/connector-gateway and by app/actions/lead-intelligence.ts:1188. */
export const BATCHDATA_DETECTED_VIA = "batchdata"

// ─────────────────────────────────────────────────────────────────────────────
// PURE — tolerant readers over one provider property row
// ─────────────────────────────────────────────────────────────────────────────

/** PURE. Dotted-path read. Returns undefined rather than throwing on a gap. */
export function at(row: unknown, path: string): unknown {
  let node: any = row
  for (const key of path.split(".")) {
    if (node === null || node === undefined) return undefined
    node = node[key]
  }
  return node
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[$,%\s,]/g, ""))
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * PURE. Read one quickList flag.
 *
 * TWO WIRE SHAPES, BOTH REAL, and this is a live defect in the neighbouring
 * file. The provider's Property Search returns `quickLists` as an OBJECT of
 * camelCase booleans — confirmed from its own field catalogue on 2026-08-20:
 * `quickLists.preforeclosure`, `quickLists.tiredLandlord`, 39 fields — and
 * lib/external/batchdata-client.ts:394 reads it that way. But
 * `normalizeBatchDataProperty` at lib/external/batchdata-client.ts:181 reads the
 * SAME field as `Array.isArray(p.quickLists)` and produces `undefined` for every
 * object-shaped response. One file, two beliefs about one field. This reader
 * accepts both shapes rather than picking a side it cannot prove for every
 * endpoint, and the disagreement is reported rather than silently worked around.
 */
export function readQuickList(row: unknown, camelName: string): boolean {
  const ql = at(row, "quickLists") ?? at(row, "quick_lists")
  if (ql && typeof ql === "object" && !Array.isArray(ql)) {
    return (ql as Record<string, unknown>)[camelName] === true
  }
  const kebab = camelName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
  const list: unknown[] = Array.isArray(ql) ? ql : Array.isArray(at(row, "tags")) ? (at(row, "tags") as unknown[]) : []
  return list.some((v) => typeof v === "string" && (v === camelName || v.toLowerCase() === kebab))
}

/** PURE. The provider's 0-100 probability-of-sale score, or null when absent. */
export function readSalePropensity(row: unknown): number | null {
  const n = num(at(row, "intel.salePropensity"))
  if (n === null) return null
  // Refuse an out-of-range value rather than banding it. A score outside 0-100
  // is a shape change at the provider, and banding it would launder that into a
  // confident-looking signal.
  return n >= 0 && n <= 100 ? n : null
}

/** PURE. Equity as a percentage 0-100, or null. */
export function readEquityPercent(row: unknown): number | null {
  const direct = num(at(row, "valuation.equityPercent"))
  if (direct !== null && direct >= 0 && direct <= 100) return direct
  const equity = num(at(row, "valuation.equityCurrentEstimatedBalance"))
  const value = num(at(row, "valuation.estimatedValue"))
  if (equity === null || value === null || value <= 0) return null
  const pct = (equity / value) * 100
  return pct >= 0 && pct <= 100 ? Math.round(pct) : null
}

/** PURE. Whole years the current owner has held the property, or null. */
export function readTenureYears(row: unknown, todayIso?: string): number | null {
  const years = num(at(row, "intel.lengthOfResidenceYears")) ?? num(at(row, "owner.lengthOfResidenceYears"))
  if (years !== null && years >= 0) return Math.floor(years)
  const months = num(at(row, "intel.lengthOfResidenceMonths")) ?? num(at(row, "owner.lengthOfResidenceMonths"))
  if (months !== null && months >= 0) return Math.floor(months / 12)
  const start = at(row, "owner.ownershipStartDate")
  if (typeof start === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(start)
    const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(todayIso ?? "")
    if (m && t) {
      let y = Number(t[1]) - Number(m[1])
      if (Number(t[2]) < Number(m[2]) || (t[2] === m[2] && Number(t[3]) < Number(m[3]))) y--
      return y >= 0 ? y : null
    }
  }
  return null
}

/** PURE. The most recent delinquent tax year, or null. */
export function readTaxDelinquentYear(row: unknown): number | null {
  const y = num(at(row, "tax.taxDelinquentYear"))
  // A four-digit year or nothing. `0` is the provider's "not delinquent", and
  // treating it as year zero would file every clean parcel as decades overdue.
  return y !== null && y >= 1900 && y <= 2200 ? y : null
}

export interface LienReading {
  count: number | null
  balance: number | null
  types: string[]
  /** Filing handle of the most identifiable lien, for dedupe. */
  handle: string | null
}

/** PURE. The property's open involuntary-lien position. */
export function readLiens(row: unknown): LienReading {
  const liens = at(row, "involuntaryLien.liens")
  const arr: any[] = Array.isArray(liens) ? liens : []
  const types = [...new Set(arr.map((l) => l?.lienType).filter((t): t is string => typeof t === "string" && !!t.trim()))]
  const handleParts = arr
    .map((l) => (typeof l?.documentNumber === "string" && l.documentNumber) || (typeof l?.filingDate === "string" && l.filingDate) || null)
    .filter((h): h is string => !!h)
    .sort()
  return {
    count: num(at(row, "openLien.totalOpenLienCount")) ?? (arr.length > 0 ? arr.length : null),
    balance: num(at(row, "openLien.totalOpenLienBalance")),
    types,
    handle: handleParts.length > 0 ? handleParts.join("+").slice(0, 120) : null,
  }
}

export interface ForeclosureReading {
  /** The furthest stage the record proves. Null when nothing foreclosure-shaped. */
  stage: "auction" | "notice_of_sale" | "lis_pendens" | "notice_of_default" | "preforeclosure" | null
  auctionDate: string | null
  status: string | null
  /** Stable handle for this filing: case number, else document number, else recording date. */
  handle: string | null
}

/**
 * PURE. The property's foreclosure position, read STAGE-FIRST.
 *
 * The stages are ordered because they are a real sequence and the provider can
 * flag several at once: a property at auction is still, truthfully, in
 * preforeclosure. Reading "the first true flag" in declaration order would let
 * an auction with a date read as a generic preforeclosure and lose the only
 * fact in the record that carries a deadline.
 */
export function readForeclosure(row: unknown): ForeclosureReading {
  const stage: ForeclosureReading["stage"] =
    readQuickList(row, "activeAuction") ? "auction"
    : readQuickList(row, "noticeOfSale") ? "notice_of_sale"
    : readQuickList(row, "noticeOfLisPendens") ? "lis_pendens"
    : readQuickList(row, "noticeOfDefault") ? "notice_of_default"
    : readQuickList(row, "preforeclosure") ? "preforeclosure"
    : null
  const str = (p: string) => { const v = at(row, p); return typeof v === "string" && v.trim() ? v.trim() : null }
  const auctionRaw = str("foreclosure.auctionDate")
  const auctionDate = auctionRaw ? (/^(\d{4}-\d{2}-\d{2})/.exec(auctionRaw)?.[1] ?? null) : null
  return {
    stage,
    auctionDate,
    status: str("foreclosure.status"),
    handle: str("foreclosure.caseNumber") ?? str("foreclosure.documentNumber") ?? str("foreclosure.recordingDate"),
  }
}

/** PURE. The property address the provider actually returned, or null. */
export function readProviderAddress(row: unknown): string | null {
  const street = at(row, "address.street") ?? at(row, "address.formattedStreet") ?? at(row, "address.streetNoUnit")
  return typeof street === "string" && street.trim() ? street.trim() : null
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — strength banding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The strength levels THIS LANE emits — the full four-value ladder owned by
 * lib/lead-governance/seller-signal-strength.ts.
 *
 * UNLIKE THE PERMIT LANE, THIS ONE CAN SPELL "urgent", and only in one place.
 * permit-signals.ts narrows itself to weak|moderate|strong with a stated reason:
 * "urgent" is a judgement about a PERSON'S situation and a building permit is a
 * fact about a STRUCTURE. That reasoning holds, and a scheduled foreclosure
 * auction passes it — a recorded trustee's sale with a DATE is the owner's
 * situation, publicly filed, with a deadline on it, and it is read rather than
 * judged. Nothing else here reaches the top of the ladder: a propensity score is
 * a model probability, not an event, and it is capped at "strong" no matter how
 * high it runs.
 */
export type BatchDataSignalStrength = SellerSignalStrength

/** PURE. Band the provider's 0-100 propensity onto the ladder, or null when the
 *  score is too low to be worth a row at all. */
export function bandSalePropensity(score: number | null): BatchDataSignalStrength | null {
  if (score === null) return null
  if (score >= 90) return "strong"
  if (score >= 75) return "moderate"
  if (score >= 60) return "weak"
  // Below 60 the model is not saying anything. Filing it as "weak" would put a
  // row on the record of every property the provider has ever scored, and lead
  // scoring COUNTS these rows — a signal that fires for everyone is a constant,
  // not a signal.
  return null
}

/** PURE. Band equity onto the ladder. Thresholds are lifted verbatim from the
 *  existing writer at app/actions/lead-intelligence.ts:1203 (>0.75 strong,
 *  >0.5 moderate) so the two writers of `high_equity` cannot disagree. */
export function bandEquity(percent: number | null, freeAndClear: boolean): BatchDataSignalStrength | null {
  if (freeAndClear) return "strong"
  if (percent === null) return null
  if (percent > 75) return "strong"
  if (percent > 50) return "moderate"
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — derivation
// ─────────────────────────────────────────────────────────────────────────────

export interface DerivedSellerSignal {
  signalType: string
  strength: BatchDataSignalStrength
  /**
   * What makes ONE occurrence of this fact different from the next one.
   *
   * THE DEDUPE UNIT, and the reason this lane can be re-run without inflating a
   * lead's score. A state that persists (vacant, absentee) has a constant
   * variant, so re-probing files nothing new. An EVENT (a new lien, a second
   * failed listing, a further delinquent year) carries its own handle, so a
   * genuinely new occurrence is a genuinely new row. A moving SCORE carries its
   * band, so a lead that climbs from moderate to strong files a second row and
   * a lead that merely stays high does not.
   */
  variant: string
  /** Fixed sentence. Nothing in this lane is authored by a model. */
  reason: string
  /** The read values behind the verdict, for the operator and the scorer. */
  observed: Record<string, unknown>
}

/**
 * PURE. Every seller signal one provider property row supports.
 *
 * DELIBERATELY CONSERVATIVE, in the same direction as the permit lane. A fact
 * that is true of a large fraction of all homes (any equity at all, five years
 * of ownership) produces NO row rather than a weak one, because lead scoring
 * counts rows and a signal that fires for everybody moves every lead equally —
 * which is the same as moving none of them, while looking like coverage.
 */
export function deriveSellerSignals(
  row: unknown,
  opts?: { todayIso?: string },
): DerivedSellerSignal[] {
  const out: DerivedSellerSignal[] = []
  const today = opts?.todayIso ?? new Date().toISOString().slice(0, 10)

  // ── sale propensity ──
  const propensity = readSalePropensity(row)
  const propensityBand = bandSalePropensity(propensity)
  if (propensityBand) {
    out.push({
      signalType: SALE_PROPENSITY_SIGNAL_TYPE,
      strength: propensityBand,
      variant: `band:${propensityBand}`,
      reason: "Provider sale-propensity model scores this property as likely to transact",
      observed: {
        sale_propensity: propensity,
        sale_propensity_category: at(row, "intel.salePropensityCategory") ?? null,
      },
    })
  }

  // ── foreclosure ──
  const fc = readForeclosure(row)
  if (fc.stage) {
    // "urgent" ONLY where the record carries a SALE, and only where that sale is
    // still ahead of us. A trustee's sale that already happened is history, not
    // a deadline, and calling it urgent would send an agent at a property that
    // has already changed hands.
    const dated = fc.stage === "auction" || fc.stage === "notice_of_sale"
    const futureAuction = !!fc.auctionDate && fc.auctionDate >= today
    const strength: BatchDataSignalStrength =
      dated && futureAuction ? "urgent"
      : dated ? "strong"
      : fc.stage === "lis_pendens" || fc.stage === "notice_of_default" ? "strong"
      : "moderate"
    out.push({
      signalType: PREFORECLOSURE_SIGNAL_TYPE,
      strength,
      variant: fc.handle ? `f:${fc.handle}` : `s:${fc.stage}`,
      reason: "Recorded foreclosure filing against this property",
      observed: {
        stage: fc.stage,
        auction_date: fc.auctionDate,
        foreclosure_status: fc.status,
        auction_is_upcoming: fc.auctionDate ? futureAuction : null,
      },
    })
  }

  // ── tax delinquency ──
  const delinquentYear = readTaxDelinquentYear(row)
  if (delinquentYear !== null || readQuickList(row, "taxDefault")) {
    const currentYear = Number(today.slice(0, 4))
    const yearsBehind = delinquentYear !== null ? currentYear - delinquentYear : null
    out.push({
      signalType: TAX_DELINQUENT_SIGNAL_TYPE,
      strength: yearsBehind !== null && yearsBehind >= 3 ? "strong" : "moderate",
      variant: delinquentYear !== null ? `y:${delinquentYear}` : "q:tax-default",
      reason: "Unpaid property tax recorded against this parcel",
      observed: { tax_delinquent_year: delinquentYear, years_behind: yearsBehind, tax_year: at(row, "tax.taxYear") ?? null },
    })
  }

  // ── involuntary liens ──
  const liens = readLiens(row)
  const hasLien = readQuickList(row, "involuntaryLien") || (liens.count ?? 0) > 0 || liens.types.length > 0
  if (hasLien) {
    const heavy = (liens.count ?? 0) >= 2 || (liens.balance ?? 0) >= 25_000
    out.push({
      signalType: INVOLUNTARY_LIEN_SIGNAL_TYPE,
      strength: heavy ? "strong" : "moderate",
      variant: liens.handle ? `l:${liens.handle}` : `n:${liens.count ?? 1}`,
      reason: "Involuntary lien filed against this property by a third party",
      observed: { open_lien_count: liens.count, open_lien_balance: liens.balance, lien_types: liens.types },
    })
  }

  // ── vacancy ──
  const vacant = at(row, "general.vacant") === true || readQuickList(row, "vacant")
  const mailVacant = at(row, "general.mailingAddressVacant") === true || readQuickList(row, "mailingAddressVacant")
  if (vacant || mailVacant) {
    out.push({
      signalType: VACANCY_SIGNAL_TYPE,
      // A vacant PROPERTY is carrying cost with nobody in it. A vacant MAILING
      // address is a weaker, second-hand read — the owner's mail is undeliverable,
      // which is suggestive and not the same observation.
      strength: vacant ? "strong" : "moderate",
      variant: vacant ? "v:property" : "v:mailing",
      reason: vacant ? "Property is recorded vacant" : "Owner's mailing address is recorded vacant",
      observed: { property_vacant: vacant, mailing_address_vacant: mailVacant },
    })
  }

  // ── absentee ──
  const outOfState = readQuickList(row, "absenteeOwnerOutOfState") || readQuickList(row, "outOfStateOwner")
  const absentee = outOfState || readQuickList(row, "absenteeOwner") || readQuickList(row, "absenteeOwnerInState")
  if (absentee) {
    out.push({
      signalType: ABSENTEE_OWNER_SIGNAL_TYPE,
      strength: outOfState ? "moderate" : "weak",
      variant: outOfState ? "a:out-of-state" : "a:in-state",
      reason: outOfState
        ? "Owner's mailing address is in another state"
        : "Owner's mailing address is not the property address",
      observed: { out_of_state: outOfState, owner_occupied: at(row, "owner.ownerOccupied") ?? null },
    })
  }

  // ── tired landlord ──
  if (readQuickList(row, "tiredLandlord")) {
    out.push({
      signalType: TIRED_LANDLORD_SIGNAL_TYPE,
      strength: "moderate",
      variant: "q:tired-landlord",
      reason: "Provider flags a long-held non-owner-occupied rental",
      observed: { tired_landlord: true },
    })
  }

  // ── listing withdrawn unsold ──
  const expired = readQuickList(row, "expiredListing")
  const canceled = readQuickList(row, "canceledListing")
  const failed = readQuickList(row, "failedListing")
  if (expired || canceled || failed) {
    const failedDateRaw = at(row, "listing.failedListingDate")
    const failedDate = typeof failedDateRaw === "string" ? (/^(\d{4}-\d{2}-\d{2})/.exec(failedDateRaw)?.[1] ?? null) : null
    const kind = expired ? "expired" : canceled ? "canceled" : "failed"
    out.push({
      signalType: LISTING_WITHDRAWN_SIGNAL_TYPE,
      strength: "strong",
      variant: failedDate ? `d:${failedDate}` : `k:${kind}`,
      reason: "A prior listing on this property came off the market without selling",
      observed: {
        withdrawal_kind: kind,
        failed_listing_date: failedDate,
        days_on_market: num(at(row, "listing.daysOnMarket")),
        original_listing_date: at(row, "listing.originalListingDate") ?? null,
      },
    })
  }

  // ── equity (REUSED signal_type: high_equity) ──
  const equityPercent = readEquityPercent(row)
  const freeAndClear = readQuickList(row, "freeAndClear")
  const equityBand = bandEquity(equityPercent, freeAndClear)
  if (equityBand) {
    out.push({
      signalType: HIGH_EQUITY_SIGNAL_TYPE,
      strength: equityBand,
      variant: `band:${equityBand}`,
      reason: "High equity position",
      observed: {
        equity_percent: equityPercent,
        free_and_clear: freeAndClear,
        estimated_value: num(at(row, "valuation.estimatedValue")),
      },
    })
  }

  // ── tenure (REUSED signal_type: market_timing) ──
  const tenure = readTenureYears(row, today)
  if (tenure !== null && tenure >= 10) {
    out.push({
      signalType: MARKET_TIMING_SIGNAL_TYPE,
      // "moderate" matches the existing writer at lead-intelligence.ts:1183,
      // which emits moderate at >= 120 months. Same fact, same word.
      strength: "moderate",
      variant: `band:${tenure >= 20 ? "20y" : "10y"}`,
      reason: "Long-term ownership",
      observed: { tenure_years: tenure, ownership_start_date: at(row, "owner.ownershipStartDate") ?? null },
    })
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — the row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PURE. Stable identity for one (fact, lead) pair.
 *
 * Keyed on the FACT's own variant, never on the run date. A daily or weekly
 * re-probe of the same unchanged property therefore produces the same key and
 * writes nothing — which is the whole reason the m514 index exists, and the same
 * lesson m490/m499 taught the permit lane: lead scoring COUNTS these rows, so a
 * re-read that files a second copy is a scoring defect wearing a duplicate-row
 * costume.
 */
export function batchDataSignalDedupeKey(params: {
  signal: DerivedSellerSignal
  leadId: string
}): string {
  return `batchdata|${params.signal.signalType}|${params.signal.variant}|${params.leadId}`
}

export interface BatchDataSignalRow {
  lead_id: string
  brokerage_id: string
  signal_type: string
  signal_strength: BatchDataSignalStrength
  detected_via: string
  signal_details: Record<string, unknown>
}

/**
 * PURE. Build the `motivated_seller_signals` row. Columns verified against the
 * live table (project hrvaqgvukzxfskkcrwbt, 2026-08-20): lead_id, brokerage_id,
 * signal_type, signal_strength, detected_via, signal_details jsonb, detected_at
 * (defaults now()). PGRST204 refuses an INSERT naming an absent column ENTIRELY,
 * so this row names those seven and nothing else.
 *
 * `observed` is passed through `redactProtectedClassFields` on the way in — the
 * THIRD fair-housing gate. The derivation never reads a protected field, so this
 * should always be a no-op; that is exactly why it runs, because a redaction
 * that only fires when someone already made the mistake is not a gate.
 */
export function buildBatchDataSignalRow(params: {
  signal: DerivedSellerSignal
  leadId: string
  brokerageId: string
  leadAddressKey: string
  providerAddress: string | null
}): BatchDataSignalRow {
  const { value: observed, redacted } = redactProtectedClassFields(params.signal.observed)
  return {
    lead_id: params.leadId,
    brokerage_id: params.brokerageId,
    signal_type: params.signal.signalType,
    signal_strength: params.signal.strength,
    detected_via: BATCHDATA_DETECTED_VIA,
    signal_details: {
      reason: params.signal.reason,
      dedupe_key: batchDataSignalDedupeKey({ signal: params.signal, leadId: params.leadId }),
      source: "batchdata_property",
      variant: params.signal.variant,
      address_key: params.leadAddressKey,
      provider_address: params.providerAddress,
      observed: observed as Record<string, unknown>,
      // A redaction is a REPORTED fact, never a silent one. An empty array here
      // is the expected state and says the gate ran and found nothing to remove.
      protected_class_redacted: redacted,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB — the ingest
// ─────────────────────────────────────────────────────────────────────────────

/** The minimum a lead row must carry to be probed. */
export interface ProbeableLead {
  id: string
  address: string | null
  city?: string | null
  state?: string | null
  zip_code?: string | null
}

/** The adapter envelope, matching the shape permit-signals' two providers share. */
export interface PropertyLookupResult {
  ok: boolean
  status: number | null
  data: Record<string, unknown> | null
  error: string | null
}

/** Injectable seam: one lead's address → one provider property row. Real
 *  implementation below; the simulator supplies its own so the proof costs
 *  nothing and never depends on a vendor's uptime. */
export type PropertyLookup = (lead: ProbeableLead) => Promise<PropertyLookupResult>

/**
 * PURE. Which of a tenant's leads to probe on a given day.
 *
 * ROTATION, NOT A CURSOR, and the reason is a measurement one. A lead the
 * provider knows nothing about produces NO row, so "we checked and found
 * nothing" leaves no trace to read back — a last-checked timestamp derived from
 * the signal table would re-probe those leads every single day forever and bill
 * for it, while a lead WITH a signal was never looked at again.
 *
 * So the selection is a deterministic rotation over the tenant's leads, sorted
 * by id and offset by the day. Every lead is probed once per
 * ceil(total / perRun) days, spend is bounded by `perRun` regardless of how many
 * leads the tenant has, and the schedule is reproducible from the date alone —
 * no state, nothing to drift.
 */
export function selectLeadsToProbe(params: {
  leads: ProbeableLead[]
  perRun: number
  dayIso: string
}): ProbeableLead[] {
  const usable = params.leads
    .filter((l) => !!normalizeStreetAddress(l.address))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (usable.length === 0 || params.perRun <= 0) return []
  if (usable.length <= params.perRun) return usable
  const days = Math.floor(Date.parse(`${params.dayIso}T00:00:00Z`) / 86_400_000)
  const offset = ((days * params.perRun) % usable.length + usable.length) % usable.length
  const out: ProbeableLead[] = []
  for (let i = 0; i < params.perRun; i++) out.push(usable[(offset + i) % usable.length])
  return out
}

export interface BatchDataSignalIngestResult {
  brokerageId: string
  leadsAvailable: number
  leadsProbed: number
  /** Probes the provider REFUSED. Distinct from `leadsNoMatch` on purpose:
   *  "the provider said no" and "the provider has nothing on this address" are
   *  two different facts and collapsing them is how a dead connector reads as a
   *  quiet market. */
  lookupsRefused: number
  /** Probes that served but returned no property for the address. */
  leadsNotFound: number
  /** Probes whose returned property did NOT match the lead's address key. */
  leadsAddressMismatch: number
  /** Probes that served a matching property carrying no qualifying signal. */
  leadsNoSignal: number
  signalsDerived: number
  alreadyRecorded: number
  signalsWritten: number
  /** Per signal_type counts of what was WRITTEN — the breakdown a total hides. */
  writtenByType: Record<string, number>
  /** Protected-class field paths the storage gate removed. Expected empty. */
  protectedClassRedacted: string[]
  /** Every refusal, verbatim. A run with errors NEVER reports a clean success. */
  errors: string[]
}

/** Minimal client surface — accepts the SSR or service supabase client. */
type SupabaseLike = { from: (table: string) => any }

export const MAX_LEADS_READ = 5000
export const DEFAULT_LOOKUPS_PER_RUN = 200
const MAX_SIGNALS_PER_RUN = 500

/**
 * Run the BatchData seller-signal probe for ONE brokerage over its OWN leads.
 *
 * TENANT SCOPING: `brokerageId` is a parameter of this function and the CALLER
 * takes it from the session or from the cron's own tenant loop — never from a
 * request body (the IDOR shape CLAUDE.md §4 names). Every read filters
 * `.eq("brokerage_id", brokerageId)` and every written row carries it, so a
 * property fact can only ever attach to a lead the same brokerage owns.
 *
 * REFUSALS: supabase-js RESOLVES a refused query, so every call destructures
 * `{ data, error }` and pushes the message onto `errors`. A refused lead read or
 * a refused idempotency read returns with nothing written — never as "0 signals".
 */
export async function ingestBatchDataSellerSignals(params: {
  supabase: SupabaseLike
  brokerageId: string
  lookup: PropertyLookup
  /** `YYYY-MM-DD`. Drives the rotation and the "is this auction still ahead" read. */
  dayIso: string
  lookupsPerRun?: number
}): Promise<BatchDataSignalIngestResult> {
  const { supabase, brokerageId, lookup, dayIso } = params
  const perRun = params.lookupsPerRun ?? DEFAULT_LOOKUPS_PER_RUN
  const result: BatchDataSignalIngestResult = {
    brokerageId,
    leadsAvailable: 0,
    leadsProbed: 0,
    lookupsRefused: 0,
    leadsNotFound: 0,
    leadsAddressMismatch: 0,
    leadsNoSignal: 0,
    signalsDerived: 0,
    alreadyRecorded: 0,
    signalsWritten: 0,
    writtenByType: {},
    protectedClassRedacted: [],
    errors: [],
  }

  // ── 1. The tenant's own leads (the ONLY things a property fact may attach to) ──
  const { data: leadRows, error: leadsError } = await supabase
    .from("leads")
    .select("id, address, city, state, zip_code")
    .eq("brokerage_id", brokerageId)
    .not("address", "is", null)
    .limit(MAX_LEADS_READ)
  if (leadsError) {
    result.errors.push(`leads read refused: ${leadsError.message}`)
    return result
  }
  const leads = (leadRows ?? []) as ProbeableLead[]
  result.leadsAvailable = leads.length
  const batch = selectLeadsToProbe({ leads, perRun, dayIso })
  if (batch.length === 0) return result

  // ── 2. Already-filed BatchData signals for this tenant (idempotency) ──
  //
  // `.in`, not `.eq` — this lane writes ten signal types and reading back only
  // one would re-file the other nine on every rotation. m514 widens the unique
  // index to the same set; this read is the fast path in front of it.
  const { data: existingRows, error: existingError } = await supabase
    .from("motivated_seller_signals")
    .select("signal_details")
    .eq("brokerage_id", brokerageId)
    .in("signal_type", BATCHDATA_SIGNAL_TYPES)
  if (existingError) {
    // Without the existing set we cannot tell a new fact from one filed last
    // rotation. Writing anyway would duplicate a lead's whole signal set every
    // pass and inflate its score, so this refuses instead.
    result.errors.push(`existing-signal read refused: ${existingError.message}`)
    return result
  }
  const alreadyKeys = new Set<string>()
  for (const row of (existingRows ?? []) as Array<{ signal_details: { dedupe_key?: string } | null }>) {
    const k = row?.signal_details?.dedupe_key
    if (typeof k === "string" && k) alreadyKeys.add(k)
  }

  // ── 3. Probe, verify the address, derive ──
  const toWrite: BatchDataSignalRow[] = []
  for (const lead of batch) {
    result.leadsProbed++
    const leadKey = normalizeStreetAddress(lead.address)
    const res = await lookup(lead)
    if (!res.ok) {
      result.lookupsRefused++
      result.errors.push(`lead ${lead.id}: provider refused (${res.status ?? "network"}): ${res.error ?? "no reason given"}`)
      continue
    }
    if (!res.data) { result.leadsNotFound++; continue }

    // EXACT key equality, the same refusal permit-signals makes. A provider free
    // to return "the closest match" would otherwise put a neighbour's foreclosure
    // on this lead's record, and every downstream score would read it as fact.
    const providerAddress = readProviderAddress(res.data)
    if (normalizeStreetAddress(providerAddress) !== leadKey) {
      result.leadsAddressMismatch++
      continue
    }

    const derived = deriveSellerSignals(res.data, { todayIso: dayIso })
    if (derived.length === 0) { result.leadsNoSignal++; continue }
    result.signalsDerived += derived.length

    for (const signal of derived) {
      const key = batchDataSignalDedupeKey({ signal, leadId: lead.id })
      if (alreadyKeys.has(key)) { result.alreadyRecorded++; continue }
      alreadyKeys.add(key) // also dedupes WITHIN this run
      const row = buildBatchDataSignalRow({
        signal, leadId: lead.id, brokerageId, leadAddressKey: leadKey, providerAddress,
      })
      const redacted = (row.signal_details as { protected_class_redacted?: string[] }).protected_class_redacted ?? []
      for (const r of redacted) if (!result.protectedClassRedacted.includes(r)) result.protectedClassRedacted.push(r)
      toWrite.push(row)
      if (toWrite.length >= MAX_SIGNALS_PER_RUN) break
    }
    if (toWrite.length >= MAX_SIGNALS_PER_RUN) break
  }

  if (toWrite.length === 0) return result

  // ── 4. Write ──
  //
  // m514 adds the partial UNIQUE index on (signal_type, signal_details->>'dedupe_key')
  // for this lane's types. The read in step 2 is the fast path; the index is the
  // guarantee. A batch INSERT is ONE statement, so a single duplicate (a
  // concurrent run, a re-dispatch) rejects the whole batch — a 23505 therefore
  // falls back to per-row inserts, which lets every genuinely-new signal through
  // and counts the collisions as what they are. Any OTHER error is reported.
  const countWritten = (rows: BatchDataSignalRow[]) => {
    for (const r of rows) result.writtenByType[r.signal_type] = (result.writtenByType[r.signal_type] ?? 0) + 1
  }

  const { data: inserted, error: insertError } = await supabase
    .from("motivated_seller_signals")
    .insert(toWrite)
    .select("id")

  if (!insertError) {
    result.signalsWritten = (inserted ?? []).length
    countWritten(toWrite)
    return result
  }
  if ((insertError as { code?: string }).code !== "23505") {
    result.errors.push(`motivated_seller_signals insert refused: ${insertError.message}`)
    return result
  }

  for (const row of toWrite) {
    const { data: one, error: oneError } = await supabase
      .from("motivated_seller_signals")
      .insert(row)
      .select("id")
      .maybeSingle()
    if (!oneError) { if (one) { result.signalsWritten++; countWritten([row]) } ; continue }
    if ((oneError as { code?: string }).code === "23505") { result.alreadyRecorded++; continue }
    result.errors.push(`motivated_seller_signals insert refused: ${oneError.message}`)
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// The real provider adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The provider datasets this lane requests. `demographic` is CONSPICUOUSLY
 * ABSENT and that absence is the point: not asking for it is the cheapest of the
 * three fair-housing gates, and the two behind it (the declaration gate and the
 * storage redaction) exist because "we did not ask" is not the same as "it did
 * not arrive".
 */
export const BATCHDATA_SIGNAL_DATASETS: readonly string[] = [
  "core", "quicklist", "batchrank", "foreclosure", "mortgage-liens", "valuation", "listing",
]

/**
 * Look one lead's own address up at the provider. NEVER THROWS — it returns the
 * same `{ ok, status, data, error }` envelope the injectable seam declares, so a
 * vendor outage is a counted refusal rather than a dead cron.
 *
 * The search criteria go through `stripProtectedClassCriteria` before they leave
 * the process. There is nothing protected in what this function assembles today;
 * the gate is here so that stays true after the next edit, and so a removal is
 * REPORTED rather than silently narrowing the query.
 */
export async function realBatchDataPropertyLookup(lead: ProbeableLead): Promise<PropertyLookupResult> {
  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const query = [lead.address, lead.city, lead.state, lead.zip_code].filter(Boolean).join(", ")
    const { criteria, removed } = stripProtectedClassCriteria({ query })
    if (removed.length > 0) {
      return { ok: false, status: null, data: null, error: `protected-class criteria refused: ${removed.join(", ")}` }
    }
    const res = await callConnector<any>({
      connector: "batchdata",
      baseUrl: "https://api.batchdata.com/api/v1",
      path: "property/search",
      method: "POST",
      auth: { style: "bearer", token: process.env.BATCHDATA_API_KEY ?? "" },
      body: { searchCriteria: criteria, options: { take: 1, skip: 0 }, datasets: BATCHDATA_SIGNAL_DATASETS },
    })
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, error: res.error ?? "batchdata refused" }
    }
    const properties: any[] = res.data?.results?.properties ?? res.data?.results ?? []
    return { ok: true, status: res.status, data: (properties[0] as Record<string, unknown>) ?? null, error: null }
  } catch (e) {
    return { ok: false, status: null, data: null, error: e instanceof Error ? e.message : String(e) }
  }
}
