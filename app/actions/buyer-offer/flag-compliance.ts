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

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import { notifyComplianceFlag } from "@/lib/notifications/notify-helpers"

export interface FlagOfferComplianceParams {
  offerId:    string
  /** Ignored — derived from session. Kept for backward compat with existing callers. */
  raiserUserId?: string
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
  const { offerId, flagType, severity, title, body, documentId } = params

  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid offer ID" }
  }

  // Auth gate — previously trusted params.raiserUserId, letting any caller
  // impersonate another user when raising compliance flags.
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", authUser.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }
  const raiserUserId = authUser.id

  const supabase = createServiceClient()

  // Load the offer to discover the brokerage + the responsible buyer-side agent
  const { data: offer } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id, transaction_id")
    .eq("id", offerId)
    .maybeSingle()
  if (!offer) return { success: false, error: "Offer not found" }
  if (offer.brokerage_id !== callerRow.brokerage_id) return { success: false, error: "Forbidden" }

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
  //
  // THE KEY. This row already supplied the tenant (activities.brokerage_id is
  // NOT NULL with no default) but omitted `entity_id`, which is NULLABLE — so it
  // inserted successfully and was then invisible to every reader that asks "what
  // has been flagged on THIS offer": the canonical key is entity_type='offer'
  // AND entity_id=<offers.id>. The flag was findable only by scanning the whole
  // activities table for a JSON substring in `notes`.
  //
  // `buyer.offer.compliance.flagged` stays a literal: it is an AUDIT event with
  // no lifecycle state, so it has no OFFER_EVENT constant by design — see the
  // vocabulary note in lib/buyer-offer/compliance-gate.ts and the standing
  // recommendation in docs/wave7-slice-writers.md.
  const now = new Date().toISOString()
  const { error: flagActivityError } = await supabase.from("activities").insert({
    brokerage_id:   offer.brokerage_id,
    agent_user_id:  raiserUserId,
    agent_id:       offer.agent_id,
    contact_id:     offer.contact_id,
    entity_type:    "offer",
    entity_id:      offerId,
    activity_type:  "buyer.offer.compliance.flagged",
    title,
    description:    body ?? title,
    notes:          JSON.stringify({ offer_id: offerId, flagType, severity, raised_by: raiserUserId, document_id: documentId, raised_at: now }),
    metadata:       { offer_id: offerId, flagType, severity, raised_by: raiserUserId, document_id: documentId, raised_at: now },
    status:         "open",
    priority:       severity === "critical" ? "high" : severity === "high" ? "high" : "medium",
  })
  if (flagActivityError) {
    // The notification fan-out below is the load-bearing human alert (it returns
    // notified_count, which IS checked by the caller), so a lost audit row does
    // not stop the flag — but supabase-js RESOLVES a rejected insert, and an
    // audit trail that quietly stopped recording must not be invisible.
    console.error(`[flag-compliance] offer ${offerId}: compliance-flag audit row failed to write:`, flagActivityError.message)
  }

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
