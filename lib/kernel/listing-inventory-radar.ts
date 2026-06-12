// lib/kernel/listing-inventory-radar.ts
//
// LISTING INVENTORY RADAR — the lead-gen leap that ties the EXISTING scraper bench →
// routing → video into ONE coordinated team play. The Data Steward continuously surfaces
// SELLER-INTENT signals the bench ALREADY scraped (expired/withdrawn listings, FSBO,
// absentee owners, high-equity / pre-foreclosure), SCORES intent, RANKS, and ROUTES the
// hottest candidates to the Listing Concierge with a GATED 'thinking of selling?' outreach
// (+ optional gated CMA + a Director-commissioned listing/explainer reel).
//
// REUSE, DO NOT REBUILD:
//   · The scraper bench (lib/external/* — fetchMotivatedSellers, exa/zenrows normalizers,
//     vision-property) already PRODUCES seller candidates and lands them in
//     raw_scraped_leads (source 'batchdata_motivated' | 'craigslist_fsbo' |
//     'expired_listing' | 'facebook_marketplace' …) with the rich BatchDataRecord in
//     raw_data (quickLists, valuation.equityPercent, motivationType, ownershipLengthYears,
//     mailingAddressVacant, vacancy, lastSale) and a normalized_preview seller summary.
//     THIS MODULE IS THE DELTA: scoreSellerIntent + rankSellerLeads + the data_steward →
//     listing_concierge routing + the gated CMA/video commission. It NEVER scrapes and it
//     NEVER fabricates contact info — it reads what the bench already earned.
//   · The routing rail (publishManagerSignal + SIGNAL_HANDLERS) carries the handoff; the
//     handler listing_concierge:seller_intent_hot turns a routed candidate into the gated
//     proposal(s). proposeClientMessage = the governed gate (proposed, human-approved).
//   · generateAICMA (app/actions/ai-cma) and commissionVideo (lib/video/video-director)
//     are the optional gated enrichments — GATED behind "is this a real contact / has a
//     real agent", with honest skip when the key/agent isn't there.
//
// CONSENT: raw_scraped_leads rows carry NO consent state (that's enforced at contact
// outreach time by the TCPA/DNC gate). The Radar therefore proposes ONLY an internal,
// agent-audience prospecting deliverable into the gate — it NEVER pushes a portal card or
// a message to a non-contact, and it routes a portal value card ONLY when the owner is
// already a contact in the CRM. Nothing auto-sends.
//
// IDEMPOTENT: one route per (candidate, window). The signal bus dedupes open
// (to_manager, signal_type, entity_id); the runner reuses raw_scraped_leads.id as entity_id.
//
// NOT server-only (simulator-driven). Pure helpers carry the scoring; the runner does I/O.

import { createServiceClient } from "@/lib/supabase/service"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

// ─── Types ────────────────────────────────────────────────────────────────────

/** The REAL seller-intent signals the bench already scraped, normalized for scoring.
 *  Every field is OPTIONAL — different sources populate different subsets; the scorer
 *  only credits what is actually present (no fabrication, no assumed values). */
export interface SellerIntentSignals {
  /** raw_scraped_leads.source — 'batchdata_motivated' | 'craigslist_fsbo' | 'expired_listing' | … */
  source: string
  /** BatchData motivationType when present ('high_equity' | 'pre_foreclosure' | 'expired' | …). */
  motivationType?: string | null
  /** BatchData quickList tags (preforeclosure, high-equity, absentee-owner, expired-listing, …). */
  quickLists?: string[] | null
  /** intentSignals[] the normalizer wrote into normalized_preview (the motivation triggers). */
  intentSignals?: string[] | null
  /** Owner equity percent (0..100) from valuation.equityPercent — high equity = able to sell. */
  equityPercent?: number | null
  /** Days since the listing expired/withdrew, when known. Fresher = hotter. */
  expiredDaysAgo?: number | null
  /** True when the record is a for-sale-by-owner listing (already trying to sell, no agent). */
  isFsbo?: boolean | null
  /** True when the owner's mailing address ≠ property (absentee/investor — likely to sell). */
  isAbsentee?: boolean | null
  /** True when the property is vacant (carrying cost with no use — motivated). */
  isVacant?: boolean | null
  /** Years the owner has held — long tenure pairs with high equity (downsizer/tired-landlord). */
  ownershipLengthYears?: number | null
  /** Days the property has sat on market (high DOM = price/demand pressure). */
  daysOnMarket?: number | null
  /** Number of price cuts observed (each cut = escalating motivation). */
  priceCuts?: number | null
  /** The source/normalizer's own motivationScore (0..100) when it produced one. */
  sourceMotivationScore?: number | null
}

