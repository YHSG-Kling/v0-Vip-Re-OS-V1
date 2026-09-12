// lib/kernel/reverse-prospecting.ts
//
// THE REVERSE PROSPECTING ENGINE — inventory becomes instant buyer demand. The moment a
// new / coming-soon / active listing exists, the brokerage's OWN buyers are the first
// market. Three managers convene on the new address:
//
//   · Data Steward   — owns the match read: scores every active buyer's SAVED criteria
//                      (property_preferences, via the canonical loadBuyerCriteria reader)
//                      against the listing facts (list_price / bedrooms / bathrooms / city)
//                      with the SAME pure scorer the market-watch uses. No new matching
//                      engine — this is the convening layer on top of the existing one.
//   · Shopping Agent — for each matched buyer, PROPOSES a persona-aware "this just came up
//                      for you" note into the gate (audience 'buyer', channel 'portal').
//                      Copy is GENERATED per the buyer's persona (generatePersonaCopy) with
//                      a deterministic fallback — never a hardcoded blast.
//   · AI ISA         — queues each matched buyer as a CALL CANDIDATE on the inter-manager
//                      bus (publishManagerSignal → ai_isa). The ISA's existing dial-batch
//                      flow proposes the consented dials; nothing auto-dials here.
//
// Nothing sends: the buyer note pends approval, the ISA queue line is a governed signal.
// Idempotent: ONE match-note per (listing, buyer) ever, keyed by the rationale tag. NOT
// server-only (simulator-driven). Only ever writes through a caller-supplied/service client.

import { createServiceClient } from "@/lib/supabase/service"
import { loadBuyerCriteria, type BuyerCriteria } from "@/lib/buyer-search/buyer-criteria"
import { scoreCriteriaFit, type ListingFacts } from "@/lib/buyer-search/market-watch"
import { proposeClientMessage } from "@/lib/agents/agent-client-messages"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import { generatePersonaCopy, type CopyGenerator, type CopyPersona } from "@/lib/kernel/ai-copy"
import { pushPortalValueCard } from "@/lib/kernel/portal-value"
import { URGENT_NUDGE_MAX_HOURS, urgentSlaBreached } from "@/lib/kernel/urgent-sla"

type Svc = ReturnType<typeof createServiceClient>

/** The rationale tag stamped on every reverse-prospecting buyer note (idempotency key). */
export const REVERSE_PROSPECTING_TAG = "REVERSE PROSPECTING"

/** A listing only becomes instant demand while it's fresh inventory. */
export const REVERSE_PROSPECTING_STATUSES = ["coming_soon", "active"] as const

// TOMBSTONE (orphan doctrine §1.3) — this name is no longer exported: REVERSE_PROSPECTING_THRESHOLD.
// Nothing in the product imported it, and no simulator did either; the
// value is live and unchanged, reached through this module's own exported
// functions, which is where callers already get its effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
/** Buyers below this fit are not worth a one-to-one note (mirrors the market-watch bar). */
const REVERSE_PROSPECTING_THRESHOLD = 70

export interface ListingForProspecting {
  id: string
  address: string
  city: string | null
  list_price: number | null
  bedrooms: number | null
  bathrooms: number | null
}

export interface BuyerMatch {
  contactId: string
  score: number
}

/** Pure: score one buyer's criteria against the listing facts (reuses the market-watch
 *  scorer). Returns null when the buyer doesn't clear the one-to-one bar. */
export function scoreBuyerMatch(criteria: BuyerCriteria, listing: ListingFacts): number {
  return scoreCriteriaFit(criteria, listing)
}

/** Pure: the deterministic FALLBACK buyer note — real, safe, names only the listing facts
 *  we have. The persona generator personalizes on top; this guarantees copy always exists. */
