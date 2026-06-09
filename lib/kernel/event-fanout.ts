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
import { renderTemplateText } from "./portal-template-render"

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

// Thin forwarder. All three fan-out channels (staff notifications + campaign_sequences enrollment +
// client portal) now live behind processKernelEvent → the kernel reactor, so EVERY emitter gets them
// uniformly — not just the handful that call this wrapper. fanOutKernelEvent simply forwards its
// richer client context (buyer/seller/transaction/listing/agent) so the reactor doesn't have to
// re-resolve it. The reactor's portal writer is template-gated + idempotent, so routing through it
// here adds no duplicate cards.
export async function fanOutKernelEvent(ctx: KernelEventContext): Promise<void> {
  try {
    await processKernelEvent({
      event:            ctx.event,
      brokerageId:      ctx.brokerageId,
      entityType:       ctx.entityType,
      entityId:         ctx.entityId,
      lifecycleEventId: ctx.lifecycleEventId,
      contactId:        ctx.contactId,
      buyerContactId:   ctx.buyerContactId,
      sellerContactId:  ctx.sellerContactId,
      transactionId:    ctx.transactionId,
      listingId:        ctx.listingId,
      agentUserId:      ctx.agentUserId,
      metadata:         ctx.metadata ?? null,
    })
  } catch (e) {
    console.error("[fanOutKernelEvent] processKernelEvent failed", e)
  }
}

// ─── 2. Sequence auto-enrollment ─────────────────────────────────────────────

// Exported so the kernel reactor (lib/kernel/event-reactor) can run the SAME canonical enrollment
// for every emitter — not just the ~10 that call fanOutKernelEvent. Idempotent (skips active
// enrollments), so the reactor + fanOut overlapping on one event never double-enrolls.
export async function enrollMatchingSequences(
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
        enrolled_by:  enrolledBy || null,  // "" (system actor) must not hit the uuid FK
        current_step: 0,
        status:       "active",
        enrolled_at:  new Date().toISOString(),
        next_step_at: new Date().toISOString(),
      }).then(() => null, () => null)

      // Bump the sequence's enrollments_total counter (best-effort).
      await supabase.rpc("increment_sequence_enrollments", { seq_id: seq.id })
        .then(() => null, () => null)
    }
  }
}

// ─── 3. Portal update writer ─────────────────────────────────────────────────

// Idempotency window: a card identical in (contact + event + title) inside this span is treated as a
// duplicate and skipped by the app-layer SELECT. Sized to absorb the reactor/fanOut overlap, retries,
// and rapid double-emits while still allowing genuinely distinct later milestones of the same event
// type to post. The DEPLOYED unique index transparency_updates_dedupe_idx (contact_id, update_type,
// md5(title), minute) is the atomic backstop for truly-concurrent emits that both pass the SELECT.
const PORTAL_DEDUPE_WINDOW_MS = 10 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  /** Which represented side this notice is FOR. "seller" = our listing side
   *  (listings, showings); "buyer" = our buyer side (properties, tours). When
   *  set, the card is written ONLY to a contact resolved to that role — so a
   *  seller-side event never posts to a buyer (and vice-versa), and we never
   *  message a side we don't represent (their contact is absent anyway).
   *  Defaults to "both" (deal-wide milestones: under contract, closed, etc.). */
  audience?:              "buyer" | "seller" | "both"
  /** Buyer-side milestones often differ from seller-side for the same
   *  underlying event. When set, applied per-contact role. */
  perRole?:               Partial<Record<"buyer" | "seller" | "lifetime", Partial<PortalUpdateTemplate>>>
}

