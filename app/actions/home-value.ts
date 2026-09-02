"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { createPortalInviteForContact } from "./portal-invites"
import { CONTACT_SOURCE_HOME_VALUE } from "@/lib/campaigns/contact-sources"
import { autoEnrollContact } from "@/lib/campaign-sequences/auto-enroll"
import { pushPortalValueCard } from "@/lib/kernel/portal-value"
import {
  LISTING_APPOINTMENT_MIN_LEAD_DAYS,
  LISTING_APPOINTMENT_TOO_SOON_ERROR,
  earliestListingAppointmentAt,
} from "@/lib/home-value/listing-appointment"
import { composeHomeValueReportEmail } from "@/lib/home-value/report-email"
import { bestEffort } from "@/lib/db/best-effort"

// ============================================================================
// WHY THIS FILE USES THE SERVICE CLIENT FOR THE PUBLIC LANE
//
// /home-value is an UNAUTHENTICATED marketing page: a homeowner who has never
// logged in fills the form. Every table this lane touches has RLS on, and the
// policies are tenant policies —
//   contacts INSERT              → broker / agent / platform_admin only
//   valuation_requests INSERT    → brokerage_id = current_user_brokerage_id()
//   home_value_estimates I/S     → brokerage_id = current_user_brokerage_id()
//   agents / calendar_events S   → same
// — and current_user_brokerage_id() is `SELECT brokerage_id FROM users WHERE
// id = auth.uid()`, which is NULL for an anonymous visitor. `brokerage_id =
// NULL` is NULL, i.e. not true, so Postgres refused every one of these
// statements. supabase-js RESOLVES a refused query instead of throwing, so the
// whole lane failed quietly: no contact, no request row, no estimate, and a
// result page that reported "Estimate not found" for every submission.
//
// The public surfaces below therefore run on the SERVICE client, exactly like
// the sibling public page app/home-value/[agentSlug]/page.tsx already does. The
// service client bypasses RLS, so tenancy is carried EXPLICITLY: every write
// names brokerage_id, and every read is either brokerage-scoped or keyed on a
// per-row secret the seller was handed (the valuation_request id in their own
// result URL). The authenticated dashboard surfaces at the bottom of this file
// (savePageConfig) keep the session client and their RLS gate.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

interface HomeValueFormData {
  propertyAddress: string
  city: string
  state: string
  zipCode: string
  bedrooms: number
  bathrooms: number
  squareFeet: number
  yearBuilt: number
  condition: string
  propertyType?: string
  firstName: string
  lastName: string
  email: string
  phone: string
  agentSlug?: string
  brokerageId?: string
  utmSource?: string
  /** Caller MUST pass true — form must show and require TCPA checkbox */
  tcpaConsent: boolean
  tcpaConsentText?: string
  qualificationData?: {
    sellTimeline?: string
    motivation?: string
    hasAgent?: string
    mortgageStatus?: string
    priceExpectation?: string
    buyAfterSell?: string
    additionalNotes?: string
  }
}

/** A comparable sale as the seller-facing result page renders it. */
// UN-EXPORTED (§1.1, 2026-08-31, lane M4): its readers are the private
// AIValuationResponse and the comp mapping in this file; the seller result
// page consumes the action's inferred return shape, never this name.
interface SellerComp {
  address: string
  sale_price: number
  beds: number
  baths: number
  sqft: number
  price_per_sqft: number
  sale_date: string
  /**
   * Miles from the subject, WHEN THE COMP PROVIDER REPORTS ONE. RentCast — the
   * platform comp source — publishes a real per-comp `distance`, so this is now
   * populated for RentCast-sourced comps. Null still means the provider gave no
   * distance, and the UI must show "—" for it, never a made-up number.
   */
  distance_miles: number | null
  /** Source URL / provider attribution for the comp, when one exists. */
  citation?: string | null
}

interface AIValuationResponse {
  estimated_value_low: number
  estimated_value_mid: number
  estimated_value_high: number
  confidence_score: number
  /**
   * "unknown" is a real answer. It means no market_data row covers this
   * property's ZIP/city yet — which is the truth before a market pull has run.
   * Asserting "stable" in that state is a fabrication the seller cannot check.
   */
  market_trend: "appreciating" | "stable" | "depreciating" | "unknown"
  ai_narrative: string
  comps: SellerComp[]
  /**
   * What actually produced the number, stored to home_value_estimates.methodology:
   *   ai_cma                 — adjusted comparable sales (runAiCma found comps)
   *   sqft_regional_average  — no comps available; sqft × a conservative regional
   *                            rate. NOT a CMA, and labelled so on the record.
   */
  methodology: "ai_cma" | "sqft_regional_average"
}

// ============================================================================
// convertValuationRequestToContact
// ============================================================================

export async function convertValuationRequestToContact(params: {
  requestId: string
}): Promise<{ success: boolean; contactId?: string; error?: string }> {
  // TENANT FROM THE SESSION (§4, 2026-09-02). This took brokerageId / agentId /
  // userId in the BODY and wrote them straight onto a service client — the IDOR
  // shape CLAUDE.md names: any signed-in caller could convert any brokerage's
  // request into a contact owned by any agent. Gate first, then the service
  // client; the request must belong to the caller's brokerage or it does not
  // exist as far as this door is concerned.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const service = createServiceClient()
  const { data: me, error: meError } = await service
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()
  if (meError) return { success: false, error: meError.message }
  if (!me?.brokerage_id) return { success: false, error: "No agent profile for this session" }
  const tenant = { brokerageId: me.brokerage_id as string, agentId: me.id as string, userId: user.id }

  try {
    // 1. Load valuation request — scoped to the caller's brokerage
    const { data: request, error: requestError } = await service
      .from("valuation_requests")
      .select("*")
      .eq("id", params.requestId)
      .eq("brokerage_id", tenant.brokerageId)
      .maybeSingle()

    if (requestError || !request) {
      return { success: false, error: "Request not found" }
    }

    if (request.contact_id) {
      return { success: false, error: "Already converted" }
    }

    // 2. Extract name from qualification_data if available, else use address prefix
    const qualData = (request.qualification_data as any) ?? {}
    const firstName = qualData.firstName ?? "Home"
    const lastName = qualData.lastName ?? "Seller"
    const email = qualData.email ?? `seller-${request.id.slice(0, 8)}@pending.local`
    const phone = qualData.phone ?? null
    const phoneDigits = phone ? phone.replace(/\D/g, "") : null

    // 3. Create contact
    const { data: newContact, error: contactError } = await service
      .from("contacts")
      .insert({
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        contact_type: "seller",
        source: CONTACT_SOURCE_HOME_VALUE,
        agent_id: tenant.agentId,
        brokerage_id: tenant.brokerageId,
      })
      .select("id")
      .single()

    if (contactError || !newContact) {
      return { success: false, error: contactError?.message ?? "Failed to create contact" }
    }

    // 4. Link request to contact. Counted (§3): a DELETE/UPDATE that matches
    //    nothing also resolves, and an unlinked request would be offered for
    //    conversion again — a second contact for the same seller.
    const { data: linked, error: linkError } = await service
      .from("valuation_requests")
      .update({ contact_id: newContact.id, agent_id: tenant.agentId })
      .eq("id", params.requestId)
      .eq("brokerage_id", tenant.brokerageId)
      .select("id")
    if (linkError) return { success: false, error: `Contact created but request not linked: ${linkError.message}`, contactId: newContact.id }
    if (!linked || linked.length === 0) return { success: false, error: "Contact created but request not linked (no matching row)", contactId: newContact.id }

    // 5. Send portal invite
    await createPortalInviteForContact({
      contactId: newContact.id,
      brokerageId: tenant.brokerageId,
      invitedByUserId: tenant.userId,
      sendMagicLink: true,
    }).catch(() => {})

    // 6. AUTOMATIC ENRICHMENT (owner, wave 14): "any time there is a new contact,
    //    there is an automatic enrichment run." This door inserts the contact
    //    directly — no captureContact, no CONTACT_CREATED emit — so neither the
    //    create-time lane nor the reactor reached it. The SURVIVOR is called
    //    (lib/enrichment/contact-enrichment-core.ts:queueContactEnrichment); it
    //    owns the freshness check, the pending-row idempotency guard, the owner's
    //    live-deal suppression and the backlog cap. Best-effort — a conversion
    //    must never fail because enrichment could not be queued.
    try {
      const { queueContactEnrichment } = await import("@/lib/enrichment/contact-enrichment-core")
      await queueContactEnrichment({
        contactId:   newContact.id,
        brokerageId: tenant.brokerageId,
        triggerType: "home_value_conversion",
      })
    } catch (err) {
      console.error("[convertValuationRequestToContact] enrichment enqueue failed (non-fatal):", err)
    }

    return { success: true, contactId: newContact.id }
  } catch (error: any) {
    console.error("[convertValuationRequestToContact] Error:", error)
    return { success: false, error: error.message ?? "Unexpected error" }
  }
}