export function composeMatchNote(listing: ListingForProspecting, buyerName?: string | null): {
  subject: string
  body: string
} {
  const where = listing.city ? ` in ${listing.city}` : ""
  const beds = typeof listing.bedrooms === "number" ? `${listing.bedrooms}-bed ` : ""
  const price = typeof listing.list_price === "number"
    ? ` listed at $${Math.round(listing.list_price).toLocaleString()}`
    : ""
  const hi = buyerName ? `Hi ${buyerName}, ` : ""
  return {
    subject: "A home just came up that matches your search",
    body:
      `${hi}a ${beds}home${where} just came on the market${price} — and it lines up with what ` +
      `you've been looking for: ${listing.address}. I wanted you to see it before it gets busy. ` +
      `Reply here and I'll set up a private showing.`,
  }
}

export interface ReverseProspectingResult {
  /** Fresh listings scanned. */
  listings: number
  /** (listing, buyer) matches found at/above threshold. */
  matches: number
  /** Buyer notes newly proposed into the gate (idempotent — skips already-noted pairs). */
  notesProposed: number
  /** Buyers queued to the AI ISA as call candidates on the bus. */
  isaQueued: number
  /** Portal value cards pushed to matched buyers' portals (additive, idempotent per day). */
  portalCardsPushed: number
  /** Stale reverse-prospecting notes (unapproved past the 6h urgent SLA) escalated to the agent. */
  urgentEscalations?: number
}

