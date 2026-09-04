// lib/kernel/returning-customer.ts
//
// RETURNING-CUSTOMER RE-ENGAGEMENT WITH MEMORY — closes the "lifetime" end of the
// scrape→deal→lifetime arc. When a PAST client (a lifetime customer / closed buyer or seller)
// becomes active again — a reactivation signal lands on signal_reactivations.contact_id — the
// right manager re-engages them WITH the memory of their prior deal: the Shopping Agent for a
// returning buyer, the Listing Concierge for a returning seller. The proposal recalls real
// facts from their closed transaction (role, price band, area, time since close), so it reads
// like a teammate who remembers them — not a cold blast.
//
// Reuses, doesn't rebuild: signal_reactivations (already carries contact_id), the prior closed
// `transactions`, proposeClientMessage (gated — proposes, never auto-sends; now autonomy-gated
// at the egress too), and the referral-radar dedup-by-rationale-tag pattern. Withdrawn excluded;
// idempotent per (contact) within the dedupe window. PURE scoring/routing is unit-tested; the
// runner is simulator-driven (not server-only).

import { createServiceClient } from "@/lib/supabase/service"
import { isLifetimeRelationshipType } from "@/lib/contact-types"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

// TOMBSTONE (CLAUDE.md §1, §6). This module declared its OWN `LIFETIME_CONTACT_TYPES`
// Set — a second spelling of the tuple in lib/campaigns/contact-sources.ts and a third
// of PAST_CLIENT_TYPES in lib/kernel/referral-radar.ts. All three named `lifetime` and
// `past_client`, which m539 retired. The survivor is
// lib/contact-types.ts:LIFETIME_CONTACT_TYPES, read here through
// `isLifetimeRelationshipType` so a legacy spelling still resolves on the READ side.

/** Rationale marker — also the idempotency key (one re-engagement per contact per window). */
export const REENGAGE_TAG = "♻️ RETURNING-CUSTOMER"
export const REENGAGE_DEDUPE_DAYS = 60

export interface ContactLite {
  id: string
  first_name?: string | null
  last_name?: string | null
  contact_type?: string | null
  lifecycle_state?: string | null
  buyer_stage?: string | null
  nurture_status?: string | null
}

/** PURE: is this a past client we'd re-engage (and not one who asked us to stop)? */
export function isReengageableLifetime(c: ContactLite): boolean {
  if ((c.nurture_status ?? "") === "withdrawn") return false
  return (
    (c.lifecycle_state ?? "") === "lifetime_customer" ||
    c.buyer_stage === "BUYER_CLOSED" ||
    c.buyer_stage === "BUYER_LIFETIME" ||
    isLifetimeRelationshipType(c.contact_type)
  )
}

/** PURE: whole months between an ISO date and now (0 when missing/invalid). */
export function monthsSince(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((now.getTime() - t) / (30 * 86_400_000)))
}

/** PURE: a human-readable price band from a numeric price. */
export function priceBand(price: number | null | undefined): string | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null
  if (price < 300_000) return "under $300k"
  if (price < 500_000) return "the $300–500k range"
  if (price < 750_000) return "the $500–750k range"
  if (price < 1_000_000) return "the $750k–1M range"
  return "the $1M+ range"
}

export interface PriorDealTxn {
  contact_id?: string | null
  buyer_contact_id?: string | null
  seller_contact_id?: string | null
  deal_type?: string | null
  status?: string | null
  purchase_price?: number | null
  close_date?: string | null
  created_at?: string | null
  property_city?: string | null
  property_state?: string | null
  property_address?: string | null
}

export type PriorRole = "buyer" | "seller" | "both" | "unknown"

export interface DealMemory {
  dealCount: number
  role: PriorRole
  lastDealType: string | null
  lastPriceBand: string | null
  lastCloseMonthsAgo: number | null
  lastArea: string | null
}

