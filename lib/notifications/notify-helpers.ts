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
import { rawRoleVariantsFor, type CanonicalRole } from "@/lib/security/types"

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
  /**
   * Extra users.id recipients the CALLER resolved — typically the offer's own
   * agent and the listing agent. This helper cannot work those out: it does not
   * know which offer or listing the flag came from, and guessing from the
   * acting user would notify the wrong side of an in-house deal.
   */
  alsoNotifyUserIds?: (string | null | undefined)[]
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
 *   - the acting user (when known)
 *   - anyone the CALLER names in `alsoNotifyUserIds` — the offer's own agent
 *     and the listing agent, which only the caller can resolve
 *   - every TC in the brokerage
 *   - every compliance_officer in the brokerage
 *
 * Critical flags additionally fan to broker + admin + superadmin so the broker
 * sees show-stopping issues without having to dig.
 *
 * Returns the count of notifications inserted (one row per recipient).
 *
 * ── THE BUG THIS COMMENT USED TO DOCUMENT BACKWARDS ─────────────────────────
 * The previous note asserted the live CHECK allowed 'TC' and that querying
 * 'tc' "never matched the constraint". The live constraint is the opposite:
 *
 *   users_user_type_check CHECK (user_type = ANY (ARRAY[
 *     'admin','agent','broker','broker_owner','compliance_officer','contact',
 *     'isa','lender','superadmin','support','system','tc','team_lead','vendor']))
 *
 * 'TC' is not a legal value at all, and every live row stores 'tc'. So
 * `.in("user_type", ["TC", ...])` matched ZERO rows — and a query that matches
 * nothing is a successful query, so it failed in total silence. The
 * transaction coordinator, the single most important recipient of a missing
 * signature or document, had never received one of these notifications.
 *
 * Roles are now expanded through rawRoleVariants() off the same table
 * toCanonicalRole() maps in, so the filter cannot drift from the vocabulary
 * again. 'compliance_manager' and 'broker_admin' were also in the old list and
 * are not legal user_type values either; they survive only as legacy aliases
 * inside that table, which is where they belong.
 */
export async function notifyComplianceFlag(
  supabase: SupabaseClient,
  input: NotifyComplianceFlagInput,
): Promise<{ notified_count: number; recipient_user_ids: string[] }> {
  const { brokerageId, agentUserId, transactionId, flag, alsoNotifyUserIds } = input

  const priority: NotificationPriority =
    flag.severity === "critical" ? "critical"
    : flag.severity === "high"   ? "high"
    : flag.severity === "low"    ? "low"
    : "medium"

  // Resolve recipients
  const recipientSet = new Set<string>()
  if (agentUserId) recipientSet.add(agentUserId)
  // The deal's own people, resolved by the caller: the offer's agent (who may
  // not be whoever clicked) and the LISTING agent (the other side of an
  // in-house deal). Owner's rule: a missing signature, initial or document
  // notifies the TC and/or the listing agent.
  for (const uid of alsoNotifyUserIds ?? []) if (uid) recipientSet.add(uid)

  const widenForCritical = flag.severity === "critical"
  const targetRoles: CanonicalRole[] = widenForCritical
    ? ["tc", "compliance_officer", "broker", "admin", "superadmin"]
    : ["tc", "compliance_officer"]

  const { data: staff, error: staffError } = await supabase
    .from("users")
    .select("id, user_type")
    .eq("brokerage_id", brokerageId)
    .in("user_type", rawRoleVariantsFor(targetRoles))

  // A failed staff lookup is not "no staff". Say so — silently notifying only
  // the acting agent is how the TC stopped being told in the first place.
  if (staffError) {
    console.error("[notify-helpers] compliance-flag staff lookup failed:", staffError.message)
  }

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

  // Channel selection by severity:
  //   low / medium       → in-app bell only (avoid email/SMS noise)
  //   high / critical    → multi-channel (in-app + email + SMS-if-consented + push-if-enabled)
  // We always write the in-app row directly so the bell rings instantly even
  // if the multi-channel service has a transient failure mid-fan-out.
  const escalate = flag.severity === "high" || flag.severity === "critical"

  if (!escalate) {
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

  // High / critical: route through NotificationService so email + SMS + push
  // also fire per recipient consent + brokerage global settings. The service
  // writes the in-app row itself (using the corrected schema), logs every
  // delivery attempt to notification_log, and respects user
  // communication_preferences for SMS gating.
  try {
    const { NotificationService } = await import("@/lib/transactions/notification-service")
    const svc = new NotificationService()
    await svc.sendMultiChannelNotification({
      brokerageId,
      recipientIds: recipients,
      entityType:   flag.entityType,
      entityId:     flag.entityId,
      eventType:    flag.type,
      title:        flag.title,
      message:      flag.body ?? flag.title,
      priority:     priority === "critical" ? "critical" : priority,
      metadata: {
        severity:    flag.severity,
        offer_id:    flag.offerId ?? null,
        document_id: flag.documentId ?? null,
      },
    })
    return { notified_count: recipients.length, recipient_user_ids: recipients }
  } catch (err: any) {
    console.error("[notify-helpers] notifyComplianceFlag multi-channel failed:", err?.message ?? err)
    return { notified_count: 0, recipient_user_ids: [] }
  }
}
