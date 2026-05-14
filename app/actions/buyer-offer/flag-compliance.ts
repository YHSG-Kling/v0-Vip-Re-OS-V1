"use server"

/**
 * Raise a compliance flag against an offer.
 *
 * Called when an agent, TC, or automated scan finds:
 *   - a signature missing on a contract page
 *   - an initial missing
 *   - a required form/disclosure not in the packet
 *   - any other compliance concern that requires human review
 *
 * The flag is recorded as an activities row AND fanned out to the agent's
 * + TC's + compliance_officer's notification bells via the shared
 * notifyComplianceFlag helper. Critical flags also surface to broker /
 * broker_admin so show-stoppers never sit unread.
 *
 * No transaction state changes here — the flag is informational. Resolving
 * the flag (e.g. uploading the missing form) is a separate agent action;
 * the notifications stay until the recipients mark them read.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import { notifyComplianceFlag } from "@/lib/notifications/notify-helpers"

export interface FlagOfferComplianceParams {
  offerId:    string
  /** users.id of whoever raised the flag (agent, TC, scanner). */
  raiserUserId: string
  /** Stable type — drives filtering / analytics. */
  flagType:   "missing_signature" | "missing_initial" | "missing_form" | "missing_field" | "expired_disclosure" | "other"
  severity:   "low" | "medium" | "high" | "critical"
  title:      string
  /** Optional body / detail (e.g. "Page 3 buyer initial missing"). */
  body?:      string
  /** Optional document id when the flag is page-specific. */
  documentId?: string
}

export interface FlagOfferComplianceResult {
  success: boolean
  notified_count?: number
  error?:  string
}

export async function flagOfferCompliance(
  params: FlagOfferComplianceParams,
): Promise<FlagOfferComplianceResult> {
  const { offerId, raiserUserId, flagType, severity, title, body, documentId } = params

  if (!isValidUUID(offerId) || !isValidUUID(raiserUserId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Load the offer to discover the brokerage + the responsible buyer-side agent
  const { data: offer } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, transaction_id")
    .eq("id", offerId)
    .maybeSingle()
  if (!offer) return { success: false, error: "Offer not found" }

  // Resolve the assigned buyer-side agent's users.id (the bell target). The
  // agents.id is what offers.agent_id stores.
  let assignedAgentUserId: string | null = null
  if (offer.agent_id) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", offer.agent_id as string)
      .maybeSingle()
    assignedAgentUserId = (agentRow?.user_id as string | null) ?? null
  }

  // Record the activity (audit trail) — activities.agent_id wants agents.id.
  const now = new Date().toISOString()
  await supabase.from("activities").insert({
    brokerage_id:   offer.brokerage_id,
    agent_user_id:  raiserUserId,
    agent_id:       offer.agent_id,
    contact_id:     offer.contact_id,
    entity_type:    "offer",
    activity_type:  "buyer.offer.compliance.flagged",
    title,
    description:    body ?? title,
    notes:          JSON.stringify({ offer_id: offerId, flagType, severity, raised_by: raiserUserId, document_id: documentId, raised_at: now }),
    metadata:       { offer_id: offerId, flagType, severity, raised_by: raiserUserId, document_id: documentId, raised_at: now },
    status:         "open",
    priority:       severity === "critical" ? "high" : severity === "high" ? "high" : "medium",
  })

  // Fan out the notification. Both the assigned buyer-side agent (so they
  // can fix it) and all TCs + compliance_officers in the brokerage (so they
  // see the queue). Critical flags also widen to broker / admin.
  const { notified_count } = await notifyComplianceFlag(supabase as any, {
    brokerageId:   offer.brokerage_id as string,
    agentUserId:   assignedAgentUserId,
    transactionId: (offer.transaction_id as string | null) ?? null,
    flag: {
      type:        `compliance.${flagType}`,
      severity,
      title,
      body,
      entityType:  "offer",
      entityId:    offerId,
      documentId:  documentId ?? null,
      offerId:     offerId,
    },
  })

  return { success: true, notified_count }
}