const PORTAL_UPDATE_TEMPLATES: Partial<Record<KernelEvent, PortalUpdateTemplate>> = {
  // Pre-listing drip — a presentation section dropped for the seller before the
  // appointment. Seller-only; the home's value is NEVER shown (deferred to the
  // meeting), so copy stays about the market + the team, never a price.
  [KernelEvent.PRESENTATION_SECTION_DELIVERED]: {
    audience: "seller",
    title: "New from your listing team: {section_title}",
    plainLanguageSummary:
      "We've added a new section of your custom listing plan — see how we'll position and market your home in today's market.",
    nextStep: "Open your portal to watch it before our meeting.",
  },
  [KernelEvent.OFFER_ACCEPTED]: {
    title: "You're under contract!",
    plainLanguageSummary:
      "The offer was accepted — you're under contract! Earnest money is due {earnest_money_due}, held by {title_company}. Inspection deadline {inspection_deadline}; estimated closing {closing_date}. Up next is due diligence — inspection, appraisal, and financing.",
    responsibleParty: "agent",
    nextStep: "Earnest money due {earnest_money_due} to {title_company}; inspection by {inspection_deadline}.",
    chatBody: "Great news — your offer was accepted! I'll send the next steps shortly.",
    perRole: {
      seller: {
        title: "Your home is under contract!",
        plainLanguageSummary:
          "An offer was accepted on your home — you're under contract! The buyer's earnest money is due {earnest_money_due}, held by {title_company}. Inspection deadline {inspection_deadline}; estimated closing {closing_date}. Next is the buyer's due-diligence period — inspection, appraisal, financing.",
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
  [KernelEvent.LISTING_PUBLISHED]: {
    title: "Your home is live on the MLS!",
    plainLanguageSummary:
      "Your listing is now active. Buyers and their agents can see it and request showings.",
    responsibleParty: "agent",
    nextStep: "Showings + offers begin coming in.",
    chatBody: "We're live! Your home is on the MLS and showings can be booked. I'll keep you posted on activity.",
  },
  [KernelEvent.LISTING_UNDER_CONTRACT]: {
    title: "Your home is under contract!",
    plainLanguageSummary:
      "An offer is accepted and the deal is in due diligence. Inspection, appraisal, and financing are next.",
    responsibleParty: "agent",
    nextStep: "Buyer's inspection + appraisal.",
    chatBody: "Under contract! I'll walk you through the inspection + appraisal phase.",
  },
  [KernelEvent.LISTING_EXPIRED]: {
    title: "Your listing expired",
    plainLanguageSummary:
      "The listing reached its expiration date without selling. Let's regroup on next steps.",
    responsibleParty: "agent",
    chatBody: "The listing reached its expiration. Let's talk about whether to relist with a refreshed strategy.",
  },
  [KernelEvent.LISTING_CANCELLED]: {
    title: "Listing withdrawn",
    plainLanguageSummary: "Your listing was withdrawn. The property is no longer marketed.",
    responsibleParty: "agent",
  },
  [KernelEvent.LISTING_STAGE_CHANGED]: {
    title: "Listing update",
    plainLanguageSummary: "Your listing moved to a new stage of the marketing-to-close timeline.",
    responsibleParty: "agent",
  },
  [KernelEvent.TRANSACTION_CLOSED]: {
    title: "Closed — congratulations!",
    plainLanguageSummary:
      "The transaction is officially closed. Your portal will now show your lifetime customer view with home value, equity, and ongoing market updates.",
    responsibleParty: "agent",
    chatBody: "Closed! Welcome to your lifetime portal — I'm here for the long haul.",
    perRole: {
      seller: {
        title: "Sold — congratulations!",
        plainLanguageSummary:
          "Your home is officially sold and the transaction has closed. You're now a lifetime customer; your portal will switch to track future home value + market activity.",
        chatBody: "Sold and closed — congratulations! Your portal now shows your lifetime view.",
      },
      buyer: {
        title: "You're a homeowner!",
        plainLanguageSummary:
          "Congratulations — closing is complete. Your portal now switches to homeowner mode with home value tracking and market updates.",
        chatBody: "Welcome home! Your portal is now your lifetime homeowner dashboard.",
      },
    },
  },
  [KernelEvent.OPEN_HOUSE_SCHEDULED]: {
    title: "Open house scheduled",
    plainLanguageSummary: "An open house has been scheduled on your listing. We'll share attendee count + feedback after.",
    responsibleParty: "agent",
    audience: "seller",  // open houses are our listing (seller) side
    chatBody: "Open house is on the calendar — I'll share who came through afterward.",
  },
  [KernelEvent.SHOWING_FEEDBACK_RECEIVED]: {
    title: "Showing feedback received",
    plainLanguageSummary: "A buyer's agent shared feedback after a recent showing of your listing.",
    responsibleParty: "agent",
    audience: "seller",  // showings happen on our listing — feedback is for the seller
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
  // Offer-OS submission path (lib/kernel/offers.ts emits OFFER_OS_SUBMITTED,
  // not OFFER_SUBMITTED). Mirror the OFFER_SUBMITTED treatment so buyer +
  // seller both get the right portal update.
  [KernelEvent.OFFER_OS_SUBMITTED]: {
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

  // ── Transaction milestones (under-contract → close) ──────────────────────────
  // The "same page" core: keep buyer + seller informed through the most anxious
  // stretch of the deal, where the portal otherwise goes quiet.
  [KernelEvent.OFFER_OS_ACCEPTED]: {
    title: "Your offer was accepted!",
    plainLanguageSummary:
      "Congratulations — the seller accepted your offer. The deal moves into due diligence: inspection, appraisal, and financing are next.",
    responsibleParty: "agent",
    nextStep: "Earnest money due, inspection scheduled.",
    chatBody: "Great news — your offer was accepted! I'll send the next steps shortly.",
    perRole: {
      seller: {
        title: "You accepted an offer!",
        plainLanguageSummary:
          "You've accepted an offer on your home. Next is the buyer's due-diligence period — inspection, appraisal, financing.",
        chatBody: "Offer accepted — congratulations! I'll keep you posted as the buyer completes due diligence.",
      },
    },
  },
  [KernelEvent.EARNEST_MONEY_RECEIVED]: {
    title: "Earnest money received",
    plainLanguageSummary:
      "The buyer's earnest money deposit has been received and is held in escrow. This is the buyer's good-faith commitment to the purchase.",
    responsibleParty: "title",
    nextStep: "Inspection period begins.",
    perRole: {
      buyer: {
        title: "Earnest money confirmed",
        plainLanguageSummary:
          "Your earnest money deposit has been received and is safely held in escrow. It will be applied toward your costs at closing.",
        chatBody: "Your earnest money is in and held in escrow — one more box checked.",
      },
    },
  },
  [KernelEvent.INSPECTION_ORDERED]: {
    title: "Home inspection scheduled",
    plainLanguageSummary:
      "The home inspection has been scheduled. The inspector will assess the property's condition and provide a report.",
    responsibleParty: "inspector",
    nextStep: "Review inspection findings, then negotiate repairs if needed.",
    perRole: {
      buyer: {
        title: "Your inspection is scheduled",
        plainLanguageSummary:
          "Your home inspection is on the calendar. Once the report is in, we'll review it together and decide on any repair requests.",
        chatBody: "Your inspection is scheduled — I'll walk you through the report once it's back.",
      },
    },
  },
  [KernelEvent.APPRAISAL_ORDERED]: {
    title: "Appraisal ordered",
    plainLanguageSummary:
      "The lender has ordered the appraisal to confirm the home's value supports the loan amount.",
    responsibleParty: "appraiser",
    nextStep: "Await appraisal results.",
  },
  [KernelEvent.APPRAISAL_COMPLETED]: {
    title: "Appraisal complete",
    plainLanguageSummary:
      "The appraisal is finished. Your agent will review the value with you and discuss any impact on the deal.",
    responsibleParty: "agent",
    nextStep: "Financing moves toward final approval.",
    chatBody: "The appraisal is in — let's review the results together.",
  },
  [KernelEvent.FINANCING_CLEAR_TO_CLOSE]: {
    title: "You're clear to close!",
    plainLanguageSummary:
      "The lender has issued the final approval — financing is fully cleared. The closing can now be scheduled.",
    responsibleParty: "lender",
    nextStep: "Schedule closing + final walkthrough.",
    chatBody: "Big milestone — you're clear to close! We're in the home stretch now.",
  },
  [KernelEvent.CD_RECEIVED]: {
    title: "Closing Disclosure ready",
    plainLanguageSummary:
      "Your Closing Disclosure is available. It itemizes your final loan terms and the exact funds due at closing. Review it carefully before signing.",
    responsibleParty: "lender",
    nextStep: "Review the figures, then proceed to closing.",
    chatBody: "Your Closing Disclosure is ready — review the numbers and let me know if anything looks off.",
  },
  [KernelEvent.CLOSING_SCHEDULED]: {
    title: "Closing scheduled",
    plainLanguageSummary:
      "Your closing appointment is set. Bring a government-issued ID and any funds required per your Closing Disclosure.",
    responsibleParty: "title",
    nextStep: "Final walkthrough, then sign at closing.",
    chatBody: "Closing is on the calendar — almost there! I'll send what to bring.",
  },
  [KernelEvent.TRANSACTION_STAGE_CHANGED]: {
    title: "Deal update",
    plainLanguageSummary: "Your transaction moved to a new stage on the path to closing.",
    responsibleParty: "agent",
  },

  // ── Buyer home-search (RealScout-style) ──────────────────────────────────────
  [KernelEvent.PROPERTY_MATCH_FOUND]: {
    title: "New homes matching your search",
    plainLanguageSummary:
      "New properties just hit the market that match what you're looking for. Open your portal to view photos, details, and request a tour.",
    responsibleParty: "client",
    audience: "buyer",  // property search is the buyer side
    nextStep: "Review matches and tell your agent which to tour.",
    chatBody: "Fresh matches for your search just came up — take a look and let me know which you'd like to tour.",
  },
  [KernelEvent.SEARCH_ALERT_TRIGGERED]: {
    title: "New homes for you",
    plainLanguageSummary:
      "A new property matching your saved search is available. Check your portal for the full details.",
    responsibleParty: "client",
    audience: "buyer",
    chatBody: "A new property matching your search just listed — want me to set up a tour?",
  },
  [KernelEvent.PROPERTY_ALERT_MATCHED]: {
    title: "A home matched your alert",
    plainLanguageSummary:
      "A property matched one of your saved alerts. View it in your portal and let your agent know if you'd like to tour it.",
    responsibleParty: "client",
    audience: "buyer",
    chatBody: "One of your saved alerts just matched a new property — let me know if it's worth a tour.",
  },
  [KernelEvent.TOUR_SCHEDULED]: {
    title: "Your tour is scheduled",
    plainLanguageSummary:
      "Your property tour is on the calendar. You'll find the date, time, and address in your portal.",
    responsibleParty: "client",
    audience: "buyer",  // tours / tour planner are the buyer side
    nextStep: "See you at the tour.",
    chatBody: "Your tour is set — details are in your portal. Looking forward to it!",
  },
  // SHOWING_SCHEDULED is the SELLER side — a buyer's agent booked a showing on OUR listing. (Buyer-side
  // property visits are TOUR_SCHEDULED above.)
  [KernelEvent.SHOWING_SCHEDULED]: {
    title: "A showing is scheduled on your listing",
    plainLanguageSummary:
      "A buyer's agent booked a showing of your home. We'll pass along any feedback afterward.",
    responsibleParty: "agent",
    audience: "seller",
    chatBody: "Good news — a showing was just booked on your listing. I'll share feedback once it's done.",
  },

  // ── E-sign & documents ───────────────────────────────────────────────────────
  [KernelEvent.OFFER_OS_ESIGN_COMPLETED]: {
    title: "Your offer is signed",
    plainLanguageSummary:
      "All parties have e-signed the offer. It's now fully executed and on file.",
    responsibleParty: "agent",
    nextStep: "Offer is delivered to the other side.",
    chatBody: "Your offer is fully signed — sending it over now.",
  },
  [KernelEvent.ESIGN_SIGNED_COMPLETED]: {
    title: "Document signed",
    plainLanguageSummary:
      "A document you needed to sign is now complete. A copy is saved to your portal for your records.",
    responsibleParty: "client",
    chatBody: "Thanks — that document is signed and saved to your portal.",
  },
  [KernelEvent.DOCUMENT_REQUESTED]: {
    title: "Action needed: document requested",
    plainLanguageSummary:
      "Your agent needs a document from you to keep things moving. Open your portal to see what's requested and upload it.",
    responsibleParty: "client",
    nextStep: "Upload the requested document in your portal.",
    chatBody: "When you have a moment, I need a quick document from you — details are in your portal.",
  },

  // ── Lifetime / post-close touchpoints ────────────────────────────────────────
  [KernelEvent.REVIEW_REQUEST_SENT]: {
    title: "How did we do?",
    plainLanguageSummary:
      "We'd love your feedback on your experience. A quick review helps other buyers and sellers and means a lot to us.",
    responsibleParty: "client",
    chatBody: "If you have a minute, I'd be grateful for a quick review of how things went!",
  },
  [KernelEvent.ANNIVERSARY_TRIGGERED]: {
    title: "Happy home anniversary!",
    plainLanguageSummary:
      "It's been another year in your home — congratulations! Your portal has an updated look at your home's value and equity.",
    responsibleParty: "agent",
    chatBody: "Happy home anniversary! I pulled a fresh look at your home's value for you.",
  },
  [KernelEvent.MARKET_UPDATE_SENT]: {
    title: "Your market update is ready",
    plainLanguageSummary:
      "A fresh update on your neighborhood's market — recent sales, trends, and what your home may be worth — is available in your portal.",
    responsibleParty: "agent",
    chatBody: "Your latest neighborhood market update is in your portal — some interesting movement this period.",
  },
  [KernelEvent.SELLER_UPDATE_SENT]: {
    title: "Listing activity update",
    plainLanguageSummary:
      "Here's the latest on your listing — recent showings, feedback, and market activity are summarized in your portal.",
    responsibleParty: "agent",
    chatBody: "I posted your latest listing activity update — showings and feedback are summarized for you.",
  },
}

// Exported so the kernel reactor (lib/kernel/event-reactor) runs the SAME template-gated portal
// write for every emitter. Returns true when at least one client card was written. Template-gated
// (events without a PORTAL_UPDATE_TEMPLATES entry — i.e. all internal events — are a no-op) and
// idempotent (an identical card for the same contact + event + entity within PORTAL_DEDUPE_WINDOW_MS
// is skipped, so reactor + fanOut overlap, retries, and double-emits never create duplicate cards).
export async function writePortalUpdate(
  ctx:        KernelEventContext,
  contactIds: string[],
): Promise<boolean> {
  const tpl = PORTAL_UPDATE_TEMPLATES[ctx.event]
  if (!tpl) return false  // event has no client-facing template; skip

  const supabase = createServiceClient()
  let wrote = false

  for (const contactId of contactIds) {
    // Resolve role — buyer / seller / lifetime — so per-role overrides apply.
    const role = await resolveContactRole(supabase, contactId, ctx)
    const merged: PortalUpdateTemplate = {
      ...tpl,
      ...(role && tpl.perRole?.[role] ? tpl.perRole[role]! : {}),
    }

    // Audience gating (representation + domain semantics): a seller-side notice (our listing /
    // showings) never posts to a buyer, a buyer-side notice (properties / tours) never posts to a
    // seller. When the role can't be confirmed, a side-specific card is skipped rather than risk
    // reaching the wrong party. Deal-wide milestones (audience "both") post to every resolved side
    // we represent — the unrepresented side simply has no contact and was already filtered out.
    const audience = merged.audience ?? "both"
    if (audience !== "both" && role !== audience) continue

    // Proactive, specific copy: fill {key} tokens from the event metadata (e.g. real contract dates).
    const meta = ctx.metadata ?? undefined
    const title    = renderTemplateText(merged.title, meta)!
    const summary  = renderTemplateText(merged.plainLanguageSummary, meta)!
    const nextStep = renderTemplateText(merged.nextStep, meta)
    const chatBody = renderTemplateText(merged.chatBody, meta)

    // Resolve the agents.id for the (optional) companion chat. client_portal_messages.agent_id is
    // NOT NULL with an FK to *agents* (not users), and contacts.agent_id is the agents.id — so use
    // that. ctx.agentUserId is a users.id (the actor) and is the WRONG id space here; feeding it in
    // is why every prior chat insert silently failed the FK. Used ONLY for the chat ping — the
    // transparency card's agent_id is a separate FK to users (ctx.agentUserId).
    const { data: chatAgentRow } = await supabase
      .from("contacts")
      .select("agent_id")
      .eq("id", contactId)
      .maybeSingle()
    const chatAgentId: string | null = chatAgentRow?.agent_id ?? null

    // Idempotency — TWO layers:
    //   1. App-layer dedupe SELECT (fast-path skip without a DB write). Skips when an identical
    //      (contact, event, title) card already exists in the 10-minute window.
    //   2. DB-level partial unique index transparency_updates_dedupe_idx
    //      (contact_id, update_type, md5(title), date_trunc('minute', created_at)) — the DEPLOYED
    //      backstop. Guarantees no duplicate even under concurrent emits that both miss the SELECT.
    const sinceIso = new Date(Date.now() - PORTAL_DEDUPE_WINDOW_MS).toISOString()
    const { data: dupe } = await supabase
      .from("transparency_updates")
      .select("id")
      .eq("contact_id", contactId)
      .eq("update_type", ctx.event)
      .eq("title", title)
      .gte("created_at", sinceIso)
      .limit(1)
      .maybeSingle()
    if (dupe) continue

    wrote = true

    // 3a. transparency_update — the canonical "what happened on my deal" card. Idempotency is two
    // layers: the app-layer SELECT above (10-min window) collapses the common case, and the DEPLOYED
    // partial unique index `transparency_updates_dedupe_idx` (contact_id, update_type, md5(title),
    // date_trunc('minute', created_at)) makes a truly-concurrent duplicate atomic — the unique
    // violation is absorbed by the swallowing `.then(ok, ignore)`. (The earlier code targeted a
    // dedupe_key column + onConflict that was never deployed, so this write silently failed and NO
    // portal card was ever written — the bug this restores.)
    await supabase.from("transparency_updates").insert(
      {
        brokerage_id:             ctx.brokerageId,
        contact_id:               contactId,
        transaction_id:           ctx.transactionId ?? null,
        listing_id:               ctx.listingId ?? null,
        // `|| null` (not `?? null`): a system actor passes agentUserId="" — an empty string would fail
        // the uuid FK to users and the swallowed insert would silently drop the whole card.
        agent_id:                 ctx.agentUserId || null,
        title:                    title,
        plain_language_summary:   summary,
        stage:                    merged.stage ?? null,
        responsible_party:        merged.responsibleParty ?? null,
        responsible_party_name:   merged.responsiblePartyName ?? null,
        next_step:                nextStep ?? null,
        update_type:              ctx.event,
        message:                  summary,
        is_visible_to_client:     true,
        metadata:                 ctx.metadata ?? {},
        created_at:               new Date().toISOString(),
      },
    ).then(() => null, () => null)

    // 3a-bis. Embed into contact_memory so the per-buyer/seller Managed Agents AND the
    // portal AI chat can recall what happened on this deal. Fire-and-forget, never
    // throws — failure here must NOT block the transparency_updates write the buyer/
    // seller relies on. Best-effort path matches the kernel's broader resilience.
    void import("@/lib/agents/contact-memory").then(mod =>
      mod.embedContactMemory({
        brokerageId:  ctx.brokerageId,
        entityType:   "contact",
        entityId:     contactId,
        memoryKind:   "transparency_update",
        content:      `${title}\n\n${summary}${nextStep ? "\n\nNext: " + nextStep : ""}`,
        sourceTable:  "transparency_updates",
        metadata:     {
          update_type:    ctx.event,
          transaction_id: ctx.transactionId ?? null,
          listing_id:     ctx.listingId ?? null,
        },
      }).catch(() => null),
    ).catch(() => null)

    // 3b. Companion portal chat message (only when template provides one AND an agent is resolvable
    //     — client_portal_messages.agent_id is NOT NULL).
    if (chatBody && chatAgentId) {
      await supabase.from("client_portal_messages").insert({
        brokerage_id:   ctx.brokerageId,
        contact_id:     contactId,
        agent_id:       chatAgentId,
        transaction_id: ctx.transactionId ?? null,
        direction:      "agent_to_client",
        body:           chatBody,
        channel:        "portal",
        read:           false,
        created_at:     new Date().toISOString(),
      }).then(() => null, () => null)
    }

    // 3c. Notification on the contact's portal bell. entity_id is a uuid column — only set it when
    //     ctx.entityId is actually a uuid (some emitters pass composite/string ids), else the whole
    //     bell insert fails the uuid cast (silently, via the swallow) and the client gets no ping.
    await supabase.from("notifications").insert({
      contact_id:   contactId,
      brokerage_id: ctx.brokerageId,
      type:         ctx.event,
      title:        title,
      body:         summary,
      entity_type:  ctx.entityType,
      entity_id:    UUID_RE.test(ctx.entityId ?? "") ? ctx.entityId : null,
      priority:     "high",
      channel:      "in_app",
      is_read:      false,
    }).then(() => null, () => null)
  }

  return wrote
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