// ============================================================================
// submitHomeValueRequest
// ============================================================================

export async function submitHomeValueRequest(formData: HomeValueFormData): Promise<{
  success: boolean
  requestId?: string
  error?: string
}> {
  // PUBLIC, SESSIONLESS lane — see the note at the top of this file. Tenancy is
  // carried explicitly on every statement below.
  const supabase = createServiceClient()

  try {
    const {
      propertyAddress,
      city,
      state,
      zipCode,
      bedrooms,
      bathrooms,
      squareFeet,
      yearBuilt,
      condition,
      propertyType,
      firstName,
      lastName,
      email,
      phone,
    agentSlug,
    brokerageId,
    utmSource,
    tcpaConsent,
    tcpaConsentText,
    qualificationData,
  } = formData

    // Step 1: Resolve agent from slug if provided, else get default brokerage agent
    let resolvedAgentId: string | null = null
    let resolvedBrokerageId = brokerageId

    if (agentSlug) {
      const { data: agentData } = await supabase
        .from("agents")
        .select("id, brokerage_id")
        .eq("public_slug", agentSlug)
        .single()

      if (agentData) {
        resolvedAgentId = agentData.id
        resolvedBrokerageId = agentData.brokerage_id
      }
    }

    // If no brokerage resolved, get the first active brokerage
    if (!resolvedBrokerageId) {
      const { data: defaultBrokerage } = await supabase
        .from("brokerages")
        .select("id")
        .is("deleted_at", null)
        .limit(1)
        .single()

      resolvedBrokerageId = defaultBrokerage?.id
    }

    if (!resolvedBrokerageId) {
      return { success: false, error: "Unable to determine brokerage" }
    }

    // Agent assignment fallback — if no agent resolved from slug, assign the
    // brokerage's primary active agent (earliest-created active agent = owner/primary).
    // This ensures every home value contact has an agent owner immediately.
    if (!resolvedAgentId) {
      const { data: primaryAgent, error: primaryAgentError } = await supabase
        .from("agents")
        .select("id")
        .eq("brokerage_id", resolvedBrokerageId)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()

      if (primaryAgentError) {
        console.error("[home-value] primary agent lookup refused:", primaryAgentError.message)
      } else if (primaryAgent?.id) {
        resolvedAgentId = primaryAgent.id
      }
    }

    // ID CLASS. Resolved ONCE, here, and reused by the portal invite, the agent
    // notification and the report email's signature lookup. agents.id and
    // users.id are different id spaces: the portal invite and the notification
    // both take a USERS id, and valuation_requests.agent_id / contacts.agent_id
    // are AGENTS ids. Neither substitutes for the other — this resolves it.
    let resolvedAgentUserId: string | null = null
    if (resolvedAgentId) {
      const { data: agentRow, error: agentRowError } = await supabase
        .from("agents")
        .select("user_id")
        .eq("id", resolvedAgentId)
        .maybeSingle()
      if (agentRowError) {
        console.error("[home-value] agent user_id lookup refused:", agentRowError.message)
      } else {
        resolvedAgentUserId = agentRow?.user_id ?? null
      }
    }

    // Step 2: Check for existing contact by email OR phone in this brokerage
    const normalizedPhone = phone.replace(/\D/g, "")

    const { data: existingContact, error: existingContactError } = await supabase
      .from("contacts")
      .select("id, first_name")
      .eq("brokerage_id", resolvedBrokerageId)
      .or(`email.eq.${email},phone.eq.${phone}`)
      // limit(1) before maybeSingle: a homeowner whose email AND phone are on two
      // different rows matches twice, and maybeSingle turns "2 rows" into an error
      // that used to read as "no match" — creating a third, duplicate contact.
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()

    if (existingContactError) {
      // A refused dedupe read resolves as "no match" and would create a DUPLICATE
      // contact for a homeowner who is already in the book. Fail loudly instead.
      console.error("[home-value] contact dedupe read refused:", existingContactError.message)
      return { success: false, error: "Failed to look up your record. Please try again." }
    }

    let contactId: string

    // Step 3: If no match, INSERT new contact FIRST
    // Per TCPA rules: create lead regardless of consent, but only store phone
    // and enable phone/SMS channels when consent is explicitly given.
    if (!existingContact) {
      const consentNow = new Date().toISOString()
      const { data: newContact, error: contactError } = await supabase
        .from("contacts")
        .insert({
          // Tenant anchor first: the scope guard reads a fixed window after
          // .from(), so burying brokerage_id deep in a long payload makes a
          // properly-scoped write look unscoped.
          brokerage_id: resolvedBrokerageId,
          agent_id: resolvedAgentId,
          first_name: firstName,
          last_name: lastName,
          email,
          // Only store phone if TCPA consent given; otherwise omit to prevent calling
          phone: tcpaConsent ? phone : null,
          preferred_channel: tcpaConsent ? "phone" : "email",
          contact_type: "seller",
          // was "home_value_tool" — one feature wrote contacts.source two ways
          source: CONTACT_SOURCE_HOME_VALUE,
          buyer_stage: "BUYER_CONTACT_CREATED",
          tcpa_consent: tcpaConsent,
          tcpa_consent_at: tcpaConsent ? consentNow : null,
          tcpa_consent_date: tcpaConsent ? consentNow : null,
          tcpa_consent_text: tcpaConsent ? (tcpaConsentText ?? null) : null,
          tcpa_consent_source: tcpaConsent ? "home_value_tool" : null,
        })
        .select("id")
        .single()

      if (contactError || !newContact) {
        console.error("Error creating contact:", contactError)
        return { success: false, error: "Failed to create contact" }
      }
      contactId = newContact.id

      // AUTOMATIC ENRICHMENT ON A NEW CONTACT (owner, wave 14). Public,
      // sessionless door that inserts a contact directly, so neither
      // captureContact's create-time lane nor the reactor's CONTACT_CREATED
      // branch reached it. Queued through the survivor
      // (lib/enrichment/contact-enrichment-core.ts:queueContactEnrichment), which
      // carries the identifier gate, the live-deal suppression and the backlog
      // cap. Only on the CREATE branch: a returning homeowner is already known to
      // the queue's freshness check, which would refuse them anyway.
      // Best-effort — a public form submission must never fail on enrichment.
      try {
        const { queueContactEnrichment } = await import("@/lib/enrichment/contact-enrichment-core")
        await queueContactEnrichment({
          contactId,
          brokerageId: resolvedBrokerageId,
          triggerType: "home_value_form",
        })
      } catch (err) {
        console.error("[submitHomeValueRequest] enrichment enqueue failed (non-fatal):", err)
      }
    } else {
      contactId = existingContact.id
    }

    // ── STEP 3b: THE PORTAL LOGIN ────────────────────────────────────────────
    // The ruling: "they will be presented with a contact portal to log in and the
    // report will show up in their portal". This is where that login is issued.
    //
    // TWO DEFECTS CLOSED HERE.
    //
    //  1. WRONG DOOR. This used to call createPortalInviteForContact — a
    //     "use server" action whose FIRST statement is auth.getUser() and which
    //     returns { error: "Unauthorized" } when there is no session. /home-value
    //     is an unauthenticated marketing page, so there never is one: every
    //     home-value seller's portal invite was refused before it did any work.
    //     createSystemPortalInvite is the sibling built for exactly this — a
    //     trusted server flow supplying the authorizing agent's USERS id, which
    //     issuePortalInvite then verifies is in the contact's brokerage.
    //
    //  2. FIRE-AND-FORGET. It was a floating .then() chain on a serverless
    //     request. The response returns, the lambda freezes, and the invite may
    //     never run at all. It is awaited now — issuing a login is part of the
    //     submission, not a side wish.
    //
    // Run for EXISTING contacts too, not only new ones: a returning homeowner is
    // just as entitled to their report, and issuePortalInvite is idempotent (it
    // reuses the open invite row and re-sends the magic link).
    let portalInvited = false
    if (resolvedAgentUserId) {
      const { createSystemPortalInvite } = await import("@/lib/portal/portal-invite-core")
      const invite = await createSystemPortalInvite({
        contactId,
        agentUserId: resolvedAgentUserId,
        sendMagicLink: true,
      }).catch((e: unknown) => ({ success: false, error: String(e) }))
      portalInvited = invite.success === true
      if (!portalInvited) {
        console.error("[home-value] portal invite failed:", (invite as { error?: string }).error)
      }
    } else {
      console.error(
        `[home-value] no agent users.id for brokerage=${resolvedBrokerageId} — contact ${contactId} gets no portal login`,
      )
    }

    // Step 4: INSERT valuation_requests with contact_id attached
    const { data: valuationRequest, error: valuationError } = await supabase
      .from("valuation_requests")
      .insert({
        contact_id: contactId,
        property_address: propertyAddress,
        city,
        state,
        zip_code: zipCode,
        bedrooms,
        bathrooms,
        square_feet: squareFeet,
        year_built: yearBuilt,
        condition,
        property_type: propertyType ?? null,
        qualification_data: qualificationData ?? null,
        agent_id: resolvedAgentId,
        brokerage_id: resolvedBrokerageId,
        utm_source: utmSource,
        ref_agent_slug: agentSlug,
      })
      .select("id")
      .single()

    if (valuationError || !valuationRequest) {
      console.error("Error creating valuation request:", valuationError)
      return { success: false, error: "Failed to create valuation request" }
    }

    // ── Kernel OS seller intake chain ────────────────────────────────────────
    // Home value form submitters have given explicit TCPA consent and are
    // created as contacts directly above. No raw_scraped_leads row is needed —
    // that table is for unauthenticated/non-consented inbound signals.
    // The lifecycle_event (Step 8) and agent notification (Step 9) below are
    // sufficient for Kernel to pick up this contact.

    // Activity for immediate agent CRM visibility
    if (resolvedAgentId) {
      await bestEffort(
        supabase.from("activities").insert({
          activity_type: "home_value_request_received",
          title: `Home value request: ${firstName} ${lastName}`,
          description: `${propertyAddress}, ${city}, ${state}`,
          notes: JSON.stringify({
            email,
            phone: tcpaConsent ? phone : null,
            sell_timeline: qualificationData?.sellTimeline ?? null,
            motivation: qualificationData?.motivation ?? null,
            valuation_request_id: valuationRequest.id,
          }),
          contact_id: contactId,
          agent_id: resolvedAgentId,
          brokerage_id: resolvedBrokerageId,
          entity_type: "contact",
          status: "pending",
          priority: qualificationData?.sellTimeline === "immediately" ? "high" : "medium",
        }),
        "the contact, the valuation_request and the lifecycle event are all already committed and error-checked above; this row only front-runs them onto the agent's CRM feed, so it must not fail a home-value request the consumer has already submitted",
      )
    }

    // Step 5: Generate the estimate from adjusted comparable sales (runAiCma).
    // brokerageId is required — it is what meters the comp pull against the
    // tenant. contactId lets the CMA engine attribute the run to this seller.
    const aiValuation = await generateAIValuation({
      propertyAddress,
      city,
      state,
      zipCode,
      bedrooms,
      bathrooms,
      squareFeet,
      yearBuilt,
      condition,
      propertyType: propertyType ?? null,
      brokerageId: resolvedBrokerageId,
      contactId,
      supabase,
    })

    // Step 6: INSERT home_value_estimates
    //
    // estimated_equity stays NULL. It used to be written as mid × 0.3 — a flat
    // "default assumption" that every seller holds 30% equity. The form never
    // asks for a mortgage balance, so equity is not derivable from anything on
    // this record, and a made-up number sitting in a column named
    // estimated_equity is exactly the kind of value a later reader treats as
    // measured. Nothing reads it today; when a real payoff figure is collected,
    // fill it from that.

    // The insert RETURNS the row as the database stored it. Everything downstream
    // — the portal card and the email — reads THIS, not `aiValuation`. Same row,
    // one set of figures, so the two surfaces cannot disagree and neither one
    // recomputes a value the record does not hold.
    const { data: storedEstimate, error: estimateError } = await supabase
      .from("home_value_estimates")
      .insert({
        valuation_request_id: valuationRequest.id,
        contact_id: contactId,
        brokerage_id: resolvedBrokerageId,
        property_address: propertyAddress,
        estimated_value_low: aiValuation.estimated_value_low,
        estimated_value_mid: aiValuation.estimated_value_mid,
        estimated_value_high: aiValuation.estimated_value_high,
        estimated_equity: null,
        confidence_score: aiValuation.confidence_score,
        // The method that actually produced the number — 'ai_cma' only when
        // adjusted comparable sales backed it.
        methodology: aiValuation.methodology,
        comps_json: aiValuation.comps,
        market_trend: aiValuation.market_trend,
        ai_narrative: aiValuation.ai_narrative,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      })
      .select(
        "id, property_address, estimated_value_low, estimated_value_mid, estimated_value_high, confidence_score, methodology, market_trend, ai_narrative, comps_json",
      )
      .single()

    if (estimateError || !storedEstimate) {
      console.error("Error creating estimate:", estimateError)
      return { success: false, error: "Failed to create estimate" }
    }

    // Step 7: UPDATE contacts.home_value_estimate
    const { error: contactValueError } = await supabase
      .from("contacts")
      .update({ home_value_estimate: storedEstimate.estimated_value_mid })
      .eq("id", contactId)
    if (contactValueError) {
      console.error("[home-value] contacts.home_value_estimate write failed:", contactValueError.message)
    }

    // Step 8: EMIT HOME_VALUE_CONTACT_CREATED kernel event
    await supabase.from("lifecycle_events").insert({
      brokerage_id: resolvedBrokerageId,
      entity_type: "contact",
      entity_id: contactId,
      event_type: KernelEvent.HOME_VALUE_CONTACT_CREATED,
      metadata: {
        request_id: valuationRequest.id,
        estimated_value: aiValuation.estimated_value_mid,
        property_address: propertyAddress,
      },
    })

    // Step 9: Notify the assigned agent via the notifications table.
    // notifications.user_id is a USERS id — resolved once above, not re-fetched
    // and not substituted with the agents id.
    if (resolvedAgentUserId) {
      const { error: notifyError } = await supabase.from("notifications").insert({
        user_id: resolvedAgentUserId,
        brokerage_id: resolvedBrokerageId,
        type: "home_value_lead",
        title: "New Home Value Request",
        body: `${firstName} ${lastName} requested a home value for ${propertyAddress}, ${city || zipCode}. Timeline: ${qualificationData?.sellTimeline ?? "unknown"}. Motivation: ${qualificationData?.motivation ?? "unknown"}. Review and start a drip campaign.`,
        entity_type: "contact",
        entity_id: contactId,
        priority: "high",
        is_read: false,
        channel: "in_app",
      })
      if (notifyError) {
        console.error("[home-value] agent notification write failed:", notifyError.message)
      }
    }

    // ── Step 9b: THE REPORT REACHES THE SELLER — portal card, then email ──────
    // Both are driven off `storedEstimate` (the row as written) and both offer
    // the ≥7-day listing appointment. Neither is allowed to break the
    // submission: the seller already has their result page either way.
    await deliverHomeValueReport({
      supabase,
      brokerageId: resolvedBrokerageId,
      contactId,
      requestId: valuationRequest.id,
      firstName,
      recipientEmail: email,
      agentUserId: resolvedAgentUserId,
      agentId: resolvedAgentId,
      portalInvited,
      estimate: storedEstimate,
    })

    // Step 10: AUTONOMOUS ENROLMENT. This used to look for a sequence by
    // `trigger_event = 'home_value_submitted'` OR `sequence_type = 'seller_nurture'`
    // — neither is a value its column's CHECK admits, so the lookup matched
    // nothing on every run and no home-value capture was ever enrolled in
    // anything. The sequence is now selected by (source_key, persona), the
    // discriminator m293 added, and the enroller is shared with the lead-magnet
    // capture so the two cannot drift apart again.
    await autoEnrollContact(supabase, {
      brokerageId: resolvedBrokerageId,
      contactId,
      source: CONTACT_SOURCE_HOME_VALUE,
      contactType: "seller",
      // Persona (first_time / downsize / divorce / probate / …) is the SITUATION,
      // and a home-value form does not reveal it. Left null so a persona-agnostic
      // seller sequence is chosen; the ISA/campaign managers set it later from
      // the qualification answers, and the next situational touch keys on it.
      contactPersona: null,
      enrolledBy: resolvedAgentId ?? null,
    })

    // Step 11: Return requestId for redirect
    return { success: true, requestId: valuationRequest.id }
  } catch (error) {
    console.error("Error in submitHomeValueRequest:", error)
    return { success: false, error: "An unexpected error occurred" }
  }
}

