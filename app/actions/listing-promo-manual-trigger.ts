"use server"

/**
 * app/actions/listing-promo-manual-trigger.ts
 *
 * Wave 27 — explicit-trigger surface for lifecycle promo moments whose
 * policy says auto_spawn=false. The agent clicks "Generate Coming Soon
 * promo" or "Generate Price Reduction promo" on the listing detail UI;
 * this action calls the reactor with bypassPolicy=true so the opt-out
 * is overridden for THIS spawn (cooldown still applies).
 *
 * The auth flow gates on:
 *   1. getAgentContext() — must be authenticated user
 *   2. Listing must belong to caller's brokerage (tenant isolation)
 *   3. Listing's agent_id must resolve (otherwise the reactor's voice
 *      profile gate will fail anyway, but we surface the clearer error here)
 *
 * Returns the reactor's result shape so the UI can surface a toast with
 * the right outcome string ('rendering' / 'already_queued' / 'failed').
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import {
  dispatchListingPromoVideo,
  type ListingPromoEventType,
  type ListingPromoResult,
} from "@/lib/video/listing-promo-reactor"
import { resolveAgentRecordToUserId } from "@/lib/kernel/agent-identity-resolver"

export interface ManualTriggerInput {
  listingId:    string
  eventType:    ListingPromoEventType
  /** Optional event-specific context — e.g. for just_sold the agent can
   *  pass disclose_sale_price=true + disclosed_sale_price so the script
   *  template includes the disclosed number. */
  eventContext?: Record<string, unknown>
}

export async function manuallyTriggerListingPromo(
  input: ManualTriggerInput,
): Promise<ListingPromoResult | { ok: false; status: "skipped"; reason: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { ok: false, status: "skipped", reason: "not authenticated" }
  }

  const svc = createServiceClient()
  const { data: listing } = await svc
    .from("listings")
    .select("id, brokerage_id, agent_id")
    .eq("id", input.listingId)
    .maybeSingle()
  const l = listing as { id: string; brokerage_id: string | null; agent_id: string | null } | null
  if (!l) return { ok: false, status: "skipped", reason: "listing not found" }
  if (l.brokerage_id !== ctx.brokerageId) {
    // Tenant isolation — the listing belongs to a different brokerage.
    return { ok: false, status: "skipped", reason: "forbidden" }
  }
  if (!l.agent_id) {
    return { ok: false, status: "skipped", reason: "listing has no assigned agent" }
  }
  const agentUserId = await resolveAgentRecordToUserId(l.agent_id)
  if (!agentUserId) {
    return { ok: false, status: "skipped", reason: "unable to resolve agent user id" }
  }

  return await dispatchListingPromoVideo({
    brokerageId:  ctx.brokerageId,
    listingId:    input.listingId,
    agentUserId,
    eventType:    input.eventType,
    eventContext: input.eventContext,
    bypassPolicy: true,
  })
}
