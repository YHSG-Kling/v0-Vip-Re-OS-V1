/**
 * lib/kernel/event-fanout.ts
 *
 * Single canonical "what happens when a kernel event fires" router. Three
 * fan-out channels per event:
 *
 *   1. Internal notifications (existing processKernelEvent — staff bell)
 *   2. Campaign sequence auto-enrollment (campaign_sequences.trigger_event)
 *   3. Client-facing portal updates (transparency_updates +
 *      client_portal_messages + contact-targeted notifications)
 *
 * The contact is the center: every meaningful state change should reach
 * their portal so seller/buyer/lifetime always know where their deal stands.
 *
 * Why this layer:
 *   - processKernelEvent is intentionally narrow (notifications only).
 *   - Adding portal/sequence logic into every emitter at every call site
 *     created drift; fan-out lives here so additions to one channel benefit
 *     every event uniformly.
 *
 * Event emitters call fanOutKernelEvent(...) instead of processKernelEvent
 * directly. This wrapper invokes processKernelEvent for staff notifications
 * AND fires the two new channels.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"

export interface KernelEventContext {
  event:          KernelEvent
  brokerageId:    string
  /** Entity the event is about — used by processKernelEvent for recipient
   *  resolution. Typically 'transaction' / 'listing' / 'contact' / 'offer'. */
  entityType:     string
  entityId:       string
  /** Contact-side links — used to fan out portal updates + sequence enrollment.
   *  Pass at least one when the event has a client-facing meaning. */
  contactId?:     string
  /** Both buyer + seller for events that affect both sides of a deal. */
  buyerContactId?:  string
  sellerContactId?: string
  /** Related entities (used in update templates + downstream sequence
   *  trigger conditions). */
  transactionId?: string
  listingId?:     string
  /** Who performed the action (auth.users.id). */
  agentUserId?:   string
  /** Free-form per-event context the templates and sequences can read. */
  metadata?:      Record<string, any>
  /** Lifecycle event id for cross-linking (already inserted by caller). */
  lifecycleEventId?: string
}

export async function fanOutKernelEvent(ctx: KernelEventContext): Promise<void> {
  // 1. Internal staff notifications (existing — leave behaviour unchanged).
  try {
    await processKernelEvent({
      event:             ctx.event,
      brokerageId:       ctx.brokerageId,
      entityType:        ctx.entityType,
      entityId:          ctx.entityId,
      lifecycleEventId:  ctx.lifecycleEventId,
    })
  } catch (e) {
    console.error("[fanOutKernelEvent] processKernelEvent failed", e)
  }

  // Both client-side fan-outs need at least one contact id.
  const contactIds = uniq([ctx.contactId, ctx.buyerContactId, ctx.sellerContactId].filter(Boolean) as string[])

  // 2. Auto-enroll matching campaign sequences for the contact(s).
  if (contactIds.length > 0) {
    try {
      await enrollMatchingSequences(ctx.event, ctx.brokerageId, contactIds, ctx.agentUserId)
    } catch (e) {
      console.error("[fanOutKernelEvent] sequence enrollment failed", e)
    }
  }

  // 3. Portal update for client(s) — transparency_updates + portal message
  //    + contact-targeted notification.
  if (contactIds.length > 0) {
    try {
      await writePortalUpdate(ctx, contactIds)
    } catch (e) {
      console.error("[fanOutKernelEvent] portal update failed", e)
    }
  }
}

// ─── 2. Sequence auto-enrollment ─────────────────────────────────────────────