// ============================================================================
// deliverHomeValueReport — the report reaches the seller on BOTH surfaces
//
// "the report will show up in their portal and also an email will be sent with
//  it both the email and the portal will be given a way to schedule a listing
//  appotintment as well"
//
// ONE source of figures: the `home_value_estimates` row exactly as it was
// stored. Nothing here recomputes a value, and if the row does not carry a
// usable range nothing is sent at all — an empty report is honest, a fabricated
// one is not.
//
// Not exported: it is one step of the submission, not a separate capability, and
// a "use server" module may only export async functions that are real actions.
// ============================================================================

/** The stored columns both surfaces render. Shaped by the insert's .select(). */
interface StoredHomeValueEstimate {
  id: string
  property_address: string | null
  estimated_value_low: number | null
  estimated_value_mid: number | null
  estimated_value_high: number | null
  confidence_score: number | null
  methodology: string | null
  market_trend: string | null
  ai_narrative: string | null
  comps_json: unknown
}

async function deliverHomeValueReport(args: {
  supabase: ReturnType<typeof createServiceClient>
  brokerageId: string
  contactId: string
  requestId: string
  firstName: string
  recipientEmail: string
  agentUserId: string | null
  agentId: string | null
  portalInvited: boolean
  estimate: StoredHomeValueEstimate
}): Promise<void> {
  const { estimate } = args

  const low = args.estimate.estimated_value_low
  const mid = args.estimate.estimated_value_mid
  const high = args.estimate.estimated_value_high

  // No range means no report. Say nothing rather than send a blank or a guess.
  if (typeof low !== "number" || typeof mid !== "number" || typeof high !== "number") {
    console.error(
      `[home-value] estimate ${estimate.id} carries no value range — no portal card and no email sent`,
    )
    return
  }

  const address = estimate.property_address ?? "your home"
  const compsCount = Array.isArray(estimate.comps_json) ? estimate.comps_json.length : 0
  const usd = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

  // ── 1. THE PORTAL ────────────────────────────────────────────────────────
  // transparency_updates is the portal's "what's happening" feed — the same
  // table the kernel fan-out and the offer net sheet write, rendered by
  // RecentUpdatesFeed on the buyer / seller / lifetime homes. pushPortalValueCard
  // is the shared primitive for it: is_visible_to_client = true (an invisible
  // card defeats the point) and idempotent per (contact, update_type, day).
  // The full report itself is rendered by <HomeValueReportCard> on the portal
  // home, which reads this same home_value_estimates row.
  const card = await pushPortalValueCard(
    {
      brokerageId: args.brokerageId,
      contactId: args.contactId,
      title: "Your home value report is ready",
      summary:
        `We estimate ${address} at ${usd(mid)} — a range of ${usd(low)} to ${usd(high)}. ` +
        `Open your portal to see how we got there, and to book a listing appointment when you're ready ` +
        `(we schedule those at least ${LISTING_APPOINTMENT_MIN_LEAD_DAYS} days out).`,
      updateType: "home_value_report",
      metadata: {
        home_value_estimate_id: estimate.id,
        valuation_request_id: args.requestId,
        methodology: estimate.methodology,
        confidence_score: estimate.confidence_score,
      },
    },
    args.supabase,
  )
  if (!card.pushed && card.reason !== "duplicate_within_window") {
    console.error(`[home-value] portal card not written for contact ${args.contactId}: ${card.reason}`)
  }

  // ── 2. THE EMAIL ─────────────────────────────────────────────────────────
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
  if (!appUrl) {
    // Same discipline the pre-listing drip uses: refuse to email links that
    // resolve nowhere rather than send a report the seller cannot open.
    console.error(
      "[home-value] NEXT_PUBLIC_APP_URL is not configured — refusing to email a report whose links resolve nowhere",
    )
    return
  }
  const reportUrl = `${appUrl}/home-value/result/${args.requestId}`

  // Who it comes from, for the closing line. users.id → first/last name.
  let agentName: string | null = null
  if (args.agentUserId) {
    const { data: agentUser, error: agentUserError } = await args.supabase
      .from("users")
      .select("first_name, last_name")
      .eq("id", args.agentUserId)
      .maybeSingle()
    if (agentUserError) {
      console.error("[home-value] agent name lookup refused:", agentUserError.message)
    } else if (agentUser) {
      agentName = [agentUser.first_name, agentUser.last_name].filter(Boolean).join(" ") || null
    }
  }

  const composed = composeHomeValueReportEmail({
    firstName: args.firstName,
    propertyAddress: address,
    estimatedValueLow: low,
    estimatedValueMid: mid,
    estimatedValueHigh: high,
    confidenceScore: estimate.confidence_score,
    methodology: estimate.methodology,
    marketTrend: estimate.market_trend,
    compsCount,
    aiNarrative: estimate.ai_narrative,
    reportUrl,
    // Only offered when a portal login was actually issued — a "log in to your
    // portal" link for a contact with no invite is a dead end.
    portalUrl: args.portalInvited ? `${appUrl}/portal/${args.contactId}` : null,
    // The ≥7-day scheduler lives on the same report page the seller already owns,
    // so the email's way in works with no login.
    listingAppointmentUrl: `${reportUrl}#listing-appointment`,
    agentName,
  })

  // THE GATE. dispatchEmail — never a provider call — so suppression, the
  // contact's consent posture, quiet hours and de-confliction all fire. The
  // homeowner asked for this specific report on this specific address and gave
  // TCPA consent on the form, so the purpose is TRANSACTIONAL, not campaign.
  const { dispatchEmail } = await import("@/lib/providers/dispatch")
  const sent = await dispatchEmail({
    brokerageId: args.brokerageId,
    contactId: args.contactId,
    // A USERS id — assembleEmail runs its signature waterfall off this. Passing
    // the agents id here would silently skip the agent + team signature tiers.
    userId: args.agentUserId ?? undefined,
    to: args.recipientEmail,
    subject: composed.subject,
    html: composed.html,
    text: composed.text,
    channelPurpose: "transactional",
    systemSource: "home_value_report",
    metadata: {
      home_value_estimate_id: estimate.id,
      valuation_request_id: args.requestId,
    },
  }).catch((e: unknown) => ({ success: false, providerKey: "exception", error: String(e) }))

  if (!sent.success) {
    console.error(`[home-value] report email not delivered to contact ${args.contactId}: ${sent.error}`)
  }
}

