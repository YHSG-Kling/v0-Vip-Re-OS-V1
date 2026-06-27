// lib/ai-isa/showing-cancellation-followup.ts
// ─────────────────────────────────────────────────────────────────────────────
// SHOWING-CANCELLATION FOLLOW-UP — a buyer who cancels a tour is a warm moment, not a dead end.
// The Shopping Agent reaches out gently the next day: "want to reschedule, or I can line up a
// couple similar homes?" — keeping the buyer engaged and driving back to the portal, instead of
// letting a cancelled showing quietly stall the search. No-spam: ONE gated message per cancelled
// showing, only on a recent cancellation, never auto-sent. PURE copy core + a thin runner.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { buildCancellationFollowup, CANCELLATION_LOOKBACK_DAYS } from "@/lib/ai-isa/showing-cancellation-copy"

export { buildCancellationFollowup, CANCELLATION_LOOKBACK_DAYS }

type Svc = ReturnType<typeof createServiceClient>

export interface CancellationFollowupResult { scanned: number; proposed: number }

/**
 * runShowingCancellationFollowups — sweep a brokerage's recently-cancelled buyer showings and
 * propose ONE gated, portal-driving reschedule/pivot note per showing (Shopping Agent owns it).
 * Idempotent per (showing): a follow-up is proposed once. Best-effort; never throws.
 */
export async function runShowingCancellationFollowups(
  brokerageId: string, client?: Svc, opts?: { limit?: number; now?: Date },
): Promise<CancellationFollowupResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const since = new Date(now.getTime() - CANCELLATION_LOOKBACK_DAYS * 86_400_000).toISOString()
  const result: CancellationFollowupResult = { scanned: 0, proposed: 0 }

  const { data: rows } = await svc.from("showing_requests")
    .select("id, contact_id, property_address, updated_at")
    .eq("brokerage_id", brokerageId).eq("status", "cancelled")
    .gte("updated_at", since).not("contact_id", "is", null)
    .order("updated_at", { ascending: false }).limit(opts?.limit ?? 50)
  const showings = (rows ?? []) as Array<{ id: string; contact_id: string; property_address: string | null; updated_at: string | null }>
  if (showings.length === 0) return result

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")

  for (const s of showings) {
    result.scanned++
    try {
      // Idempotent: one cancellation follow-up per showing.
      const { data: dup } = await svc.from("agent_client_messages").select("id")
        .eq("brokerage_id", brokerageId).eq("entity_type", "showing_cancellation").eq("entity_id", s.id)
        .in("status", ["proposed", "approved", "sent"]).limit(1).maybeSingle()
      if (dup) continue

      const { data: c } = await svc.from("contacts").select("first_name, agent_id").eq("id", s.contact_id).maybeSingle()
      const contact = c as { first_name: string | null; agent_id: string | null } | null
      if (!contact) continue

      const fallback = buildCancellationFollowup(contact.first_name, s.property_address)
      let agentUserId: string | null = null
      if (contact.agent_id) {
        const { data: a } = await svc.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
        agentUserId = (a as { user_id: string | null } | null)?.user_id ?? null
      }
      // Gateway-written, brand-voiced (deterministic fallback only).
      const msg = await generateClientMessage({
        brokerageId, agentUserId, audience: "buyer",
        purpose: "A buyer's showing was cancelled. Warmly offer to reschedule, or to line up a couple of similar homes — no pressure — and point them to their portal.",
        recipientFirstName: contact.first_name,
        ctas: ["Find another time", "See a few similar homes"],
        fallback,
      }).catch(() => fallback)

      const r = await proposeClientMessage({
        brokerageId, agentKind: "shopping_agent", entityType: "showing_cancellation", entityId: s.id,
        recipientContactId: s.contact_id, audience: "buyer", subject: msg.subject, body: msg.body,
        rationale: "Showing cancelled — gated reschedule/pivot note that keeps the buyer engaged and drives back to the portal.",
        channel: "portal",
      }, svc)
      if (r.ok) result.proposed++
    } catch { /* best-effort per showing */ }
  }
  return result
}
