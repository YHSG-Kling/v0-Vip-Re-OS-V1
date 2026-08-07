/**
 * lib/listing-presentation/generate-ai-presentation.ts
 *
 * THE AI LISTING-PRESENTATION NARRATIVE — the implementation behind
 * app/actions/ai-listing-presentation.ts::generateListingPresentation and step 2
 * of the listing-appt-prep chain.
 *
 * WHY IT LIVES HERE AND NOT IN THE ACTION.
 *
 * It was written as a "use server" action gated on supabase.auth.getUser(). Two
 * of the three chain entry points run inside an authenticated request and were
 * fine; the third — lib/ai-isa/book-seller-appointment.ts, which the AI-ISA calls
 * from a webhook and which drives startRun() directly — has NO session, so the
 * gate returned { success:false, error:"Unauthorized" } and step 2 failed before
 * doing any work. Moving the body into a server-only module gives the unattended
 * caller a door it can actually walk through, while the action stays the gate for
 * anything reachable from a browser. Same shape as
 * lib/portal/portal-invite-core.ts::createSystemPortalInvite, for the same reason.
 *
 * brokerageId is the TENANT ANCHOR and is never taken from the wire: the action
 * derives it from the session, the chain from its run row. Everything below is
 * scoped to it, including the agent the presentation is written for.
 *
 * ONE ROW PER APPOINTMENT — this is NOT a second producer.
 *
 * lib/workflow/intelligence/listing-presentation-builder.ts::buildListingPresentation
 * (run by the listing-presentation-prep cron) writes the STRUCTURED presentation:
 * the CMA range, the 3-price net sheet, the slide deck, the packet — and
 * materializes the seller's section drip from it. If this function inserted its
 * own row for an appointment that already has one, materializePresentationSections
 * would build a SECOND set of sections on it and the seller would receive the
 * pre-listing drip twice. So when the appointment already has a presentation, the
 * AI narrative is written ONTO that row and its id is returned. There is one
 * presentation per listing appointment, whichever producer reaches it first.
 *
 * SELLER-SAFETY BOUNDARY: nothing here writes to presentation_sections and
 * nothing here is sent to the seller. The pre-listing drip is PRICE-WITHHELD; the
 * pricing this narrative carries is for the AGENT's deck, at the table.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { isValidUUID } from "@/lib/validations"
import { z } from "zod"

export interface AiListingPresentationPropertyData {
  address: string
  city: string
  /** 2-letter. listing_presentations.state is NOT NULL — no row without it. */
  state: string
  zipCode: string
  bedrooms: number
  bathrooms: number
  sqft: number
  lotSize?: number
  yearBuilt?: number
  propertyType: string
  features?: string[]
  condition?: string
  sellerMotivation?: string
  timeline?: string
}

export interface AiListingPresentationInput {
  /** TENANT ANCHOR. Session-derived or run-derived — never accepted from a client. */
  brokerageId: string
  /** agents.id (the plain `agent_id` spelling means agents(id) — see m366). */
  agentId: string
  contactId?: string | null
  /** calendar_events.id. The key that keeps this to ONE presentation per appointment. */
  appointmentId?: string | null
  appointmentAt?: string | null
  propertyData: AiListingPresentationPropertyData
  sellerInfo?: {
    name: string
    concerns?: string[]
    previousAgentExperience?: string
  }
  /**
   * The agent's own words for this seller, typed on the CMA → Presentation tab.
   *
   * Ported here from app/actions/cma-presentation/presentation-assembler.ts,
   * whose assemblePresentationContent() dropped it into a markdown string that
   * was never persisted. It is the one input this producer did not accept, and
   * losing it was the only thing that made the hardcoded template look like it
   * carried something this does not.
   */
  agentMessage?: string
  presentationType?: "full" | "mini" | "digital"
}

export interface AiListingPresentationResult {
  success: boolean
  presentation?: unknown
  /** A REAL listing_presentations.id. Never undefined on success — see the insert below. */
  presentationId?: string
  /** True when the AI narrative was written onto the presentation the prep cron had already built. */
  attachedToExisting?: boolean
  error?: string
}

const presentationSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  sections: z.array(z.object({
    sectionNumber: z.number(),
    title: z.string(),
    content: z.string(),
    bulletPoints: z.array(z.string()).optional(),
    visualSuggestion: z.string().optional(),
    talkingPoints: z.array(z.string()),
  })),
  marketAnalysis: z.object({
    summary: z.string(),
    comparablesSummary: z.string(),
    pricingStrategy: z.object({
      recommendedPrice: z.number(),
      priceRange: z.object({ low: z.number(), high: z.number() }),
      reasoning: z.string(),
    }),
    marketTrends: z.array(z.object({ trend: z.string(), impact: z.string() })),
    daysOnMarketExpectation: z.number(),
  }),
  marketingPlan: z.object({
    overview: z.string(),
    strategies: z.array(z.object({
      strategy: z.string(),
      description: z.string(),
      timeline: z.string(),
    })),
    digitalMarketing: z.array(z.string()),
    traditionalMarketing: z.array(z.string()),
    photography: z.string(),
    staging: z.string(),
    openHousePlan: z.string(),
  }),
  timeline: z.object({
    preListing: z.array(z.object({ task: z.string(), days: z.string() })),
    activeListing: z.array(z.object({ task: z.string(), days: z.string() })),
    underContract: z.array(z.object({ task: z.string(), days: z.string() })),
  }),
  valueProposition: z.object({
    mainMessage: z.string(),
    differentiators: z.array(z.string()),
    testimonialSuggestion: z.string(),
    guarantees: z.array(z.string()).optional(),
  }),
  objectionHandlers: z.array(z.object({
    objection: z.string(),
    response: z.string(),
    supporting: z.string(),
  })),
  closingSlide: z.object({
    headline: z.string(),
    callToAction: z.string(),
    nextSteps: z.array(z.string()),
  }),
  appendix: z.object({
    detailedComps: z.array(z.object({
      address: z.string(),
      soldPrice: z.number(),
      soldDate: z.string(),
      comparison: z.string(),
    })),
    agentBio: z.string(),
    testimonials: z.array(z.string()),
  }),
})