async function enrollMatchingSequences(
  event:        KernelEvent,
  brokerageId:  string,
  contactIds:   string[],
  enrolledBy?:  string,
): Promise<void> {
  const supabase = createServiceClient()

  const { data: sequences } = await supabase
    .from("campaign_sequences")
    .select("id, sequence_type, name")
    .eq("brokerage_id", brokerageId)
    .eq("trigger_event", event)
    .eq("is_active", true)

  if (!sequences || sequences.length === 0) return

  for (const seq of sequences) {
    for (const contactId of contactIds) {
      // Idempotency — skip if this contact already has an active enrollment
      // in this sequence (avoid double-enroll if event fires twice).
      const { data: existing } = await supabase
        .from("sequence_enrollments")
        .select("id")
        .eq("sequence_id", seq.id)
        .eq("contact_id", contactId)
        .eq("status", "active")
        .maybeSingle()
      if (existing) continue

      // Schedule the first step at next_step_at = now (worker picks it up
      // immediately; subsequent steps are scheduled by the worker using
      // delay_days/delay_hours from campaign_sequence_steps).
      await supabase.from("sequence_enrollments").insert({
        sequence_id:  seq.id,
        contact_id:   contactId,
        brokerage_id: brokerageId,
        enrolled_by:  enrolledBy ?? null,
        current_step: 0,
        status:       "active",
        enrolled_at:  new Date().toISOString(),
        next_step_at: new Date().toISOString(),
      }).then(() => null, () => null)

      // Bump the sequence's enrollments_total counter (best-effort).
      await supabase.rpc("increment_sequence_enrollments", { p_sequence_id: seq.id })
        .then(() => null, () => null)
    }
  }
}

// ─── 3. Portal update writer ─────────────────────────────────────────────────

interface PortalUpdateTemplate {
  title:                  string
  plainLanguageSummary:   string
  stage?:                 string
  responsibleParty?:      "agent" | "client" | "lender" | "title" | "inspector" | "appraiser"
  responsiblePartyName?:  string
  nextStep?:              string
  /** Optional companion chat message for client_portal_messages — use when
   *  the update warrants a conversational ping in addition to the milestone
   *  card. Keep short (one sentence). */
  chatBody?:              string
  /** Buyer-side milestones often differ from seller-side for the same
   *  underlying event. When set, applied per-contact role. */
  perRole?:               Partial<Record<"buyer" | "seller" | "lifetime", Partial<PortalUpdateTemplate>>>
}

const PORTAL_UPDATE_TEMPLATES: Partial<Record<KernelEvent, PortalUpdateTemplate>> = {
  [KernelEvent.OFFER_ACCEPTED]: {
    title: "You're under contract!",
    plainLanguageSummary:
      "The offer was accepted. The deal is now in the due-diligence phase — inspection, appraisal, and financing are next.",
    responsibleParty: "agent",
    nextStep: "Earnest money due, inspection scheduled.",
    chatBody: "Great news — your offer was accepted! I'll send the next steps shortly.",
    perRole: {
      seller: {
        title: "Your home is under contract!",
        plainLanguageSummary:
          "An offer was accepted on your home. Next we move into the buyer's due-diligence period — inspection, appraisal, financing.",
        chatBody: "Congrats — your home is under contract! I'll keep you posted as the buyer completes their due diligence.",
      },
    },
  },
  [KernelEvent.LISTING_CREATED]: {
    title: "Your listing is being prepared",
    plainLanguageSummary:
      "Your listing record was created. We'll coordinate photography, marketing, and the go-live date.",
    responsibleParty: "agent",
    nextStep: "Photography + marketing prep.",
    chatBody: "Your listing is in motion — I'll keep you posted as we book photos and prep the launch.",
  },
  [KernelEvent.COMING_SOON_SENT]: {
    title: "Coming Soon campaign launched",
    plainLanguageSummary:
      "Your home is being marketed as 'Coming Soon' before going active on the MLS. Early interest is being captured.",
    responsibleParty: "agent",
    chatBody: "Coming Soon marketing is live — I'll let you know as buyer interest comes in.",
  },
  [KernelEvent.OPEN_HOUSE_SCHEDULED]: {
    title: "Open house scheduled",
    plainLanguageSummary: "An open house has been scheduled. We'll share attendee count + feedback after.",
    responsibleParty: "agent",
    chatBody: "Open house is on the calendar — I'll share who came through afterward.",
  },
  [KernelEvent.SHOWING_FEEDBACK_RECEIVED]: {
    title: "Showing feedback received",
    plainLanguageSummary: "A buyer's agent shared feedback after a recent showing.",
    responsibleParty: "agent",
  },
  [KernelEvent.OFFER_SUBMITTED]: {
    title: "Offer submitted",
    plainLanguageSummary:
      "Your offer was sent to the seller's agent. Most sellers respond within 24-48 hours.",
    responsibleParty: "client",
    perRole: {
      seller: {
        title: "New offer received",
        plainLanguageSummary: "An offer came in on your home. Your agent will walk you through the details.",
        chatBody: "An offer just came in on your home — let me know when you have time to review.",
      },
    },
  },
  [KernelEvent.OFFER_REJECTED]: {
    title: "Offer not accepted",
    plainLanguageSummary:
      "The seller did not accept this offer. Your agent will reach out to discuss next steps — counter, walk away, or try a similar home.",
    responsibleParty: "agent",
  },
  [KernelEvent.OFFER_COUNTER_SENT]: {
    title: "Counter offer sent",
    plainLanguageSummary: "A counter offer was sent. Awaiting the other side's response.",
    responsibleParty: "client",
  },
}

