/**
 * lib/agents/listing-concierge.ts
 *
 * Listing Concierge (Seller Concierge) — one Anthropic Managed Agent per brokerage that
 * runs a per-seller-side session for the ENTIRE seller journey, from contact-created
 * through under-contract / expired. Phase-aware (not gated by listing_agreement signed):
 * the kickoff carries the seller's current state and the system prompt adapts.
 *
 * PHASE TABLE (kickoff infers from the seller-side state):
 *   ┌───────────────────────────────────────────────┬────────────────────────────────────┐
 *   │ State signal                                  │ Agent's job in this phase          │
 *   ├───────────────────────────────────────────────┼────────────────────────────────────┤
 *   │ seller contact, no listing yet                │ Drive listing appointment           │
 *   │                                               │ scheduling; intro to brokerage      │
 *   │ listing appointment scheduled, no CMA         │ Pre-listing CMA prep, comp pull,    │
 *   │                                               │ net-sheet draft                     │
 *   │ listing created (draft/LEAD), no agreement    │ Stage listing agreement; comp set   │
 *   │                                               │ ready for appointment               │
 *   │ fully-signed listing agreement, listing live  │ Full concierge: showings, feedback, │
 *   │                                               │ health, price-rec, renewal staging  │
 *   └───────────────────────────────────────────────┴────────────────────────────────────┘
 *
 * Operates on a SELLER-SIDE CONTACT — entity_type='contact', NOT 'listing' — so it can
 * start the moment the seller becomes a contact. The current listing (if any) is
 * surfaced in the kickoff via FK lookup.
 *
 * Persona-aware: the seller's contact_persona (motivated_seller / fsbo / expired /
 * divorce / probate / luxury_seller / etc.) drives the tone via persona-config.aiContext.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnManagedAgentSession, type AgentTemplate, type SpawnResult } from "./spawn-helper"
import { resolvePersonaContext } from "./persona-context"
import { resolveBrokerageContext, renderBrokerageContextForKickoff } from "./brokerage-context"
import { buildOutcomeFor, buildDefineOutcomeEvent } from "./outcomes"

const LISTING_CONCIERGE_SYSTEM = `You are the Listing Concierge for a real-estate seller. You serve under whichever
brokerage the kickoff names — the brokerage's name, subscription tier, brand voice,
prohibited words, and signature policy are passed in the kickoff context block. NEVER
substitute a hardcoded brokerage name in your output.

You run from seller contact-created through closing and ADAPT to whichever phase the
seller is in. You COMPOSE with the existing kernel — do NOT reinvent flows the kernel
already runs:

KERNEL PIECES YOU COMPOSE WITH (do not duplicate, do not bypass):
   - Brand voice + prohibited words + tagline: lib/kernel/brand-voice.ts.
   - Compliance gates: lib/kernel/compliance.ts (Fair Housing, Them-First, TCPA).
   - Email signature: lib/kernel/communications/assemble-email.ts auto-wraps outbound.
   - Pre-listing-appointment automation: lib/workflow-orchestrator/chains/listing-appt-prep.ts
     auto-triggers on the "listing.appointment_set" event and runs: (1) AI CMA via
     lib/cma/ai-cma-orchestrator.ts, (2) listing presentation generation, (3) DID avatar
     videos, (4) drip campaign enrollment. DO NOT recommend "run a CMA" or "build a
     presentation" in your agent_briefing when the appointment is already set — the
     kernel ran them; surface their output and gaps, don't duplicate.
   - Education portal: lib/kernel/education.ts has per-persona seller education plans
     (FSBO, expired, divorce, probate, luxury_seller, etc.).

PHASES + YOUR JOB IN EACH:

A) PRE-APPOINTMENT (seller contact exists, no listing appointment scheduled)
   - Drive toward scheduling the listing appointment. The single highest-leverage move
     here is to get the appointment_set event fired (lib/workflow-orchestrator/chains/
     listing-appt-prep.ts auto-runs CMA + presentation + video + drip on that event).
     Frame the agent_briefing around "schedule the appointment so the auto-prep chain
     fires" rather than recommending the agent manually run a CMA.
   - Begin gathering property fundamentals (address, beds/baths, sqft, condition notes)
     so the auto-CMA produces a useful result.
   - Do NOT recommend a list price yet — requires CMA and the appointment conversation.

B) APPOINTMENT-PREP (appointment scheduled, CMA/presentation chain ran)
   - The kernel auto-prep chain already ran the AI CMA and built the presentation.
     Confirm in your agent_briefing whether the auto-prep produced a result; if it
     failed/missed, recommend the agent rerun via the workflow-orchestrator (NOT a
     manual CMA flow).
   - Pre-stage the listing agreement so it's ready for signature at the appointment.

C) AGREEMENT-PENDING (listing draft exists, no fully-signed agreement)
   - Drive the agreement to signature. Surface what's blocking (counter-proposal,
     commission re-negotiation, etc).
   - Hold off on marketing recommendations until representation is in place.

D) ACTIVE LISTING (fully-signed listing agreement + live listing)
   - Read the listing state (DOM, showings, feedback, listing-health score, CMA).
   - Identify feedback themes, pricing pressure, low showing velocity.
   - Draft a weekly seller update.
   - Flag specific actions when listing-health crosses watch/at_risk/critical (price
     range with comps, staging change, photography refresh, marketing channel
     expansion).
   - Pre-stage listing-agreement renewals 30 days before expiration.

GLOBAL RULES (every phase):
   - Match the persona voice — the kickoff names the persona; mirror that register.
     A motivated_seller hears urgency-respectful language; a luxury_seller hears
     sophistication; a probate/divorce contact hears neutral + confidentiality.
   - Output is reviewed by the agent BEFORE publishing to the seller.
   - Never recommend a specific price change without supporting comps from CMA tools.
   - Never speculate about specific buyers' financials, motivations, or competing offers.
   - Never reveal showings, feedback, or offers from one source to a different audience.

RESPONSE FORMAT (JSON):
{
  "phase":             "pre_appointment" | "appointment_prep" | "agreement_pending" | "active_listing",
  "seller_update":     "...",  // 150 words max, what to share with the seller (in PERSONA voice)
  "agent_briefing":    "...",  // bullets — what the agent should action this week
  "next_step_for_seller": "schedule_appointment|complete_cma|sign_agreement|review_feedback|consider_price_change|null",
  "price_recommendation": {    // null EXCEPT in "active_listing" with CMA support
    "direction": "reduce|hold|raise" | null,
    "range_low":  number | null,
    "range_high": number | null,
    "supporting_comp_count": number,
    "rationale": "one sentence"
  } | null,
  "listing_health_trend": "improving|stable|declining" | null,
  "agreement_renewal_due_in_days": number | null,
  "next_check_at":     "ISO8601 timestamp"
}`

const TEMPLATE: AgentTemplate = {
  kind:    "listing_concierge",
  model:   "claude-sonnet-4-6",
  system:  LISTING_CONCIERGE_SYSTEM,
}

export async function spawnListingConciergeForSeller(params: {
  brokerageId:    string
  contactId:      string
  environmentId?: string
  kickoff?:       string
}): Promise<SpawnResult> {
  const svc = createServiceClient()

  // Tenant-scoped seller-side contact lookup. Accept contact_type 'seller' or 'both'.
  const { data: contact } = await svc
    .from("contacts")
    .select("id, first_name, last_name, contact_type, contact_persona, brokerage_id")
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!contact) return { ok: false, error: "contact not found in this brokerage" }
  if (contact.contact_type !== "seller" && contact.contact_type !== "both") {
    return { ok: false, error: `contact contact_type=${contact.contact_type ?? "null"} — Listing Concierge only operates on seller-type contacts (or 'both')` }
  }

  // Phase detection.
  // (i) listing row associated with this seller-contact
  const { data: listingRow } = await svc
    .from("listings")
    .select("id, address, city, state, list_price, status, lifecycle_stage")
    .eq("seller_contact_id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // (ii) fully-signed listing_agreement on that listing
  let hasSignedAgreement = false
  if (listingRow) {
    const { data: agr } = await svc
      .from("listing_agreements")
      .select("id")
      .eq("listing_id", listingRow.id)
      .eq("brokerage_id", params.brokerageId)
      .eq("esign_status", "fully_signed")
      .limit(1)
      .maybeSingle()
    hasSignedAgreement = !!agr
  }

  // (iii) listing-appointment scheduled? Look in activities — calendar_event_type or
  //       activity_type marker for a listing-presentation appointment.
  const { data: apptRow } = await svc
    .from("activities")
    .select("id, scheduled_at, status")
    .eq("contact_id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .in("activity_type", ["listing_appointment", "listing_presentation", "presentation_scheduled"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const hasAppointment = !!apptRow

  // (iv) CMA on file for this seller / listing
  const { data: cmaRow } = await svc
    .from("cma_reports")
    .select("id")
    .eq("contact_id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .limit(1)
    .maybeSingle().then(r => r, () => ({ data: null }))
  const hasCMA = !!cmaRow

  let phase: "pre_appointment" | "appointment_prep" | "agreement_pending" | "active_listing"
  if (hasSignedAgreement)        phase = "active_listing"
  else if (listingRow)           phase = "agreement_pending"
  else if (hasAppointment)       phase = hasCMA ? "agreement_pending" : "appointment_prep"
  else                           phase = "pre_appointment"

  const persona     = resolvePersonaContext(contact.contact_persona as string | null, "seller")
  const brokerage   = await resolveBrokerageContext({
    brokerageId: params.brokerageId,
    journeyType: "seller",
    persona:     persona.key,
  })
  const sellerName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.id.slice(0, 8)
  const propertyAddress = listingRow
    ? [listingRow.address, listingRow.city, listingRow.state].filter(Boolean).join(", ")
    : "(no listing yet)"

  const kickoff = params.kickoff ?? [
    renderBrokerageContextForKickoff(brokerage),
    "",
    "──── SELLER CONTEXT ────",
    `Seller: ${sellerName}`,
    `Persona: ${persona.label} (${persona.key})`,
    `Phase: ${phase}`,
    `Property: ${propertyAddress}`,
    `Listing stage: ${listingRow?.lifecycle_stage ?? "no listing yet"}`,
    `Listing appointment: ${hasAppointment ? "scheduled" : "not scheduled"}`,
    `CMA on file (kernel auto-prep output): ${hasCMA ? "YES" : "NO"}`,
    `Fully-signed listing agreement: ${hasSignedAgreement ? "YES" : "NO"}`,
    "",
    `PERSONA VOICE GUIDANCE (mirror this in the seller_update): ${persona.aiContext}`,
    persona.sensitive ? "⚠️  SENSITIVE CONTEXT — use extra care; respect privacy and timing." : "",
    "",
    `Produce your initial seller update + agent briefing per your response format. Match the`,
    `phase rules above and the brokerage compliance/voice gates. Output JSON only.`,
  ].filter(Boolean).join("\n")

  const rubric = buildOutcomeFor("listing_concierge", {
    brokerageName: brokerage.brokerageName,
    subjectName:   sellerName,
  })
  const outcomeEvent = buildDefineOutcomeEvent(rubric, kickoff)

  return spawnManagedAgentSession(TEMPLATE, {
    brokerageId:   params.brokerageId,
    entityType:    "contact",
    entityId:      params.contactId,
    environmentId: params.environmentId,
    title:         `Listing: ${sellerName} ${propertyAddress !== "(no listing yet)" ? `· ${propertyAddress}` : ""}`,
    outcomeEvent,
    metadata: {
      seller_contact_id: params.contactId,
      persona:           persona.key,
      phase,
      listing_id:        (listingRow?.id as string | undefined) ?? "",
    },
  })
}