export async function generateAiListingPresentation(
  input: AiListingPresentationInput,
): Promise<AiListingPresentationResult> {
  if (!isValidUUID(input.brokerageId)) return { success: false, error: "Invalid brokerage ID" }
  if (!isValidUUID(input.agentId)) return { success: false, error: "Invalid agent ID" }
  if (input.contactId && !isValidUUID(input.contactId)) return { success: false, error: "Invalid contact ID" }
  if (input.appointmentId && !isValidUUID(input.appointmentId)) {
    return { success: false, error: "Invalid appointment ID" }
  }

  // The two columns the row cannot exist without. listing_presentations.state is
  // NOT NULL with no default, and a CMA is state-scoped: without a real state
  // there is nothing honest to write, so this refuses instead of guessing one.
  const propertyAddress = (input.propertyData?.address ?? "").trim()
  const state = (input.propertyData?.state ?? "").trim().toUpperCase()
  if (!propertyAddress) {
    return { success: false, error: "A property address is required to build a listing presentation" }
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    return {
      success: false,
      error: "A 2-letter property state is required to build a listing presentation",
    }
  }

  const svc = createServiceClient()

  try {
    // ── The agent, inside the caller's tenant. ────────────────────────────────
    // A refused read is not "no such agent": reporting "not found" for a refusal
    // would blame the data for an outage. It is checked and surfaced.
    const { data: agent, error: agentErr } = await svc
      .from("agents")
      .select("id, user_id, brokerage_id, specializations, years_experience, brand_voice_profile(*)")
      .eq("id", input.agentId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (agentErr) return { success: false, error: `Agent lookup failed: ${agentErr.message}` }
    if (!agent) return { success: false, error: "Agent not found in your brokerage" }

    // The agent's NAME lives on users, not agents — the prompt used to read
    // agents.first_name / agents.last_name, columns that do not exist, so every
    // presentation was written for "undefined undefined".
    let agentName = "Your agent"
    const agentUserId: string | null = (agent as any).user_id ?? null
    if (agentUserId) {
      const { data: agentUser, error: agentUserErr } = await svc
        .from("users").select("first_name, last_name").eq("id", agentUserId).maybeSingle()
      if (agentUserErr) return { success: false, error: `Agent name lookup failed: ${agentUserErr.message}` }
      const composed = [agentUser?.first_name, agentUser?.last_name].filter(Boolean).join(" ")
      if (composed) agentName = composed
    }

    // ── Prompt inputs. Both are additive context; an empty result is a real
    //    answer (no sold inventory in that ZIP yet), so neither blocks. A
    //    REFUSED read is still logged rather than passed off as "none found".
    const { data: comps, error: compsErr } = await svc
      .from("listings")
      .select("address, city, state, zip, list_price, sold_price, bedrooms, bathrooms, sqft, year_built, go_live_date")
      // tenant anchor (scope burn-down): comps come from the caller's own brokerage inventory
      .eq("brokerage_id", input.brokerageId)
      .eq("zip", input.propertyData.zipCode)
      .eq("status", "sold")
      .order("go_live_date", { ascending: false })
      .limit(10)
    if (compsErr) console.error("[ai-listing-presentation] comps read refused:", compsErr.message)

    const { data: marketData, error: marketErr } = await svc
      .from("market_data")
      .select("*")
      .eq("zip_code", input.propertyData.zipCode)
      .order("data_date", { ascending: false })
      .limit(5)
    if (marketErr) console.error("[ai-listing-presentation] market_data read refused:", marketErr.message)

    const { object: presentation } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: presentationSchema,
      prompt: `Create a compelling listing presentation:

Property Details:
${JSON.stringify(input.propertyData, null, 2)}

Seller Information:
${JSON.stringify(input.sellerInfo ?? {}, null, 2)}
${input.agentMessage ? `\nThe agent's own note to this seller — open the presentation in their voice with it, do not quote it verbatim as a block:\n${input.agentMessage}\n` : ""}
Agent Profile:
Name: ${agentName}
Specializations: ${(agent as any)?.specializations?.join(", ") || "N/A"}
Years Experience: ${(agent as any)?.years_experience ?? "N/A"}

Comparable Sales:
${JSON.stringify(comps?.slice(0, 5) ?? [], null, 2)}

Market Data:
${JSON.stringify(marketData ?? [], null, 2)}

Presentation Type: ${input.presentationType ?? "full"}

Create:
1. Engaging title and introduction
2. Market analysis with pricing recommendation
3. Comprehensive marketing plan
4. Clear timeline
5. Strong value proposition
6. Objection handlers for common concerns
7. Powerful closing with clear next steps
8. Supporting appendix materials`,
    })

    // `presentation` is a TEXT column, not jsonb — stringify explicitly rather
    // than relying on how the transport happens to coerce an object.
    const narrative = {
      property_address: propertyAddress,
      property_data:    input.propertyData,
      presentation:     JSON.stringify(presentation),
      presentation_type: input.presentationType ?? "full",
      agent_id:         input.agentId,
      updated_at:       new Date().toISOString(),
    }

    // ── ONE ROW PER APPOINTMENT ──────────────────────────────────────────────
    // If the prep cron already built this appointment's presentation, write the
    // narrative onto it. A second row would mean a second section drip for one
    // seller (see the header).
    if (input.appointmentId) {
      const { data: existing, error: existingErr } = await svc
        .from("listing_presentations")
        .select("id")
        .eq("appointment_id", input.appointmentId)
        .eq("brokerage_id", input.brokerageId)
        .maybeSingle()
      // An unreadable row is NOT treated as absent — inserting on a failed read
      // is exactly how the seller ends up with two presentations and two drips.
      if (existingErr) {
        return { success: false, error: `Existing presentation lookup failed: ${existingErr.message}` }
      }
      if (existing?.id) {
        const { data: updated, error: updateErr } = await svc
          .from("listing_presentations")
          .update(narrative)
          .eq("id", existing.id)
          .eq("brokerage_id", input.brokerageId)
          .select("id")
          .maybeSingle()
        if (updateErr) return { success: false, error: `Could not save presentation: ${updateErr.message}` }
        if (!updated?.id) return { success: false, error: "Could not save presentation: row not returned" }
        return { success: true, presentation, presentationId: updated.id, attachedToExisting: true }
      }
    }

    // ── The insert. ──────────────────────────────────────────────────────────
    // brokerage_id and state are NOT NULL with no default; omitting them refused
    // every insert this function ever attempted with 23502, and because the error
    // was destructured and never read it returned success with presentationId
    // undefined — which is what stamped video_metadata.presentation_id = null on
    // every chapter reel. Both are supplied from resolved values, and the error
    // is checked.
    const { data: saved, error: saveErr } = await svc
      .from("listing_presentations")
      .insert({
        brokerage_id:   input.brokerageId,
        state,
        agent_user_id:  agentUserId,
        contact_id:     input.contactId ?? null,
        appointment_id: input.appointmentId ?? null,
        appointment_at: input.appointmentAt ?? null,
        ...narrative,
        // CHECK listing_presentations_status_check: draft|ready|presented|converted|abandoned.
        // The narrative is finished, so 'ready'.
        status:       "ready",
        created_at:   new Date().toISOString(),
      })
      .select("id")
      .single()

    if (saveErr || !saved?.id) {
      // NEVER success. A refused insert used to be reported as a success with no
      // id, and step 3 stamped that null onto every chapter reel it produced.
      return {
        success: false,
        error: `Could not save presentation: ${saveErr?.message ?? "insert returned no row"}`,
      }
    }

    return { success: true, presentation, presentationId: saved.id, attachedToExisting: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[ai-listing-presentation] generation failed:", message)
    return { success: false, error: message }
  }
}
