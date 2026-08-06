/**
 * CMA COMP PROVIDER — where a CMA's comparables actually come from.
 *
 * THE RULING THIS IMPLEMENTS (owner, verbatim):
 *   "the cma generator that the presentation is using uses rentcast by default
 *    which is platform owned and if the agent connects their idx broker then
 *    they would use that provider. cma can use ai to help with the cma but
 *    needs at least 3 sold listings within 6 months but can use 1 year in case
 *    limited comps, 2 active and 1 pending."
 *
 * ─── PROVIDER RESOLUTION ────────────────────────────────────────────────────
 * SOLD side   → RentCast, always. RentCast is the platform-owned provider and
 *               it is the ONLY connected source that can serve closed/off-market
 *               comparables. IDX Broker cannot: a bare IDX key reaches only the
 *               brokerage's own featured/active set, because per-MLS search needs
 *               account-specific MLS ids + field mappings provisioned per
 *               brokerage (see lib/idxbroker-client.ts). "Use IDX when connected"
 *               therefore CANNOT mean sold comps, and this module does not
 *               pretend otherwise.
 * ACTIVE side → the brokerage's connected IDX Broker feed WHEN ONE IS CONNECTED
 *               (their own MLS-rights inventory, narrowed to the subject's
 *               city/ZIP); RentCast's still-listed comparables otherwise.
 * PENDING     → IDX only, and only when its feed labels a row pending/contingent.
 *               RentCast's comparable feed carries no under-contract status at
 *               all. When nothing reports one, the pending comp is ABSENT and
 *               said to be absent. It is never substituted with an active.
 *
 * ─── THE COMP MIX ───────────────────────────────────────────────────────────
 * 3 sold within 6 months, 2 active, 1 pending. The sold window widens to 12
 * months ONLY when the 6-month window returns fewer than 3, and the window that
 * was actually used is recorded on the provenance so a CMA built on year-old
 * comps has to say so.
 *
 * ─── WHAT THIS MODULE WILL NOT DO ───────────────────────────────────────────
 * It will not invent a comparable, it will not carry a comp whose date it cannot
 * establish into a "sold within N months" claim, and it will not fall back to an
 * AI web search for the comp list (that is the whole point of the ruling — see
 * lib/cma/perplexity-comp-finder.ts). When no provider returns anything it
 * returns an empty set with a legible reason, never a silent empty.
 */

import "server-only"
import { getRentcastComps, isRentcastConfigured, type RentcastComp } from "@/lib/property/rentcast"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import { IDXBrokerClient, type NormalizedIdxListing } from "@/lib/idxbroker-client"
import type { CompProviderId, ScoredComp } from "./comp-types"
import type { SubjectFeatures } from "./state-adjustment-rates"

// ─── The required mix, named once ───────────────────────────────────────────

/** At least this many SOLD comps, per the ruling. */
export const REQUIRED_SOLD_COMPS = 3
/** Exactly this many ACTIVE comps. */
export const REQUIRED_ACTIVE_COMPS = 2
/** Exactly this many PENDING comps. */
export const REQUIRED_PENDING_COMPS = 1
/** The sold window we try first. */
export const PRIMARY_SOLD_WINDOW_MONTHS = 6
/** The widened window, used ONLY when the primary one is short of the minimum. */
export const WIDENED_SOLD_WINDOW_MONTHS = 12

/**
 * How many comparables to ask RentCast for. The pull has to cover the sold set
 * AND the still-listed rows AND whatever falls outside the date window, so it is
 * deliberately larger than the 3 we keep. 20 is RentCast's own documented
 * default `compCount`; it is not raised past that to avoid a rejected request.
 */
const RENTCAST_COMP_PULL_LIMIT = 20

/** How many IDX featured rows to consider before narrowing. */
const IDX_PULL_LIMIT = 100

/** Cost telemetry, in cents, matching lib/property/rentcast.ts COST_PER_AVM_LOOKUP ($0.15). */
const RENTCAST_COMPS_COST_CENTS = 15
/** IDX Broker is a flat-rate subscription — a featured-set read has no marginal
 *  per-call price. Metered at zero cost so the CALL still appears in the vendor
 *  ledger (an unmetered egress path is not allowed), without inventing a price. */
const IDX_PULL_COST_DOLLARS = 0

// ─── Public shapes ──────────────────────────────────────────────────────────

