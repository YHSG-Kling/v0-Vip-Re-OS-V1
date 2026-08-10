"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { checkCompliancePassed, syncOfferStatus } from "@/lib/buyer-offer"
import { OFFER_EVENT } from "@/lib/buyer-offer/offer-lifecycle"

interface RespondToCounterParams {
  offerId: string
  response: "accept" | "reject" | "counter_back"
  userId?: string  // ignored — derived from session
  counterTerms?: Record<string, any>
  rejectionReason?: string
}

export async function respondToCounter(params: RespondToCounterParams) {
  const { offerId, response, counterTerms, rejectionReason } = params

  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid offer ID" }
  }

  // Auth gate — same pattern as handle-offer-response. Counter accept
  // is a legally binding contract step; the previous code trusted
  // caller-supplied userId for audit and pulled the offer with no
  // brokerage scope.
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }
  const userId = user.id
  const brokerageIdC = callerRow.brokerage_id

  const supabase = createServiceClient()

  // Get offer scoped to caller's brokerage
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, contact_id, listing_id, transaction_id, brokerage_id")
    .eq("id", offerId)
    .single()

  if (offerError || !offer) {
    return { success: false, error: "Offer not found" }
  }
  if (offer.brokerage_id !== brokerageIdC) {
    return { success: false, error: "Forbidden" }
  }

  // ── THE TENANT ─────────────────────────────────────────────────────────────
  // From the OFFER row, never from the caller. The Forbidden check above proves
  // the two are equal on the only path that gets here, but the rule is that the
  // audit row's tenant is a property of the offer, not of whoever called.
  const brokerageId = offer.brokerage_id as string

  // ── THE ACTOR ──────────────────────────────────────────────────────────────
  // activities.agent_id FKs agents(id); the session gives a users id. Disjoint
  // spaces — RESOLVED once here, never substituted. (It was resolved five
  // separate times below, one round-trip per insert, for the same answer.)
  const actorAgentId = await resolveAgentId(supabase as any, userId)

  // Count counter rounds (max 5) — scoped by brokerage.
  // Keyed on contact_id (not entity_type), so re-keying the writes below to the
  // offer does not change what this counts. Canonical event names.
  const { data: counterEvents } = await supabase
    .from("activities")
    .select("id")
    .eq("contact_id", offer.contact_id)
    .eq("brokerage_id", brokerageId)
    .in("activity_type", [OFFER_EVENT.COUNTER_RECEIVED, OFFER_EVENT.COUNTER_SUBMITTED])

  if (counterEvents && counterEvents.length >= 5 && response === "counter_back") {
    return {
      success: false,
      error: "Maximum counter rounds (5) exceeded"
    }
  }

  // ── EVERY OFFER EVENT BELOW IS KEYED TO THE OFFER ──────────────────────────
  // All of them used to be written with `entity_type:'contact'` and no
  // `entity_id`. Nothing that reads an offer's lifecycle can see such a row:
  // track-offer-lifecycle.ts:getOfferLifecycleState,
  // lib/buyer-offer/status-sync.ts:syncOfferStatus,
  // lib/buyer-offer/expire-offers.ts and
  // offer-lifecycle.ts:deriveOfferStateFromActivities ALL filter
  // `entity_type='offer' AND entity_id=<offers.id>`. That is precisely why the
  // syncOfferStatus(offerId) call at the bottom of this function has never once
  // matched a row: it looked for the offer key and this function only ever wrote
  // the contact one. `contact_id` is still populated on every row, so the
  // contact-side feeds and the counter-round count above are unaffected.
  //
  // The two NON-offer events keep their own canonical keys rather than being
  // dragged onto the offer: `buyer.under_contract` is a CONTACT milestone
  // (lib/kernel/portal.ts:521 renders it on the buyer's timeline) and
  // `transaction.lifecycle.initiated` is a TRANSACTION event. Both were also
  // missing their `entity_id`; both now carry it.

  if (response === "accept") {
    // COMPLIANCE GATE: Must pass before accepting counter.
    //
    // A GATE THAT COULD NOT REFUSE. `checkCompliancePassed` returns a
    // ComplianceCheckResult OBJECT (`{ passed, complianceEventId, … }`), and the
    // test was `if (!compliancePassed)` — an object is always truthy, so `!obj`
    // is always false and this branch was UNREACHABLE. Every counter acceptance
    // passed the gate regardless of compliance. `app/actions/seller-offers.ts:131`
    // reads the same helper correctly (`complianceCheck.passed`), and this
    // module's own header states the rule this path breaks: "NO PATH may emit
    // buyer.offer.accepted or buyer.under_contract without
    // buyer.offer.compliance.passed in activities history" — and the accept
    // branch below emits BOTH. It fails CLOSED now, as written and as intended:
    // the helper destructures `error`, so a REFUSED read also returns passed:false.
    const complianceCheck = await checkCompliancePassed(offerId)
    if (!complianceCheck.passed) {
      const { error: blockError } = await supabase.from("activities").insert({
        brokerage_id: brokerageId,
        agent_id: actorAgentId,
        contact_id: offer.contact_id,
        // Audit event, not a lifecycle transition — see the vocabulary note in
        // lib/buyer-offer/compliance-gate.ts for why these have no OFFER_EVENT
        // constant. Keyed to the offer so the block is visible on the offer.
        activity_type: "buyer.offer.block",
        title: "Counter acceptance blocked: compliance gate failed",
        description: "Cannot accept counter: compliance.passed event not found",
        notes: JSON.stringify({ offer_id: offerId, reason: "compliance_gate_failed", attempted_action: "accept_counter" }),
        metadata: { offer_id: offerId, reason: "compliance_gate_failed", attempted_action: "accept_counter" },
        status: "completed",
        entity_type: "offer",
        entity_id: offerId,
      })
      if (blockError) {
        console.error("[respond-to-counter] compliance block audit row failed to write:", blockError.message)
      }

      return {
        success: false,
        error: "Cannot accept counter: compliance.passed event not found",
        blockerType: "compliance_gate"
      }
    }

    // Emit counter acceptance.
    // CHECKED: these are the rows the lifecycle derives ACCEPTED from and the
    // rows syncOfferStatus reads two steps below. supabase-js RESOLVES a
    // rejected insert, so an unread { error } here is how a legally binding
    // counter acceptance can report success while leaving no trace.
    const { error: acceptEventsError } = await supabase.from("activities").insert([
      {
        brokerage_id: brokerageId,
        agent_id: actorAgentId,
        contact_id: offer.contact_id,
        activity_type: OFFER_EVENT.COUNTER_ACCEPTED,
        title: "Counter offer accepted",
        description: `Counter accepted for offer ${offerId}`,
        notes: JSON.stringify({ offer_id: offerId }),
        metadata: { offer_id: offerId },
        status: "completed",
        entity_type: "offer",
        entity_id: offerId,
      },
      {
        brokerage_id: brokerageId,
        agent_id: actorAgentId,
        contact_id: offer.contact_id,
        activity_type: OFFER_EVENT.ACCEPTED,
        title: "Offer accepted via counter",
        description: `Offer ${offerId} accepted via counter`,
        notes: JSON.stringify({ offer_id: offerId }),
        metadata: { offer_id: offerId },
        status: "completed",
        entity_type: "offer",
        entity_id: offerId,
      },
      {
        brokerage_id: brokerageId,
        agent_id: actorAgentId,
        contact_id: offer.contact_id,
        activity_type: "buyer.under_contract",
        title: "Buyer under contract",
        description: "Buyer moved to under contract via counter acceptance",
        notes: JSON.stringify({ buyer_id: offer.contact_id, offer_id: offerId, transaction_id: offer.transaction_id }),
        metadata: { buyer_id: offer.contact_id, offer_id: offerId, transaction_id: offer.transaction_id },
        status: "completed",
        // A CONTACT milestone, keyed to the contact — not an offer lifecycle
        // event, and deliberately not re-pointed at the offer.
        entity_type: "contact",
        entity_id: offer.contact_id,
        transaction_id: offer.transaction_id ?? null,
      }
    ])
    if (acceptEventsError) {
      return {
        success: false,
        error: `Counter acceptance could not be recorded (${acceptEventsError.message}). The offer's lifecycle did NOT move to ACCEPTED — retry before treating this counter as accepted.`,
      }
    }

    // Transaction handoff
    if (offer.transaction_id) {
      const { error: handoffError } = await supabase.from("activities").insert({
        brokerage_id: brokerageId,
        agent_id: actorAgentId,
        contact_id: offer.contact_id,
        activity_type: "transaction.lifecycle.initiated",
        title: "Transaction lifecycle initiated",
        description: "Transaction initiated from counter acceptance",
        notes: JSON.stringify({ transaction_id: offer.transaction_id, source: "buyer_offer_counter_acceptance", offer_id: offerId }),
        metadata: { transaction_id: offer.transaction_id, source: "buyer_offer_counter_acceptance", offer_id: offerId },
        status: "completed",
        entity_type: "transaction",
        entity_id: offer.transaction_id,
        transaction_id: offer.transaction_id,
      })
      if (handoffError) {
        console.error("[respond-to-counter] transaction handoff event failed to write:", handoffError.message)
      }
    }
  } else if (response === "reject") {
    const { error: rejectError } = await supabase.from("activities").insert({
      brokerage_id: brokerageId,
      agent_id: actorAgentId,
      contact_id: offer.contact_id,
      activity_type: OFFER_EVENT.COUNTER_REJECTED,
      title: "Counter offer rejected",
      description: rejectionReason ?? `Counter rejected for offer ${offerId}`,
      notes: JSON.stringify({ offer_id: offerId, reason: rejectionReason }),
      metadata: { offer_id: offerId, reason: rejectionReason ?? null },
      status: "completed",
      entity_type: "offer",
      entity_id: offerId,
    })
    if (rejectError) {
      return {
        success: false,
        error: `Counter rejection could not be recorded (${rejectError.message}). The offer's lifecycle did NOT move to REJECTED — retry.`,
      }
    }
  } else if (response === "counter_back") {
    const { error: counterBackError } = await supabase.from("activities").insert({
      brokerage_id: brokerageId,
      agent_id: actorAgentId,
      contact_id: offer.contact_id,
      activity_type: OFFER_EVENT.COUNTER_SUBMITTED,
      title: "Counter back submitted",
      description: `Counter back submitted for offer ${offerId}`,
      notes: JSON.stringify({ offer_id: offerId, counter_terms: counterTerms }),
      metadata: { offer_id: offerId, counter_terms: counterTerms ?? null },
      status: "pending",
      entity_type: "offer",
      entity_id: offerId,
    })
    if (counterBackError) {
      return {
        success: false,
        error: `Counter-back could not be recorded (${counterBackError.message}). The counter round was NOT logged — retry.`,
      }
    }
  }

  // ── SYNC THE OPERATIONAL INDEX — AND REPORT IT ─────────────────────────────
  // The result of this call used to be discarded. syncOfferStatus queries the
  // offer key, found nothing (because every write above used the contact key),
  // and returned {success:false, error:"No lifecycle events found"} on EVERY
  // call — silently. `offers.status` therefore never moved for any counter
  // response in the history of this action, and nobody could see that.
  //
  // Now the writes carry the offer key, so this should find them. If it still
  // does not, that is a real failure — the events landed but the column every
  // screen renders did not follow — and the caller has to be told.
  const sync = await syncOfferStatus(offerId)
  if (!sync.success) {
    return {
      success: false,
      response,
      error: `The counter response was recorded, but offers.status could not be synced from it (${sync.error}). The screens will keep showing the previous status until this is resolved.`,
    }
  }

  return { success: true, response, status: sync.newStatus }
}