// ============================================================================
// getHomeValueResult
// ============================================================================

export async function getHomeValueResult(requestId: string) {
  // PUBLIC read — the seller reaches this page straight off the form with no
  // session. Scoped by the valuation_request id, which is a per-row secret only
  // the seller was handed (it is their own result URL).
  const supabase = createServiceClient()

  const { data: estimate, error } = await supabase
    .from("home_value_estimates")
    .select(`
      *,
      valuation_requests (
        property_address,
        city,
        state,
        zip_code,
        bedrooms,
        bathrooms,
        square_feet,
        year_built,
        condition,
        ref_agent_slug,
        brokerage_id,
        contact_id
      )
    `)
    .eq("valuation_request_id", requestId)
    .single()

  if (error || !estimate) {
    return { success: false, error: "Estimate not found" }
  }

  // If agent slug, fetch agent info
  let agent = null
  const agentSlug = estimate.valuation_requests?.ref_agent_slug

  if (agentSlug) {
    const { data: agentData, error: agentError } = await supabase
      .from("agents")
      .select("id, phone_mobile, profile_image_url, users(first_name, last_name, email)")
      .eq("public_slug", agentSlug)
      .maybeSingle()

    if (agentError) {
      console.error("[home-value] result-page agent read refused:", agentError.message)
    } else if (agentData) {
      const agentUser = (agentData.users as any) ?? null
      agent = {
        id: agentData.id,
        first_name: agentUser?.first_name ?? null,
        last_name: agentUser?.last_name ?? null,
        phone_mobile: agentData.phone_mobile ?? null,
        email: agentUser?.email ?? null,
        profile_image_url: agentData.profile_image_url ?? null,
      }
    }
  }

  const vr = estimate.valuation_requests as any
  const resolvedContactId: string | null = estimate.contact_id ?? vr?.contact_id ?? null

  // THE HOMEOWNER'S OWN NAME. The booking cards stamp it on the appointment and
  // into the agent's notification ("<name> booked a listing appointment"). The
  // page used to pass the AGENT's name into that slot, so every booking told the
  // agent they had booked with themselves. Distinct identities, resolved here.
  let contactName: string | null = null
  if (resolvedContactId) {
    const { data: contactRow, error: contactRowError } = await supabase
      .from("contacts")
      .select("first_name, last_name")
      .eq("id", resolvedContactId)
      .maybeSingle()
    if (contactRowError) {
      console.error("[home-value] result-page contact read refused:", contactRowError.message)
    } else if (contactRow) {
      contactName = [contactRow.first_name, contactRow.last_name].filter(Boolean).join(" ") || null
    }
  }

  return {
    success: true,
    requestId,
    contactName,
    estimate: {
      id: estimate.id,
      propertyAddress: estimate.property_address,
      estimatedValueLow: estimate.estimated_value_low,
      estimatedValueMid: estimate.estimated_value_mid,
      estimatedValueHigh: estimate.estimated_value_high,
      estimatedEquity: estimate.estimated_equity,
      confidenceScore: estimate.confidence_score,
      methodology: estimate.methodology,
      comps: estimate.comps_json || [],
      marketTrend: estimate.market_trend,
      aiNarrative: estimate.ai_narrative,
      generatedAt: estimate.generated_at,
      expiresAt: estimate.expires_at,
      propertyDetails: estimate.valuation_requests,
    },
    brokerageId: vr?.brokerage_id ?? null,
    contactId: resolvedContactId,
    agent,
  }
}

