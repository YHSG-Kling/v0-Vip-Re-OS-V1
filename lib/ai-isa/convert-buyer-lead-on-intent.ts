/**
 * lib/ai-isa/convert-buyer-lead-on-intent.ts
 *
 * BUYER-side CONVERSION ON POSITIVE INTENT — the mirror of the corrected seller
 * intent-conversion (convert-seller-lead-on-intent.ts), built as an INTENT ROUTER.
 *
 * There is NO one-size-fits-all buyer milestone. A buyer LEAD converts to a
 * CONTACT the moment it shows POSITIVE INTENT, and then EACH intent type routes
 * to its OWN right milestone on the buyer side. The Shopping Agent (Buyer
 * Concierge, lib/agents/shopping-agent.ts) owns the buyer relationship from
 * contact-created onward.
 *
 * INTENT → MILESTONE (the router's whole point):
 *   - positive_reply     → convert only. ISA goes dormant; the buyer is now a
 *                          contact the agent/Shopping Agent owns. No milestone.
 *   - criteria_request   → convert THEN capture the buyer's CRITERIA into
 *                          property_preferences (saved search) and advance
 *                          buyer_stage → BUYER_SEARCH_CONFIGURED.
 *   - preapproval_request→ convert THEN START the pre-approval step: stand up an
 *                          (unverified) buyer_financial_profiles row so the
 *                          Shopping Agent / lender flow has a target. We do NOT
 *                          mark financially_verified — they REQUESTED pre-approval,
 *                          they have not COMPLETED it (honest).
 *   - showing_request    → convert THEN schedule a showing via the existing
 *                          showing-request path, RESPECTING the BBA gate (NAR 2024
 *                          settlement — no showing without a signed Buyer Broker
 *                          Agreement). Advances buyer_stage → BUYER_TOURING.
 *
 * On every reason, Step 1 is the CANONICAL convert: acceptAIISAHandoff →
 * consent → qualified → Engine-2 assignment → lossless contact, leads.ai_isa_owner
 * =false (ISA dormant), agent notified. Same path the seller side uses; the buyer
 * vs seller fork is purely the lead's motivation (contact-creator maps
 * 'buyer'/'both' → contact_type='buyer').
 *
 * Reuse, don't rebuild: the converter, the handoff, the BBA gate, the criteria
 * columns, the financial-profile table and the buyer-stage machine all already
 * exist. This module only ROUTES intent → the canonical conversion + the right
 * existing milestone. No new tables. Idempotent per (lead, reason); honest guards
 * (lead under representation → refuse; missing criteria/property → skip that
 * routing but STILL convert).
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { acceptAIISAHandoff } from "@/app/actions/ai-isa/accept-handoff"
import { requireActiveBBA } from "@/lib/buyer-broker/gate"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import {
  buyerIntentToMilestone,
  type BuyerIntentReason,
} from "./buyer-intent-router"

export type { BuyerIntentReason } from "./buyer-intent-router"

/** Buyer criteria the caller captures from the lead conversation (criteria_request). */
export interface BuyerCriteriaInput {
  minPrice?:        number | null
  maxPrice?:        number | null
  minBeds?:         number | null
  minBaths?:        number | null
  cities?:          string[]
  zipCodes?:        string[]
  propertyTypes?:   string[]
  mustHaveFeatures?: string[]
  dealBreakers?:    string[]
}

/** A property the buyer wants to see (showing_request). Mirrors requestShowing's inputs. */
export interface ShowingPropertyRef {
  /** UUID when the property is an in-house listing; else supply the external fields. */
  listingId?:        string
  propertyAddress:   string
  propertyCity?:     string
  propertyState?:    string
  propertyZip?:      string
  mlsNumber?:        string
  listPrice?:        number
  /** Preferred date/time slots; first is used for the structured columns. */
  preferredDates?:   { date: string; time: string }[]
  clientNotes?:      string
}

