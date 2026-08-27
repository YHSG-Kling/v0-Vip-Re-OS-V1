// lib/agents/seller-conversion-nurture.ts
// ─────────────────────────────────────────────────────────────────────────────
// SELLER-CONVERSION NURTURE — don't drop the homeowner who showed selling intent but hasn't booked the
// listing consult yet. These are CONTACTS WITH A SELLER-MODE PORTAL (they asked "what's my home
// worth?" → became a contact_type='seller' with a portal_view='seller' invite), exactly like a buyer
// who is a contact but hasn't converted. So we mirror the BUYER nurture: a MULTI-MANAGER reel chain,
// NOT a one-off hardcoded email.
//
//   Listing Concierge (detect) → Asset Manager (commission a personal value reel) → Campaign
//   Orchestrator (deliver the gated 1:1 + the seller-mode portal CTA).
//
// This runner is just the DETECTOR: it publishes seller_conversion_reel_handoff to the Asset Manager
// and the existing bus does the rest (commissionVideo stages the gated reel; on completion the
// existing video-coordination routes contact_outreach_ready → the Campaign Orchestrator, which writes
// the seller-audience, listing_concierge-voiced copy through the gateway — no hardcoded copy, ever).
// Idempotent per contact; gated (human approves the reel + the send); best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { isUnconvertedSellerCandidate } from "./seller-conversion-eligibility"

type Svc = ReturnType<typeof createServiceClient>

/** Don't re-kick the same un-converted seller more than once per ~30 days. */
const SELLER_NURTURE_COOLDOWN_DAYS = 30

export interface SellerConversionResult { scanned: number; handedOff: number }

export async function runSellerConversionNurture(
  brokerageId: string, client?: Svc, opts?: { limit?: number; now?: Date },
): Promise<SellerConversionResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: SellerConversionResult = { scanned: 0, handedOff: 0 }
  if (!brokerageId) return result

  // Sellers we ALREADY represent (active pipeline) — never nurture them to "convert"; they're converted.
  const { data: activeListings } = await svc.from("listings")
    .select("seller_contact_id").eq("brokerage_id", brokerageId)
    .in("status", ["active", "coming_soon", "pending"]).not("seller_contact_id", "is", null)
  const represented = new Set(((activeListings ?? []) as Array<{ seller_contact_id: string }>).map((l) => l.seller_contact_id))

  // Un-converted seller leads: asked for a home value OR declared seller intent (these are contacts
  // with a seller-mode portal, not portal-less strangers).
  const { data: rows } = await svc.from("contacts")
    .select("id, home_value_estimate, contact_type, motivation_type")
    .eq("brokerage_id", brokerageId)
    .or("home_value_estimate.not.is.null,motivation_type.eq.seller,contact_type.eq.seller")
    .neq("status", "deleted")
    .limit(opts?.limit ?? 100)
  const candidates = ((rows ?? []) as Array<{
    id: string; home_value_estimate: number | null; contact_type: string | null; motivation_type: string | null
  }>).filter((c) => isUnconvertedSellerCandidate(c, represented, c.id))
  if (candidates.length === 0) return result

  const cooldownIso = new Date(now.getTime() - SELLER_NURTURE_COOLDOWN_DAYS * 86_400_000).toISOString()
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")

  for (const c of candidates) {
    result.scanned++
    try {
      // Idempotent — one seller-conversion reel handoff per contact per cooldown window.
      const { data: recent } = await svc.from("manager_signals").select("id")
        .eq("brokerage_id", brokerageId).eq("signal_type", "seller_conversion_reel_handoff")
        .eq("contact_id", c.id).gte("created_at", cooldownIso).limit(1).maybeSingle()
      if (recent) continue

      // Hand the un-converted seller to the Asset Manager (video director) to commission the personal
      // value reel; the existing bus delivers it via the Campaign Orchestrator to the seller-mode portal.
      const sig = await publishManagerSignal({
        brokerageId,
        fromManager: "listing_concierge",
        toManager: "asset_manager",
        signalType: "seller_conversion_reel_handoff",
        message: "An un-converted seller (asked home value / declared selling, no listing yet) — commissioning their personal value reel to map their move and convert them to a listing consult.",
        entityType: "contact",
        entityId: c.id,
        contactId: c.id,
        payload: { audience: "seller" },
      }, svc)
      if (sig.ok) result.handedOff++
    } catch { /* best-effort per contact */ }
  }
  return result
}
