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
import { resolveAgentRecordToUserId } from "@/lib/kernel/agent-identity-resolver"
import {
  composeClientMessage,
  composeCounterpartyMessage,
  composeStaffMessage,
  composeSubject,
  displayContingencies,
  isPrincipalRole,
  toHtml,
  PARTIES_EMAILED_ACTIVITY_TYPE,
  PARTIES_NOTIFIED_ACTIVITY_TYPE,
  PARTIES_NOTIFIED_NOTIFICATION_TYPE,
  type PartiesPacket,
  type PartyContact,
  type TransactionTerms,
  type ViewerRole,
} from "./transaction-parties-packet"

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

// ─── notifyTransactionParties ───────────────────────────────────────────────
//
// OWNER RULING (wave 10): "once the transaction is created, the terms/dates need
// to be saved to the transaction and all parties of the transaction notified of
// such info, dates, contingencies, parties contact info etc."
//
// The SAVE half lives in lib/transactions/offer-bridge.ts. This is the NOTIFY
// half, which did not exist: before this, a transaction was born with real
// terms and nobody was told. It runs on the ONE chokepoint every accept flow
// shares (the offer→deal bridge, after participants are populated).
//
// WHO — resolved from source-of-truth rows, never guessed:
//   · the deal's agent          transactions.agent_id  (AGENTS id → users.id)
//   · the listing agent         listings.agent_id      (AGENTS id → users.id)
//   · the deal's coordinator    transactions.coordinator_id + transaction_assignments
//                               → transaction_coordinators.user_id (USERS id)
//   · the brokerage TC bench    users.user_type ∈ rawRoleVariantsFor(['tc'])
//                               (same resolution notifyComplianceFlag uses — the
//                                'TC' vs 'tc' bug is fixed once, in one place)
//   · our represented clients   transactions.buyer_contact_id / seller_contact_id
//   · outside professionals     transaction_participants rows with an email that
//                               are NOT one of the users we just notified
//
// agents.id / users.id / contacts.id are DISJOINT. Every hop resolves; nothing
// is `??`-ed across id spaces. (transactions.agent_id FKs agents(id) — live
// verified — which is exactly why the kernel notification engine's
// resolveRecipients, which stamps it straight into notifications.user_id (a
// users FK), has never delivered a transaction-entity notification.)
//
// WHAT — see lib/notifications/transaction-parties-packet.ts for the audience
// boundary. Staff get the full roster; a principal gets the professionals plus
// their own row and NEVER the counterparty's details; an outside professional
// gets the professional roster only. The outside BUYER/SELLER is deliberately
// NOT contacted: they are represented by another brokerage, and going around
// their agent is both an ethics violation and a consent we do not hold. They
// are reported in `skipped_outside_principals`, never silently dropped.
//
// HONESTY — every write destructures its error. A fan-out that reached zero
// recipients returns sent:false with a reason; it never reports success. The
// idempotency marker is written ONLY when something was actually delivered, so
// a retry after a total failure can still notify.

export interface NotifyTransactionPartiesInput {
  transactionId: string
  brokerageId:   string
}

export interface NotifyTransactionPartiesResult {
  /** True only when at least one recipient was actually reached. */
  sent:                        boolean
  /** True when a prior successful fan-out already notified this transaction. */
  already_notified:            boolean
  staff_user_ids:              string[]
  contact_ids:                 string[]
  emailed:                     Array<{ role: string; email: string }>
  /** Outside principals we must not contact directly, with the reason. */
  skipped_outside_principals:  Array<{ role: string; reason: string }>
  /** Everything that went wrong — never swallowed, never mistaken for success. */
  errors:                      string[]
}

const OUTSIDE_PRINCIPAL_SKIP_REASON =
  "represented by another brokerage — their own agent notifies them; direct contact would bypass their representation"

