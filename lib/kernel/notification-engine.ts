// lib/kernel/notification-engine.ts
//
// LAYER 0 — kernel-level notification processing engine.
// Takes a KernelEvent, loads rules from the database, resolves recipients,
// and creates notifications.
//
// Kernel defines meaning. Database configures delivery.
//
// Rules:
// - This file ONLY reads notification_rules and writes notifications.
// - No side effects beyond those two tables.
// - resolveRecipients failures are caught by the processKernelEvent caller.
// - TypeScript strict mode throughout.

import { KernelEvent } from "./events"
import { createServiceClient } from "@/lib/supabase/service"

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export async function processKernelEvent(params: {
  event: KernelEvent
  brokerageId: string
  entityType: string
  entityId: string
  lifecycleEventId?: string
  complianceEventId?: string
  activityId?: string
  // Optional client-side context — forwarded to the reactor for portal + sequence fan-out.
  // Present when called via fanOutKernelEvent; absent for direct staff-notification callers.
  contactId?: string
  buyerContactId?: string
  sellerContactId?: string
  transactionId?: string
  listingId?: string
  agentUserId?: string
  metadata?: Record<string, unknown> | null
  /** Set by the sequence engine's own emits so its events don't re-trigger enrollment (feedback loop). */
  suppressEnrollment?: boolean
}): Promise<void> {

  const supabase = createServiceClient()

  // 1. Load rules from database.
  // Query uses trigger_event (string) which matches KernelEvent enum value exactly.
  const { data: rules, error } = await supabase
    .from("notification_rules")
    .select("*")
    .eq("brokerage_id", params.brokerageId)
    .eq("trigger_event", params.event)
    .eq("is_active", true)

  if (error) {
    console.error("[NotificationEngine] Error loading rules:", error)
    throw error
  }

  // Per-brokerage rules take precedence; otherwise fall back to sensible
  // defaults so notifications deliver out-of-the-box (no brokerage has seeded
  // notification_rules yet — without this, no event ever notifies anyone).
  const effectiveRules: Array<{ recipient_role: string }> =
    rules && rules.length > 0 ? rules : defaultRulesForEvent(params.event)

  // 2. Resolve recipients based on entity type and assignment.
  const recipients = await resolveRecipients(params)
  console.log(`[NotificationEngine] Resolved ${recipients.length} recipients`)

  // 3. For each rule, filter recipients by role and create notifications.
  for (const rule of effectiveRules) {
    const matchingRecipients = recipients.filter(r => r.role === rule.recipient_role)

    if (matchingRecipients.length === 0) {
      console.log(`[NotificationEngine] No recipients matched role ${rule.recipient_role}`)
      continue
    }

    for (const recipient of matchingRecipients) {
      try {
        // supabase-js RESOLVES a rejected write — an FK violation on
        // notifications.user_id comes back as `{ error }`, it does NOT throw. The
        // try/catch below therefore never fired, and the success line printed for
        // every row the database had refused. That is how the id-class defect
        // above stayed invisible: the log said "Created notification" while the
        // bell stayed empty. Destructure the error and say which of the two
        // actually happened.
        const { error: insertError } = await supabase.from("notifications").insert({
          user_id:     recipient.user_id,
          brokerage_id: params.brokerageId,
          type:        params.event,
          entity_type: params.entityType,
          entity_id:   params.entityId,
          title:       generateTitle(params.event),
          body:        generateBody(params.event, params.entityType),
          is_read:     false,
        })

        if (insertError) {
          // NOT rethrown, deliberately. processKernelEvent sits on the emit path
          // of every lifecycle action in the product; throwing here would turn a
          // failed bell into a failed offer/transaction write for the human who
          // triggered it. The notification is the echo, never the deal.
          console.error(
            `[NotificationEngine] notification NOT created for user ${recipient.user_id} (role ${recipient.role}, event ${params.event}): ${insertError.message}`,
          )
          continue
        }

        console.log(`[NotificationEngine] Created notification for user ${recipient.user_id}`)
      } catch (err) {
        console.error("[NotificationEngine] Error creating notification:", err)
      }
    }
  }

  // ─── AGENTIC REACTOR ──────────────────────────────────────────────────────────
  // Fan this SAME event into the kernel reactor so marketing/automation react in real time
  // (campaign enrollment), not just notify a human. Isolated in its own try/catch — a reactor
  // failure must never break the notification path above. The safety-net cron still sweeps
  // lifecycle_events, and the reactor's enrollment is cooldown-idempotent, so the two never
  // double-enroll. Side-effecting sends stay gated downstream in the channel adapters.
  try {
    const { dispatchKernelEvent } = await import("@/lib/kernel/event-reactor")
    await dispatchKernelEvent({
      event:           params.event,
      brokerageId:     params.brokerageId,
      entityType:      params.entityType,
      entityId:        params.entityId,
      metadata:        params.metadata ?? null,
      contactId:       params.contactId,
      buyerContactId:  params.buyerContactId,
      sellerContactId: params.sellerContactId,
      transactionId:   params.transactionId,
      listingId:       params.listingId,
      agentUserId:     params.agentUserId,
      suppressEnrollment: params.suppressEnrollment,
    })
  } catch (err) {
    console.error("[NotificationEngine] reactor dispatch failed:", err)
  }
}