export interface CompSourceRequest {
  brokerageId: string
  /** auth users.id of the acting agent — used ONLY to resolve their own IDX
   *  connection through the agent → team → brokerage → platform cascade. Never
   *  substituted for agents.id or any other id space. */
  agentUserId?: string | null
  teamId?: string | null
  address: string
  city?: string | null
  state?: string | null
  zip?: string | null
  /** The subject's known features — used to score similarity for providers that
   *  do not publish one of their own. */
  subject: SubjectFeatures
}

/** What actually produced this comp set. Rides on the CMA result. */
export interface CompProvenance {
  soldProvider: CompProviderId
  activeProvider: CompProviderId
  pendingProvider: CompProviderId
  /** Whether an IDX Broker key resolved for this brokerage/agent at all. */
  idxConnected: boolean
  /** Whether a RentCast key resolved (tenant row, else platform env). */
  rentcastConfigured: boolean
  /** The sold window actually used: 6, 12, or null when no sold comp was found. */
  soldWindowMonths: number | null
  /** True only when the window had to be widened because 6 months fell short. */
  soldWindowWidened: boolean
  soldCompCount: number
  activeCompCount: number
  pendingCompCount: number
  /** True when the set meets 3 sold + 2 active + 1 pending. */
  meetsRequiredMix: boolean
  /** Plain-language facts about what happened — every empty side gets one. */
  notes: string[]
  citations: string[]
  /** Provider spend attributable to this pull, in cents. */
  estimatedCostCents: number
}