export interface SellerLeadCandidate {
  /** raw_scraped_leads.id — the routing entity + idempotency key. */
  rawLeadId: string
  signals: SellerIntentSignals
  /** Best-effort property address for the proposal copy (never used to fabricate identity). */
  propertyAddress?: string | null
  ownerFirstName?: string | null
  ownerLastName?: string | null
  /** When the bench already promoted this owner to a CRM contact, its id (enables a portal card). */
  contactId?: string | null
}

export interface ScoredSellerLead extends SellerLeadCandidate {
  /** 0..1 intent score from scoreSellerIntent. */
  intentScore: number
  /** The signal labels that earned the score (audit trail, no fabrication). */
  reasons: string[]
}

// ─── Scoring weights (documented) ───────────────────────────────────────────────

/**
 * WEIGHTS — each is the points a PRESENT, REAL signal contributes to the raw intent total
 * before normalization. Chosen so the strongest single distress signals (pre-foreclosure,
 * a fresh expired listing) plus high equity clearly outrank a fresh, low-equity FSBO.
 *
 * Rationale:
 *  · PRE_FORECLOSURE — the single hottest distress signal (forced timeline). Highest weight.
 *  · EXPIRED_FRESH    — a recently expired/withdrawn listing = a seller who WANTED to sell and
 *                       just failed; recency-decayed (fresh ≫ stale).
 *  · HIGH_EQUITY      — ability to transact (no underwater drag); scaled by equity %.
 *  · ABSENTEE / VACANT— owner not living there → low attachment, high willingness.
 *  · FSBO             — already trying to sell, but WITHOUT distress = lower urgency than the above.
 *  · TENURE/DOM/CUTS  — supporting accelerants, smaller weights.
 */
export const SELLER_INTENT_WEIGHTS = {
  PRE_FORECLOSURE: 0.42,
  TAX_LIEN: 0.30,
  EXPIRED_MAX: 0.34, // at 0 days; decays to ~0 by EXPIRED_DECAY_DAYS
  HIGH_EQUITY_MAX: 0.26, // scaled by equity% (full at >=70%)
  ABSENTEE: 0.16,
  VACANT: 0.18,
  FSBO: 0.15,
  PROBATE: 0.22,
  DIVORCE: 0.20,
  TENURE_MAX: 0.08, // long-held owner accelerant (full at >=15 yrs)
  DOM_MAX: 0.10, // high days-on-market pressure (full at >=90 days)
  PRICE_CUT_EACH: 0.05, // per observed price reduction, capped
  PRICE_CUT_CAP: 0.15,
} as const

const EXPIRED_DECAY_DAYS = 120 // an expired listing's signal fades over ~4 months
const EQUITY_FULL_AT = 70 // equity% at which HIGH_EQUITY_MAX is fully credited
const TENURE_FULL_AT = 15 // years held for full tenure credit
const DOM_FULL_AT = 90 // days-on-market for full DOM credit

/** Case-insensitive membership test over the candidate's tag-ish arrays + scalar labels. */
function hasTag(signals: SellerIntentSignals, ...needles: string[]): boolean {
  const hay = [
    signals.motivationType ?? "",
    ...(signals.quickLists ?? []),
    ...(signals.intentSignals ?? []),
    signals.source ?? "",
  ]
    .join(" ")
    .toLowerCase()
  return needles.some((n) => hay.includes(n.toLowerCase()))
}

/**
 * PURE: score a seller candidate's intent 0..1 from REAL signals only. Each branch adds
 * weight ONLY when the underlying signal is actually present in the scraped record — an
 * absent field contributes nothing (never assumed). The raw total is clamped to [0,1].
 */