// ─── RECIPIENT RESOLVER ───────────────────────────────────────────────────────
//
// TODO: Evolve to support deal_team_members and advanced routing.
//
// FUTURE: This resolver will expand to support:
// - deal_team_members table (contacts assigned to multi-agent deal teams)
// - All team members receive notifications: assigned_agent, team_lead, TC, lender, attorney, closing_attorney
// - ISA role routing (leads assigned to ISA queue)
// - Dynamic recipient resolution based on transaction stage and role
//
// For now: V0 implementation resolves single agent per contact.
// This foundation scales to deal_team_members without breaking changes.

// TODO: Cache optimization (Layer 13)
// Current: Queries all brokerage-level users on every event.
// Under high volume, consider:
// - In-memory cache (TTL-based, per-brokerage)
// - One-time fetch per event loop
// - Redis cache for distributed systems
//
// For now: Query-per-event is acceptable. Mark for optimization when volume testing shows need.

// ─── ID CLASS OF EVERY RECIPIENT RESOLUTION IN THIS FILE ─────────────────────
//
// `notifications.user_id` FKs `users(id)` (verified live against pg_constraint).
// Every value pushed into `recipients[].user_id` must therefore be a USERS id.
// The columns this resolver reads split into two disjoint classes:
//
//   AGENTS-class — FK `agents(id)`, MUST be resolved before use:
//     · contacts.agent_id      (contact / buyer / seller branch)
//     · transactions.agent_id  (transaction branch)
//     · listings.agent_id      (listing_stage_machine branch)
//   USERS-class — safe to push straight through:
//     · contacts.tc_user_id
//     · contacts.compliance_officer_id
//     · contacts.user_id       (the seller-channel lookup)
//     · users.id               (the brokerage-level pool)
//
// All three AGENTS-class columns were being written straight into
// `notifications.user_id`. The insert is FK-rejected — and supabase-js resolves
// a rejected write, so the engine logged a created notification for a row the
// database threw away. The assigned agent, on the three entity types where the
// assignment actually lives, had never received one of these notifications.
//
// The two classes are the same distance apart everywhere in this schema; see
// scripts/agent-fk-columns.ts for the authoritative snapshot and
// lib/kernel/agent-identity-resolver.ts for the ONE resolver. Nothing here
// invents a second one, and nothing `??`-falls-back across the boundary — a
// fallback would just write a different wrong id.
//
// The resolver is loaded at CALL TIME, the same way the reactor is dispatched
// below. It carries `import "server-only"`, and `lib/kernel/lifecycle.ts`
// imports this module statically — a static edge here would make the whole
// lifecycle chain unloadable outside a react-server condition and take
// scripts/transaction-parties-notify-simulator.ts down with it (verified: it
// did). Same idiom as lib/kernel/event-reactor.ts, which resolves this exact
// column the same way.
async function pushResolvedAgentRecipient(
  recipients: Array<{ user_id: string; role: string }>,
  agentRecordId: string | null | undefined,
  role: string,
  source: string,
): Promise<void> {
  if (!agentRecordId) return
  const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
  const userId = await resolveAgentRecordToUserId(agentRecordId)
  if (!userId) {
    // A resolve that yields nothing is a recipient we DO NOT HAVE. Saying so is
    // the whole point: the alternative is pushing the agents id and letting the
    // database refuse it out of sight.
    console.error(
      `[NotificationEngine] ${source}=${agentRecordId} is an agents.id with no users row — no '${role}' recipient resolved; nothing is sent to them.`,
    )
    return
  }
  recipients.push({ user_id: userId, role })
}

