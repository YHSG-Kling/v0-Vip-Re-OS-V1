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

  if (!rules || rules.length === 0) {
    console.log(`[NotificationEngine] No active rules for event: ${params.event}`)
    return
  }

  console.log(`[NotificationEngine] Found ${rules.length} rules for ${params.event}`)

  // 2. Resolve recipients based on entity type and assignment.
  const recipients = await resolveRecipients(params)
  console.log(`[NotificationEngine] Resolved ${recipients.length} recipients`)

  // 3. For each rule, filter recipients by role and create notifications.
  for (const rule of rules) {
    const matchingRecipients = recipients.filter(r => r.role === rule.recipient_role)

    if (matchingRecipients.length === 0) {
      console.log(`[NotificationEngine] No recipients matched role ${rule.recipient_role}`)
      continue
    }

    for (const recipient of matchingRecipients) {
      try {
        await supabase.from("notifications").insert({
          user_id:     recipient.user_id,
          brokerage_id: params.brokerageId,
          type:        params.event,
          entity_type: params.entityType,
          entity_id:   params.entityId,
          title:       generateTitle(params.event),
          body:        generateBody(params.event, params.entityType),
          is_read:     false,
        })

        console.log(`[NotificationEngine] Created notification for user ${recipient.user_id}`)
      } catch (err) {
        console.error("[NotificationEngine] Error creating notification:", err)
      }
    }
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
    const { data: contact } = await supabase
      .from("contacts")
      .select("assigned_agent_id")
      .eq("id", params.entityId)
      .single()

    if (contact?.assigned_agent_id) {
      recipients.push({
        user_id: contact.assigned_agent_id,
        role: "agent",
      })
    }
  }

  // TC assigned to transaction.
  if (params.entityType === "transaction") {
    const { data: transaction } = await supabase
      .from("transactions")
      .select("assigned_tc_id")
      .eq("id", params.entityId)
      .single()

    if (transaction?.assigned_tc_id) {
      recipients.push({
        user_id: transaction.assigned_tc_id,
        role: "TC",
      })
    }
  }

  // Listing stage machine — resolve assigned agent + TC via listings table.
  // Metadata-aware routing: TC, seller channel, and escalation per event spec.
  if (params.entityType === "listing_stage_machine") {
    const { data: listing } = await supabase
      .from("listings")
      .select("assigned_agent_id, assigned_tc_id, brokerage_id")
      .eq("id", params.entityId)
      .single()

    // Agent always receives listing sub-event notifications
    if (listing?.assigned_agent_id) {
      recipients.push({ user_id: listing.assigned_agent_id, role: "agent" })
    }

    // TC routing — required for repair events and admin submission
    const tcEvents: KernelEvent[] = [
      KernelEvent.LISTING_REPAIR_REQUIRED,
      KernelEvent.LISTING_REPAIR_COMPLETED,
      KernelEvent.LISTING_REPAIR_FAILED,
      KernelEvent.LISTING_MLS_SUBMITTED_TO_ADMIN,
    ]
    if (listing?.assigned_tc_id && tcEvents.includes(params.event)) {
      recipients.push({ user_id: listing.assigned_tc_id, role: "TC" })
    }

    // Seller channel — only if brokerage policy allows it
    // Read from brokerage_settings.seller_notification_policy
    if ([
      KernelEvent.LISTING_REPAIR_REQUIRED,
      KernelEvent.LISTING_REPAIR_COMPLETED,
      KernelEvent.LISTING_REPAIR_FAILED,
    ].includes(params.event)) {
      const { data: policy } = await supabase
        .from("brokerage_settings")
        .select("seller_notification_enabled")
        .eq("brokerage_id", params.brokerageId)
        .maybeSingle()

      if (policy?.seller_notification_enabled) {
        // Resolve seller user_id via listing → contacts → user
        const { data: listingContact } = await supabase
          .from("listing_contacts")
          .select("contact_id")
          .eq("listing_id", params.entityId)
          .eq("role", "seller")
          .maybeSingle()

        if (listingContact?.contact_id) {
          const { data: contact } = await supabase
            .from("contacts")
            .select("user_id")
            .eq("id", listingContact.contact_id)
            .maybeSingle()

          if (contact?.user_id) {
            recipients.push({ user_id: contact.user_id, role: "seller" })
          }
        }
      }
    }
  }

  // Brokerage-level roles (always included).
  // TODO: Cache optimization — this query runs on every event.
  const { data: brokerageUsers } = await supabase
    .from("users")
    .select("id, user_type")
    .eq("brokerage_id", params.brokerageId)
    .in("user_type", ["admin", "broker", "compliance_officer", "team_lead"])

  for (const user of brokerageUsers || []) {
    recipients.push({
      user_id: user.id,
      role: user.user_type,
    })
  }

  return recipients
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
