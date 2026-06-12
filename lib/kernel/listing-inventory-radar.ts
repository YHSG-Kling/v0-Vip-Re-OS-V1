// lib/kernel/listing-inventory-radar.ts
//
// LISTING INVENTORY RADAR — the lead-gen leap that ties the EXISTING scraper bench →
// THE GATE → AI ISA into the canonical lead flow. The Data Steward continuously surfaces
// SELLER-INTENT signals the bench ALREADY scraped (expired/withdrawn listings, FSBO,
// absentee owners, high-equity / pre-foreclosure), SCORES intent, RANKS, and feeds the
// hottest candidates INTO THE CANONICAL PIPELINE — it does NOT shortcut a non-contact to
// the seller relationship.
//
// THE CANONICAL FLOW (respected, not skipped):
//   raw_scraped_leads → THE GATE (lib/lead-pipeline processRawRecord: enrich + dedup +
//   territory/identity guards) → a `leads` row (ai_isa_owner=true, NO portal — NOT a
//   contact) → AI ISA qualifies → on conversion → contact (gets portal) → THEN the Listing
//   Concierge runs the seller relationship.
//
// WHAT THIS MODULE OWNS (the DELTA — the prioritization is the real value):
//   · scoreSellerIntent + rankSellerLeads — score/rank a bench-scraped candidate's intent
//     from REAL persisted signals (never fabricates, never scrapes).
//   · The runner: for a HOT raw candidate, PROMOTE it THROUGH THE GATE into a `leads` row
//     (ai_isa_owner=true) when not already promoted, CARRY the seller-intent score + reasons
//     onto the lead (leads.notes + a lead_score bump — existing columns) so AI ISA
//     prioritizes it, then ROUTE data_steward → ai_isa to assign/prioritize the lead for
//     qualification. The lead has NO portal and is NOT a contact; NO client-facing message,
//     NO commissioned reel for a non-contact.
//   · CONTACT-BACKED branch ONLY: when the candidate already corresponds to a CRM contact
//     (its promoted lead converted — leads.contact_id set, portal-eligible), the
//     data_steward → listing_concierge seller path still applies (post-conversion). That is
//     the ONLY path that proposes a client-facing seller deliverable.
//
// REUSE, DO NOT REBUILD: the scraper bench (lib/external/*) already lands seller candidates
//   in raw_scraped_leads with the rich BatchDataRecord in raw_data + a normalized_preview.
//   processRawRecord (lib/lead-pipeline) IS the gate. publishManagerSignal + SIGNAL_HANDLERS
//   carry the handoff; ai_isa:seller_intent_hot assigns/prioritizes the lead for ISA
//   qualification; listing_concierge:seller_intent_hot (contact-backed only) proposes the
//   gated seller deliverable.
//
// CONSENT: raw_scraped_leads + leads carry NO consent state (enforced at contact outreach by
// the TCPA/DNC gate + AI-ISA channel resolver). The Radar therefore NEVER pushes a portal
// card or a message to a non-contact — a raw scraped lead becomes an ISA-owned lead, not a
// seller conversation, until it converts. Nothing auto-sends.
//
// IDEMPOTENT: one promotion + one route per (candidate, window). processRawRecord is a
// no-op past 'promoted'; the signal bus dedupes open (to_manager, signal_type, entity_id);
// the runner reuses raw_scraped_leads.id as entity_id.
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
  /** The promoted `leads.id` for this raw row, when the gate already created one
   *  (raw_scraped_leads.lead_id). NULL until promotion — the runner promotes it through
   *  the gate before routing. A lead is NOT a contact and carries NO portal. */
  leadId?: string | null
  /** ONLY set when the owner already corresponds to a CRM contact (leads.contact_id —
   *  the lead converted, became portal-eligible). This is the sole gate for the
   *  client-facing Listing Concierge path. NULL for a raw scraped lead by default. */
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
    // raw_scraped_leads.lead_id is the promoted LEAD (NOT a contact — a lead has no portal
    // and is not a contact). It is carried as leadId; contactId stays null here and is
    // resolved by the runner ONLY when that lead has converted (leads.contact_id set).
    leadId: row.lead_id ?? null,
    contactId: null,
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

/** Deterministic, honest seller-intent note stamped onto the GATED lead (leads.notes) so the
 *  AI ISA — which owns the lead until it qualifies + converts — can PRIORITIZE it and open
 *  its qualifying conversation with the right context. This is an INTERNAL lead note, NOT a
 *  client message; no contact info is fabricated and nothing is sent. */