/** PURE: summarize a contact's CLOSED transactions into a re-engagement memory. */
export function summarizePriorDeals(txns: PriorDealTxn[], contactId: string, now: Date = new Date()): DealMemory {
  const closed = txns.filter((t) => ["closed", "completed", "won"].includes((t.status ?? "").toLowerCase()))
  if (closed.length === 0) return { dealCount: 0, role: "unknown", lastDealType: null, lastPriceBand: null, lastCloseMonthsAgo: null, lastArea: null }

  let wasBuyer = false, wasSeller = false
  for (const t of closed) {
    if (t.buyer_contact_id === contactId || (t.deal_type ?? "").toLowerCase().includes("buy")) wasBuyer = true
    if (t.seller_contact_id === contactId || (t.deal_type ?? "").toLowerCase().includes("sell") || (t.deal_type ?? "").toLowerCase().includes("listing")) wasSeller = true
  }
  const role: PriorRole = wasBuyer && wasSeller ? "both" : wasBuyer ? "buyer" : wasSeller ? "seller" : "unknown"

  // Most-recent closed deal (by close_date, then created_at).
  const sorted = [...closed].sort((a, b) => {
    const da = new Date(a.close_date ?? a.created_at ?? 0).getTime()
    const db = new Date(b.close_date ?? b.created_at ?? 0).getTime()
    return db - da
  })
  const last = sorted[0]
  const area = [last.property_city, last.property_state].filter(Boolean).join(", ") || last.property_address || null
  return {
    dealCount: closed.length,
    role,
    lastDealType: last.deal_type ?? null,
    lastPriceBand: priceBand(last.purchase_price),
    lastCloseMonthsAgo: monthsSince(last.close_date ?? last.created_at, now),
    lastArea: area,
  }
}

/**
 * PURE: which manager re-engages, given the reactivation signal type + the prior-deal role.
 * Buyer intent → Shopping Agent; seller intent → Listing Concierge; ambiguous → infer from the
 * prior role, else the Sphere Manager keeps the relationship warm.
 */
export function reEngagementManager(signalType: string | null | undefined, memory: DealMemory): ManagerKey {
  const s = (signalType ?? "").toLowerCase()
  if (/buy|search|criteria|property|showing|tour/.test(s)) return "shopping_agent"
  if (/sell|list|cma|valuation|equity|value/.test(s)) return "listing_concierge"
  if (memory.role === "buyer") return "shopping_agent"
  if (memory.role === "seller") return "listing_concierge"
  return "sphere_of_influence"
}

/** PURE: the client-message audience for the re-engaging manager. */
export function audienceForManager(managerKey: ManagerKey): "buyer" | "seller" | "agent" | "lead" {
  return managerKey === "listing_concierge" ? "seller" : "buyer"
}

export interface ReEngagementDraft {
  managerKey: ManagerKey
  audience: "buyer" | "seller" | "agent" | "lead"
  subject: string
  body: string
  rationale: string
}