// ============================================================================
// AI Valuation Generation
// ============================================================================

/** Seller-facing condition wording → the 1-5 grade the adjustment engine uses. */
const CONDITION_GRADE: Record<string, number> = {
  excellent: 5,
  good:      4,
  fair:      3,
  poor:      2,
}

/** runAiCma only adjusts against these three; anything else has no rate table. */
function cmaPropertyType(raw: string | null | undefined): "single_family" | "condo" | "townhouse" | null {
  return raw === "single_family" || raw === "condo" || raw === "townhouse" ? raw : null
}

/**
 * Market direction from the market_data OBSERVATION, never from a model's guess.
 * Narrowest geography first (ZIP, then city+state) and only rows carrying a
 * 1-year price trend. No row → "unknown", which the result page renders as
 * "Market trend not yet available" rather than inventing a direction.
 */
async function resolveMarketTrend(
  supabase: ReturnType<typeof createServiceClient>,
  where: { zipCode?: string | null; city?: string | null; state?: string | null }
): Promise<AIValuationResponse["market_trend"]> {
  const read = async (col: "zip_code" | "city", value: string) => {
    let q = supabase
      .from("market_data")
      .select("price_trend_pct_1yr")
      .eq(col, value)
      .not("price_trend_pct_1yr", "is", null)
      .order("data_date", { ascending: false })
      .limit(1)
    if (col === "city" && where.state) q = q.eq("state", where.state)
    const { data, error } = await q.maybeSingle()
    if (error) {
      console.error("[home-value] market_data read refused:", error.message)
      return null
    }
    return data?.price_trend_pct_1yr ?? null
  }

  const pct = (where.zipCode ? await read("zip_code", where.zipCode) : null)
    ?? (where.city ? await read("city", where.city) : null)

  if (pct == null) return "unknown"
  // ±1% over a year is noise, not a direction.
  if (pct > 1) return "appreciating"
  if (pct < -1) return "depreciating"
  return "stable"
}

/**
 * SELLER VALUATION — adjusted comparable sales, or an honestly-labelled fallback.
 *
 * This used to ask a chat model to "Provide exactly 3 comparable sales" and wrote
 * whatever came back into home_value_estimates.comps_json, which the public result
 * page renders as "N similar properties recently sold near you" — addresses, sale
 * prices and sale dates that no transaction ever produced, shown to a homeowner as
 * fact. It also stamped methodology:'ai_cma' while doing nothing of the kind.
 *
 * The real CMA engine already existed: lib/cma/ai-cma-orchestrator.runAiCma —
 * grounded comp sourcing with citations, state appraiser-guideline adjustment
 * rates applied per comp deterministically, a value range derived from the
 * ADJUSTED prices, confidence from comp count + similarity + spread, and its own
 * disclaimers. It is what the workflow AVM/CMA adapter and the listing-presentation
 * builder already use. This lane now uses it too, so there is one valuation
 * method in the product instead of two.
 *
 * When no comps come back the range would be zero, so we fall back to sqft × a
 * conservative regional rate — the SAME arithmetic as before, but returned with
 * comps: [] and methodology:'sqft_regional_average' so the record says what it is.
 */