export function scoreSellerIntent(signals: SellerIntentSignals): { score: number; reasons: string[] } {
  const W = SELLER_INTENT_WEIGHTS
  let raw = 0
  const reasons: string[] = []

  const add = (pts: number, label: string) => {
    if (pts > 0) {
      raw += pts
      reasons.push(`${label} (+${pts.toFixed(2)})`)
    }
  }

  // ── Distress (forced timeline) — the hottest signals ──
  if (hasTag(signals, "pre_foreclosure", "preforeclosure", "notice-of-default", "notice-of-lis-pendens", "notice-of-sale", "foreclosure")) {
    add(W.PRE_FORECLOSURE, "pre-foreclosure/distress")
  }
  if (hasTag(signals, "tax_lien", "tax-default", "involuntary-lien")) {
    add(W.TAX_LIEN, "tax lien")
  }
  if (hasTag(signals, "probate", "inherited")) {
    add(W.PROBATE, "probate/inherited")
  }
  if (hasTag(signals, "divorce")) {
    add(W.DIVORCE, "divorce")
  }

  // ── Expired/withdrawn — wanted to sell, just failed; recency-decayed ──
  const expiredTagged = hasTag(signals, "expired", "withdrawn", "cancelled", "canceled", "expired-listing", "failed-listing", "canceled-listing")
  if (expiredTagged) {
    const days = signals.expiredDaysAgo ?? 0
    const recency = Math.max(0, 1 - Math.max(0, days) / EXPIRED_DECAY_DAYS)
    const pts = W.EXPIRED_MAX * recency
    add(pts, `expired/withdrawn listing (${days}d ago, recency ${recency.toFixed(2)})`)
  }

  // ── High equity — ability to transact, scaled by equity% ──
  const eq = signals.equityPercent
  if (typeof eq === "number" && eq > 0) {
    const scaled = Math.min(1, eq / EQUITY_FULL_AT)
    add(W.HIGH_EQUITY_MAX * scaled, `equity ${Math.round(eq)}%`)
  } else if (hasTag(signals, "high_equity", "high-equity", "free-and-clear")) {
    // tagged high-equity with no numeric % → credit ~70% of the max
    add(W.HIGH_EQUITY_MAX * 0.7, "high-equity (tagged)")
  }

  // ── Disposition signals — owner not attached to the home ──
  if (signals.isAbsentee || hasTag(signals, "absentee", "absentee-owner", "out-of-state-owner", "out-of-state-absentee-owner")) {
    add(W.ABSENTEE, "absentee owner")
  }
  if (signals.isVacant || hasTag(signals, "vacant", "mailing-address-vacant")) {
    add(W.VACANT, "vacant property")
  }
  if (hasTag(signals, "tired_landlord", "tired-landlord")) {
    add(W.ABSENTEE, "tired landlord")
  }

  // ── FSBO — already selling, no distress = lower urgency ──
  if (signals.isFsbo || hasTag(signals, "fsbo", "for-sale-by-owner", "for_sale_by_owner", "by_owner")) {
    add(W.FSBO, "FSBO (already selling)")
  }

  // ── Accelerants ──
  const tenure = signals.ownershipLengthYears
  if (typeof tenure === "number" && tenure > 0) {
    add(W.TENURE_MAX * Math.min(1, tenure / TENURE_FULL_AT), `${Math.round(tenure)}yr tenure`)
  }
  const dom = signals.daysOnMarket
  if (typeof dom === "number" && dom > 0) {
    add(W.DOM_MAX * Math.min(1, dom / DOM_FULL_AT), `${Math.round(dom)} days on market`)
  }
  const cuts = signals.priceCuts
  if (typeof cuts === "number" && cuts > 0) {
    add(Math.min(W.PRICE_CUT_CAP, cuts * W.PRICE_CUT_EACH), `${cuts} price cut(s)`)
  }

  const score = Math.max(0, Math.min(1, raw))
  return { score, reasons }
}

/**
 * PURE: rank candidates by intent score (desc), stable on score ties by rawLeadId so the
 * ordering is deterministic for idempotent routing. Returns scored copies.
 */
export function rankSellerLeads(candidates: SellerLeadCandidate[]): ScoredSellerLead[] {
  return candidates
    .map((c) => {
      const { score, reasons } = scoreSellerIntent(c.signals)
      return { ...c, intentScore: score, reasons }
    })
    .sort((a, b) => (b.intentScore - a.intentScore) || a.rawLeadId.localeCompare(b.rawLeadId))
}

