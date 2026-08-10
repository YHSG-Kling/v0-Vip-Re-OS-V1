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
 * No transaction state changes here — the flag is informational. The flag is
 * CLEARED by lib/compliance/offer-flag-resolution.ts:resolveOfferComplianceFlags
 * (on a passing submit, or when the specific miss it names is supplied); the
 * notifications stay until the recipients mark them read.
 *
 * ── ONE ROW PER MISS, NOT ONE PER ATTEMPT ────────────────────────────────────
 * This action used to INSERT unconditionally, so every resubmission that still
 * hit the same miss minted another `status:'open'` row. Nothing ever closed one,
 * so the queue only ever grew and stopped meaning anything.
 *
 * It now UPSERTS on the flag's stable identity. The row write itself lives in
 * lib/compliance/offer-flag-resolution.ts:recordOfferComplianceFlag, alongside
 * the resolver that closes it — one module owns the flag row's whole lifecycle,
 * and it takes an injectable client so the behaviour is provable without
 * credentials (scripts/offer-flag-loop-simulator.ts). That module documents why
 * the identity is `flagType + title` and explicitly NOT `documentId`.
 *
 * THIS action keeps what only it can do: the auth gate, the tenant + agent
 * resolution off the offer row, and the notification fan-out.
 *
 * The NOTIFICATION fan-out is deliberately NOT deduped. A failed resubmission is
 * a new event for the humans even when the miss is old — the owner's rule is that
 * the missing piece goes to the TC and the agent every time it blocks.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID }          from "@/lib/validations"
import { notifyComplianceFlag } from "@/lib/notifications/notify-helpers"
import { recordOfferComplianceFlag } from "@/lib/compliance/offer-flag-resolution"

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
  /** The stable identity of the miss this flag names — see offer-flag-resolution.ts. */
  flag_key?: string
  /** True when an already-open flag for the SAME miss was refreshed instead of
   *  a second one being minted. */
  deduped?: boolean
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

  // Record the flag row. Delegated to the module that also CLOSES it, so the
  // raise side and the resolve side can never disagree about what identifies a
  // miss — see lib/compliance/offer-flag-resolution.ts for the anchor and the
  // upsert-vs-refuse decision.
  //
  // The notification fan-out below is the load-bearing human alert (it returns
  // notified_count, which IS checked by the caller), so a lost audit row does not
  // stop the flag — but supabase-js RESOLVES a rejected write, and an audit trail
  // that quietly stopped recording must not be invisible.
  const recorded = await recordOfferComplianceFlag({
    offerId,
    brokerageId:  offer.brokerage_id as string,
    raiserUserId,
    // activities.agent_id FKs agents(id); agent_user_id is users-class. Disjoint
    // spaces — offers.agent_id is already an agents id and goes only to agentId.
    agentId:      (offer.agent_id as string | null) ?? null,
    contactId:    (offer.contact_id as string | null) ?? null,
    flagType,
    severity,
    title,
    body,
    documentId,
    client:       supabase,
  })
  if (!recorded.success || recorded.error) {
    console.error(`[flag-compliance] offer ${offerId}: compliance-flag audit row problem:`, recorded.error)
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

  return { success: true, notified_count, flag_key: recorded.flag_key, deduped: recorded.deduped }
}