/** PURE: compose the memory-aware re-engagement proposal (gated draft; the human approves). */
export function composeReEngagement(params: {
  contactName: string
  memory: DealMemory
  signalType: string | null | undefined
  /**
   * ORPHAN DOCTRINE §1.2 — BUILD THE MISSING HALF, merged onto the SURVIVOR
   * reader rather than into a new one.
   *
   * `signal_reactivations.signal_strength` and `.signal_data` were written by
   * lib/ai-isa/long-term-nurture.ts:179 (recordReactivationSignal — the
   * inbound-intent classifier stamps strength 80 and a
   * {source, side, reason} payload) and read by NOBODY: this lane, the only
   * consumer of the table's contact arm, selected `signal_type` alone. So the
   * human approving a re-engagement was shown WHICH signal fired and never how
   * strong it was or where it came from — the two facts that decide whether a
   * "past client is active again" claim is worth sending.
   *
   * Optional so the pure composer stays callable without them.
   */
  signalStrength?: number | null
  signalData?: Record<string, unknown> | null
  /** Most recent prior reactivation of this contact (signal_reactivations.isa_reactivated_at). */
  lastReactivatedAt?: string | null
  now?: Date
}): ReEngagementDraft {
  const { contactName, memory, signalType } = params
  const managerKey = reEngagementManager(signalType, memory)
  const audience = audienceForManager(managerKey)
  const name = contactName.trim() || "there"

  // The "memory recall" — real facts from their prior closed deal, when we have them.
  const recall: string[] = []
  if (memory.lastCloseMonthsAgo != null && memory.dealCount > 0) {
    const when = memory.lastCloseMonthsAgo === 0 ? "recently" : `about ${memory.lastCloseMonthsAgo} month${memory.lastCloseMonthsAgo === 1 ? "" : "s"} ago`
    const what = memory.role === "seller" ? "sale" : memory.role === "both" ? "move" : "purchase"
    const where = memory.lastArea ? ` in ${memory.lastArea}` : ""
    const band = memory.lastPriceBand ? ` (${memory.lastPriceBand})` : ""
    recall.push(`I still have your ${what}${where}${band} from ${when} on file`)
  }
  const recallLine = recall.length > 0 ? `${recall.join("; ")}. ` : ""

  const isBuyer = managerKey === "shopping_agent"
  const subject = isBuyer
    ? `${name}, ready to look again?`
    : managerKey === "listing_concierge"
      ? `${name}, curious what your home is worth now?`
      : `${name}, checking in`
  const body = isBuyer
    ? `Hi ${name} — it looks like you're back in the market. ${recallLine}When you're ready I can pull fresh listings that fit what you loved last time and line up showings. Want me to start a new search?`
    : managerKey === "listing_concierge"
      ? `Hi ${name} — looks like you may be thinking about selling. ${recallLine}I can put together a no-pressure current value and a net-proceeds picture whenever you'd like. Want me to prepare one?`
      : `Hi ${name} — great to reconnect. ${recallLine}If anything's on the horizon — buying, selling, or just a question — I'm here. How can I help?`

  const mgrLabel = isBuyer ? "Shopping Agent" : managerKey === "listing_concierge" ? "Listing Concierge" : "Sphere Manager"

  // The signal's own provenance, for the human who decides whether to send.
  // Every part is OMITTED when unknown — an absent strength is never rendered
  // as a number, and an unrecognised payload is never described.
  const provenance: string[] = []
  if (typeof params.signalStrength === "number" && Number.isFinite(params.signalStrength)) {
    provenance.push(`strength ${params.signalStrength}`)
  }
  const src = params.signalData?.source
  if (typeof src === "string" && src) provenance.push(`via ${src}`)
  if (params.lastReactivatedAt) {
    const since = (params.now ?? new Date()).getTime() - new Date(params.lastReactivatedAt).getTime()
    const days = Math.max(0, Math.floor(since / 86_400_000))
    if (Number.isFinite(days)) {
      provenance.push(`last re-engaged ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`)
    }
  }
  const provenanceLine = provenance.length > 0 ? ` [${provenance.join(", ")}]` : ""

  const rationale = `${REENGAGE_TAG} — ${mgrLabel}: a past client is active again (${signalType ?? "reactivation signal"})${provenanceLine}. Drafted with their prior-deal memory for approval — the same-day, remembered re-engagement no competitor offers.`

  return { managerKey, audience, subject, body, rationale }
}

export interface ReturningCustomerResult {
  scanned: number
  proposed: number
  deduped: number
  skippedNotLifetime: number
}

/**
 * Consume pending CONTACT reactivation signals and propose a memory-aware re-engagement from the
 * right manager. Gated (proposeClientMessage → approval queue, never auto-sends), idempotent per
 * (contact) within REENGAGE_DEDUPE_DAYS, withdrawn excluded. Marks each signal processed.
 */
