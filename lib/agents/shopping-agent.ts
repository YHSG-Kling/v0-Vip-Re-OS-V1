/**
 * lib/agents/shopping-agent.ts
 *
 * Buyer Concierge — one Anthropic Managed Agent per brokerage that runs a per-buyer
 * session for the ENTIRE buyer journey, from contact-created through under-contract.
 * Phase-aware (not gated by BBA existence): the kickoff carries the buyer's current
 * representation/financial/search state and the system prompt knows how to operate at
 * each phase.
 *
 * PHASE TABLE (kickoff infers from offer data):
 *   ┌─────────────────────────────────────────────┬──────────────────────────────────────┐
 *   │ State signal                                │ Agent's job in this phase            │
 *   ├─────────────────────────────────────────────┼──────────────────────────────────────┤
 *   │ contact exists, no active BBA, no lender    │ Lender intro (preferred partner),    │
 *   │                                             │ qualification, BBA staging           │
 *   │ active BBA, no pre-approval                 │ Push pre-approval, surface lender    │
 *   │                                             │ docs needed                          │
 *   │ active BBA + pre-approval, no saved search  │ Configure search criteria + alerts   │
 *   │ active BBA + pre-approval + searching       │ Full shopping (current behavior):    │
 *   │                                             │ tour digests, market shifts, BBA     │
 *   │                                             │ renewal staging                      │
 *   └─────────────────────────────────────────────┴──────────────────────────────────────┘
 *
 * Persona-aware: the buyer's `contact_persona` is resolved via lib/agents/persona-context
 * and the aiContext string is injected into the kickoff so the agent's drafts mirror the
 * persona's voice (first-time buyer = jargon-explained reassurance; investor = data-
 * driven; divorce/probate = neutral + confidential).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnManagedAgentSession, type AgentTemplate, type SpawnResult } from "./spawn-helper"
import { resolvePersonaContext } from "./persona-context"
import { resolveBrokerageContext, renderBrokerageContextForKickoff } from "./brokerage-context"
import { checkFinancialVerification } from "@/lib/buyer-lifecycle/financial-verification"

const SHOPPING_AGENT_SYSTEM = `You are the Buyer Concierge for a real-estate buyer. You serve under whichever brokerage
the kickoff names — the brokerage's name, subscription tier, brand voice, prohibited words,
and preferred lender are passed in the kickoff context block. NEVER substitute a hardcoded
brokerage name in your output; if you need to name the brokerage, use the one in the kickoff.

You run from contact-created through under-contract and ADAPT to whichever phase the buyer
is in. You COMPOSE with the existing kernel — do NOT reinvent flows the kernel already runs:

KERNEL PIECES YOU COMPOSE WITH (do not duplicate, do not bypass):
   - Brand voice: lib/kernel/brand-voice.ts — the kickoff gives you the resolved tone,
     prohibited words, and preferred phrasing. Match them in every drafted message.
   - Compliance gates: lib/kernel/compliance.ts — Fair Housing, Them-First (≥60% client-
     focused pronouns, no pushy phrases), TCPA. Your output is gated here on the way out;
     self-filter upfront so the gates don't kick back your draft.
   - Email signature: lib/kernel/communications/assemble-email.ts auto-applies the
     resolved user/team/brokerage signature to outbound email. DO NOT draft a signature;
     end your email body with the closing line only.
   - Buyer financial verification: lib/buyer-lifecycle/financial-verification.ts already
     reads activities for lender_intro / pre_approval / proof_of_funds signals and
     returns the current status. The kickoff carries this; DO NOT re-derive it.
   - Education portal: lib/kernel/education.ts already builds per-persona education plans.
     If you recommend education, reference the kernel's plan rather than inventing one.

PHASES + YOUR JOB IN EACH:

A) PRE-REPRESENTATION (no signed Buyer Broker Agreement yet)
   - If the kickoff names a PREFERRED LENDER, draft a warm intro: name + email + phone
     from the kickoff, no quotes, no commitments. If no preferred lender is configured,
     flag in agent_briefing that one should be set under vendor_directory before lender-
     intro outreach.
   - Drive toward financial qualification (pre-approval letter, proof of funds). When
     the kernel financial-verification already reports a lender_intro happened, do NOT
     repeat the intro — track to next step (pre-approval upload).
   - Stage the BBA so the agent can send for signature once the buyer is qualified.
   - Do NOT recommend specific properties yet — representation must be in place first
     (NAR Code of Ethics + August 2024 settlement).

B) REPRESENTED, PRE-SEARCH (active BBA, no saved search yet)
   - Help configure search criteria, must-haves, deal-breakers.
   - Pre-stage property alerts.

C) ACTIVELY SHOPPING (active BBA + active search + tours happening)
   - Review saved searches, property_interests (liked/disliked), tour history.
   - Identify pattern shifts and the 3-5 newest listings worth attention.
   - Flag tours that should be scheduled this week + stale-interest properties.
   - Pre-stage BBA renewals 30 days before expiration.

PHASES + YOUR JOB IN EACH:

A) PRE-REPRESENTATION (no signed Buyer Broker Agreement yet)
   - Surface the brokerage's preferred lender for an introduction (offer warm intro language;
     no quotes, no commitments).
   - Drive toward financial qualification (pre-approval letter, proof of funds).
   - Stage the BBA so the agent can send for signature once the buyer is qualified.
   - Do NOT recommend specific properties yet — representation must be in place first
     (NAR Code of Ethics + August 2024 settlement).

B) REPRESENTED, PRE-SEARCH (active BBA, no saved search yet)
   - Help configure search criteria, must-haves, deal-breakers.
   - Pre-stage property alerts.

C) ACTIVELY SHOPPING (active BBA + active search + tours happening)
   - Review saved searches, property_interests (liked/disliked), tour history.
   - Identify pattern shifts and the 3-5 newest listings worth attention.
   - Flag tours that should be scheduled this week + stale-interest properties.
   - Pre-stage BBA renewals 30 days before expiration.

GLOBAL RULES (every phase):
   - Match the persona voice — the kickoff names the persona; mirror that register.
   - Output is reviewed by the agent BEFORE publishing to the buyer. Never communicate
     directly with the buyer.
   - Never quote or suggest a specific offer amount. The agent + CMA tools handle pricing.
   - Never make commitments about closing dates, seller flexibility, or property condition.
   - Never suggest properties outside the buyer's stated geographic / property-type scope.
   - Never reveal info about other buyers or transactions.

RESPONSE FORMAT (JSON):
{
  "phase":           "pre_representation" | "represented_pre_search" | "actively_shopping",
  "buyer_digest":    "...",   // 120 words max, what to share with the buyer (in PERSONA voice)
  "agent_briefing":  "...",   // bullets — what the agent should action this week
  "next_step_for_buyer": "lender_intro|pre_approval|sign_bba|configure_search|review_listings|schedule_tours|null",
  "recommended_tours": [      // up to 5, ONLY in "actively_shopping" phase
    { "listing_id": "uuid", "reason": "one sentence", "urgency": "high|medium|low" }
  ],
  "bba_renewal_due_in_days": number | null,
  "next_check_at":   "ISO8601 timestamp"
}`

const TEMPLATE: AgentTemplate = {
  kind:    "shopping_agent",
  model:   "claude-sonnet-4-6",
  system:  SHOPPING_AGENT_SYSTEM,
}

export async function spawnShoppingAgentForBuyer(params: {
  brokerageId:    string
  contactId:      string
  environmentId?: string
  kickoff?:       string
}): Promise<SpawnResult> {
  const svc = createServiceClient()

  // Tenant-scoped contact lookup — must be a buyer (or both-side contact) in this brokerage.
  // 'both' contact_type also counts; we operate on buyers (the seller side is handled by
  // the Listing Concierge for the other half).
  const { data: contact } = await svc
    .from("contacts")
    .select("id, first_name, last_name, contact_type, contact_persona, buyer_stage, brokerage_id")
    .eq("id", params.contactId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!contact) return { ok: false, error: "contact not found in this brokerage" }
  if (contact.contact_type !== "buyer" && contact.contact_type !== "both") {
    return { ok: false, error: `contact contact_type=${contact.contact_type ?? "null"} — Buyer Concierge only operates on buyer-type contacts (or 'both')` }
  }

  // Phase detection — read the canonical signals.
  const { data: bba } = await svc
    .from("buyer_broker_agreements")
    .select("id, status, expiration_date, agreement_type, commission_payer")
    .eq("buyer_contact_id", params.contactId)
    .eq("status", "active")
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Pre-approval signal — read from the CANONICAL kernel financial-verification module.
  // Don't re-derive what the kernel already aggregates from activities. The result tells
  // us status (pre_approval / proof_of_funds / lender_intro / agent_confirmation / none)
  // so the agent can target the next step instead of re-running an already-done step.
  let finStatus: Awaited<ReturnType<typeof checkFinancialVerification>> | null = null
  try {
    finStatus = await checkFinancialVerification({ contactId: params.contactId })
  } catch {
    finStatus = null
  }
  const hasPreApproval = !!(finStatus?.isVerified)

  // Saved search signal — has the buyer configured what they're looking for?
  const { data: savedSearches } = await svc
    .from("saved_properties")
    .select("id").eq("contact_id", params.contactId).limit(1)
  const hasSavedSearch = !!(savedSearches && savedSearches.length > 0)

  // Compute phase.
  let phase: "pre_representation" | "represented_pre_search" | "actively_shopping"
  if (!bba)                            phase = "pre_representation"
  else if (!hasSavedSearch || !hasPreApproval) phase = "represented_pre_search"
  else                                  phase = "actively_shopping"

  // Persona-aware tone + brokerage-context (brand voice, compliance gates, signature
  // policy, preferred lender) — pulled from the same kernel chokepoints the rest of the
  // app uses so the agent stays inside the same rails as human-authored content.
  const persona     = resolvePersonaContext(contact.contact_persona as string | null, "buyer")
  const brokerage   = await resolveBrokerageContext({
    brokerageId: params.brokerageId,
    journeyType: "buyer",
    persona:     persona.key,
  })
  const buyerName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.id.slice(0, 8)

  const kickoff = params.kickoff ?? [
    renderBrokerageContextForKickoff(brokerage),
    "",
    "──── BUYER CONTEXT ────",
    `Buyer: ${buyerName}`,
    `Persona: ${persona.label} (${persona.key})`,
    `Phase: ${phase}`,
    `Buyer stage: ${contact.buyer_stage ?? "n/a"}`,
    `BBA: ${bba ? `${bba.agreement_type ?? "exclusive"}, expires ${bba.expiration_date ?? "no expiration"}` : "NONE — pre-representation"}`,
    `Financial verification: ${finStatus?.isVerified ? `verified via ${finStatus.verificationType}` : "NOT verified"}`,
    `Saved search configured: ${hasSavedSearch ? "YES" : "NO"}`,
    "",
    `PERSONA VOICE GUIDANCE (mirror this in the buyer_digest): ${persona.aiContext}`,
    persona.sensitive ? "⚠️  SENSITIVE CONTEXT — use extra care; never assume the situation is voluntary." : "",
    "",
    `Produce your initial buyer digest + agent briefing per your response format. Match the`,
    `phase rules above and the brokerage compliance/voice gates. Output JSON only.`,
  ].filter(Boolean).join("\n")

  return spawnManagedAgentSession(TEMPLATE, {
    brokerageId:   params.brokerageId,
    entityType:    "contact",
    entityId:      params.contactId,
    environmentId: params.environmentId,
    title:         `Buyer: ${buyerName}`,
    kickoff,
    metadata: {
      buyer_contact_id: params.contactId,
      persona:          persona.key,
      phase,
      bba_id:           (bba?.id as string | undefined) ?? "",
    },
  })
}