export interface SourcedComps {
  closedComps: ScoredComp[]
  activeComps: ScoredComp[]
  pendingComps: ScoredComp[]
  provenance: CompProvenance
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function sourceCompsForCma(req: CompSourceRequest): Promise<SourcedComps> {
  const notes: string[] = []
  const citations: string[] = []
  let costCents = 0

  const fullAddress = [
    req.address,
    req.city ?? null,
    [req.state ?? null, req.zip ?? null].filter(Boolean).join(" ") || null,
  ]
    .filter(Boolean)
    .join(", ")

  // ── 1. RentCast — the platform default, and the only sold source ──────────
  const rentcastConfigured = await isRentcastConfigured(req.brokerageId)
  let rentcastRows: RentcastComp[] = []
  if (rentcastConfigured) {
    rentcastRows = await getRentcastComps({
      brokerageId: req.brokerageId,
      address: fullAddress,
      limit: RENTCAST_COMP_PULL_LIMIT,
    })
    // getRentcastComps meters its own call (usage_type comps_lookup); this only
    // mirrors the spend onto the CMA's own cost estimate.
    costCents += RENTCAST_COMPS_COST_CENTS
    if (rentcastRows.length > 0) {
      citations.push("RentCast comparable sales (/avm/value comparables)")
    } else {
      notes.push(
        "RentCast is configured but returned no comparables for this address — either the address did not resolve or RentCast has no comparable coverage there.",
      )
    }
  } else {
    notes.push(
      "RentCast is not configured for this brokerage (no tenant credential and no platform key), so no closed comparable sales could be sourced.",
    )
  }

  // ── 2. Split RentCast's rows by what their dates actually say ─────────────
  const soldCandidates: DatedComp[] = []
  const rentcastActiveCandidates: DatedComp[] = []
  let datelessCount = 0

  for (const row of rentcastRows) {
    if (row.removed_date) {
      // Off the market on a known date → a closed/sold comparable.
      soldCandidates.push({ comp: toScoredCompFromRentcast(row, "closed", row.removed_date), date: row.removed_date })
      continue
    }
    const seen = row.last_seen_date ?? row.listed_date
    if (seen) {
      // Still on the market → an ACTIVE comparable, priced at today's ask.
      rentcastActiveCandidates.push({ comp: toScoredCompFromRentcast(row, "active", seen), date: seen })
      continue
    }
    // No date of any kind. We cannot say when — or whether — this transacted, so
    // it cannot be counted toward "sold within 6 months" and it is not silently
    // promoted into the set.
    datelessCount++
  }
  if (datelessCount > 0) {
    notes.push(
      `${datelessCount} RentCast comparable(s) carried no listing dates and were excluded — a comparable with no date cannot be shown to fall inside the sold window.`,
    )
  }

  // ── 3. The sold window: 6 months, widened to 12 only when 6 falls short ───
  const now = Date.now()
  const withinMonths = (months: number) =>
    soldCandidates.filter((c) => monthsBetween(c.date, now) <= months)

  let soldWindowMonths: number | null = null
  let soldWindowWidened = false
  let soldSelected: DatedComp[] = []

  if (soldCandidates.length > 0) {
    const primary = withinMonths(PRIMARY_SOLD_WINDOW_MONTHS)
    if (primary.length >= REQUIRED_SOLD_COMPS) {
      soldSelected = primary
      soldWindowMonths = PRIMARY_SOLD_WINDOW_MONTHS
    } else {
      // Widen — and record that we did, because a 12-month comp set is a
      // materially weaker basis and the seller-facing report has to say so.
      const widened = withinMonths(WIDENED_SOLD_WINDOW_MONTHS)
      soldSelected = widened
      soldWindowMonths = widened.length > 0 ? WIDENED_SOLD_WINDOW_MONTHS : null
      soldWindowWidened = widened.length > 0
      notes.push(
        `Only ${primary.length} qualifying sale(s) closed within ${PRIMARY_SOLD_WINDOW_MONTHS} months, so the sold window was widened to ${WIDENED_SOLD_WINDOW_MONTHS} months.`,
      )
    }
  }

  const closedComps = soldSelected
    .sort((a, b) => b.comp.similarityScore - a.comp.similarityScore || compareDesc(a.date, b.date))
    .slice(0, REQUIRED_SOLD_COMPS)
    .map((c) => c.comp)

  if (closedComps.length > 0 && closedComps.length < REQUIRED_SOLD_COMPS) {
    notes.push(
      `Only ${closedComps.length} closed comparable sale(s) could be sourced — below the ${REQUIRED_SOLD_COMPS}-sale minimum this CMA is supposed to rest on.`,
    )
  }

  // ── 4. Active + pending: IDX when connected, RentCast otherwise ───────────
  const idx = await IDXBrokerClient.forBrokerage(req.brokerageId, {
    agentUserId: req.agentUserId ?? null,
    teamId: req.teamId ?? null,
  }).catch(() => null)
  const idxConnected = !!idx?.isConfigured()

  let activeComps: ScoredComp[] = []
  let pendingComps: ScoredComp[] = []
  let activeProvider: CompProviderId = "none"
  let pendingProvider: CompProviderId = "none"

  if (idxConnected && idx) {
    const idxRows = await idx
      .searchActiveListings({
        city: req.city ?? undefined,
        state: req.state ?? undefined,
        zipCode: req.zip ?? undefined,
        limit: IDX_PULL_LIMIT,
      })
      .catch(() => [] as NormalizedIdxListing[])

    // Metered even at zero marginal cost: every outbound provider call belongs in
    // the vendor ledger, and a call that never appears there cannot be governed.
    void logVendorUsage({
      vendorName: "idxbroker",
      usageType: "api_call",
      unitCount: 1,
      estimatedCost: IDX_PULL_COST_DOLLARS,
      systemSource: "cma_comp_source",
      brokerageId: req.brokerageId,
      metadata: { endpoint: "/clients/featured", rows: idxRows.length, purpose: "cma_active_comps" },
    }).catch(() => null)

    const idxActive: ScoredComp[] = []
    const idxPending: ScoredComp[] = []
    for (const row of idxRows) {
      if (!row.price || row.price <= 0) continue
      const status = idxStatusOf(row.status)
      if (status === "pending") idxPending.push(toScoredCompFromIdx(req.subject, row, "pending"))
      else if (status === "active") idxActive.push(toScoredCompFromIdx(req.subject, row, "active"))
      // Anything else the feed labels (sold/off-market/unknown) is dropped: an
      // IDX featured row is not a verifiable closed sale.
    }

    if (idxActive.length > 0) {
      activeComps = rank(idxActive).slice(0, REQUIRED_ACTIVE_COMPS)
      activeProvider = "idxbroker"
      citations.push("IDX Broker connected feed (brokerage featured/active listings)")
    } else {
      notes.push(
        "IDX Broker is connected but its featured feed returned no active listings matching the subject's city/ZIP, so the active comparables fall back to RentCast.",
      )
    }
    if (idxPending.length > 0) {
      pendingComps = rank(idxPending).slice(0, REQUIRED_PENDING_COMPS)
      pendingProvider = "idxbroker"
    }
  }

  if (activeComps.length === 0 && rentcastActiveCandidates.length > 0) {
    activeComps = rentcastActiveCandidates
      .sort((a, b) => b.comp.similarityScore - a.comp.similarityScore)
      .slice(0, REQUIRED_ACTIVE_COMPS)
      .map((c) => c.comp)
    activeProvider = "rentcast"
  }

  if (activeComps.length === 0) {
    notes.push(
      idxConnected
        ? "No active comparable listings were available from either the connected IDX feed or RentCast."
        : "No IDX feed is connected and RentCast returned no still-listed comparables, so no active comparables are included.",
    )
  } else if (activeComps.length < REQUIRED_ACTIVE_COMPS) {
    notes.push(
      `Only ${activeComps.length} active comparable listing(s) were available (the mix calls for ${REQUIRED_ACTIVE_COMPS}).`,
    )
  }

  if (pendingComps.length === 0) {
    notes.push(
      idxConnected
        ? "No pending (under-contract) comparable was available: the connected IDX feed reported none. RentCast's comparable feed carries no under-contract status at all, so none was substituted."
        : "No pending (under-contract) comparable was available. RentCast's comparable feed carries no under-contract status, and only a connected IDX Broker feed can report one — none is connected.",
    )
  }

  const meetsRequiredMix =
    closedComps.length >= REQUIRED_SOLD_COMPS &&
    activeComps.length >= REQUIRED_ACTIVE_COMPS &&
    pendingComps.length >= REQUIRED_PENDING_COMPS

  return {
    closedComps,
    activeComps,
    pendingComps,
    provenance: {
      soldProvider: closedComps.length > 0 ? "rentcast" : "none",
      activeProvider,
      pendingProvider,
      idxConnected,
      rentcastConfigured,
      soldWindowMonths,
      soldWindowWidened,
      soldCompCount: closedComps.length,
      activeCompCount: activeComps.length,
      pendingCompCount: pendingComps.length,
      meetsRequiredMix,
      notes,
      citations,
      estimatedCostCents: costCents,
    },
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface DatedComp {
  comp: ScoredComp
  date: string
}

function rank(comps: ScoredComp[]): ScoredComp[] {
  return [...comps].sort((a, b) => b.similarityScore - a.similarityScore)
}

function compareDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0
}

/** Whole months between an ISO day and `now`. Negative ages clamp to 0. */
function monthsBetween(isoDay: string, now: number): number {
  const then = new Date(`${isoDay}T00:00:00Z`).getTime()
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - then) / (30.44 * 24 * 60 * 60 * 1000))
}