// ─── Mapping the persisted scrape row → scoring signals (pure) ────────────────────

/** Extract SellerLeadCandidate from a raw_scraped_leads row (raw_data + normalized_preview).
 *  Reads ONLY real persisted fields; absent fields stay null. */
export function candidateFromRawRow(row: {
  id: string
  source: string | null
  raw_data: Record<string, unknown> | null
  normalized_preview: Record<string, unknown> | null
  address?: string | null
  lead_id?: string | null
}): SellerLeadCandidate {
  const raw = (row.raw_data ?? {}) as Record<string, any>
  const prev = (row.normalized_preview ?? {}) as Record<string, any>
  const valuation = (raw.valuation ?? {}) as Record<string, any>
  const vacancy = (raw.vacancy ?? {}) as Record<string, any>

  const quickLists = Array.isArray(raw.quickLists)
    ? (raw.quickLists as string[])
    : Array.isArray(prev.quickLists)
      ? (prev.quickLists as string[])
      : []
  const intentSignals = Array.isArray(prev.intentSignals)
    ? (prev.intentSignals as string[])
    : Array.isArray(prev.intent?.matched)
      ? (prev.intent.matched as string[])
      : []

  const equityPercent =
    typeof valuation.equityPercent === "number"
      ? valuation.equityPercent
      : typeof raw.equityPercent === "number"
        ? raw.equityPercent
        : null

  return {
    rawLeadId: row.id,
    contactId: row.lead_id ?? null, // when the bench already promoted the owner (leads→contacts)
    propertyAddress: (raw.propertyAddress as string) ?? prev.propertyAddress ?? row.address ?? null,
    ownerFirstName: (raw.firstName as string) ?? prev.firstName ?? null,
    ownerLastName: (raw.lastName as string) ?? prev.lastName ?? null,
    signals: {
      source: row.source ?? "",
      motivationType: (raw.motivationType as string) ?? prev.behaviorType ?? null,
      quickLists,
      intentSignals,
      equityPercent,
      expiredDaysAgo: typeof raw.expiredDaysAgo === "number" ? raw.expiredDaysAgo : null,
      isFsbo: typeof raw.fsboMarker === "boolean" ? raw.fsboMarker : null,
      isAbsentee: typeof raw.mailingAddressVacant === "boolean" ? raw.mailingAddressVacant : null,
      isVacant: typeof vacancy.isVacant === "boolean" ? vacancy.isVacant : null,
      ownershipLengthYears: typeof raw.ownershipLengthYears === "number" ? raw.ownershipLengthYears : null,
      daysOnMarket: typeof raw.daysOnMarket === "number" ? raw.daysOnMarket : null,
      priceCuts: typeof raw.priceCuts === "number" ? raw.priceCuts : null,
      sourceMotivationScore: typeof prev.motivationScore === "number" ? prev.motivationScore : null,
    },
  }
}

// ─── Proposal copy (pure, deterministic fallback) ─────────────────────────────────

/** A short, honest description of WHY this owner is a hot seller candidate (earned lines). */
export function describeSellerReason(lead: ScoredSellerLead): string {
  const top = lead.reasons.slice(0, 3).map((r) => r.replace(/\s*\([^)]*\)\s*$/, "")).join(", ")
  const addr = lead.propertyAddress ?? "this property"
  return top
    ? `${addr}: ${top} (intent ${(lead.intentScore * 100).toFixed(0)}/100).`
    : `${addr}: scored seller-intent ${(lead.intentScore * 100).toFixed(0)}/100.`
}

/** Deterministic FALLBACK body for the gated 'thinking of selling?' agent prospecting
 *  brief (audience 'agent' — internal, NOT a client message; no contact info fabricated). */
export function composeProspectingBriefFallback(lead: ScoredSellerLead): string {
  const addr = lead.propertyAddress ?? "a property we surfaced"
  return [
    `Seller-intent radar flagged ${addr} as a high-intent listing-inventory candidate.`,
    `Why now: ${lead.reasons.slice(0, 4).map((r) => r.replace(/\s*\([^)]*\)\s*$/, "")).join("; ") || "scored seller intent"}.`,
    `Suggested play: a "thinking of selling?" touch — open with the home's current market position. If the owner is already a CRM contact, a gated CMA + a short listing/explainer reel are queued for your approval. Nothing sends until you approve it; no contact info is assumed.`,
  ].join(" ")
}