async function resolveRecipients(params: {
  event: KernelEvent
  brokerageId: string
  entityType: string
  entityId: string
}): Promise<Array<{ user_id: string; role: string }>> {

  const supabase = createServiceClient()
  const recipients: Array<{ user_id: string; role: string }> = []

  // V0: Agent assigned to contact.
  if (
    params.entityType === "contact" ||
    params.entityType === "buyer" ||
    params.entityType === "seller"
  ) {
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("agent_id, tc_user_id, compliance_officer_id")
      .eq("id", params.entityId)
      .single()

    // supabase-js resolves a refused read: without this, "the query was refused"
    // and "this contact has no agent" are the same silence.
    if (contactError) {
      console.error(`[NotificationEngine] contact ${params.entityId} lookup failed: ${contactError.message}`)
    }

    // AGENTS-class → resolved. Not a users id.
    await pushResolvedAgentRecipient(recipients, contact?.agent_id, "agent", "contacts.agent_id")
    // Per-contact Transaction Coordinator (not in the brokerage-level pool).
    // Role casing must match notification_rules.recipient_role CHECK ('TC').
    // USERS-class column (FK users(id)) — pushed straight through, correctly.
    if (contact?.tc_user_id) {
      recipients.push({ user_id: contact.tc_user_id, role: "TC" })
    }
    // Named compliance officer for this contact (in addition to brokerage-wide).
    // USERS-class column (FK users(id)) — pushed straight through, correctly.
    if (contact?.compliance_officer_id) {
      recipients.push({ user_id: contact.compliance_officer_id, role: "compliance_officer" })
    }
  }

  // Owning agent of the transaction (there is no separate assigned_tc_id column;
  // the responsible party is transactions.agent_id).
  if (params.entityType === "transaction") {
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select("agent_id")
      .eq("id", params.entityId)
      .single()

    if (transactionError) {
      console.error(`[NotificationEngine] transaction ${params.entityId} lookup failed: ${transactionError.message}`)
    }

    // AGENTS-class → resolved. This is the deal's responsible agent, and until
    // now every transaction notification addressed to them was FK-rejected.
    await pushResolvedAgentRecipient(recipients, transaction?.agent_id, "agent", "transactions.agent_id")
  }

  // Listing stage machine — resolve assigned agent + TC via listings table.
  // Metadata-aware routing: TC, seller channel, and escalation per event spec.
  if (params.entityType === "listing_stage_machine") {
    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("agent_id, brokerage_id")
      .eq("id", params.entityId)
      .single()

    if (listingError) {
      console.error(`[NotificationEngine] listing ${params.entityId} lookup failed: ${listingError.message}`)
    }

    // Agent always receives listing sub-event notifications.
    // AGENTS-class → resolved, the same way lib/kernel/event-reactor.ts already
    // resolves this exact column before using it as a users id.
    await pushResolvedAgentRecipient(recipients, listing?.agent_id, "agent", "listings.agent_id")

    // Seller channel — only if brokerage policy allows it
    // Read from brokerage_settings.seller_notification_policy
    if ([
      KernelEvent.LISTING_REPAIR_REQUIRED,
      KernelEvent.LISTING_REPAIR_COMPLETED,
      KernelEvent.LISTING_REPAIR_FAILED,
    ].includes(params.event)) {
      const { data: policy } = await supabase
        .from("global_settings")
        .select("seller_notification_enabled")
        .eq("brokerage_id", params.brokerageId)
        .maybeSingle()

      if (policy?.seller_notification_enabled) {
        // Resolve seller user_id via listing_agreements → contacts → user
        const { data: listingAgreement } = await supabase
          .from("listing_agreements")
          .select("seller_contact_id")
          .eq("listing_id", params.entityId)
          .maybeSingle()

        if (listingAgreement?.seller_contact_id) {
          const { data: contact } = await supabase
            .from("contacts")
            .select("user_id")
            .eq("id", listingAgreement.seller_contact_id)
            .maybeSingle()

          // USERS-class column (contacts.user_id FKs users(id)) — the seller's
          // login, not their contact row. Pushed straight through, correctly.
          if (contact?.user_id) {
            recipients.push({ user_id: contact.user_id, role: "seller" })
          }
        }
      }
    }
  }

  // Brokerage-level roles (always included).
  // USERS-class by construction — this reads users.id itself.
  // TODO: Cache optimization — this query runs on every event.
  const { data: brokerageUsers, error: brokerageUsersError } = await supabase
    .from("users")
    .select("id, user_type")
    .eq("brokerage_id", params.brokerageId)
    .in("user_type", ["admin", "broker", "compliance_officer", "team_lead"])

  if (brokerageUsersError) {
    console.error(`[NotificationEngine] brokerage ${params.brokerageId} recipient pool lookup failed: ${brokerageUsersError.message}`)
  }

  for (const user of brokerageUsers || []) {
    recipients.push({
      user_id: user.id,
      role: user.user_type,
    })
  }

  return recipients
}

