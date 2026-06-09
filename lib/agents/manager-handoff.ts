/**
 * lib/agents/manager-handoff.ts
 *
 * Wave 48 — imperative cross-manager handoff. Today managers run beside each other:
 * a listing goes active and the Marketing/Ads managers only discover it on their
 * weekly cron. This proposes the downstream coordinated campaign into the Command
 * Center the moment the lifecycle event fires — the Listing/Deal manager hands off
 * to the Marketing manager THROUGH the one governed gate. A human approves; the
 * handler kicks the coordinated promo. Idempotent (one open handoff per listing).
 */
import { createServiceClient } from "@/lib/supabase/service"

async function proposeHandoff(
  params: { brokerageId: string; listingId: string; actionType: "promote_new_listing" | "just_sold_campaign"; rationale: string },
  client?: ReturnType<typeof createServiceClient>,
): Promise<{ proposed: boolean; actionId?: string; reason?: string }> {
  const supabase = client ?? createServiceClient()
  if (!params.brokerageId || !params.listingId) return { proposed: false, reason: "missing ids" }

  const { data: existing } = await supabase
    .from("marketing_agent_actions")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .eq("action_type", params.actionType)
    .contains("action_input", { listing_id: params.listingId })
    .in("status", ["proposed", "approved", "executing", "succeeded"])
    .maybeSingle()
  if (existing) return { proposed: false, actionId: (existing as { id: string }).id, reason: "already proposed" }

  const { data, error } = await supabase.from("marketing_agent_actions").insert({
    brokerage_id: params.brokerageId, action_type: params.actionType,
    action_input: { listing_id: params.listingId }, rationale: params.rationale, status: "proposed",
  }).select("id").single()
  if (error || !data) return { proposed: false, reason: error?.message ?? "insert failed" }
  return { proposed: true, actionId: (data as { id: string }).id }
}

/** Listing went active → propose the coordinated new-listing push. */
export async function proposeListingHandoff(brokerageId: string, listingId: string, client?: ReturnType<typeof createServiceClient>) {
  return proposeHandoff({ brokerageId, listingId, actionType: "promote_new_listing",
    rationale: "Listing is live — launch the coordinated new-listing promotion (just-listed reel + social). Approve to hand off to Marketing." }, client)
}

/** Deal closed → propose the just-sold campaign (announcement + sphere + testimonial). */
export async function proposeClosingHandoff(brokerageId: string, listingId: string, client?: ReturnType<typeof createServiceClient>) {
  return proposeHandoff({ brokerageId, listingId, actionType: "just_sold_campaign",
    rationale: "Deal closed — launch the just-sold campaign (just-sold reel + announcement). Approve to hand off to Marketing." }, client)
}