async function generateAIValuation(propertyData: {
  propertyAddress: string
  city: string
  state: string
  zipCode: string
  bedrooms: number
  bathrooms: number
  squareFeet: number
  yearBuilt: number
  condition: string
  propertyType?: string | null
  brokerageId: string
  contactId?: string | null
  agentUserId?: string | null
  supabase: ReturnType<typeof createServiceClient>
}): Promise<AIValuationResponse> {
  const marketTrend = await resolveMarketTrend(propertyData.supabase, {
    zipCode: propertyData.zipCode,
    city: propertyData.city,
    state: propertyData.state,
  })

  try {
    const { runAiCma } = await import("@/lib/cma/ai-cma-orchestrator")
    const cma = await runAiCma({
      mode: "standard",
      brokerageId: propertyData.brokerageId,
      agentUserId: propertyData.agentUserId ?? null,
      contactId: propertyData.contactId ?? null,
      subject: {
        address: propertyData.propertyAddress,
        city: propertyData.city,
        state: propertyData.state,
        zip: propertyData.zipCode,
        propertyType: cmaPropertyType(propertyData.propertyType),
        sqftLiving: propertyData.squareFeet || null,
        bedrooms: propertyData.bedrooms || null,
        // The seller form collects one bathroom count, not a full/half split.
        fullBaths: propertyData.bathrooms || null,
        halfBaths: null,
        yearBuilt: propertyData.yearBuilt || null,
        conditionGrade: CONDITION_GRADE[propertyData.condition] ?? null,
      },
    })

    // A zero mid means no comp survived — there is nothing to show a seller.
    if (cma.estimatedValueMid <= 0 || cma.adjustedComps.length === 0) {
      throw new Error("no comparable sales returned")
    }

    const comps: SellerComp[] = cma.adjustedComps.map((a) => {
      const baths = (a.comp.fullBaths ?? 0) + (a.comp.halfBaths ?? 0) * 0.5
      const sqft = a.comp.sqftLiving ?? 0
      return {
        address: a.comp.address,
        sale_price: Math.round(a.comp.salePrice),
        beds: a.comp.bedrooms ?? 0,
        baths,
        sqft,
        price_per_sqft: Math.round(
          a.comp.pricePerSqft ?? (sqft > 0 ? a.comp.salePrice / sqft : 0)
        ),
        sale_date: a.comp.saleDate,
        // Real per-comp distance when the provider published one (RentCast
        // does); null — rendered "—" — when it did not.
        distance_miles: a.comp.distanceMiles ?? null,
        citation: a.comp.citation ?? null,
      }
    })

    return {
      estimated_value_low: cma.estimatedValueLow,
      estimated_value_mid: cma.estimatedValueMid,
      estimated_value_high: cma.estimatedValueHigh,
      // runAiCma reports confidence 0..1; this column stores 0-100.
      confidence_score: Math.round(cma.confidenceScore * 100),
      market_trend: marketTrend,
      ai_narrative: [cma.aiNarrative, ...cma.disclaimers].filter(Boolean).join("\n\n"),
      comps,
      methodology: "ai_cma",
    }
  } catch (error) {
    console.error("[home-value] CMA unavailable, falling back to regional sqft rate:", error)
    // No comparable sales could be sourced. Same arithmetic as before — sqft ×
    // a conservative regional rate — but returned with NO comps and labelled
    // sqft_regional_average, because calling this a CMA on the stored record
    // was the lie that let three invented sales reach a homeowner's screen.
    // confidence_score is 35, not the old 60: this is the weakest method we
    // have, and the number should say so.
    const pricePerSqft = 200 // Conservative default
    const baseValue = propertyData.squareFeet * pricePerSqft

    return {
      estimated_value_low: Math.round(baseValue * 0.9),
      estimated_value_mid: Math.round(baseValue),
      estimated_value_high: Math.round(baseValue * 1.1),
      confidence_score: 35,
      market_trend: marketTrend,
      ai_narrative:
        "We could not find enough recent comparable sales near your home to build a comparative market analysis, so this range is based on a regional average price per square foot — it does not account for your home's condition, upgrades, lot or location within the neighborhood. A local agent can walk the property and give you a figure grounded in real recent sales.",
      comps: [],
      methodology: "sqft_regional_average",
    }
  }
}

// ============================================================================
// AGENT SLOT LOADING — ONE appointment, ONE lead time
//
// The home-value lane books exactly ONE meeting: the listing appointment, which
// the owner also calls the home value appointment. It offers 1-hour slots inside
// the agent's configured working hours (home_value_page_configs.working_hours,
// default Mon–Fri 9–5), conflict-checked against that agent's calendar_events,
// starting no earlier than LISTING_APPOINTMENT_MIN_LEAD_DAYS out.
//
// This used to be parameterised for a SECOND booking — a 48-hour "walk-through
// evaluation" — that the owner has since ruled is the same meeting. That path is
// gone: it also wrote an event_type ('home_valuation_appointment') that nothing
// in the system ever read, so it produced no presentation and no seller drip.
//
// The offered slots and the server's refusal are computed from the SAME
// boundary, so the UI can never present a time the booking action will reject.
// ============================================================================

export interface AgentSlotOption {
  id: string
  userId: string
  firstName: string
  lastName: string
  phone: string | null
  email: string | null
  profileImageUrl: string | null
  slots: Array<{ startAt: string; endAt: string; label: string }>
}

/**
 * getListingAppointmentSlots — THE ONE bookable meeting in the home-value lane.
 *
 * "both the email and the portal will be given a way to schedule a listing
 *  appotintment ... which needs to be atleast 7 days out", and "the 7 day floor is
 *  only for listing appointments (also called home value appointments)".
 *
 * The first offered slot IS earliestListingAppointmentAt(), the same instant
 * scheduleSellerListingAppointment refuses below, so the seller is never shown a
 * time the server will turn down.
 */