/** Build the persona for a buyer contact (best-effort) for copy generation. */
function personaFor(row: {
  first_name?: string | null
  last_name?: string | null
  contact_persona?: string | null
  buyer_stage?: string | null
}): CopyPersona {
  return {
    name: [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || null,
    audience: "buyer",
    situation: row.buyer_stage ?? row.contact_persona ?? null,
  }
}

/**
 * Run reverse prospecting for one brokerage. For each fresh listing, match the brokerage's
 * active buyers by saved criteria, then per matched buyer propose a persona-aware note into
 * the gate (Shopping Agent) and queue the buyer to the AI ISA on the bus. Idempotent per
 * (listing, buyer). Returns counts.
 */
export async function runReverseProspecting(
  brokerageId: string,
  opts: { now?: Date; copyGenerator?: CopyGenerator } = {},
  client?: Svc,
): Promise<ReverseProspectingResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const result: ReverseProspectingResult = { listings: 0, matches: 0, notesProposed: 0, isaQueued: 0, portalCardsPushed: 0 }
  if (!brokerageId) return result

  // Fresh inventory only (coming_soon / active). list_price is the canonical price column.
  const { data: listings } = await supabase
    .from("listings")
    .select("id, address, city, list_price, bedrooms, bathrooms")
    .eq("brokerage_id", brokerageId)
    .in("status", REVERSE_PROSPECTING_STATUSES as unknown as string[])
    .is("deleted_at", null)
    .limit(100)
  const listingRows = (listings ?? []) as ListingForProspecting[]
  if (listingRows.length === 0) return result
  result.listings = listingRows.length

  // The brokerage's buyers — anyone whose contact_type marks them a buyer and who isn't
  // paused/withdrawn. (contact_type buyer/both; nurture_status not withdrawn.)
  const { data: buyers } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, contact_persona, buyer_stage, nurture_status, contact_type")
    .eq("brokerage_id", brokerageId)
    .in("contact_type", ["buyer", "both"])
    .is("deleted_at", null)
    .limit(500)
  const buyerRows = (buyers ?? []) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    contact_persona: string | null
    buyer_stage: string | null
    nurture_status: string | null
  }>
  const activeBuyers = buyerRows.filter((b) => b.nurture_status !== "withdrawn")
  if (activeBuyers.length === 0) return result

  // Load each buyer's criteria ONCE (the canonical normalized reader).
  const criteriaByBuyer = new Map<string, BuyerCriteria>()
  for (const b of activeBuyers) {
    const c = await loadBuyerCriteria(supabase, b.id)
    if (c) criteriaByBuyer.set(b.id, c)
  }

  const generator = opts.copyGenerator

  for (const listing of listingRows) {
    const facts: ListingFacts = {
      list_price: listing.list_price,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      city: listing.city,
    }

    // The matched buyers for THIS listing.
    const matched: BuyerMatch[] = []
    for (const b of activeBuyers) {
      const criteria = criteriaByBuyer.get(b.id)
      if (!criteria) continue
      const score = scoreBuyerMatch(criteria, facts)
      if (score >= REVERSE_PROSPECTING_THRESHOLD) matched.push({ contactId: b.id, score })
    }
    if (matched.length === 0) continue
    result.matches += matched.length

    // Idempotency: which (listing, buyer) pairs already have a reverse-prospecting note?
    const matchedIds = matched.map((m) => m.contactId)
    const { data: existing } = await supabase
      .from("agent_client_messages")
      .select("recipient_contact_id")
      .eq("brokerage_id", brokerageId)
      .eq("entity_type", "listing")
      .eq("entity_id", listing.id)
      .ilike("rationale", `${REVERSE_PROSPECTING_TAG}%`)
      .in("recipient_contact_id", matchedIds)
    const alreadyNoted = new Set(
      (existing ?? []).map((e: { recipient_contact_id: string | null }) => e.recipient_contact_id),
    )

    for (const m of matched) {
      if (alreadyNoted.has(m.contactId)) continue
      const buyer = activeBuyers.find((b) => b.id === m.contactId)!
      const persona = personaFor(buyer)
      const fallback = composeMatchNote(listing, persona.name)

      // (a) Shopping Agent — persona-aware buyer note into the gate.
      const draft = await generatePersonaCopy(
        {
          goal: "a 'this just came up for you' note about a brand-new listing that matches the buyer's saved search",
          facts: [
            `The home: ${listing.address}${listing.city ? `, ${listing.city}` : ""}`,
            typeof listing.list_price === "number" ? `Listed at $${Math.round(listing.list_price).toLocaleString()}` : "Price available on request",
            typeof listing.bedrooms === "number" ? `${listing.bedrooms} bedrooms` : "Bedroom count available on request",
            typeof listing.bathrooms === "number" ? `${listing.bathrooms} bathrooms` : "Bath count available on request",
            "It matches the criteria this buyer saved.",
            "Offer to set up a private showing — no pressure.",
          ],
          channel: "portal",
          persona,
          words: 70,
        },
        fallback,
        { generator },
      )

      const proposed = await proposeClientMessage(
        {
          brokerageId,
          agentKind: "shopping_agent",
          entityType: "listing",
          entityId: listing.id,
          recipientContactId: m.contactId,
          audience: "buyer",
          subject: draft.subject ?? fallback.subject,
          body: draft.body,
          rationale: `${REVERSE_PROSPECTING_TAG}: new listing ${listing.address} matched this buyer's saved search (fit ${m.score}).`,
          channel: "portal",
        },
        supabase,
      )
      if (proposed.ok) result.notesProposed += 1

      // (c) PORTAL VALUE CARD — leave the SAME real "this just came up for you" match on the
      // buyer's portal so it always has something fresh worth returning to. ADDITIVE: the gated
      // note above is unchanged; this surfaces only the REAL matched-listing copy (facts come
      // straight off the listing row — no fabrication). Reuses the persona-generated body. The
      // listing is real context, so we attach listing_id. Idempotent per (buyer, "reverse_prospecting",
      // day): if the buyer matched multiple fresh listings the same day, the portal gets ONE card
      // (honesty over noise — the gated per-listing notes still carry every match).
      const card = await pushPortalValueCard({
        brokerageId, contactId: m.contactId, listingId: listing.id,
        title: draft.subject ?? fallback.subject,
        summary: draft.body,
        updateType: "reverse_prospecting",
        metadata: { audience: "buyer", listing_id: listing.id, listing_address: listing.address, fit_score: m.score, source: "reverse_prospecting" },
        now,
      }, supabase)
      if (card.pushed) result.portalCardsPushed += 1

      // (b) AI ISA — queue the buyer as a call candidate on the bus. fromManager
      // 'shopping_agent' (demand side) → toManager 'ai_isa' (from !== to). Idempotent per
      // open (ai_isa, signal_type, entity_id=listing) — dedupe is on by default; to allow a
      // PER-BUYER queue line we key the entity to the buyer's contact via contactId + a
      // buyer-scoped signal_type so each matched buyer is its own candidate.
      const queued = await publishManagerSignal(
        {
          brokerageId,
          fromManager: "shopping_agent",
          toManager: "ai_isa",
          signalType: "reverse_prospecting_call_candidate",
          message: `New listing ${listing.address} matches this buyer (fit ${m.score}) — call candidate.`,
          entityType: "contact",
          entityId: m.contactId,
          contactId: m.contactId,
          payload: { listing_id: listing.id, listing_address: listing.address, fit_score: m.score },
        },
        supabase,
      )
      if (queued.ok) result.isaQueued += 1
    }
  }

  // ── URGENT 6h SLA — a new-listing match is time-critical (the home can go under contract).
  //    Any reverse-prospecting note still UNAPPROVED past 6h gets ONE urgent agent nudge: "call
  //    them before it's gone." Rides this hourly cron (6h granularity); idempotent via a
  //    per-note escalation notification. The ISA call candidate was already queued at match time;
  //    this is the human checkpoint so a hot match never sits a full day in the approval queue.
  result.urgentEscalations = await escalateStaleReverseProspectingNotes(supabase, brokerageId, now)

  return result
}

