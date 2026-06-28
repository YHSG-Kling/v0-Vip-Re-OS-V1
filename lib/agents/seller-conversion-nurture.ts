// lib/agents/seller-conversion-nurture.ts
// ─────────────────────────────────────────────────────────────────────────────
// SELLER-CONVERSION NURTURE — don't drop the homeowner who showed seller intent but hasn't booked the
// listing appointment yet. The seller-side mirror of the buyer welcome/nurture: the Listing Concierge
// keeps a warm, gated, recurring touch on un-converted seller leads (home-value requesters / declared
// sellers with NO active listing) to convert them to a listing consult. Idempotent (one touch per
// contact per cadence window), gated (human approves), never spam. Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { buildSellerConversionMessage } from "./seller-conversion-copy"

type Svc = ReturnType<typeof createServiceClient>

/** Don't re-touch the same un-converted seller more than once per ~30 days. */
export const SELLER_NURTURE_COOLDOWN_DAYS = 30

export interface SellerConversionResult { scanned: number; proposed: number }

export async function runSellerConversionNurture(
  brokerageId: string, client?: Svc, opts?: { limit?: number; now?: Date },
): Promise<SellerConversionResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: SellerConversionResult = { scanned: 0, proposed: 0 }
  if (!brokerageId) return result

  // Sellers we ALREADY represent (active pipeline) — never nurture them to "convert"; they're converted.
  const { data: activeListings } = await svc.from("listings")
    .select("seller_contact_id").eq("brokerage_id", brokerageId)
    .in("status", ["active", "coming_soon", "pending"]).not("seller_contact_id", "is", null)
  const represented = new Set(((activeListings ?? []) as Array<{ seller_contact_id: string }>).map((l) => l.seller_contact_id))

  // Un-converted seller leads: asked for a home value OR declared seller intent, with a real channel.
  const { data: rows } = await svc.from("contacts")
    .select("id, first_name, home_value_estimate, email, contact_type, motivation_type, status")
    .eq("brokerage_id", brokerageId)
    .or("home_value_estimate.not.is.null,motivation_type.eq.seller,contact_type.eq.seller")
    .neq("status", "deleted")
    .limit(opts?.limit ?? 100)
  const candidates = ((rows ?? []) as Array<{
    id: string; first_name: string | null; home_value_estimate: number | null
    email: string | null; contact_type: string | null; motivation_type: string | null
  }>).filter((c) => !represented.has(c.id))
  if (candidates.length === 0) return result

  const cooldownIso = new Date(now.getTime() - SELLER_NURTURE_COOLDOWN_DAYS * 86_400_000).toISOString()
  const { proposeClientMessage } = await import("./agent-client-messages")
  const { generateClientMessage } = await import("./generate-client-message")

  for (const c of candidates) {
    result.scanned++
    try {
      // Idempotent — one seller-conversion touch per contact per cooldown window.
      const { data: recent } = await svc.from("agent_client_messages").select("id")
        .eq("brokerage_id", brokerageId).eq("entity_type", "seller_conversion").eq("recipient_contact_id", c.id)
        .gte("created_at", cooldownIso).limit(1).maybeSingle()
      if (recent) continue

      const fallback = buildSellerConversionMessage(c.first_name, c.home_value_estimate)
      const msg = await generateClientMessage({
        brokerageId, audience: "seller",
        purpose: "Warmly re-engage a homeowner who showed interest in selling but hasn't booked a listing consult — share that their home value + likely net proceeds are ready, and invite them (no pressure, no obligation) to map their move with their agent.",
        recipientFirstName: c.first_name,
        ctas: ["See what my home could sell for", "Book a quick, no-pressure consult"],
        fallback,
      }).catch(() => fallback)

      const r = await proposeClientMessage({
        brokerageId, agentKind: "listing_concierge", entityType: "seller_conversion", entityId: c.id,
        recipientContactId: c.id, audience: "seller", subject: msg.subject, body: msg.body,
        rationale: "Un-converted seller lead (asked home value / declared seller, no listing yet) — gated nurture to a listing consult so the seller funnel doesn't go quiet.",
        channel: "portal",
      }, svc)
      if (r.ok) result.proposed++
    } catch { /* best-effort per contact */ }
  }
  return result
}