// ─── Live runner ──────────────────────────────────────────────────────────────

export const SELLER_INTENT_SIGNAL_TYPE = "seller_intent_hot"

export interface ListingInventoryRadarResult {
  candidatesScanned: number
  scored: number
  routed: number
  /** how many routed candidates already had a CRM contact (portal-eligible). */
  contactBacked: number
  skippedReason?: string
}

export interface RadarOpts {
  now?: Date
  /** how many TOP candidates to route per pass (default 10). */
  topN?: number
  /** the minimum intent score to route (default 0.45 — hot only). */
  minScore?: number
  /** how far back to read scraped seller candidates (default 30 days). */
  lookbackDays?: number
  copyGenerator?: CopyGenerator
  /** test seam: inject candidates instead of reading raw_scraped_leads (the simulator seeds
   *  REAL rows and lets the runner read them; this is only for pure-path unit coverage). */
  candidateOverride?: SellerLeadCandidate[]
}

/** The scrape sources that represent SELLER candidates (the bench's seller-side output). */
const SELLER_SOURCES = ["batchdata_motivated", "craigslist_fsbo", "expired_listing", "facebook_marketplace", "rental_listing"]

/**
 * Read the bench's already-scraped seller candidates, score+rank them, and route the
 * TOP (score ≥ minScore) to the Listing Concierge via a data_steward → listing_concierge
 * signal. The handler (listing_concierge:seller_intent_hot) proposes the GATED outreach.
 * Idempotent per (candidate, window) via the signal bus dedupe. Honest skip when the bench
 * returned nothing.
 */
export async function runListingInventoryRadar(
  brokerageId: string,
  opts: RadarOpts = {},
  client?: Svc,
): Promise<ListingInventoryRadarResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const topN = opts.topN ?? 10
  const minScore = opts.minScore ?? 0.45
  const lookbackDays = opts.lookbackDays ?? 30
  const result: ListingInventoryRadarResult = { candidatesScanned: 0, scored: 0, routed: 0, contactBacked: 0 }

  // 1. Read the bench's seller candidates (NEVER scrape here — reuse what's already landed).
  let candidates: SellerLeadCandidate[]
  if (opts.candidateOverride) {
    candidates = opts.candidateOverride
  } else {
    const sinceIso = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString()
    const { data: rows } = await supabase
      .from("raw_scraped_leads")
      .select("id, source, raw_data, normalized_preview, address, lead_id, created_at")
      .eq("brokerage_id", brokerageId)
      .in("source", SELLER_SOURCES)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(500)
    candidates = ((rows ?? []) as any[]).map((r) => candidateFromRawRow(r))
  }

  result.candidatesScanned = candidates.length
  if (candidates.length === 0) {
    result.skippedReason = "no seller candidates on the bench in window"
    return result
  }

  // 2. Score + rank (pure).
  const ranked = rankSellerLeads(candidates)
  result.scored = ranked.length

  // 3. Route the TOP hot candidates to the Listing Concierge.
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const hot = ranked.filter((l) => l.intentScore >= minScore).slice(0, topN)

  for (const lead of hot) {
    const pub = await publishManagerSignal(
      {
        brokerageId,
        fromManager: "data_steward",
        toManager: "listing_concierge",
        signalType: SELLER_INTENT_SIGNAL_TYPE,
        message: describeSellerReason(lead),
        entityType: "raw_scraped_lead",
        entityId: lead.rawLeadId, // idempotency anchor — one open route per candidate
        contactId: lead.contactId ?? null,
        payload: {
          intent_score: Number(lead.intentScore.toFixed(4)),
          reasons: lead.reasons,
          property_address: lead.propertyAddress ?? null,
          owner_first_name: lead.ownerFirstName ?? null,
          owner_last_name: lead.ownerLastName ?? null,
          source: lead.signals.source,
          motivation_type: lead.signals.motivationType ?? null,
          contact_backed: !!lead.contactId,
        },
        dedupe: true,
      },
      supabase,
    )
    if (pub.ok) {
      result.routed += 1
      if (lead.contactId) result.contactBacked += 1
    }
  }

  return result
}