/**
 * escalateStaleReverseProspectingNotes — the 6h URGENT gate. Finds reverse-prospecting buyer
 * notes still 'proposed' (unapproved) past URGENT_NUDGE_MAX_HOURS and fires ONE urgent agent
 * notification per note ("a hot new-listing match has been waiting — call them before it's
 * gone"). Idempotent via a per-note escalation notification (entity = the message). Returns the
 * count escalated this run. Best-effort — never throws to the caller.
 */
async function escalateStaleReverseProspectingNotes(
  supabase: Svc, brokerageId: string, now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - URGENT_NUDGE_MAX_HOURS * 3_600_000).toISOString()
  const { data: stale } = await supabase
    .from("agent_client_messages")
    .select("id, recipient_contact_id, entity_id, created_at, rationale")
    .eq("brokerage_id", brokerageId)
    .eq("status", "proposed")
    .ilike("rationale", `%${REVERSE_PROSPECTING_TAG}%`)
    .lt("created_at", cutoff)
    .limit(50)
  const rows = (stale ?? []) as Array<{ id: string; recipient_contact_id: string | null; entity_id: string | null; created_at: string | null; rationale: string | null }>
  let escalated = 0
  for (const note of rows) {
    if (!urgentSlaBreached(note.created_at, now)) continue
    if (!note.recipient_contact_id) continue
    try {
      // Idempotent: one urgent escalation per note ever.
      const { data: prior } = await supabase.from("notifications").select("id")
        .eq("entity_type", "agent_client_message").eq("entity_id", note.id)
        .eq("type", "reverse_prospecting_urgent").limit(1).maybeSingle()
      if (prior) continue

      const { data: contact } = await supabase.from("contacts")
        .select("first_name, agent_id, brokerage_id").eq("id", note.recipient_contact_id).maybeSingle()
      const c = contact as { first_name: string | null; agent_id: string | null; brokerage_id: string | null } | null
      if (!c?.agent_id) continue
      const { data: agentRow } = await supabase.from("agents").select("user_id").eq("id", c.agent_id).maybeSingle()
      const agentUserId = (agentRow as { user_id: string | null } | null)?.user_id ?? null
      if (!agentUserId) continue

      const { error } = await supabase.from("notifications").insert({
        user_id: agentUserId, brokerage_id: brokerageId,
        type: "reverse_prospecting_urgent",
        title: "Hot match waiting — call before it's gone",
        body: `A new-listing match for ${c.first_name ?? "your buyer"} has been waiting over ${URGENT_NUDGE_MAX_HOURS}h for your OK. New listings move fast — review the gated note or call them now.`,
        entity_type: "agent_client_message", entity_id: note.id,
        priority: "high", channel: "in_app",
      })
      if (!error) escalated += 1
    } catch { /* best-effort per note */ }
  }
  return escalated
}