export function composeSellerIntentLeadNote(lead: ScoredSellerLead): string {
  const addr = lead.propertyAddress ?? "this property"
  const why = lead.reasons.slice(0, 4).map((r) => r.replace(/\s*\([^)]*\)\s*$/, "")).join("; ") || "scored seller intent"
  return `[Listing Inventory Radar] Seller-intent ${(lead.intentScore * 100).toFixed(0)}/100 for ${addr}. Why now: ${why}. Prioritize for AI-ISA qualification — NOT yet a contact (no portal, no client message until qualified + converted).`
}

/** Deterministic FALLBACK body for the CONTACT-BACKED seller brief (audience 'agent') — only
 *  ever composed when the owner is already a CRM contact (post-conversion, portal-eligible).
 *  Internal agent brief; the client-facing follow-up is the agent's gated next step. */
export function composeProspectingBriefFallback(lead: ScoredSellerLead): string {
  const addr = lead.propertyAddress ?? "a property we surfaced"
  return [
    `Seller-intent radar flagged ${addr} as a high-intent listing-inventory candidate (existing CRM contact).`,
    `Why now: ${lead.reasons.slice(0, 4).map((r) => r.replace(/\s*\([^)]*\)\s*$/, "")).join("; ") || "scored seller intent"}.`,
    `Suggested play: a "thinking of selling?" touch — open with the home's current market position. A gated CMA + a short listing/explainer reel are queued for your approval. Nothing sends until you approve it.`,
  ].join(" ")
}

// ─── Live runner ──────────────────────────────────────────────────────────────

export const SELLER_INTENT_SIGNAL_TYPE = "seller_intent_hot"

export interface ListingInventoryRadarResult {
  candidatesScanned: number
  scored: number
  routed: number
  /** how many hot candidates were promoted THROUGH THE GATE into a `leads` row this pass
   *  (ai_isa_owner=true) — the canonical raw → leads step. */
  promoted: number
  /** how many hot candidates routed data_steward → ai_isa (the default — a non-contact lead
   *  prioritized for ISA qualification). */
  routedToIsa: number
  /** how many routed candidates already had a CRM contact (portal-eligible) and took the
   *  data_steward → listing_concierge seller path instead. */
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
  /** THE GATE seam. Production default = lib/lead-pipeline processRawRecord (a 'use server',
   *  server-client-bound action). It cannot run under a plain-tsx simulator, so the simulator
   *  injects an equivalent gate that runs the SAME canonical eligibility + promotion against
   *  the service client. Default is the real gate; never bypasses it. */
  promote?: (rawLeadId: string, brokerageId: string) => Promise<{ action: "created" | "merged" | "skipped"; leadId?: string }>
}

/** The scrape sources that represent SELLER candidates (the bench's seller-side output). */
const SELLER_SOURCES = ["batchdata_motivated", "craigslist_fsbo", "expired_listing", "facebook_marketplace", "rental_listing"]