// ─── DEFAULT NOTIFICATION RULES ───────────────────────────────────────────────
// Used when a brokerage has not configured notification_rules. Keeps the
// notification system functional out-of-the-box: the assigned agent is always
// notified; the per-contact TC on transaction/closing-cycle events; compliance
// officers on compliance events (they are also in the brokerage-level pool).
function defaultRulesForEvent(event: KernelEvent): Array<{ recipient_role: string }> {
  const e = String(event).toLowerCase()
  const roles = new Set<string>(["agent"])
  if (/(transaction|contract|closing|inspection|financing|appraisal|walkthrough|cd_|deal_closed|offer)/.test(e)) {
    roles.add("TC")
  }
  if (e.includes("compliance")) {
    roles.add("compliance_officer")
  }
  return Array.from(roles).map((recipient_role) => ({ recipient_role }))
}

// ─── TITLE / BODY GENERATORS ──────────────────────────────────────────────────

function generateTitle(event: KernelEvent): string {
  const titles: Partial<Record<KernelEvent, string>> = {
    [KernelEvent.CONTACT_CREATED]:    "New Contact Assigned",
    [KernelEvent.OFFER_RECEIVED]:     "New Offer Received",
    [KernelEvent.CONTRACT_SIGNED]:    "Contract Signed",
    [KernelEvent.DEAL_CLOSED]:        "Deal Closed",
    [KernelEvent.INSPECTION_DUE]:     "Inspection Due Soon",
    [KernelEvent.FINANCING_DUE]:      "Financing Contingency Due",
    [KernelEvent.APPRAISAL_DUE]:      "Appraisal Due",
    [KernelEvent.WALKTHROUGH_DUE]:    "Final Walkthrough Due",
    [KernelEvent.CD_DUE]:             "Closing Disclosure Due",
    [KernelEvent.CD_RECEIVED]:        "Closing Disclosure Received",
    [KernelEvent.CLOSING_SCHEDULED]:  "Closing Scheduled",
    [KernelEvent.TASK_ASSIGNED]:      "New Task Assigned",
    [KernelEvent.TASK_OVERDUE]:       "Task Overdue",
    [KernelEvent.COMPLIANCE_VIOLATION]: "Compliance Alert",
    [KernelEvent.MESSAGE_FROM_CONTACT]: "New Message from Contact",
    // ── Listing Stage Machine — Sub-Events ────────────────────────────────
    [KernelEvent.LISTING_MEDIA_SCHEDULED]:             "Media Capture Scheduled",
    [KernelEvent.LISTING_REPAIR_REQUIRED]:             "Pre-Listing Repair Required",
    [KernelEvent.LISTING_REPAIR_COMPLETED]:            "Pre-Listing Repair Completed",
    [KernelEvent.LISTING_REPAIR_FAILED]:               "Pre-Listing Repair Failed — Stage Blocked",
    [KernelEvent.LISTING_COMING_SOON_ASSETS_PREPARED]: "Coming Soon Assets Ready for Review",
    [KernelEvent.LISTING_DRIP_COMPLETED]:              "Seller Presentation Drip Complete",
    [KernelEvent.LISTING_MLS_SUBMITTED_TO_ADMIN]:      "Listing Submitted to Admin for MLS Activation",
    [KernelEvent.LISTING_OPEN_HOUSE_COMPLETED]:        "Open House Completed",
    [KernelEvent.LISTING_SHOWING_COMPLETED]:           "Showing Completed",
  }

  return titles[event] ?? event
}

function generateBody(event: KernelEvent, entityType: string): string {
  const bodies: Partial<Record<KernelEvent, string>> = {
    [KernelEvent.LISTING_MEDIA_SCHEDULED]:
      "Media capture has been scheduled. Approval may be required before publishing.",
    [KernelEvent.LISTING_REPAIR_REQUIRED]:
      "A pre-listing repair has been recorded and requires attention before going live.",
    [KernelEvent.LISTING_REPAIR_COMPLETED]:
      "A pre-listing repair has been marked complete. Review and advance the listing stage.",
    [KernelEvent.LISTING_REPAIR_FAILED]:
      "A pre-listing repair failed. The listing stage is blocked until resolved.",
    [KernelEvent.LISTING_COMING_SOON_ASSETS_PREPARED]:
      "Coming soon marketing assets are prepared and awaiting approval.",
    [KernelEvent.LISTING_DRIP_COMPLETED]:
      "Seller presentation drip sequence is complete. Seller is ready for a decision.",
    [KernelEvent.LISTING_MLS_SUBMITTED_TO_ADMIN]:
      "Listing has been submitted to admin for MLS activation review.",
    [KernelEvent.LISTING_OPEN_HOUSE_COMPLETED]:
      "Open house event has been completed. Review attendee notes and follow up.",
    [KernelEvent.LISTING_SHOWING_COMPLETED]:
      "A showing has been completed. Feedback token created — follow up with buyer's agent.",
  }
  return bodies[event] ?? `${entityType}: ${event}`
}