export async function getListingAppointmentSlots(
  brokerageId: string,
): Promise<{ success: boolean; agents?: AgentSlotOption[]; error?: string }> {
  // PUBLIC lane — the result page and the portal both reach this without an
  // agent session. Tenant scope is the explicit brokerage_id filter below.
  const supabase = createServiceClient()

  // The floor is 7 days, so the window has to run past it to show anything —
  // 7 days of lead time plus a fortnight of choices.
  const opts = {
    earliest: earliestListingAppointmentAt(),
    windowDays: LISTING_APPOINTMENT_MIN_LEAD_DAYS + 14,
  }

  // Fetch all active agents for this brokerage
  const { data: agents, error: agentsError } = await supabase
    .from("agents")
    .select("id, user_id, phone_mobile, profile_image_url, brokerage_id, users(first_name, last_name, email)")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .limit(10)

  if (agentsError) {
    console.error("[home-value] agent slot read refused:", agentsError.message)
    return { success: false, error: "Scheduling is unavailable right now." }
  }
  if (!agents?.length) {
    return { success: false, error: "No agents available" }
  }

  const now = new Date()
  const earliestSlot = opts.earliest
  const windowEnd = new Date(now.getTime() + opts.windowDays * 24 * 60 * 60 * 1000)

  const agentIds = agents.map((a) => a.id)

  // Fetch existing calendar events and agent page configs in parallel
  const [eventsRes, configsRes] = await Promise.all([
    supabase
      .from("calendar_events")
      .select("entity_id, start_at, end_at")
      .in("entity_id", agentIds)
      .eq("entity_type", "agent")
      .gte("start_at", now.toISOString())
      .lte("start_at", windowEnd.toISOString()),
    supabase
      .from("home_value_page_configs")
      .select("agent_id, working_hours, show_scheduler")
      .in("agent_id", agentIds),
  ])

  // A refused conflict read resolves as "nothing is booked" and would offer
  // times the agent is already in. Refuse to offer anything instead.
  if (eventsRes.error) {
    console.error("[home-value] calendar conflict read refused:", eventsRes.error.message)
    return { success: false, error: "Scheduling is unavailable right now." }
  }
  if (configsRes.error) {
    console.error("[home-value] scheduler config read refused:", configsRes.error.message)
    return { success: false, error: "Scheduling is unavailable right now." }
  }

  const bookedByAgent: Record<string, Array<{ start: Date; end: Date }>> = {}
  for (const ev of eventsRes.data ?? []) {
    if (!bookedByAgent[ev.entity_id]) bookedByAgent[ev.entity_id] = []
    // end_at is nullable; a start-only event still blocks its hour.
    const start = new Date(ev.start_at)
    const end = ev.end_at ? new Date(ev.end_at) : new Date(start.getTime() + 60 * 60 * 1000)
    bookedByAgent[ev.entity_id].push({ start, end })
  }

  // Map agent_id -> working_hours config (fall back to Mon-Fri 9-17 if no config)
  const DEFAULT_HOURS: WorkingHourSlot[] = [
    { day: 1, start_hour: 9, end_hour: 17 },
    { day: 2, start_hour: 9, end_hour: 17 },
    { day: 3, start_hour: 9, end_hour: 17 },
    { day: 4, start_hour: 9, end_hour: 17 },
    { day: 5, start_hour: 9, end_hour: 17 },
  ]
  const configByAgent: Record<string, { hours: WorkingHourSlot[]; showScheduler: boolean }> = {}
  for (const c of configsRes.data ?? []) {
    configByAgent[c.agent_id] = {
      hours: (c.working_hours as WorkingHourSlot[]) ?? DEFAULT_HOURS,
      showScheduler: c.show_scheduler ?? true,
    }
  }

  // Generate 1-hour slots within agent-defined working hours, no earlier than
  // `earliestSlot` — the SAME boundary the booking action enforces server-side.
  function generateSlots(agentId: string): Array<{ startAt: string; endAt: string; label: string }> {
    const slots: Array<{ startAt: string; endAt: string; label: string }> = []
    const booked = bookedByAgent[agentId] ?? []
    const agentConfig = configByAgent[agentId]

    // Skip scheduler-disabled agents
    if (agentConfig && agentConfig.showScheduler === false) return []

    const hours = agentConfig?.hours ?? DEFAULT_HOURS
    // Build a fast lookup: day -> [{start_hour, end_hour}]
    const hoursByDay: Record<number, Array<{ start: number; end: number }>> = {}
    for (const h of hours) {
      if (!hoursByDay[h.day]) hoursByDay[h.day] = []
      hoursByDay[h.day].push({ start: h.start_hour, end: h.end_hour })
    }

    for (let dayOffset = 0; dayOffset <= opts.windowDays; dayOffset++) {
      const d = new Date(now)
      d.setDate(d.getDate() + dayOffset)
      d.setHours(0, 0, 0, 0)
      const dow = d.getDay()
      const dayRanges = hoursByDay[dow]
      if (!dayRanges?.length) continue

      for (const range of dayRanges) {
        for (let h = range.start; h < range.end; h++) {
          const slotStart = new Date(d)
          slotStart.setHours(h, 0, 0, 0)
          const slotEnd = new Date(slotStart)
          slotEnd.setHours(h + 1)

          // The lead-time floor for THIS appointment kind.
          if (slotStart < earliestSlot) continue

          const conflict = booked.some((b) => slotStart < b.end && slotEnd > b.start)
          if (!conflict) {
            slots.push({
              startAt: slotStart.toISOString(),
              endAt: slotEnd.toISOString(),
              label: slotStart.toLocaleString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              }),
            })
          }
          if (slots.length >= 20) break
        }
        if (slots.length >= 20) break
      }
      if (slots.length >= 20) break
    }
    return slots
  }

  const result = agents.map((agent) => {
    const user = Array.isArray(agent.users) ? agent.users[0] : (agent.users as any)
    return {
      id: agent.id,
      userId: agent.user_id,
      firstName: user?.first_name ?? "",
      lastName: user?.last_name ?? "",
      phone: agent.phone_mobile ?? null,
      email: user?.email ?? null,
      profileImageUrl: agent.profile_image_url ?? null,
      slots: generateSlots(agent.id),
    }
  }).filter((a) => a.slots.length > 0)

  if (result.length === 0) return { success: false, error: "No agents available" }
  return { success: true, agents: result }
}

// ============================================================================
// scheduleSellerListingAppointment — THE ≥7-DAY BOOKING
//
// "both the email and the portal will be given a way to schedule a listing
//  appotintment as well which needs to be atleast 7 days out"
//
// The floor is enforced HERE, on the server, because that is the only place it
// can be enforced. getListingAppointmentSlots offers nothing earlier, but a
// client can post any timestamp it likes straight at this action, so filtering
// the offered slots is presentation — this is the authority.
//
// It writes calendar_events.event_type = 'listing_appointment' — the SAME value
// lib/application/listing-lifecycle.ts writes for an agent-booked listing
// consult, so this seller's meeting is the same first-class kind of event on the
// agent's calendar and not a private synonym. entity_type is 'agent' (not
// 'listing') because this seller has no listing row yet; there is nothing to
// point at and inventing one would be a fabricated record.
// ============================================================================

export async function scheduleSellerListingAppointment(args: {
  contactId: string
  agentId: string
  brokerageId: string
  startAt: string // ISO
  endAt: string // ISO
  propertyAddress: string
  contactName: string
}): Promise<{ success: boolean; calendarEventId?: string; error?: string }> {
  const eventTitle = `Listing Appointment — ${args.propertyAddress}`

  // PUBLIC lane: the caller is an unauthenticated seller (result page) or a
  // portal contact. Every id it hands us is therefore UNTRUSTED.
  const supabase = createServiceClient()

  const start = new Date(args.startAt)
  const end = new Date(args.endAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { success: false, error: "That time is not valid. Please pick another." }
  }

  // ── THE LEAD-TIME FLOOR ────────────────────────────────────────────────────
  // The ONE appointment this lane books carries it. Unconditional: there is no
  // second, floor-less kind of home-value booking any more.
  if (start < earliestListingAppointmentAt()) {
    return { success: false, error: LISTING_APPOINTMENT_TOO_SOON_ERROR }
  }

  // ── TENANCY. The service client bypasses RLS, so the ids in the payload are
  // verified against the brokerage before anything is written. Without this a
  // caller could book on any agent in any tenant on behalf of any contact.
  const [agentCheck, contactCheck] = await Promise.all([
    supabase
      .from("agents")
      .select("id, user_id")
      .eq("id", args.agentId)
      .eq("brokerage_id", args.brokerageId)
      .maybeSingle(),
    supabase
      .from("contacts")
      .select("id")
      .eq("id", args.contactId)
      .eq("brokerage_id", args.brokerageId)
      .maybeSingle(),
  ])
  if (agentCheck.error || contactCheck.error) {
    console.error(
      "[home-value] booking identity check refused:",
      agentCheck.error?.message ?? contactCheck.error?.message,
    )
    return { success: false, error: "Booking is unavailable right now. Please try again." }
  }
  if (!agentCheck.data || !contactCheck.data) {
    return { success: false, error: "We couldn't match that agent and contact. Please reload and try again." }
  }
  const agentUserId: string | null = agentCheck.data.user_id ?? null

  // Double-check the slot is still free. end_at is nullable on calendar_events,
  // so an event with no end would fall out of a `.gt("end_at", …)` filter —
  // fetch this agent's overlapping window and compare in code.
  const { data: sameDayEvents, error: conflictError } = await supabase
    .from("calendar_events")
    .select("id, start_at, end_at")
    .eq("entity_type", "agent")
    .eq("entity_id", args.agentId)
    .gte("start_at", new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString())
    .lte("start_at", args.endAt)

  if (conflictError) {
    // A refused conflict read resolves as "nothing booked" and would double-book
    // the agent. Refuse the booking instead.
    console.error("[home-value] booking conflict read refused:", conflictError.message)
    return { success: false, error: "Booking is unavailable right now. Please try again." }
  }

  const conflict = (sameDayEvents ?? []).some((ev) => {
    const evStart = new Date(ev.start_at)
    const evEnd = ev.end_at ? new Date(ev.end_at) : new Date(evStart.getTime() + 60 * 60 * 1000)
    return start < evEnd && end > evStart
  })
  if (conflict) {
    return { success: false, error: "That time slot is no longer available. Please select another." }
  }

  // Insert calendar event
  const { data: calEvent, error: calError } = await supabase
    .from("calendar_events")
    .insert({
      brokerage_id: args.brokerageId,
      entity_type: "agent",
      entity_id: args.agentId,
      event_type: "listing_appointment",
      start_at: args.startAt,
      end_at: args.endAt,
      is_system_generated: false,
      title: eventTitle,
      // agent_user_id is the USERS id — the column downstream calendar sync and
      // the Zoom/transcript lanes read. agents.id lives in entity_id.
      agent_user_id: agentUserId,
      metadata: {
        contact_id: args.contactId,
        agent_id: args.agentId,
        property_address: args.propertyAddress,
        contact_name: args.contactName,
        source: "home_value_page",
      },
    })
    .select("id")
    .single()

  if (calError || !calEvent) {
    console.error("[home-value] calendar_events insert failed:", calError?.message)
    return { success: false, error: "Failed to book appointment. Please try again." }
  }

  // Insert activity record. activities is a consequential ledger — the broker's
  // evidence of what happened — so the write checks its own error.
  const { error: activityError } = await supabase.from("activities").insert({
    brokerage_id: args.brokerageId,
    agent_id: args.agentId,
    contact_id: args.contactId,
    activity_type: "listing_appointment",
    title: eventTitle,
    description: `Scheduled by ${args.contactName} via the home value tool.`,
    scheduled_at: args.startAt,
    status: "scheduled",
    priority: "high",
  })
  if (activityError) {
    console.error("[home-value] appointment activity write failed:", activityError.message)
  }

  // Notify the agent. notifications.user_id is a USERS id.
  if (agentUserId) {
    const when = new Date(args.startAt).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    })
    const { error: notifyError } = await supabase.from("notifications").insert({
      user_id: agentUserId,
      brokerage_id: args.brokerageId,
      type: "appointment_scheduled",
      title: "Listing Appointment Booked",
      body: `${args.contactName} booked a listing appointment for ${args.propertyAddress} on ${when}.`,
      entity_type: "contact",
      entity_id: args.contactId,
      priority: "high",
      is_read: false,
      channel: "in_app",
    })
    if (notifyError) {
      console.error("[home-value] appointment notification write failed:", notifyError.message)
    }
  }

  return { success: true, calendarEventId: calEvent.id }
}