export interface ConvertBuyerLeadOnIntentParams {
  brokerageId: string
  /** The buyer LEAD that showed positive intent. */
  leadId: string
  /** Why we're converting — drives which milestone the convert routes to. */
  reason: BuyerIntentReason
  /** Buyer criteria to capture (reason === 'criteria_request'). */
  criteria?: BuyerCriteriaInput
  /** The property the buyer wants to see (reason === 'showing_request'). */
  propertyRef?: ShowingPropertyRef
  /** Pre-approval seed (reason === 'preapproval_request'). */
  preapproval?: {
    financeType?: "conventional" | "fha" | "va" | "cash" | "other"
    isCashBuyer?: boolean
    estimatedMonthlyBudget?: number | null
  }
}

export interface ConvertBuyerLeadOnIntentResult {
  success: boolean
  /** contacts.id the lead converted into. */
  contactId?: string
  /** True when the lead was already a contact before this call (idempotent rerun). */
  alreadyConverted?: boolean
  /** True when the agent was freshly notified of the new contact. */
  agentNotified?: boolean
  /** The buyer_stage the contact is at after routing (or null if unchanged). */
  buyerStage?: string | null
  /** property_preferences.id captured (criteria_request only). */
  preferencesId?: string
  /** buyer_financial_profiles.id created/updated (preapproval_request only). */
  financialProfileId?: string
  /** showing_requests.id scheduled (showing_request only). */
  showingRequestId?: string
  /** When a showing was skipped because the BBA gate blocked it. */
  showingBlockedByBBA?: boolean
  /** When a routing step was skipped because required data was missing (still converted). */
  routingSkippedReason?: string
  error?: string
}

