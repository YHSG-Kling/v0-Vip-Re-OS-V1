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
 * ─── THE LATER RULING THAT NARROWS THE ONE ABOVE ────────────────────────────
 * Owner, verbatim: "rentcast is platform owned and should not be used if the
 * tenant adds their idx broker credentials."
 *
 * That is a CONNECTION rule. A tenant who has connected their own IDX Broker
 * account does not have the platform's RentCast account spent on their behalf —
 * not for the active side, and not for the SOLD side either, even though IDX
 * cannot serve solds. ELIGIBILITY IS THEREFORE DECIDED BEFORE ANYTHING IS
 * SPENT, at the top of sourceCompsForCma, through the one resolver in
 * lib/property/rentcast-eligibility.ts.
 *
 * This module previously called RentCast FIRST and UNCONDITIONALLY and did not
 * construct the IDX client until ninety lines later, so `idxConnected` was
 * computed AFTER `costCents += RENTCAST_COMPS_COST_CENTS` had already been
 * booked. A tenant with IDX connected paid for RentCast on every single CMA.
 *
 * CONSEQUENCE, ACCEPTED AND REPORTED RATHER THAN PAPERED OVER: the sold side is
 * RentCast-only by construction (see AI_GAP_FILL_SLOTS — an AI web search is
 * never admitted to the closed-sale set), so a tenant with their own IDX feed
 * gets a CMA with NO closed comparables and therefore no value range. That is
 * not a silent degrade: `meetsRequiredMix` is false, `rentcastEligibility`
 * names `tenant_has_idx`, and `notes` carries a sentence saying in plain words
 * that the required 3-sold minimum cannot be met and why. A CMA that cannot
 * meet the owner's mix reports that it cannot; it does not quietly return a
 * thinner set and let the reader assume the market was thin.
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
 * ─── THE AI GAP-FILL (owner's second ruling) ────────────────────────────────
 * Owner, verbatim: "perplexitycma can fill in if comps cant be found like under
 * contract/pending."
 *
 * Providers are tried FIRST for every slot, always. Only a slot still SHORT
 * after that is offered to lib/cma/perplexity-comp-finder, and only the slots
 * named in AI_GAP_FILL_SLOTS below. Every gap-filled row carries
 * `sourceProvider: "perplexity"`, the slot is recorded on
 * `CompProvenance.aiGapFilledSlots`, and the CMA's seller-facing disclaimers say
 * so in plain words. See AI_GAP_FILL_SLOTS for why the SOLD side is excluded.
 *
 * ─── WHAT THIS MODULE WILL NOT DO ───────────────────────────────────────────
 * It will not invent a comparable, it will not carry a comp whose date it cannot
 * establish into a "sold within N months" claim, it will not let an AI web
 * search anywhere near the closed-sale set that the dollar range is computed
 * from, and it will not let a gap-filled row pass as provider data. When nothing
 * can be sourced at all it returns an empty set with a legible reason, never a
 * silent empty.
 */

import "server-only"
import {
  getRentcastAvmAndComps,
  type RentcastAvmAndComps,
  type RentcastComp,
} from "@/lib/property/rentcast"
import {
  resolveRentcastEligibility,
  type RentcastEligibilityReason,
} from "@/lib/property/rentcast-eligibility"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import { IDXBrokerClient, type NormalizedIdxListing } from "@/lib/idxbroker-client"
import {
  findCompsViaPerplexity,
  PERPLEXITY_COMP_SEARCH_COST_USD,
  type PerplexityCompFinderResult,
  type PerplexityCompSlotRequest,
} from "./perplexity-comp-finder"
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

/** The three sides of the required mix, named so a shortfall can be attributed. */
export type CompSlot = "sold" | "active" | "pending"

/**
 * WHICH SLOTS AN AI WEB SEARCH IS ALLOWED TO FILL — and the reasoning, because
 * this is a judgement call and the next reader is entitled to the argument
 * rather than the conclusion.
 *
 * ADMITTED: pending, active.
 *   Both are ASKING prices. Neither enters the valuation math: runAiCma computes
 *   its low/mid/high from the ADJUSTED CLOSED comps only, and the active/pending
 *   rows exist to say which way the market is moving. An unverified row there is
 *   bounded — it can make the narrative's market-direction paragraph wrong; it
 *   cannot move the number. And the PENDING slot is the case the owner's ruling
 *   actually names: it is unservable by construction, because RentCast's
 *   comparable feed carries no under-contract status at all and IDX only reports
 *   one when the brokerage's own featured feed happens to hold it. A requirement
 *   that is normally impossible to meet is exactly what a gap-filler is for.
 *
 * REFUSED: sold.
 *   1. Closed sales are the ONLY input to the dollar range. A wrong AI-sourced
 *      sale price does not degrade the estimate, it BECOMES the estimate — the
 *      number on a seller's screen, in cma_reports, and in the appraiser packet
 *      handed to a licensed appraiser at the property.
 *   2. The failure mode is invisible. A public listing page shows a "last sold"
 *      figure, an estimate, and a list price in the same layout; a web-reading
 *      model conflating them produces a comp that is perfectly plausible and
 *      simply false. There is no downstream check that catches it.
 *   3. Unlike pending, the sold slot is NOT structurally unservable — RentCast
 *      serves closed comparables by design. A short sold set means either the
 *      tenant has no RentCast credential (a setup problem that AI would MASK
 *      rather than fix) or genuinely thin local coverage — and thin local
 *      coverage is precisely where a web search is most likely to reach for a
 *      neighbouring town and least likely to be right.
 *   4. There is already a sanctioned answer to a thin sold set: widen the window
 *      to 12 months, say so, and haircut the confidence. Where that still falls
 *      short, "this rests on 2 closed sales — treat the range as directional" is
 *      an honest CMA. "Here is a third sale we read off the internet" is not.
 *
 * Consequence, accepted deliberately: with no RentCast credential a CMA now
 * produces no value range at all. That is the correct outcome. The fix is to
 * connect the provider, and a report that says so is worth more than one that
 * quietly papers over it.
 */
export const AI_GAP_FILL_SLOTS: readonly CompSlot[] = ["active", "pending"] as const

/** Perplexity spend attributable to one gap-fill search, in cents. */
const PERPLEXITY_GAP_FILL_COST_CENTS = Math.round(PERPLEXITY_COMP_SEARCH_COST_USD * 100)

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

/** Vendor-ledger lane for a CMA comp pull when the caller did not name one.
 *  Named once so the RentCast pull and the IDX pull cannot file under two
 *  different lanes for the same CMA. */
const DEFAULT_COMP_SYSTEM_SOURCE = "cma_comp_source"

// ─── Public shapes ──────────────────────────────────────────────────────────

export interface CompSourceRequest {
  brokerageId: string
  /** auth users.id of the acting agent — used ONLY to resolve their own IDX
   *  connection through the agent → team → brokerage → platform cascade. Never
   *  substituted for agents.id or any other id space. */
  agentUserId?: string | null
  teamId?: string | null
  /**
   * The contact this CMA is being run for, when the caller has one. Vendor-
   * ledger attribution ONLY — never a credential selector, never a tenant
   * boundary (`brokerageId` is both). `AiCmaInput.contactId` had been accepted
   * by the orchestrator and read by nothing since it was written; this is where
   * it now lands, so a provider charge can be traced to the client whose CMA
   * spent it instead of only to the brokerage.
   */
  contactId?: string | null
  address: string
  city?: string | null
  state?: string | null
  zip?: string | null
  /** The subject's known features — used to score similarity for providers that
   *  do not publish one of their own. */
  subject: SubjectFeatures
  /** 'single_family' | 'condo' | 'townhouse' — narrows the AI gap-fill search. */
  propertyType?: string | null
  /**
   * Set false to refuse the AI gap-fill entirely and take the provider-only set
   * with its holes. Defaults to ON (the owner's ruling). Even when on, it only
   * ever touches the slots in AI_GAP_FILL_SLOTS.
   */
  allowAiGapFill?: boolean
  /** Vendor-ledger attribution for the lane doing the sourcing. */
  systemSource?: string
}

/**
 * THE PROVIDER'S AUTOMATED ESTIMATE — a BASELINE, never the recommendation.
 *
 * Owner, verbatim: "getting a cma is very complicated and rentcast does ovver an
 * avm which can be argued but a possible baseline."
 *
 * That is exactly the status this type encodes and enforces. RentCast's
 * `/avm/value` returns a model-computed price alongside the comparables the CMA
 * is built from, and it arrives on the SAME billed call — so refusing to show it
 * costs nothing and hides something the agent may legitimately want to argue
 * with. Showing it as if it were the analysis, however, would replace a
 * comp-derived, state-rate-adjusted value conclusion with a black-box number.
 *
 * THREE GUARANTEES, and they are the whole point of this being a named type
 * rather than three loose numbers on the provenance:
 *
 *  1. IT IS LABELLED WHEREVER IT SURFACES. `kind` is a fixed discriminator and
 *     `label` is the sentence a renderer must show beside the figure. A consumer
 *     cannot destructure a bare `value` out of this without stepping over both.
 *
 *  2. IT NEVER BECOMES THE RECOMMENDATION. Nothing in the CMA math reads this.
 *     `runAiCma` computes estimatedValueLow/Mid/High from the ADJUSTED CLOSED
 *     comps alone and this field is not an input to that; `cma_reports
 *     .recommended_price` is written from the comp-bounded pricing strategy.
 *     If this ever became either, the CMA would be reporting a vendor's model as
 *     its own analysis — which is the failure the comp-sourcing rules above
 *     exist to prevent, arriving through a different door.
 *
 *  3. MISSING READS AS MISSING. `available: false` with `value: null` and a
 *     plain-language `unavailableNote`. Never 0, never silently absent — a
 *     baseline of $0 next to a $600k range is a defect that looks like data,
 *     and a baseline that quietly vanishes when RentCast is suppressed lets a
 *     reader assume none was ever offered.
 */
export interface ProviderAvmBaseline {
  /** Fixed discriminator. Its only job is to be impossible to confuse with a
   *  comp-derived conclusion at a call site or in a JSON blob. */
  kind: "provider_automated_estimate"
  provider: "rentcast"
  /** The words that must appear beside the number on any surface that shows it. */
  label: string
  /** True only when the provider actually published an estimate. */
  available: boolean
  /** Null when unavailable — NEVER 0. */
  value: number | null
  rangeLow: number | null
  rangeHigh: number | null
  /** Why there is no baseline, in the report's own words. Null when available. */
  unavailableNote: string | null
}

/** The label, named once so every surface says the same thing. */
export const PROVIDER_AVM_BASELINE_LABEL =
  "RentCast automated valuation (AVM) — the data provider's own automated estimate, shown as a baseline for comparison. It is NOT this analysis's value conclusion and NOT the recommended list price: those are derived from the adjusted closed comparable sales below."

/** What actually produced this comp set. Rides on the CMA result. */
export interface CompProvenance {
  /**
   * The provider that served the MAJORITY of a side. When a side was partly
   * provider-served and partly AI-gap-filled, this names the provider and the
   * AI part is recorded on `aiGapFilledSlots` — every individual comp also
   * carries its own `sourceProvider`, which is the authoritative per-row answer.
   */
  soldProvider: CompProviderId
  activeProvider: CompProviderId
  pendingProvider: CompProviderId
  /** Whether an IDX Broker key resolved for this brokerage/agent at all —
   *  INCLUDING the platform fallback key, because this field answers "could the
   *  feed be queried?". For "did the TENANT connect their own?", read
   *  `tenantOwnsIdx`, which is the fact the owner ruling turns on. */
  idxConnected: boolean
  /**
   * Whether RentCast was ELIGIBLE and therefore actually QUERIED for this CMA.
   *
   * DELIBERATE CHANGE OF MEANING, recorded because a silent one would be worse:
   * this used to mean "a RentCast key resolved" (and its doc still said "tenant
   * row, else platform env", which wave 17 had already made impossible — there
   * is no tenant row). Consumers — lib/kernel/appraiser-packet.ts is the one
   * that renders it — use it to tell an appraiser whether RentCast "was
   * configured and queried". Under the new ruling a key can resolve while the
   * provider is deliberately not called, and reporting a query that never
   * happened is the more dangerous falsehood: it reads as "RentCast had no
   * comparables for this address". So this field now means QUERIED, the raw key
   * fact moves to `rentcastPlatformKeyPresent`, and WHY it was not queried is on
   * `rentcastEligibility`.
   */
  rentcastConfigured: boolean
  /** Did the ONE platform RentCast key resolve? Separate from the field above:
   *  the key can be present while the provider is deliberately not used. */
  rentcastPlatformKeyPresent: boolean
  /** WHICH of the three eligibility questions decided it — `eligible`,
   *  `tenant_has_idx`, `idx_check_unreadable`, `no_platform_key` or
   *  `budget_exhausted`. Never collapse this to a boolean: "we deliberately did
   *  not call" and "we could not reach the provider" are opposite facts about
   *  the product. */
  rentcastEligibility: RentcastEligibilityReason
  /** Has this TENANT connected their own IDX Broker credentials (owner-scoped —
   *  a platform-tier credential is the product's account, not theirs)? This is
   *  the fact that suppresses RentCast. */
  tenantOwnsIdx: boolean
  /** The sold window actually used: 6, 12, or null when no sold comp was found. */
  soldWindowMonths: number | null
  /** True only when the window had to be widened because 6 months fell short. */
  soldWindowWidened: boolean
  soldCompCount: number
  activeCompCount: number
  pendingCompCount: number
  /** True when the returned set meets 3 sold + 2 active + 1 pending, counting
   *  AI-gap-filled rows. Read it together with the two fields below. */
  meetsRequiredMix: boolean
  /** True only when the PROVIDERS alone met the mix, before any gap-fill. This
   *  is the number to quote when the question is "how well-sourced is this?" */
  meetsRequiredMixFromProvidersAlone: boolean
  /**
   * Which sides had rows supplied by the AI web search because no provider
   * could serve them. Empty on a fully provider-backed set. `"sold"` can never
   * appear here — see AI_GAP_FILL_SLOTS.
   */
  aiGapFilledSlots: CompSlot[]
  /** How many individual comps in this set came from the AI web search. */
  aiGapFilledCompCount: number
  /** True when a gap-fill search was actually RUN (it may still have returned
   *  nothing usable — which is a different fact from never having tried). */
  aiGapFillAttempted: boolean
  /**
   * The provider's own automated estimate, carried as a labelled BASELINE.
   * ALWAYS PRESENT as an object — when RentCast was not called, or answered
   * without a price, this is `available: false` with a note saying so. It is
   * never omitted and never zero. See ProviderAvmBaseline for the three
   * guarantees this field exists to hold.
   */
  avmBaseline: ProviderAvmBaseline
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

  // ── 1. MAY RENTCAST RUN FOR THIS TENANT AT ALL? Asked BEFORE any spend ────
  //
  // This resolves first — before the pull, before `costCents` moves, and before
  // the IDX client is built — because the alternative is the defect this
  // restructure exists to remove: deciding whether we were allowed to spend
  // AFTER we had already spent. One resolver answers all three questions and
  // names which one said no.
  const rentcastEligibility = await resolveRentcastEligibility({
    brokerageId: req.brokerageId,
    agentUserId: req.agentUserId ?? null,
    teamId: req.teamId ?? null,
  })
  const tenantOwnsIdx = rentcastEligibility.idx.status === "connected"

  let rentcastRows: RentcastComp[] = []
  // The AVM baseline rides on the SAME `/avm/value` response as the comparables
  // — see getRentcastAvmAndComps. It starts unavailable and is only ever
  // upgraded by a provider that actually answered, so every path out of this
  // function carries a baseline object that says what it knows.
  let avmPull: RentcastAvmAndComps | null = null
  if (rentcastEligibility.eligible) {
    avmPull = await getRentcastAvmAndComps({
      brokerageId: req.brokerageId,
      agentUserId: req.agentUserId ?? null,
      teamId: req.teamId ?? null,
      address: fullAddress,
      limit: RENTCAST_COMP_PULL_LIMIT,
      // The lane that actually spent, on the vendor ledger row. Without this
      // every CMA comp pull was filed as `buyer_search`, which is the one
      // question the ledger exists to answer.
      systemSource: req.systemSource ?? DEFAULT_COMP_SYSTEM_SOURCE,
      contactId: req.contactId ?? null,
    })
    rentcastRows = avmPull.comps
    // The pull meters its own call ONCE (usage_type comps_lookup) and the AVM
    // comes back on that same call at no marginal cost; this only mirrors the
    // one spend onto the CMA's own cost estimate. It is NOT doubled for the AVM.
    costCents += RENTCAST_COMPS_COST_CENTS
    if (rentcastRows.length > 0) {
      citations.push("RentCast comparable sales (/avm/value comparables)")
    } else {
      notes.push(
        "RentCast is configured but returned no comparables for this address — either the address did not resolve or RentCast has no comparable coverage there.",
      )
    }
  } else {
    // The reason is stated in the report's own words, per reason, because "no
    // closed comparables" means something completely different in each case and
    // the reader is owed the difference.
    notes.push(
      rentcastEligibility.reason === "tenant_has_idx"
        ? `No closed comparable sales were sourced from RentCast, and that was DELIBERATE, not a failure: this brokerage has connected its own IDX Broker credentials (at ${rentcastEligibility.idxOwnerType} level), and RentCast is the platform's provider for brokerages that have not. An IDX Broker feed cannot serve closed sales — it reaches the brokerage's own featured/active inventory — so the closed-sale side of this analysis has no provider at all. Pull the closed sales from the MLS directly.`
        : rentcastEligibility.reason === "budget_exhausted"
        ? "No closed comparable sales were sourced: this brokerage is over its monthly vendor budget, so the paid property-data tier is paused for the rest of the billing month. Nothing was substituted in its place."
        : rentcastEligibility.reason === "idx_check_unreadable"
        ? "No closed comparable sales were sourced: it could not be determined whether this brokerage has its own IDX Broker feed connected, and the platform's RentCast account is not spent on that uncertainty. This is a lookup failure, NOT a statement that no comparable sales exist — retry before drawing any conclusion from this report."
        : "RentCast is not configured for this platform (no platform key), so no closed comparable sales could be sourced.",
    )
  }

  // ── 1b. THE PROVIDER'S AVM, AS A LABELLED BASELINE ────────────────────────
  //
  // Built here, from the pull above, and stated in `notes` either way — because
  // the two ways this can go wrong are showing a zero and showing nothing.
  const avmBaseline = buildAvmBaseline(avmPull, rentcastEligibility.detail)
  if (avmBaseline.available) {
    notes.push(
      `A RentCast automated valuation (AVM) of $${avmBaseline.value!.toLocaleString()} is carried on this analysis AS A BASELINE FOR COMPARISON ONLY. It is the data provider's own automated estimate; it is not derived from the comparable sales in this report, it has had no state appraiser adjustment applied to it, and it is neither this analysis's value conclusion nor the recommended list price.`,
    )
  } else {
    notes.push(`No provider AVM baseline is available for this property: ${avmBaseline.unavailableNote}`)
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
      systemSource: req.systemSource ?? DEFAULT_COMP_SYSTEM_SOURCE,
      brokerageId: req.brokerageId,
      metadata: { endpoint: "/clients/featured", rows: idxRows.length, purpose: "cma_active_comps", contact_id: req.contactId ?? null },
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
      // WHICH sentence is true depends on whether RentCast was even allowed to
      // run. When the TENANT owns the IDX feed, RentCast was deliberately not
      // called at all (rentcastEligibility.reason === "tenant_has_idx"), so
      // there is nothing to fall back TO — promising a fallback that cannot
      // happen is the same class of defect as a silent empty, just politer.
      notes.push(
        rentcastEligibility.eligible
          ? "IDX Broker is connected but its featured feed returned no active listings matching the subject's city/ZIP, so the active comparables fall back to RentCast."
          : "IDX Broker is connected but its featured feed returned no active listings matching the subject's city/ZIP. There is NO RentCast fallback for the active side on this CMA: " +
              rentcastEligibility.detail,
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
        ? "No active comparable listings were available from a data provider — neither the connected IDX feed nor RentCast returned one."
        : "No IDX feed is connected and RentCast returned no still-listed comparables, so no active comparables came from a data provider.",
    )
  } else if (activeComps.length < REQUIRED_ACTIVE_COMPS) {
    notes.push(
      `Only ${activeComps.length} active comparable listing(s) were available from a data provider (the mix calls for ${REQUIRED_ACTIVE_COMPS}).`,
    )
  }

  if (pendingComps.length === 0) {
    notes.push(
      idxConnected
        ? "No pending (under-contract) comparable was available from a data provider: the connected IDX feed reported none. RentCast's comparable feed carries no under-contract status at all, so none was substituted from it."
        : "No pending (under-contract) comparable was available from a data provider. RentCast's comparable feed carries no under-contract status, and only a connected IDX Broker feed can report one — none is connected.",
    )
  }

  // ── 5. The AI gap-fill — PER SLOT, providers already exhausted ────────────
  //
  // Nothing above this line has been influenced by a model. Everything below
  // only touches the slots the providers left short, and only the slots in
  // AI_GAP_FILL_SLOTS — never the sold side.
  const meetsRequiredMixFromProvidersAlone =
    closedComps.length >= REQUIRED_SOLD_COMPS &&
    activeComps.length >= REQUIRED_ACTIVE_COMPS &&
    pendingComps.length >= REQUIRED_PENDING_COMPS

  const allowAiGapFill = req.allowAiGapFill !== false
  const aiGapFilledSlots: CompSlot[] = []
  let aiGapFilledCompCount = 0
  let aiGapFillAttempted = false

  const wantActive = allowAiGapFill && AI_GAP_FILL_SLOTS.includes("active")
    ? Math.max(0, REQUIRED_ACTIVE_COMPS - activeComps.length)
    : 0
  const wantPending = allowAiGapFill && AI_GAP_FILL_SLOTS.includes("pending")
    ? Math.max(0, REQUIRED_PENDING_COMPS - pendingComps.length)
    : 0

  // The sold shortfall is stated, and stated as a REFUSAL rather than an
  // absence, so nobody reading the provenance later concludes the gap-fill was
  // simply forgotten here.
  if (allowAiGapFill && closedComps.length < REQUIRED_SOLD_COMPS) {
    notes.push(
      `The closed-sale side was NOT gap-filled by AI web search — deliberately. Closed sales are the only input to this analysis's value range, so they stay provider-verified; this set carries ${closedComps.length} of the ${REQUIRED_SOLD_COMPS} the method calls for. AI gap-fill is admitted for the ${AI_GAP_FILL_SLOTS.join(" and ")} sides only.`,
    )
  }

  if (wantActive > 0 || wantPending > 0) {
    aiGapFillAttempted = true
    const want: PerplexityCompSlotRequest = { closed: 0, active: wantActive, pending: wantPending }
    let ai: PerplexityCompFinderResult | null = null
    try {
      ai = await findCompsViaPerplexity({
        brokerageId: req.brokerageId,
        subjectAddress: fullAddress || req.address,
        subjectCity: req.city ?? null,
        subjectState: req.state ?? null,
        subjectZip: req.zip ?? null,
        subjectBeds: req.subject.bedrooms ?? null,
        subjectBaths:
          (req.subject.fullBaths ?? 0) + (req.subject.halfBaths ?? 0) * 0.5 || null,
        subjectSqft: req.subject.sqftLiving ?? null,
        subjectYearBuilt: req.subject.yearBuilt ?? null,
        subjectPropertyType: req.propertyType ?? null,
        want,
        systemSource: req.systemSource ?? DEFAULT_COMP_SYSTEM_SOURCE,
      })
    } catch {
      ai = null
    }
    costCents += PERPLEXITY_GAP_FILL_COST_CENTS

    // Never let a gap-fill re-serve a property a provider already gave us.
    const seen = new Set(
      [...closedComps, ...activeComps, ...pendingComps].map((c) => normalizeAddress(c.address)),
    )
    const admit = (rows: ScoredComp[], limit: number): ScoredComp[] => {
      const out: ScoredComp[] = []
      for (const row of rows) {
        const key = normalizeAddress(row.address)
        if (!key || seen.has(key)) continue
        seen.add(key)
        // Rank it on the same deterministic basis as an IDX comp — a model's
        // opinion of its own comp is not comparable to RentCast's measured
        // correlation and never gets to sort against one.
        out.push({ ...row, similarityScore: featureSimilarity(req.subject, row) })
        if (out.length >= limit) break
      }
      return out
    }

    const aiActive = ai ? admit(ai.activeComps, wantActive) : []
    const aiPending = ai ? admit(ai.pendingComps, wantPending) : []

    if (aiActive.length > 0) {
      activeComps = [...activeComps, ...aiActive]
      aiGapFilledSlots.push("active")
      aiGapFilledCompCount += aiActive.length
      if (activeProvider === "none") activeProvider = "perplexity"
      notes.push(
        `${aiActive.length} active comparable listing(s) came from an AI web search (Perplexity), not from a data provider, because no connected provider could serve the active side. They are unverified.`,
      )
    }
    if (aiPending.length > 0) {
      pendingComps = [...pendingComps, ...aiPending]
      aiGapFilledSlots.push("pending")
      aiGapFilledCompCount += aiPending.length
      if (pendingProvider === "none") pendingProvider = "perplexity"
      notes.push(
        `The pending (under-contract) comparable came from an AI web search (Perplexity), not from a data provider — no connected provider reports under-contract status for this area. It is unverified.`,
      )
    }
    if (aiGapFilledCompCount > 0) {
      citations.push("Perplexity Sonar AI web search (gap-fill only — unverified, see disclaimers)")
      for (const c of ai?.citations ?? []) citations.push(c)
    } else {
      notes.push(
        ai == null
          ? "An AI web search was attempted to fill the comparable slots no provider could serve, but the search itself failed. Those slots remain empty."
          : `An AI web search was attempted to fill the comparable slots no provider could serve and returned nothing usable${ai.droppedUnusableRows > 0 ? ` (${ai.droppedUnusableRows} result(s) were discarded for having no address, no price, or no source link)` : ""}. Those slots remain empty.`,
      )
    }
  }

  const meetsRequiredMix =
    closedComps.length >= REQUIRED_SOLD_COMPS &&
    activeComps.length >= REQUIRED_ACTIVE_COMPS &&
    pendingComps.length >= REQUIRED_PENDING_COMPS

  // ── 6. THE MIX, STATED. A CMA that cannot meet the owner's minimum says so ─
  //
  // The owner's rule is 3 sold within 6 months (12 when 6 falls short), 2 active
  // and 1 pending. Falling short is a legitimate outcome; falling short QUIETLY
  // is not — a reader handed four comps and no warning concludes the market was
  // thin. Every side that missed is named, with its count, in one sentence.
  if (!meetsRequiredMix) {
    const short: string[] = []
    if (closedComps.length < REQUIRED_SOLD_COMPS) short.push(`${closedComps.length} of ${REQUIRED_SOLD_COMPS} sold`)
    if (activeComps.length < REQUIRED_ACTIVE_COMPS) short.push(`${activeComps.length} of ${REQUIRED_ACTIVE_COMPS} active`)
    if (pendingComps.length < REQUIRED_PENDING_COMPS) short.push(`${pendingComps.length} of ${REQUIRED_PENDING_COMPS} pending`)
    notes.push(
      `THIS COMPARABLE SET DOES NOT MEET THE REQUIRED MIX (${REQUIRED_SOLD_COMPS} sold within ${PRIMARY_SOLD_WINDOW_MONTHS} months — ${WIDENED_SOLD_WINDOW_MONTHS} where the shorter window falls short — plus ${REQUIRED_ACTIVE_COMPS} active and ${REQUIRED_PENDING_COMPS} pending). Short on: ${short.join(", ")}.` +
        (closedComps.length < REQUIRED_SOLD_COMPS && !rentcastEligibility.eligible
          ? ` The closed-sale shortfall is because no provider served that side at all: ${rentcastEligibility.detail}`
          : ""),
    )
  }

  return {
    closedComps,
    activeComps,
    pendingComps,
    provenance: {
      soldProvider: closedComps.length > 0 ? "rentcast" : "none",
      activeProvider,
      pendingProvider,
      idxConnected,
      rentcastConfigured: rentcastEligibility.eligible,
      rentcastPlatformKeyPresent: rentcastEligibility.platformKeyPresent,
      rentcastEligibility: rentcastEligibility.reason,
      tenantOwnsIdx,
      soldWindowMonths,
      soldWindowWidened,
      soldCompCount: closedComps.length,
      activeCompCount: activeComps.length,
      pendingCompCount: pendingComps.length,
      meetsRequiredMix,
      meetsRequiredMixFromProvidersAlone,
      aiGapFilledSlots,
      aiGapFilledCompCount,
      aiGapFillAttempted,
      avmBaseline,
      notes,
      citations,
      estimatedCostCents: costCents,
    },
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Turn the RentCast pull into the labelled baseline, or into an honest "no
 * baseline available" with the reason spelled out.
 *
 * `null` in means RentCast was never called at all (the gate refused before any
 * request), which is a different sentence from "we called and it had no
 * estimate" — so `eligibilityDetail` is carried in to say WHICH question
 * suppressed it rather than reporting a provider failure that never happened.
 *
 * There is deliberately NO branch here that produces `available: true` with a
 * null or zero value: the only way to be available is for the provider to have
 * published a positive price, which `getRentcastAvmAndComps` has already
 * checked. A baseline that says "available" and shows nothing is worse than no
 * baseline.
 */
function buildAvmBaseline(
  pull: RentcastAvmAndComps | null,
  eligibilityDetail: string,
): ProviderAvmBaseline {
  const unavailable = (note: string): ProviderAvmBaseline => ({
    kind: "provider_automated_estimate",
    provider: "rentcast",
    label: PROVIDER_AVM_BASELINE_LABEL,
    available: false,
    value: null,
    rangeLow: null,
    rangeHigh: null,
    unavailableNote: note,
  })

  if (pull == null) {
    return unavailable(
      `RentCast was not queried for this CMA, so it published no automated estimate to show. ${eligibilityDetail}`,
    )
  }
  if (!pull.avmAvailable || pull.avm.value == null) {
    return unavailable(
      pull.avmUnavailableReason === "provider_error"
        ? "the RentCast lookup did not complete, so no automated estimate could be read. This is a lookup failure, not a statement that the property has no value — retry before drawing any conclusion from its absence."
        : pull.avmUnavailableReason === "no_address"
        ? "no address could be assembled to look up."
        : pull.avmUnavailableReason === "not_eligible"
        ? `RentCast was not queried. ${pull.eligibility.detail}`
        : "RentCast was queried and published no automated valuation for this address — its model has no estimate here. Nothing was substituted in its place.",
    )
  }
  return {
    kind: "provider_automated_estimate",
    provider: "rentcast",
    label: PROVIDER_AVM_BASELINE_LABEL,
    available: true,
    value: pull.avm.value,
    rangeLow: pull.avm.rangeLow,
    rangeHigh: pull.avm.rangeHigh,
    unavailableNote: null,
  }
}

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

/**
 * Loose address key used ONLY to stop a gap-filled comp from re-serving a
 * property a provider already gave us. Lower-cased, punctuation and runs of
 * whitespace collapsed. It is deliberately not an address PARSER — a missed
 * match costs a duplicate row, and a parser that "helpfully" merged two
 * different addresses would cost a comp.
 */
function normalizeAddress(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
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