// ============================================================================
// getAgentBySlug (for personalization)
// ============================================================================

export async function getAgentBySlug(slug: string) {
  // PUBLIC read — the landing page personalises itself for an anonymous visitor.
  // public_slug is a globally-unique public handle: the row IS the scope.
  const supabase = createServiceClient()

  const { data: agent, error } = await supabase
    .from("agents")
    .select("id, user_id, phone_mobile, profile_image_url, brokerage_id, users(first_name, last_name, email)")
    .eq("public_slug", slug)
    .maybeSingle()

  if (error) {
    console.error("[home-value] agent slug read refused:", error.message)
    return null
  }
  if (!agent) return null
  const user = Array.isArray(agent.users) ? agent.users[0] : (agent.users as any)
  return {
    id: agent.id,
    user_id: agent.user_id,
    first_name: user?.first_name ?? "",
    last_name: user?.last_name ?? "",
    email: user?.email ?? null,
    phone_mobile: agent.phone_mobile ?? null,
    profile_image_url: agent.profile_image_url ?? null,
    brokerage_id: agent.brokerage_id,
  }
}

// ============================================================================
// HomeValuePageConfig types
// ============================================================================

export interface WorkingHourSlot {
  day: number        // 0=Sun … 6=Sat
  start_hour: number // 0–23
  end_hour: number   // 0–23 (exclusive, so 20 means last slot starts at 19:00)
}

export interface HomeValuePageConfig {
  id?: string
  agentId: string
  brokerageId: string
  headline: string
  subheadline: string
  ctaButtonText: string
  primaryColor: string
  agentBioOverride: string | null
  showQSellTimeline: boolean
  showQMotivation: boolean
  showQMortgageStatus: boolean
  showQPriceExpectation: boolean
  showQHasAgent: boolean
  showQBuyAfterSell: boolean
  showQAdditionalNotes: boolean
  labelSellTimeline: string | null
  labelMotivation: string | null
  labelMortgageStatus: string | null
  labelPriceExpectation: string | null
  labelHasAgent: string | null
  labelBuyAfterSell: string | null
  workingHours: WorkingHourSlot[]
  showScheduler: boolean
}

// ============================================================================
// savePageConfig
// ============================================================================

export async function savePageConfig(config: HomeValuePageConfig): Promise<{ success: boolean; id?: string; error?: string }> {
  const supabase = await createClient()

  const row = {
    agent_id: config.agentId,
    brokerage_id: config.brokerageId,
    headline: config.headline,
    subheadline: config.subheadline,
    cta_button_text: config.ctaButtonText,
    primary_color: config.primaryColor,
    agent_bio_override: config.agentBioOverride,
    show_q_sell_timeline: config.showQSellTimeline,
    show_q_motivation: config.showQMotivation,
    show_q_mortgage_status: config.showQMortgageStatus,
    show_q_price_expectation: config.showQPriceExpectation,
    show_q_has_agent: config.showQHasAgent,
    show_q_buy_after_sell: config.showQBuyAfterSell,
    show_q_additional_notes: config.showQAdditionalNotes,
    label_sell_timeline: config.labelSellTimeline,
    label_motivation: config.labelMotivation,
    label_mortgage_status: config.labelMortgageStatus,
    label_price_expectation: config.labelPriceExpectation,
    label_has_agent: config.labelHasAgent,
    label_buy_after_sell: config.labelBuyAfterSell,
    working_hours: config.workingHours,
    show_scheduler: config.showScheduler,
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from("home_value_page_configs")
    .upsert(row, { onConflict: "agent_id" })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, id: data.id }
}

// ============================================================================
// getPageConfig — for the dashboard builder
// ============================================================================

export async function getPageConfig(agentId: string): Promise<HomeValuePageConfig | null> {
  // Read by BOTH the authenticated dashboard builder and the PUBLIC landing page
  // (getPageConfigByAgentId). The row is public-facing branding for one agent,
  // scoped by that agent_id — the anon client returned nothing for the public
  // caller, so every visitor saw the default headline instead of the agent's.
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("home_value_page_configs")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle()

  if (error) {
    console.error("[home-value] page config read refused:", error.message)
    return null
  }
  if (!data) return null

  return {
    id: data.id,
    agentId: data.agent_id,
    brokerageId: data.brokerage_id,
    headline: data.headline,
    subheadline: data.subheadline,
    ctaButtonText: data.cta_button_text,
    primaryColor: data.primary_color,
    agentBioOverride: data.agent_bio_override,
    showQSellTimeline: data.show_q_sell_timeline,
    showQMotivation: data.show_q_motivation,
    showQMortgageStatus: data.show_q_mortgage_status,
    showQPriceExpectation: data.show_q_price_expectation,
    showQHasAgent: data.show_q_has_agent,
    showQBuyAfterSell: data.show_q_buy_after_sell,
    showQAdditionalNotes: data.show_q_additional_notes,
    labelSellTimeline: data.label_sell_timeline,
    labelMotivation: data.label_motivation,
    labelMortgageStatus: data.label_mortgage_status,
    labelPriceExpectation: data.label_price_expectation,
    labelHasAgent: data.label_has_agent,
    labelBuyAfterSell: data.label_buy_after_sell,
    workingHours: (data.working_hours as WorkingHourSlot[]) ?? [],
    showScheduler: data.show_scheduler,
  }
}

// ============================================================================
// getPageConfigByAgentId — public-facing, used by home-value/page.tsx
// ============================================================================

export async function getPageConfigByAgentId(agentId: string): Promise<HomeValuePageConfig | null> {
  return getPageConfig(agentId)
}