/**
 * IDX feeds spell status in their own words. Only the labels that unambiguously
 * mean "under contract" become pending; only the ones that mean "for sale"
 * become active. Anything else is deliberately unclassified rather than guessed.
 */
function idxStatusOf(raw: string | null): "active" | "pending" | "other" {
  if (!raw) return "active" // /clients/featured is the brokerage's live set by default
  const s = raw.toLowerCase()
  if (s.includes("pend") || s.includes("contingent") || s.includes("under contract")) return "pending"
  if (s.includes("active") || s.includes("for sale") || s.includes("coming soon")) return "active"
  return "other"
}

/** Split a decimal bath count into the full/half pair the rate table adjusts on. */
function splitBaths(bathrooms: number | null): { fullBaths: number | null; halfBaths: number | null } {
  if (bathrooms == null || !Number.isFinite(bathrooms) || bathrooms <= 0) {
    return { fullBaths: null, halfBaths: null }
  }
  const full = Math.floor(bathrooms)
  return { fullBaths: full, halfBaths: bathrooms - full >= 0.5 ? 1 : 0 }
}

function toScoredCompFromRentcast(
  row: RentcastComp,
  status: "closed" | "active",
  effectiveDate: string,
): ScoredComp {
  const { fullBaths, halfBaths } = splitBaths(row.bathrooms)
  return {
    address: row.address,
    status,
    salePrice: row.sale_price,
    // For a closed comp this is the date it left the market; for a live one it is
    // the date RentCast last observed it. Either way it is the date the price was
    // true, which is exactly what the time-of-sale adjustment needs.
    saleDate: effectiveDate,
    sqftLiving: row.square_feet > 0 ? row.square_feet : null,
    bedrooms: row.bedrooms > 0 ? row.bedrooms : null,
    fullBaths,
    halfBaths,
    // RentCast's comparable record carries none of these. Null means unknown, so
    // computeCompAdjustments skips the line entirely rather than adjusting
    // against an assumed "no pool" / "no basement".
    garageSpaces: null,
    hasPool: null,
    isWaterfront: null,
    hasView: null,
    lotSizeAcres: row.lot_size_acres,
    yearBuilt: row.year_built,
    conditionGrade: null,
    basementFinished: null,
    isNewConstruction: null,
    isGated: null,
    daysOnMarket: row.days_on_market > 0 ? row.days_on_market : null,
    pricePerSqft: row.price_per_sqft > 0 ? row.price_per_sqft : null,
    // RentCast publishes its own correlation-to-subject; use it rather than
    // inventing a similarity number. Absent → explicitly neutral (0.5).
    similarityScore: row.correlation ?? 0.5,
    citation: "RentCast comparable (/avm/value)",
    distanceMiles: row.distance_miles > 0 ? row.distance_miles : null,
    sourceProvider: "rentcast",
    priceBasis: status === "closed" ? "closed_sale" : "list_price",
  }
}