export async function runReturningCustomerReengagement(
  brokerageId: string,
  opts: { now?: Date; limit?: number } = {},
  client?: Svc,
): Promise<ReturningCustomerResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")

  // signal_strength / signal_data joined the select 2026-09-04 (§1.2): they were
  // written by recordReactivationSignal and read by nobody, so the approver saw
  // the signal's NAME and nothing about its weight or origin.
  const { data: signals } = await supabase
    .from("signal_reactivations")
    .select("id, contact_id, signal_type, signal_strength, signal_data")
    .eq("brokerage_id", brokerageId)
    .eq("isa_reactivated", false)
    .not("contact_id", "is", null)
    .order("triggered_at", { ascending: true })
    .limit(opts.limit ?? 200)

  const res: ReturningCustomerResult = { scanned: 0, proposed: 0, deduped: 0, skippedNotLifetime: 0 }
  const since = new Date(now.getTime() - REENGAGE_DEDUPE_DAYS * 86_400_000).toISOString()

  for (const sig of (signals ?? []) as Array<{
    id: string
    contact_id: string
    signal_type: string | null
    signal_strength: number | null
    signal_data: Record<string, unknown> | null
  }>) {
    res.scanned += 1
    const markProcessed = async () =>
      supabase.from("signal_reactivations").update({ isa_reactivated: true, isa_reactivated_at: now.toISOString() }).eq("id", sig.id)

    const { data: contact } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, contact_type, lifecycle_state, buyer_stage, nurture_status")
      .eq("id", sig.contact_id)
      .maybeSingle()

    if (!contact || !isReengageableLifetime(contact as ContactLite)) {
      res.skippedNotLifetime += 1
      await markProcessed() // not a returning lifetime customer — consume so we don't re-scan it
      continue
    }

    // Dedup — one returning-customer re-engagement per contact per window.
    const { data: dup } = await supabase
      .from("agent_client_messages")
      .select("id")
      .eq("recipient_contact_id", sig.contact_id)
      .ilike("rationale", `${REENGAGE_TAG}%`)
      .gte("proposed_at", since)
      .limit(1)
      .maybeSingle()
    if (dup) { res.deduped += 1; await markProcessed(); continue }

    // Prior-deal memory from closed transactions (buyer OR seller side).
    const { data: txns } = await supabase
      .from("transactions")
      .select("contact_id, buyer_contact_id, seller_contact_id, deal_type, status, purchase_price, close_date, created_at, property_city, property_state, property_address")
      .or(`contact_id.eq.${sig.contact_id},buyer_contact_id.eq.${sig.contact_id},seller_contact_id.eq.${sig.contact_id}`)
      .is("deleted_at", null)
      .limit(50)
    const memory = summarizePriorDeals((txns ?? []) as PriorDealTxn[], sig.contact_id, now)

    const name = [(contact as ContactLite).first_name, (contact as ContactLite).last_name].filter(Boolean).join(" ")

    // §1.2 — the READER for isa_reactivated_at, which until now was write-only.
    // The most recent time THIS contact's signals were consumed tells the
    // approver whether this is a first re-engagement or the fourth this month.
    // §3: the error is read — an unreadable history omits the line rather than
    // asserting "never re-engaged before".
    const { data: priorReactivation, error: priorErr } = await supabase
      .from("signal_reactivations")
      .select("isa_reactivated_at")
      .eq("contact_id", sig.contact_id)
      .eq("brokerage_id", brokerageId)
      .not("isa_reactivated_at", "is", null)
      .order("isa_reactivated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastReactivatedAt = priorErr
      ? null
      : ((priorReactivation as { isa_reactivated_at?: string | null } | null)?.isa_reactivated_at ?? null)

    const draft = composeReEngagement({
      contactName: name,
      memory,
      signalType: sig.signal_type,
      signalStrength: sig.signal_strength,
      signalData: sig.signal_data,
      lastReactivatedAt,
      now,
    })

    const proposed = await proposeClientMessage({
      brokerageId,
      agentKind: draft.managerKey,
      entityType: "contact",
      recipientContactId: sig.contact_id,
      audience: draft.audience,
      subject: draft.subject,
      body: draft.body,
      rationale: draft.rationale,
      channel: "portal",
    }, supabase)

    if (proposed.ok) res.proposed += 1
    await markProcessed()
  }

  return res
}
