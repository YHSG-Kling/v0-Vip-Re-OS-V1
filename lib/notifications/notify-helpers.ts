/**
 * lib/notifications/notify-helpers.ts
 *
 * Small, focused notification helpers used by the offer + transaction chains.
 *
 * Why this file exists:
 *   - The e-sign webhook used to write only an `activities` row when the buyer
 *     signed — the agent saw it in the activities feed but the in-app
 *     notification bell never rang. notifyEsignSigned() fixes that.
 *   - When compliance flags a missing signature / initial / form, the TC + the
 *     transaction's agent + the brokerage's compliance officers all need to
 *     see it in their notifications. notifyComplianceFlag() fans out to
 *     every relevant recipient.
 *
 * Both helpers write to the `notifications` table directly (schema is
 * permissive — no CHECK on type), respecting the existing column conventions:
 *   - user_id        : recipient (users.id)
 *   - brokerage_id   : tenant scope
 *   - type           : dot-namespaced event type
 *   - title / body   : human-readable
 *   - entity_type    : 'offer' | 'transaction' | 'document'
 *   - entity_id      : the target row id (so the UI can deep-link)
 *   - priority       : 'low' | 'medium' | 'high' | 'critical'
 *   - channel        : 'in_app' (default); email/sms left to notification-service
 *   - activity_id    : when the notification is the surface form of an activities row
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

// ─── Types ──────────────────────────────────────────────────────────────────

export type NotificationPriority = "low" | "medium" | "high" | "critical"

export interface NotifyEsignSignedInput {
  brokerageId:   string
  agentUserId:   string | null   // users.id of the buyer-side agent (recipient)
  offerId:       string
  envelopeId:    string
  provider:      string
  activityId?:   string | null   // when the caller already inserted the activity
}

export interface ComplianceFlag {
  /** Stable type string for filtering / analytics. */
  type:        string
  /** Severity drives priority + which audiences see it. */
  severity:    "low" | "medium" | "high" | "critical"
  /** Short title — shown in the bell. */
  title:       string
  /** Optional body / detail for the dropdown. */
  body?:       string
  /** Source entity for deep-linking. */
  entityType:  "offer" | "transaction" | "document"
  entityId:    string
  /** Optional ids for cross-reference. */
  documentId?: string | null
  offerId?:    string | null
}

export interface NotifyComplianceFlagInput {
  brokerageId:   string
  /** Acting agent's users.id — receives the notification first. */
  agentUserId?:  string | null
  /** Optional transaction id used to widen the recipient set to the tx's TCs. */
  transactionId?: string | null
  flag:          ComplianceFlag
}

// ─── notifyEsignSigned ──────────────────────────────────────────────────────

/**
 * Fire an in-app notification when an e-sign envelope completes (currently
 * the buyer-only signature for our offer flow). Agent's bell rings + the
 * dropdown deep-links into the offer.
 *
 * Idempotent at the activity level — the caller already deduplicates the
 * activities row via `voice-packet-signed-{docId}` keys; if the notification
 * was inserted on a prior webhook retry, the only side-effect is one extra
 * row, which the UI dedupes by activity_id.
 */
export async function notifyEsignSigned(
  supabase: SupabaseClient,
  input: NotifyEsignSignedInput,
): Promise<void> {
  if (!input.agentUserId) return

  // Avoid duplicate insert when called twice with the same activity_id.
  if (input.activityId) {
    const { data: existing } = await supabase
      .from("notifications")
      .select("id")
      .eq("activity_id", input.activityId)
      .eq("user_id", input.agentUserId)
      .limit(1)
      .maybeSingle()
    if (existing) return
  }

  await supabase.from("notifications").insert({
    user_id:       input.agentUserId,
    brokerage_id:  input.brokerageId,
    type:          "buyer.offer.buyer_signed",
    title:         "Buyer signed the offer",
    body:          `Envelope completed via ${input.provider}. Forward to the listing agent and await the seller's response.`,
    entity_type:   "offer",
    entity_id:     input.offerId,
    priority:      "high",
    channel:       "in_app",
    activity_id:   input.activityId ?? null,
  })
}

// ─── notifyComplianceFlag ───────────────────────────────────────────────────

/**
 * Fan out a compliance flag to every relevant recipient:
 *   - the acting agent (when known)
 *   - every TC in the brokerage (users.user_type = 'TC')
 *   - every compliance_officer in the brokerage
 *
 * Critical flags additionally fan to broker + broker_admin so the broker
 * sees show-stopping issues without having to dig.
 *
 * Returns the count of notifications inserted (one row per recipient).
 *
 * Note on user_type values: the live CHECK constraint allows
 *   {broker, admin, agent, vendor, lender, TC, compliance_officer, contact,
 *    team_lead}.
 * We use the exact-case values 'TC' and 'compliance_officer' — earlier code
 * sites queried 'tc' / 'transaction_coordinator', which never matched the
 * constraint. The fix lives here as the canonical fan-out path.
 */
export async function notifyComplianceFlag(
  supabase: SupabaseClient,
  input: NotifyComplianceFlagInput,
): Promise<{ notified_count: number; recipient_user_ids: string[] }> {
  const { brokerageId, agentUserId, transactionId, flag } = input

  const priority: NotificationPriority =
    flag.severity === "critical" ? "critical"
    : flag.severity === "high"   ? "high"
    : flag.severity === "low"    ? "low"
    : "medium"

  // Resolve recipients
  const recipientSet = new Set<string>()
  if (agentUserId) recipientSet.add(agentUserId)

  const widenForCritical = flag.severity === "critical"
  const targetRoles = widenForCritical
    ? ["TC", "compliance_officer", "broker", "broker_admin", "admin"]
    : ["TC", "compliance_officer"]

  const { data: staff } = await supabase
    .from("users")
    .select("id, user_type")
    .eq("brokerage_id", brokerageId)
    .in("user_type", targetRoles)

  for (const u of staff ?? []) {
    if (u.id) recipientSet.add(u.id as string)
  }

  // For a per-transaction TC assignment we'd also union in the tx's own TC.
  // The transactions schema doesn't currently expose assigned_tc_id; we rely
  // on brokerage-wide TC role membership above. (When a per-tx TC column is
  // added later, this is the natural place to union it in.)
  void transactionId

  const recipients = Array.from(recipientSet)
  if (recipients.length === 0) return { notified_count: 0, recipient_user_ids: [] }

  const rows = recipients.map(uid => ({
    user_id:      uid,
    brokerage_id: brokerageId,
    type:         flag.type,
    title:        flag.title,
    body:         flag.body ?? null,
    entity_type:  flag.entityType,
    entity_id:    flag.entityId,
    priority,
    channel:      "in_app",
  }))

  const { error } = await supabase.from("notifications").insert(rows)
  if (error) {
    console.error("[notify-helpers] notifyComplianceFlag insert failed:", error.message)
    return { notified_count: 0, recipient_user_ids: [] }
  }
  return { notified_count: rows.length, recipient_user_ids: recipients }
}