async function writePortalUpdate(
  ctx:        KernelEventContext,
  contactIds: string[],
): Promise<void> {
  const tpl = PORTAL_UPDATE_TEMPLATES[ctx.event]
  if (!tpl) return  // event has no client-facing template; skip

  const supabase = createServiceClient()

  for (const contactId of contactIds) {
    // Resolve role — buyer / seller / lifetime — so per-role overrides apply.
    const role = await resolveContactRole(supabase, contactId, ctx)
    const merged: PortalUpdateTemplate = {
      ...tpl,
      ...(role && tpl.perRole?.[role] ? tpl.perRole[role]! : {}),
    }

    // 3a. transparency_update — the canonical "what happened on my deal" card.
    await supabase.from("transparency_updates").insert({
      contact_id:               contactId,
      transaction_id:           ctx.transactionId ?? null,
      listing_id:               ctx.listingId ?? null,
      agent_id:                 ctx.agentUserId ?? null,
      title:                    merged.title,
      plain_language_summary:   merged.plainLanguageSummary,
      stage:                    merged.stage ?? null,
      responsible_party:        merged.responsibleParty ?? null,
      responsible_party_name:   merged.responsiblePartyName ?? null,
      next_step:                merged.nextStep ?? null,
      update_type:              ctx.event,
      message:                  merged.plainLanguageSummary,
      is_visible_to_client:     true,
      metadata:                 ctx.metadata ?? {},
      created_at:               new Date().toISOString(),
    }).then(() => null, () => null)

    // 3b. Companion portal chat message (only when template provides one).
    if (merged.chatBody) {
      await supabase.from("client_portal_messages").insert({
        brokerage_id:   ctx.brokerageId,
        contact_id:     contactId,
        agent_id:       ctx.agentUserId ?? null,
        transaction_id: ctx.transactionId ?? null,
        direction:      "outbound",
        body:           merged.chatBody,
        channel:        "portal",
        read:           false,
        created_at:     new Date().toISOString(),
      }).then(() => null, () => null)
    }

    // 3c. Notification on the contact's portal bell.
    await supabase.from("notifications").insert({
      contact_id:   contactId,
      brokerage_id: ctx.brokerageId,
      type:         ctx.event,
      title:        merged.title,
      body:         merged.plainLanguageSummary,
      entity_type:  ctx.entityType,
      entity_id:    ctx.entityId,
      priority:     "high",
      channel:      "in_app",
      is_read:      false,
    }).then(() => null, () => null)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveContactRole(
  supabase: ReturnType<typeof createServiceClient>,
  contactId: string,
  ctx: KernelEventContext,
): Promise<"buyer" | "seller" | "lifetime" | null> {
  // Direct hint from caller (preferred — saves a DB hit).
  if (contactId === ctx.buyerContactId)  return "buyer"
  if (contactId === ctx.sellerContactId) return "seller"

  // Fallback to contact_type lookup.
  const { data } = await supabase
    .from("contacts")
    .select("contact_type")
    .eq("id", contactId)
    .maybeSingle()
  const t = (data?.contact_type ?? "").toLowerCase()
  if (t.includes("buyer"))             return "buyer"
  if (t.includes("seller"))            return "seller"
  if (t === "lifetime_customer")       return "lifetime"
  return null
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}
