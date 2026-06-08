/**
 * lib/listing-presentation/propose-prelisting-drip.ts
 *
 * Wave 39 — closes the agentic loop for the pre-listing presentation. When the
 * presentation is built, the marketing manager PROPOSES the seller-facing drip
 * (CMA chart sections + branded slides + narration) into the Command Center
 * rather than auto-firing it. A human approves once; approving runs the
 * start_prelisting_drip handler (materializePresentationSections → renders →
 * narration → schedule → portal/email), all under the existing spend cap +
 * compliance gates. Governance model: managers propose, humans approve,
 * managers execute — nothing reaches the seller without a human in the loop.
 *
 * Idempotent — one open proposal per presentation. Not server-only.
 */
import { createServiceClient } from "@/lib/supabase/service"

export interface ProposeResult { proposed: boolean; actionId?: string; reason?: string }

export async function proposePrelistingDrip(
  params: { presentationId: string; brokerageId: string; sessionId?: string | null },
  client?: ReturnType<typeof createServiceClient>,
): Promise<ProposeResult> {
  const supabase = client ?? createServiceClient()
  if (!params.brokerageId || !params.presentationId) return { proposed: false, reason: "missing ids" }

  // Idempotent — don't re-propose if a drip action for this presentation is
  // already proposed/approved/executing/done.
  const { data: existing } = await supabase
    .from("marketing_agent_actions")
    .select("id, status")
    .eq("brokerage_id", params.brokerageId)
    .eq("action_type", "start_prelisting_drip")
    .contains("action_input", { presentation_id: params.presentationId })
    .in("status", ["proposed", "approved", "executing", "succeeded"])
    .maybeSingle()
  if (existing) return { proposed: false, actionId: (existing as { id: string }).id, reason: "already proposed" }

  const { data, error } = await supabase
    .from("marketing_agent_actions")
    .insert({
      brokerage_id:             params.brokerageId,
      managed_agent_session_id: params.sessionId ?? null,
      action_type:              "start_prelisting_drip",
      action_input:             { presentation_id: params.presentationId },
      rationale:
        "Produce + drip the seller-facing pre-listing presentation (CMA charts, branded sections, the agent's narrated avatar) to win the listing before the appointment. Awaiting your approval — nothing reaches the seller until you approve.",
      status:                   "proposed",
    })
    .select("id")
    .single()
  if (error || !data) return { proposed: false, reason: error?.message ?? "insert failed" }
  return { proposed: true, actionId: (data as { id: string }).id }
}