export async function convertBuyerLeadOnIntent(
  params: ConvertBuyerLeadOnIntentParams,
): Promise<ConvertBuyerLeadOnIntentResult> {
  const svc = createServiceClient()
  const plan = buyerIntentToMilestone(params.reason)

  // ── Pre-read: was this lead ALREADY converted? + honest representation guard ─
  const { data: preLead } = await svc
    .from("leads")
    .select("id, contact_id, is_active, agent_id, lifecycle_state")
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!preLead) {
    return { success: false, error: "Lead not found" }
  }
  // Honest guard: a lead under representation must NOT be converted/poached.
  if ((preLead as any).lifecycle_state === "representation") {
    return { success: false, error: "Cannot convert buyer: lead is under representation" }
  }
  const wasAlreadyConverted = !!preLead.contact_id

  // ── Step 1: CONVERT via the CANONICAL handoff (same path the seller side uses) ─
  // Idempotent — returns the existing contact when leads.contact_id is already set.
  const handoff = await acceptAIISAHandoff({
    leadId: params.leadId,
    brokerageId: params.brokerageId,
    actorUserId: "system",
  })
  if (!handoff.success || !handoff.contactId) {
    return { success: false, error: handoff.error ?? "Conversion failed" }
  }
  const contactId = handoff.contactId

  // Resolve the contact's agent (for notification + BBA gate + milestone rows).
  const { data: contactRow } = await svc
    .from("contacts")
    .select("agent_id, buyer_stage")
    .eq("id", contactId)
    .maybeSingle()
  const agentId = (contactRow as any)?.agent_id ?? preLead.agent_id ?? null

  // ── Step 2: NOTIFY the agent of a new buyer contact (fresh conversions only) ──
  let agentNotified = false
  if (!wasAlreadyConverted && agentId) {
    const { data: agentUser } = await svc
      .from("agents")
      .select("user_id")
      .eq("id", agentId)
      .maybeSingle()
    const agentUserId = (agentUser as any)?.user_id ?? null
    if (agentUserId) {
      const { error: notifyErr } = await svc.from("notifications").insert({
        brokerage_id: params.brokerageId,
        user_id: agentUserId,
        contact_id: contactId,
        type: "buyer_intent_converted",
        title: "New buyer contact — ready for follow-up",
        body: NOTIFY_BODY[params.reason],
        entity_type: "contact",
        entity_id: contactId,
        priority: "high",
      })
      agentNotified = !notifyErr
    }

    // ── WELCOME the new buyer the moment they convert — invite + a personal WELCOME avatar reel.
    //    The Shopping Agent hands the welcome reel to the Asset Manager (video director); on
    //    completion the Campaign Orchestrator sends the gated 1:1 invite email embedding it + the
    //    portal CTA. A newly converted buyer is never dropped between conversion and first touch. ──
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      await publishManagerSignal({
        brokerageId: params.brokerageId,
        fromManager: "shopping_agent",
        toManager: "asset_manager",
        signalType: "buyer_welcome_reel_handoff",
        message: "A buyer just became a contact — commissioning their personal welcome avatar reel (invite + reel, fronted by the assigned agent).",
        entityType: "contact",
        entityId: contactId,
        contactId,
        payload: { audience: "buyer", reason: params.reason },
      }, svc)
    } catch (e) {
      console.error("[convert-buyer-lead] welcome reel handoff failed:", e)
    }
  }

  let buyerStage: string | null = (contactRow as any)?.buyer_stage ?? null
  let preferencesId: string | undefined
  let financialProfileId: string | undefined
  let showingRequestId: string | undefined
  let showingBlockedByBBA = false
  let routingSkippedReason: string | undefined

  // ── Step 3: ROUTE to the milestone for this intent ───────────────────────────

  // 3a. CRITERIA — capture buyer criteria → property_preferences (saved search).
  if (plan.capturesCriteria) {
    const c = params.criteria
    const hasAny =
      !!c &&
      (c.minPrice != null || c.maxPrice != null || c.minBeds != null || c.minBaths != null ||
        (c.cities?.length ?? 0) > 0 || (c.zipCodes?.length ?? 0) > 0 ||
        (c.propertyTypes?.length ?? 0) > 0 || (c.mustHaveFeatures?.length ?? 0) > 0 ||
        (c.dealBreakers?.length ?? 0) > 0)
    if (!hasAny) {
      routingSkippedReason = "criteria_request without criteria — converted, skipped saved-search capture"
    } else {
      const { data: pref, error: prefErr } = await svc
        .from("property_preferences")
        .upsert(
          {
            contact_id:                 contactId,
            brokerage_id:               params.brokerageId,
            agent_id:                   agentId,
            // Explicit price wins (preferred_*); everything else lands in the inferred_* columns
            // the canonical reader (loadBuyerCriteria) normalizes from.
            preferred_price_min:        c!.minPrice ?? null,
            preferred_price_max:        c!.maxPrice ?? null,
            inferred_beds_min:          c!.minBeds ?? null,
            inferred_baths_min:         c!.minBaths ?? null,
            inferred_cities:            (c!.cities?.length ?? 0) > 0 ? c!.cities : null,
            inferred_zip_codes:         (c!.zipCodes?.length ?? 0) > 0 ? c!.zipCodes : null,
            inferred_property_types:    (c!.propertyTypes?.length ?? 0) > 0 ? c!.propertyTypes : null,
            inferred_must_have_features: (c!.mustHaveFeatures?.length ?? 0) > 0 ? c!.mustHaveFeatures : null,
            inferred_deal_breakers:     (c!.dealBreakers?.length ?? 0) > 0 ? c!.dealBreakers : null,
            updated_at:                 new Date().toISOString(),
          },
          { onConflict: "contact_id" },
        )
        .select("id")
        .single()
      if (!prefErr && pref) {
        preferencesId = (pref as any).id as string
      }
    }
  }

  // 3b. PRE-APPROVAL — START the step (unverified profile row), don't fake verification.
  // NEVER clobber real loan facts already on the profile (owner correction: loan terms
  // come from the pre-approval or the lender, never an assumption): an existing row keeps
  // its finance_type / cash flag / verified state unless the intake EXPLICITLY stated
  // them; the "conventional" placeholder is only ever written on a brand-new row because
  // finance_type is NOT NULL on the live schema (no honest "unknown" value exists yet).
  if (plan.startsPreapproval) {
    const pre = params.preapproval ?? {}
    const { data: existingFin, error: existingFinErr } = await svc
      .from("buyer_financial_profiles")
      .select("id, finance_type, is_cash_buyer, verified, lender_referral_status")
      .eq("contact_id", contactId)
      .maybeSingle()
    // §3: supabase-js RESOLVES refusals. A refused read here arrived as `ex = null`,
    // which this block reads as "brand-new profile" — and a brand-new profile is
    // exactly the case that writes the "conventional" placeholder and resets the
    // referral status. A denied read must not be able to overwrite a real one.
    if (existingFinErr) {
      console.error(
        `[convert-buyer-lead-on-intent] buyer_financial_profiles read REFUSED for contact ${contactId} — skipping the pre-approval upsert rather than treating a refusal as a new profile:`,
        existingFinErr.message,
      )
    }
    const ex = existingFinErr
      ? undefined
      : (existingFin as { id: string; finance_type: string | null; is_cash_buyer: boolean | null; verified: boolean | null; lender_referral_status: string | null } | null)
    const { data: profile, error: profErr } = await svc
      .from("buyer_financial_profiles")
      .upsert(
        {
          contact_id:               contactId,
          brokerage_id:             params.brokerageId,
          finance_type:             pre.financeType ?? ex?.finance_type ?? "conventional",
          is_cash_buyer:            pre.isCashBuyer ?? ex?.is_cash_buyer ?? false,
          estimated_monthly_budget: pre.estimatedMonthlyBudget ?? null,
          // verified stays false on a NEW request — but an already-verified profile is
          // never un-verified by a lead-intent replay.
          verified:                 ex?.verified === true,
          // ── "referred" WAS THE WRONG WORD, AND IT WALKED THE STATUS BACKWARDS ──
          //
          // This block's own heading says it STARTS the pre-approval step, and its
          // comment above says it must "NEVER clobber real loan facts already on the
          // profile". It then hardcoded `lender_referral_status: "referred"` inside an
          // upsert — so on every intent replay it wrote "referred" over whatever the
          // column already held.
          //
          // Two defects in one literal, against the live CHECK
          // (declined | in_progress | not_referred | pre_approved | referred):
          //
          //   · IT NAMED THE WRONG STATE. Starting a pre-approval is not a referral.
          //     Nobody has been introduced to any lender at this point — neither
          //     lender_referred_vendor_id (the brokerage bench, m605) nor
          //     lender_referred_partner_id (the agent's own rolodex) is written here,
          //     so the row claimed a referral it could not name. `in_progress` is the
          //     value the vocabulary already has for exactly this.
          //   · IT REGRESSED REAL PROGRESS. An unconditional write in an upsert means
          //     a buyer who had reached `pre_approved` was knocked back to `referred`
          //     by an ISA replay, and the surfaces that read this column would show
          //     the deal moving backwards for no reason a human could see.
          //
          // So: only ADVANCE from the resting state. An existing status is preserved
          // exactly, and a genuinely new row starts at `in_progress` because this
          // block is the thing that starts it.
          lender_referral_status:   ex?.lender_referral_status ?? "in_progress",
          updated_at:               new Date().toISOString(),
        },
        { onConflict: "contact_id" },
      )
      .select("id")
      .single()
    if (!profErr && profile) {
      financialProfileId = (profile as any).id as string
    }
  }

  // 3c. SHOWING — schedule a showing, RESPECTING the BBA gate.
  if (plan.schedulesShowing) {
    const ref = params.propertyRef
    if (!ref || !ref.propertyAddress) {
      routingSkippedReason = "showing_request without a property — converted, skipped showing schedule"
    } else {
      // BBA gate: NAR 2024 settlement — no showing without a signed BBA with the agent.
      // Only gate when an agent is assigned (there always is post-conversion).
      let allowed = true
      if (agentId) {
        const gate = await requireActiveBBA({
          buyerContactId: contactId,
          agentId,
          brokerageId: params.brokerageId,
        })
        allowed = gate.allowed
      }
      if (!allowed) {
        showingBlockedByBBA = true
        routingSkippedReason = "showing_request blocked by BBA gate — converted, no showing scheduled (NAR 2024)"
      } else {
        const first = ref.preferredDates?.[0]
        const requestedDate = first?.date ?? new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
        const startHHMM = first?.time ?? "10:00"
        const endHHMM = addMinutes(startHHMM, 30)
        const datesText = (ref.preferredDates ?? [{ date: requestedDate, time: startHHMM }])
          .map((d, i) => `Option ${i + 1}: ${d.date} at ${d.time}`)
          .join(", ")
        const message = [
          `Showing request for ${ref.propertyAddress}.`,
          `Preferred dates: ${datesText}.`,
          ref.clientNotes ? `Notes: ${ref.clientNotes}` : "",
        ].filter(Boolean).join(" ")

        const { data: showing, error: showErr } = await svc
          .from("showing_requests")
          .insert({
            listing_id:           ref.listingId ?? null,
            contact_id:           contactId,
            brokerage_id:         params.brokerageId,
            property_address:     ref.propertyAddress,
            property_city:        ref.propertyCity ?? null,
            property_state:       ref.propertyState ?? null,
            property_zip:         ref.propertyZip ?? null,
            mls_number:           ref.mlsNumber ?? null,
            list_price:           ref.listPrice ?? null,
            source:               "agent_input",
            requested_date:       requestedDate,
            requested_start_time: `${startHHMM}:00`,
            requested_end_time:   `${endHHMM}:00`,
            message,
            status:               "pending",
          })
          .select("id")
          .single()
        if (!showErr && showing) {
          showingRequestId = (showing as any).id as string
        }
      }
    }
  }

  // ── Step 4: ADVANCE buyer_stage to the milestone for this intent ─────────────
  // We write contacts.buyer_stage + a lifecycle_events row + fire the kernel event
  // directly via the service client so this is callable from any server context
  // (webhook / cron / script) without a request-scoped session. Skipped when the
  // routing step that justifies the advance was skipped (e.g. no criteria captured,
  // or the showing was BBA-blocked) — we never claim a milestone we didn't reach.
  const advanceOk =
    !plan.advancesStage ? false
    : plan.capturesCriteria ? !!preferencesId
    : plan.schedulesShowing ? !!showingRequestId
    : plan.startsPreapproval ? !!financialProfileId
    : true

  if (plan.advancesStage && advanceOk && plan.targetStage && buyerStage !== plan.targetStage) {
    const fromStage = buyerStage ?? "BUYER_CONTACT_CREATED"
    const { error: stageErr } = await svc
      .from("contacts")
      .update({ buyer_stage: plan.targetStage, updated_at: new Date().toISOString() })
      .eq("id", contactId)
    if (!stageErr) {
      buyerStage = plan.targetStage
      // Audit row on the buyer_lifecycle machine (same entity_type transitionLifecycle uses).
      await svc.from("lifecycle_events").insert({
        brokerage_id: params.brokerageId,
        entity_type: "buyer_lifecycle",
        entity_id: contactId,
        event_type: `lifecycle.${plan.kernelEvent}`,
        metadata: {
          from_state: fromStage,
          to_state: plan.targetStage,
          via: "buyer_intent_conversion",
          reason: params.reason,
        },
        created_at: new Date().toISOString(),
      }).then(() => null, () => null)
      // Fire the kernel milestone event (service-client safe; non-blocking).
      try {
        await processKernelEvent({
          event: plan.kernelEvent as KernelEvent,
          brokerageId: params.brokerageId,
          entityType: "contact",
          entityId: contactId,
          contactId,
          metadata: { reason: params.reason, to_state: plan.targetStage },
        })
      } catch (err) {
        console.error("[convert-buyer-lead-on-intent] kernel event dispatch failed:", err)
      }
    }
  }

  return {
    success: true,
    contactId,
    alreadyConverted: wasAlreadyConverted,
    agentNotified,
    buyerStage,
    preferencesId,
    financialProfileId,
    showingRequestId,
    showingBlockedByBBA: showingBlockedByBBA || undefined,
    routingSkippedReason,
  }
}

const NOTIFY_BODY: Record<BuyerIntentReason, string> = {
  positive_reply:
    "A buyer lead engaged positively and converted to a contact. Reach out to keep the conversation alive.",
  criteria_request:
    "A buyer lead shared their search criteria and converted to a contact. A saved search has been captured — review and refine.",
  preapproval_request:
    "A buyer lead asked to get pre-approved and converted to a contact. The pre-approval step has been started — connect them with a lender.",
  showing_request:
    "A buyer lead wants to see a property and converted to a contact. A showing request has been queued (BBA permitting).",
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number)
  const total = (h * 60 + m + minutes)
  const eh = Math.floor(total / 60) % 24
  const em = total % 60
  return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`
}