/**
 * Read the bench's already-scraped seller candidates, score+rank them, and feed the TOP
 * (score ≥ minScore) INTO THE CANONICAL FLOW — respecting the gate, NOT shortcutting a
 * non-contact to the seller relationship:
 *
 *   1. PROMOTE THROUGH THE GATE — for a hot raw candidate not yet promoted, run
 *      processRawRecord (enrich + dedup + territory/identity guards) so it becomes a `leads`
 *      row (ai_isa_owner=true, NO portal, NOT a contact). The gate's own guards may skip it
 *      (territory mismatch / insufficient identity / duplicate) — that is respected.
 *   2. CARRY THE INTENT — stamp the seller-intent score + reasons onto the promoted lead
 *      (leads.notes + a lead_score floor) so the AI ISA, which owns the lead, prioritizes it.
 *   3. ROUTE — by DEFAULT data_steward → ai_isa (assign/prioritize the lead for
 *      qualification). ONLY when the candidate already corresponds to a CRM contact
 *      (its lead converted — leads.contact_id) does it take the data_steward →
 *      listing_concierge seller path (the one path that proposes a client-facing deliverable).
 *
 * Idempotent per (candidate, window): processRawRecord is a no-op past 'promoted'; the signal
 * bus dedupes the open route. Honest skip when the bench returned nothing.
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
  const result: ListingInventoryRadarResult = {
    candidatesScanned: 0, scored: 0, routed: 0, promoted: 0, routedToIsa: 0, contactBacked: 0,
  }

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

  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  // THE GATE: default = the canonical processRawRecord; the simulator injects an equivalent.
  const promote = opts.promote ?? (async (rawLeadId: string, bId: string) => {
    const { processRawRecord } = await import("@/lib/lead-pipeline")
    const r = await processRawRecord(rawLeadId, bId)
    return { action: r.action, leadId: r.leadId }
  })
  const hot = ranked.filter((l) => l.intentScore >= minScore).slice(0, topN)

  for (const lead of hot) {
    // ── 3a. GATE — ensure the raw candidate is promoted into a `leads` row. ──
    // processRawRecord IS the gate: enrich + dedup + territory/identity guards, ai_isa_owner=true.
    // It is idempotent enough for our needs — a row already 'promoted' carries leads.lead_id, so
    // we skip re-promotion and reuse it. The gate may legitimately skip (guard fail) → no lead.
    let leadId = lead.leadId ?? null
    if (!leadId) {
      try {
        const promo = await promote(lead.rawLeadId, brokerageId)
        if ((promo.action === "created" || promo.action === "merged") && promo.leadId) {
          leadId = promo.leadId
          if (promo.action === "created") result.promoted += 1
        } else {
          // Gate honestly declined (territory mismatch / insufficient identity / dup with
          // equal confidence) — do NOT route a non-existent lead. Skip this candidate.
          continue
        }
      } catch {
        continue
      }
    }

    // ── 3b. Resolve contact-backing: a lead is a CONTACT only after it converted. ──
    // leads.contact_id is the sole portal-eligibility gate; a freshly promoted lead has none.
    let contactId: string | null = null
    if (leadId) {
      const { data: leadRow } = await supabase
        .from("leads")
        .select("id, contact_id, lead_score, notes")
        .eq("id", leadId)
        .eq("brokerage_id", brokerageId)
        .maybeSingle()
      contactId = (leadRow as { contact_id?: string | null } | null)?.contact_id ?? null

      // ── Carry the seller-intent onto the lead so AI ISA prioritizes it (existing columns:
      //    notes + lead_score). Idempotent: only stamp the radar note once; floor the score. ──
      const note = composeSellerIntentLeadNote(lead)
      const existingNotes = (leadRow as { notes?: string | null } | null)?.notes ?? ""
      const alreadyStamped = existingNotes.includes("[Listing Inventory Radar]")
      const intentFloor = Math.round(lead.intentScore * 100)
      const curScore = Number((leadRow as { lead_score?: number | null } | null)?.lead_score ?? 0)
      const patch: Record<string, unknown> = {}
      if (!alreadyStamped) patch.notes = existingNotes ? `${existingNotes}\n${note}` : note
      if (intentFloor > curScore) patch.lead_score = intentFloor
      if (Object.keys(patch).length > 0) {
        await supabase.from("leads").update(patch).eq("id", leadId).eq("brokerage_id", brokerageId)
      }
    }

    // ── 3c. ROUTE — default data_steward → ai_isa; contact-backed → listing_concierge. ──
    const toManager: "ai_isa" | "listing_concierge" = contactId ? "listing_concierge" : "ai_isa"
    const pub = await publishManagerSignal(
      {
        brokerageId,
        fromManager: "data_steward",
        toManager,
        signalType: SELLER_INTENT_SIGNAL_TYPE,
        message: describeSellerReason(lead),
        entityType: "raw_scraped_lead",
        entityId: lead.rawLeadId, // idempotency anchor — one open route per candidate
        contactId, // null for a non-contact lead (the default)
        payload: {
          intent_score: Number(lead.intentScore.toFixed(4)),
          reasons: lead.reasons,
          property_address: lead.propertyAddress ?? null,
          owner_first_name: lead.ownerFirstName ?? null,
          owner_last_name: lead.ownerLastName ?? null,
          source: lead.signals.source,
          motivation_type: lead.signals.motivationType ?? null,
          lead_id: leadId,
          contact_backed: !!contactId,
        },
        dedupe: true,
      },
      supabase,
    )
    if (pub.ok) {
      result.routed += 1
      if (contactId) result.contactBacked += 1
      else result.routedToIsa += 1
    }
  }

  return result
}