function toScoredCompFromIdx(
  subject: SubjectFeatures,
  row: NormalizedIdxListing,
  status: "active" | "pending",
): ScoredComp {
  const { fullBaths, halfBaths } = splitBaths(row.bathrooms)
  const comp: ScoredComp = {
    address: [row.address, row.city, row.state].filter(Boolean).join(", "),
    status,
    // An IDX row's price is an ASKING price, never a sale.
    salePrice: row.price ?? 0,
    // The feed gives no list date; the price is true as of the pull, which is
    // what the time-of-sale adjustment measures against.
    saleDate: new Date().toISOString().slice(0, 10),
    sqftLiving: row.squareFeet,
    bedrooms: row.bedrooms,
    fullBaths,
    halfBaths,
    garageSpaces: null,
    hasPool: null,
    isWaterfront: null,
    hasView: null,
    lotSizeAcres: null,
    yearBuilt: row.yearBuilt,
    conditionGrade: null,
    basementFinished: null,
    isNewConstruction: null,
    isGated: null,
    daysOnMarket: row.daysOnMarket,
    pricePerSqft:
      row.price && row.squareFeet && row.squareFeet > 0 ? Math.round(row.price / row.squareFeet) : null,
    similarityScore: 0,
    citation: row.mlsNumber ? `IDX Broker feed · MLS ${row.mlsNumber}` : "IDX Broker feed",
    // IDX returns no distance from an arbitrary subject address.
    distanceMiles: null,
    sourceProvider: "idxbroker",
    priceBasis: "list_price",
  }
  comp.similarityScore = featureSimilarity(subject, comp)
  return comp
}

/**
 * Deterministic 0..1 similarity from the attributes the subject and comp SHARE.
 *
 * Used only for providers that publish no similarity metric of their own (IDX).
 * It is a ranking heuristic over known facts — not a claim about either
 * property — and when the two share no comparable attribute at all it returns an
 * explicitly neutral 0.5 rather than an invented score.
 */
function featureSimilarity(subject: SubjectFeatures, comp: ScoredComp): number {
  const parts: number[] = []

  if (subject.sqftLiving && comp.sqftLiving) {
    parts.push(clamp01(1 - Math.abs(subject.sqftLiving - comp.sqftLiving) / subject.sqftLiving))
  }
  if (subject.bedrooms != null && comp.bedrooms != null) {
    parts.push(clamp01(1 - Math.abs(subject.bedrooms - comp.bedrooms) / 3))
  }
  const subjectBaths = (subject.fullBaths ?? 0) + (subject.halfBaths ?? 0) * 0.5
  const compBaths = (comp.fullBaths ?? 0) + (comp.halfBaths ?? 0) * 0.5
  if (subjectBaths > 0 && compBaths > 0) {
    parts.push(clamp01(1 - Math.abs(subjectBaths - compBaths) / 3))
  }
  if (subject.yearBuilt && comp.yearBuilt) {
    parts.push(clamp01(1 - Math.abs(subject.yearBuilt - comp.yearBuilt) / 50))
  }

  if (parts.length === 0) return 0.5
  return parts.reduce((s, n) => s + n, 0) / parts.length
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