export async function notifyTransactionParties(
  supabase: SupabaseClient,
  input: NotifyTransactionPartiesInput,
): Promise<NotifyTransactionPartiesResult> {
  const { transactionId, brokerageId } = input
  const result: NotifyTransactionPartiesResult = {
    sent: false,
    already_notified: false,
    staff_user_ids: [],
    contact_ids: [],
    emailed: [],
    skipped_outside_principals: [],
    errors: [],
  }

  // ── 1. Idempotency gate. A transaction created once must not notify twice if
  //       the path is retried. FAIL CLOSED: a refused read is not "no marker".
  const { data: marker, error: markerError } = await supabase
    .from("activities")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("transaction_id", transactionId)
    .eq("activity_type", PARTIES_NOTIFIED_ACTIVITY_TYPE)
    .limit(1)
    .maybeSingle()
  if (markerError) {
    result.errors.push(`idempotency check failed (${markerError.message}) — refusing to fan out`)
    return result
  }
  if (marker) {
    result.already_notified = true
    return result
  }

  // ── 2. The deal itself.
  const { data: txn, error: txnError } = await supabase
    .from("transactions")
    .select(
      "id, brokerage_id, agent_id, coordinator_id, listing_id, offer_id, deal_name, property_address, " +
      "purchase_price, earnest_money, contract_date, close_date, inspection_deadline, appraisal_deadline, " +
      "financing_deadline, buyer_contact_id, seller_contact_id",
    )
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (txnError) {
    result.errors.push(`transaction load failed: ${txnError.message}`)
    return result
  }
  if (!txn) {
    result.errors.push("transaction not found in this brokerage")
    return result
  }
  const t = txn as Record<string, any>

  // ── 3. Contract facts that live on the offer (contingencies + the earnest
  //       DUE DATE, which has no transactions column and is carried as a
  //       milestone). Both are read, never invented.
  let contingencies: string[] = []
  let earnestDueFromOffer: string | null = null
  if (t.offer_id) {
    const { data: offer, error: offerError } = await supabase
      .from("offers")
      .select("contingencies, earnest_money_due_at")
      .eq("id", t.offer_id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (offerError) result.errors.push(`offer terms load failed: ${offerError.message}`)
    contingencies = displayContingencies((offer as any)?.contingencies)
    earnestDueFromOffer = ((offer as any)?.earnest_money_due_at as string | null) ?? null
  }

  const { data: emMilestone, error: emError } = await supabase
    .from("transaction_milestones")
    .select("target_date")
    .eq("brokerage_id", brokerageId)
    .eq("transaction_id", transactionId)
    .eq("milestone_type", "earnest_money_due")
    .limit(1)
    .maybeSingle()
  if (emError) result.errors.push(`earnest-money milestone load failed: ${emError.message}`)

  // ── 4. The roster (written by participant-populator at creation time).
  const { data: participantRows, error: participantError } = await supabase
    .from("transaction_participants")
    .select("role, name, company, email, phone, license_number")
    .eq("brokerage_id", brokerageId)
    .eq("transaction_id", transactionId)
  if (participantError) result.errors.push(`participant roster load failed: ${participantError.message}`)
  const parties: PartyContact[] = ((participantRows ?? []) as any[]).map(p => ({
    role:           String(p.role ?? "party"),
    name:           String(p.name ?? ""),
    company:        p.company ?? null,
    email:          p.email ?? null,
    phone:          p.phone ?? null,
    license_number: p.license_number ?? null,
  }))

  const terms: TransactionTerms = {
    dealName:           t.deal_name ?? null,
    propertyAddress:    t.property_address ?? null,
    purchasePrice:      t.purchase_price != null ? Number(t.purchase_price) : null,
    earnestMoney:       t.earnest_money != null ? Number(t.earnest_money) : null,
    earnestMoneyDue:    ((emMilestone as any)?.target_date as string | null)
      ?? (earnestDueFromOffer ? String(earnestDueFromOffer).slice(0, 10) : null),
    contractDate:       t.contract_date ?? null,
    closingDate:        t.close_date ?? null,
    inspectionDeadline: t.inspection_deadline ?? null,
    appraisalDeadline:  t.appraisal_deadline ?? null,
    financingDeadline:  t.financing_deadline ?? null,
    contingencies,
    titleCompany:       parties.find(p => p.role === "title_company")?.company
      ?? parties.find(p => p.role === "title_company")?.name
      ?? null,
  }
  const packet: PartiesPacket = { terms, parties }
  const subject = composeSubject(terms)

  // ── 5. STAFF recipients (users.id), each resolved across its own id space.
  const staff = new Set<string>()

  let listingAgentRecordId: string | null = null
  if (t.listing_id) {
    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("agent_id")
      .eq("id", t.listing_id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (listingError) result.errors.push(`listing agent load failed: ${listingError.message}`)
    listingAgentRecordId = ((listing as any)?.agent_id as string | null) ?? null
  }

  for (const agentRecordId of [t.agent_id as string | null, listingAgentRecordId]) {
    if (!agentRecordId) continue
    const userId = await resolveAgentRecordToUserId(agentRecordId)
    if (userId) staff.add(userId)
    else result.errors.push(`agents.id=${agentRecordId} has no users row — that agent was not notified`)
  }

  // Per-deal coordinator(s): the column AND the assignment junction (both are
  // written by different surfaces; reading one only is how a TC misses a deal).
  const coordinatorIds = new Set<string>()
  if (t.coordinator_id) coordinatorIds.add(t.coordinator_id as string)
  const { data: assignments, error: assignmentError } = await supabase
    .from("transaction_assignments")
    .select("coordinator_id")
    .eq("brokerage_id", brokerageId)
    .eq("transaction_id", transactionId)
  if (assignmentError) result.errors.push(`coordinator assignment load failed: ${assignmentError.message}`)
  for (const a of (assignments ?? []) as any[]) if (a.coordinator_id) coordinatorIds.add(a.coordinator_id)
  if (coordinatorIds.size > 0) {
    const { data: coordinators, error: coordinatorError } = await supabase
      .from("transaction_coordinators")
      .select("id, user_id")
      .eq("brokerage_id", brokerageId)
      .in("id", Array.from(coordinatorIds))
    if (coordinatorError) result.errors.push(`coordinator resolution failed: ${coordinatorError.message}`)
    for (const c of (coordinators ?? []) as any[]) if (c.user_id) staff.add(c.user_id as string)
  }

  // The brokerage TC bench — same role-vocabulary resolution notifyComplianceFlag
  // uses, so 'tc' vs 'TC' can never drift apart again.
  const tcRoles: CanonicalRole[] = ["tc"]
  const { data: tcUsers, error: tcError } = await supabase
    .from("users")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .in("user_type", rawRoleVariantsFor(tcRoles))
  if (tcError) result.errors.push(`TC roster lookup failed: ${tcError.message}`)
  for (const u of (tcUsers ?? []) as any[]) if (u.id) staff.add(u.id as string)

  // ── 6. Staff in-app fan-out (per-recipient idempotent).
  const staffIds = Array.from(staff)
  if (staffIds.length > 0) {
    const { data: existing, error: existingError } = await supabase
      .from("notifications")
      .select("user_id")
      .eq("brokerage_id", brokerageId)
      .eq("type", PARTIES_NOTIFIED_NOTIFICATION_TYPE)
      .eq("entity_id", transactionId)
      .in("user_id", staffIds)
    if (existingError) result.errors.push(`duplicate-notification check failed: ${existingError.message}`)
    const already = new Set(((existing ?? []) as any[]).map(r => r.user_id as string))
    const targets = staffIds.filter(id => !already.has(id))
    if (targets.length > 0) {
      const staffBody = composeStaffMessage(packet)
      const { error: insertError } = await supabase.from("notifications").insert(
        targets.map(uid => ({
          user_id:      uid,
          brokerage_id: brokerageId,
          type:         PARTIES_NOTIFIED_NOTIFICATION_TYPE,
          title:        subject,
          body:         staffBody,
          entity_type:  "transaction",
          entity_id:    transactionId,
          priority:     "high",
          channel:      "in_app",
          is_read:      false,
        })),
      )
      if (insertError) result.errors.push(`staff notification insert failed: ${insertError.message}`)
      else result.staff_user_ids = targets
    }
  } else {
    result.errors.push("no staff recipient resolved (no deal agent, listing agent, coordinator or TC)")
  }

  // ── 7. Our represented clients — portal card + portal bell. Both sides only
  //       when both are ours; an outside principal has no contact FK here.
  const clientTargets: Array<{ contactId: string; viewer: ViewerRole }> = []
  if (t.buyer_contact_id)  clientTargets.push({ contactId: t.buyer_contact_id as string,  viewer: "buyer" })
  if (t.seller_contact_id && t.seller_contact_id !== t.buyer_contact_id) {
    clientTargets.push({ contactId: t.seller_contact_id as string, viewer: "seller" })
  }

  for (const target of clientTargets) {
    const body = composeClientMessage(packet, target.viewer)

    // Portal card. The DEPLOYED unique index (contact_id, update_type,
    // md5(title), minute) is the atomic backstop — a 23505 here means the card
    // is already on the portal, which is success, not failure.
    const { error: cardError } = await supabase.from("transparency_updates").insert({
      brokerage_id:           brokerageId,
      contact_id:             target.contactId,
      transaction_id:         transactionId,
      listing_id:             t.listing_id ?? null,
      agent_id:               t.agent_id ?? null,          // AGENTS id — matches the column's FK
      title:                  subject,
      plain_language_summary: body,
      message:                body,
      next_step:              terms.earnestMoneyDue
        ? `Earnest money due ${terms.earnestMoneyDue}.`
        : "Your agent will confirm the earnest-money deadline.",
      next_step_date:         terms.earnestMoneyDue ?? null,
      update_type:            PARTIES_NOTIFIED_NOTIFICATION_TYPE,
      responsible_party:      "agent",
      is_visible_to_client:   true,
      metadata:               { transaction_id: transactionId, audience: target.viewer },
      created_at:             new Date().toISOString(),
    })
    const cardDuplicate = (cardError as any)?.code === "23505"
    if (cardError && !cardDuplicate) {
      result.errors.push(`portal card insert failed for contact ${target.contactId}: ${cardError.message}`)
    }

    // Portal bell.
    const { data: bellDupe, error: bellDupeError } = await supabase
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", target.contactId)
      .eq("type", PARTIES_NOTIFIED_NOTIFICATION_TYPE)
      .eq("entity_id", transactionId)
      .limit(1)
      .maybeSingle()
    if (bellDupeError) result.errors.push(`client bell dedupe check failed: ${bellDupeError.message}`)
    let bellOk = !!bellDupe
    if (!bellDupe) {
      const { error: bellError } = await supabase.from("notifications").insert({
        contact_id:   target.contactId,
        brokerage_id: brokerageId,
        type:         PARTIES_NOTIFIED_NOTIFICATION_TYPE,
        title:        subject,
        body,
        entity_type:  "transaction",
        entity_id:    transactionId,
        priority:     "high",
        channel:      "in_app",
        is_read:      false,
      })
      if (bellError) result.errors.push(`client bell insert failed for contact ${target.contactId}: ${bellError.message}`)
      else bellOk = true
    }

    if (bellOk || !cardError || cardDuplicate) result.contact_ids.push(target.contactId)
  }

  // ── 8. Outside professionals on the file — B2B-transactional email through
  //       THE gate (lib/providers/dispatch.ts), which enforces suppression /
  //       consent / de-confliction. Outside PRINCIPALS are never emailed.
  const staffEmails = new Set<string>()
  if (staffIds.length > 0) {
    const { data: staffRows, error: staffEmailError } = await supabase
      .from("users")
      .select("email")
      .eq("brokerage_id", brokerageId)
      .in("id", staffIds)
    if (staffEmailError) result.errors.push(`staff email lookup failed: ${staffEmailError.message}`)
    for (const u of (staffRows ?? []) as any[]) if (u.email) staffEmails.add(String(u.email).toLowerCase())
  }

  // Which principals on the roster are OURS? Resolved by contact id → email, so
  // a roster row belonging to a client we already reached on the portal is not
  // mistaken for an outside party (and vice-versa).
  const ourClientEmails = new Set<string>()
  if (clientTargets.length > 0) {
    const { data: clientRows, error: clientEmailError } = await supabase
      .from("contacts")
      .select("email")
      .eq("brokerage_id", brokerageId)
      .in("id", clientTargets.map(c => c.contactId))
    if (clientEmailError) result.errors.push(`client email lookup failed: ${clientEmailError.message}`)
    for (const c of (clientRows ?? []) as any[]) if (c.email) ourClientEmails.add(String(c.email).toLowerCase())
  }

  const counterpartyBody = composeCounterpartyMessage(packet)
  const seenEmails = new Set<string>()
  for (const party of parties) {
    const email = party.email?.trim().toLowerCase()
    if (isPrincipalRole(party.role)) {
      // Our OWN principals were reached on the portal above. Anyone else's
      // principal is off-limits — recorded with the reason, never silently dropped.
      if (email && !ourClientEmails.has(email) && !staffEmails.has(email)) {
        result.skipped_outside_principals.push({ role: party.role, reason: OUTSIDE_PRINCIPAL_SKIP_REASON })
      }
      continue
    }
    if (!email) continue
    if (staffEmails.has(email)) continue      // already reached in-app
    if (seenEmails.has(email)) continue
    seenEmails.add(email)

    // Resolve the address to one of our contacts when we have one, so the
    // dispatch gate can apply that contact's suppression + consent state.
    const { data: contactRow, error: contactLookupError } = await supabase
      .from("contacts")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .ilike("email", email)
      .limit(1)
      .maybeSingle()
    if (contactLookupError) result.errors.push(`contact lookup for ${email} failed: ${contactLookupError.message}`)

    // Per-recipient idempotency for the OUTBOUND leg. The staff and client legs
    // dedupe on their own rows; email has none, so each successful send is
    // recorded on the deal's activity trail and re-checked here. Without this, a
    // retry that crashed between the send and the marker would email the
    // cooperating agent twice. FAIL CLOSED — a refused read skips the send
    // rather than risk a duplicate.
    const { data: alreadyEmailed, error: emailDupeError } = await supabase
      .from("activities")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("transaction_id", transactionId)
      .eq("activity_type", PARTIES_EMAILED_ACTIVITY_TYPE)
      .ilike("notes", `%${email}%`)
      .limit(1)
      .maybeSingle()
    if (emailDupeError) {
      result.errors.push(`outbound dedupe check for ${email} failed (${emailDupeError.message}) — send skipped`)
      continue
    }
    if (alreadyEmailed) continue

    try {
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      const sendResult = await dispatchEmail({
        brokerageId,
        contactId:      ((contactRow as any)?.id as string | undefined) ?? undefined,
        to:             party.email!,
        subject,
        html:           toHtml(counterpartyBody),
        text:           counterpartyBody,
        channelPurpose: "transactional",
        systemSource:   "transaction_parties_notice",
        metadata:       { transaction_id: transactionId, participant_role: party.role },
      })
      if (sendResult?.success) {
        result.emailed.push({ role: party.role, email: party.email! })
        // Record the send so a retry cannot repeat it. 'sent' only ever means
        // the gate accepted it — a blocked/suppressed send lands in errors above.
        const { error: sendLogError } = await supabase.from("activities").insert({
          brokerage_id:   brokerageId,
          transaction_id: transactionId,
          agent_id:       t.agent_id ?? null,
          entity_type:    "transaction",
          entity_id:      transactionId,
          activity_type:  PARTIES_EMAILED_ACTIVITY_TYPE,
          title:          `Contract terms sent to the ${party.role}`,
          description:    `Terms, dates, contingencies and the professional roster sent to ${party.name}.`,
          notes:          JSON.stringify({ role: party.role, email }),
          status:         "completed",
          completed_at:   new Date().toISOString(),
          channel:        "email",
          created_at:     new Date().toISOString(),
        })
        if (sendLogError) {
          result.errors.push(`outbound audit row for ${email} failed: ${sendLogError.message} — a retry may email twice`)
        }
      } else {
        result.errors.push(`email to ${party.role} <${email}> not sent: ${sendResult?.error ?? "unknown"}`)
      }
    } catch (err: any) {
      result.errors.push(`email to ${party.role} <${email}> threw: ${err?.message ?? err}`)
    }
  }

  // ── 9. Verdict. Zero recipients is NOT success.
  result.sent =
    result.staff_user_ids.length > 0 ||
    result.contact_ids.length > 0 ||
    result.emailed.length > 0

  if (!result.sent) {
    if (result.errors.length === 0) result.errors.push("no recipient could be resolved for this transaction")
    console.error(
      `[notify-helpers] notifyTransactionParties reached ZERO recipients for transaction=${transactionId}:`,
      result.errors.join(" | "),
    )
    return result
  }

  // ── 10. Marker — written only after real delivery, so a retry after a total
  //        failure can still notify. agent_id is the AGENTS id the column FKs.
  const { error: activityError } = await supabase.from("activities").insert({
    brokerage_id:   brokerageId,
    transaction_id: transactionId,
    agent_id:       t.agent_id ?? null,
    entity_type:    "transaction",
    entity_id:      transactionId,
    activity_type:  PARTIES_NOTIFIED_ACTIVITY_TYPE,
    title:          "Parties notified of contract terms and dates",
    description:    `${result.staff_user_ids.length} staff, ${result.contact_ids.length} client portal(s), ${result.emailed.length} outside professional(s) notified of the terms, dates, contingencies and party contact details.`,
    status:         "completed",
    completed_at:   new Date().toISOString(),
    channel:        "in_app",
    metadata: {
      staff_user_ids:             result.staff_user_ids,
      contact_ids:                result.contact_ids,
      emailed:                    result.emailed,
      skipped_outside_principals: result.skipped_outside_principals,
      errors:                     result.errors,
    },
    created_at:     new Date().toISOString(),
  })
  if (activityError) {
    result.errors.push(`notification marker insert failed: ${activityError.message} — a retry may notify twice`)
  }

  return result
}
