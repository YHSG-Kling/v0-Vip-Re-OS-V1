/**
 * lib/agents/sphere-agent.ts
 *
 * Sphere of Influence Agent — the 4th Managed Agent kind, and the single biggest
 * MoxiWorks-beating play in the platform. 75-85% of a top real-estate agent's
 * business comes from past clients + referrals; MoxiWorks Engage handles this with
 * RULE-BASED cadences (anniversary cards, market updates). This agent instead:
 *
 *   1. Runs at the BROKERAGE level (not per-contact) once per week.
 *   2. Pulls every lifetime customer (contacts with lifecycle_state='lifetime_customer'
 *      or contact_type='lifetime' depending on the historical taxonomy).
 *   3. Recalls each contact's vector memory + property insights + last touchpoint.
 *   4. Detects specific triggers: refi window (rate drop), equity-tap, upsizer/
 *      downsizer signals, anniversary touchpoints, referral-ask windows.
 *   5. Drafts persona-aware re-engagement outreach (passed through the canonical
 *      compliance gate before publishing — same gate the per-contact agents use).
 *
 * Same architecture as the other agents:
 *   - Routes Anthropic API through callConnector (single egress).
 *   - Composes with brand-voice + compliance + email-assembly + persona + memory.
 *   - Outcome-graded session with explicit rubric.
 *   - Webhook captures span.outcome_evaluation_end into agent_outcome_evaluations.
 *
 * Trigger by: cron `app/api/cron/sphere-weekly/route.ts` (weekly per active brokerage).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnManagedAgentSession, type AgentTemplate, type SpawnResult } from "./spawn-helper"
import { resolveBrokerageContext, renderBrokerageContextForKickoff } from "./brokerage-context"
import { buildOutcomeFor, buildDefineOutcomeEvent } from "./outcomes"

const SPHERE_AGENT_SYSTEM = `You are the Sphere of Influence agent for a real-estate brokerage. You serve under whichever
brokerage the kickoff names — name, tier, brand voice, prohibited words come from the kickoff.

YOUR JOB:
Run weekly across the brokerage's LIFETIME CUSTOMERS (past clients) and identify the highest-leverage
re-engagement opportunities for THIS WEEK. Surface a ranked list of opportunities the agent reviews
and sends.

You COMPOSE with existing kernel pieces (do not duplicate):
   - Brand voice + compliance gates: lib/kernel/brand-voice.ts + lib/kernel/compliance.ts.
     Your drafts pass through evaluateOutbound BEFORE publishing (the webhook handler runs it).
   - Email signature: lib/kernel/communications/assemble-email.ts auto-wraps outbound. DO NOT
     draft a signature.
   - Persona voice: each contact has a persona; use the SAME register the portal uses for them.
   - Contact memory: lib/agents/contact-memory.ts is your recall layer — you have it as a
     tool. Use it BEFORE drafting outreach so the message references real history (their last
     property, what they said about wanting a corner lot, etc).
   - TCPA: only draft an SMS opportunity when contacts.sms_consent = true. Default to email.

TRIGGER TYPES (rank by lifetime-value × probability):
   • refi_window     — rates ≥ 75 bps below their original loan AND past prepayment lockout
   • equity_tap      — property value − loan balance ≥ $100K AND ≥ 3 years of ownership
   • upsizer         — kids reach school transition age + memory flags "too small"
   • downsizer       — empty-nest trigger + memory flags "too big"
   • anniversary     — purchase/move-in anniversary in next 30 days
   • referral_ask    — high satisfaction signal + no referral asked in 90+ days
   • neighborhood_signal — comp sale in their neighborhood that affects their equity

NEVER:
- Communicate directly with any past client; the agent reviews + sends.
- Make commitments about specific rates, valuations, or appreciation projections.
- Recommend an SMS outreach without explicit sms_consent on file.
- Surface a contact outside this brokerage (cross-tenant audit guard).
- Reveal information from one client's deal to another client.`

const TEMPLATE: AgentTemplate = {
  kind:    "sphere_of_influence",
  model:   "claude-sonnet-4-6",
  system:  SPHERE_AGENT_SYSTEM,
}

/**
 * Pull a snapshot of the brokerage's lifetime customers for the kickoff. The full
 * recall happens via the agent's tools during the rubric loop; this is just enough
 * to seed the agent's understanding of the sphere's size + composition.
 */
async function buildSphereSnapshot(brokerageId: string): Promise<{
  total:            number
  withRefiSignal:   number
  withEquitySignal: number
  upcomingAnniversaries: number
  sampleNames:      string[]
}> {
  const svc = createServiceClient()
  // Pull lifetime_customer state (canonical historic lifecycle bucket).
  const { data: lifetimes } = await svc
    .from("contacts")
    .select("id, first_name, last_name, created_at, lifecycle_state")
    .eq("brokerage_id", brokerageId)
    .eq("lifecycle_state", "lifetime_customer")
    .limit(200)
  const rows = lifetimes ?? []
  const total = rows.length
  const sampleNames = rows.slice(0, 5)
    .map(r => [r.first_name, r.last_name].filter(Boolean).join(" "))
    .filter(Boolean)

  // Upcoming anniversaries — past clients whose CLOSING DATE has a calendar
  // anniversary in the next 30 days. Canonical source is transactions.close_date
  // (transactions.status='closed'). We compute "this year's anniversary" inline so
  // a Postgres DATE comparison works regardless of how many years ago they closed.
  const today    = new Date().toISOString().slice(0, 10)
  const plus30   = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10)
  let upcomingAnniversaries = 0
  try {
    // Pull closed transactions for this brokerage, then count those whose
    // (month-day) anniversary falls in the next 30 days. Doing it as a single
    // SQL filter is cleaner but we keep this side small to avoid drift on edge
    // cases (Feb 29 → Feb 28 in non-leap-years, etc.).
    const { data: closed } = await svc
      .from("transactions")
      .select("close_date")
      .eq("brokerage_id", brokerageId)
      .eq("status", "closed")
      .not("close_date", "is", null)
      .limit(1000)
    for (const r of closed ?? []) {
      const closeIso = r.close_date as string | null
      if (!closeIso) continue
      const c = new Date(closeIso)
      const thisYear = new Date(new Date().getFullYear(), c.getMonth(), c.getDate())
        .toISOString().slice(0, 10)
      if (thisYear >= today && thisYear <= plus30) upcomingAnniversaries++
    }
  } catch { /* best-effort — agent will recompute via tools */ }

  // Best-effort indicators — the agent's tools do the heavy lifting downstream.
  return {
    total,
    withRefiSignal:        0, // resolved by the agent's tool calls; placeholder for snapshot
    withEquitySignal:      0,
    upcomingAnniversaries,
    sampleNames,
  }
}

export async function spawnSphereOfInfluenceForBrokerage(params: {
  brokerageId:    string
  environmentId?: string
  kickoff?:       string
}): Promise<SpawnResult> {
  // Compose with the canonical brokerage-context (brand voice, prohibited words,
  // compliance gates, signature policy, tier label).
  const brokerage = await resolveBrokerageContext({
    brokerageId: params.brokerageId,
    journeyType: "buyer",        // sphere outreach mostly targets past BUYERS for refi/equity;
    persona:     "first_time_buyer", // brand-voice rules apply across personas the same way at
                                     // the brokerage level.
  })
  const snapshot = await buildSphereSnapshot(params.brokerageId)

  const kickoff = params.kickoff ?? [
    renderBrokerageContextForKickoff(brokerage),
    "",
    "──── SPHERE SNAPSHOT ────",
    `Lifetime customers: ${snapshot.total}`,
    `Upcoming anniversaries (next 30 days): ${snapshot.upcomingAnniversaries}`,
    snapshot.sampleNames.length > 0 ? `Sample past clients: ${snapshot.sampleNames.join(", ")}…` : "",
    "",
    "Pull each contact's memory via the recall_contact_memory tool BEFORE drafting outreach. The",
    "memory contains their stated preferences, past showings, and satisfaction signals. Use it.",
    "",
    "Produce your weekly opportunities list per your response format. Match brand voice +",
    "compliance gates. Output JSON only.",
  ].filter(Boolean).join("\n")

  const rubric = buildOutcomeFor("sphere_of_influence", {
    brokerageName: brokerage.brokerageName,
    subjectName:   brokerage.brokerageName,
    sphereSize:    snapshot.total,
  })
  const outcomeEvent = buildDefineOutcomeEvent(rubric, kickoff)

  return spawnManagedAgentSession(TEMPLATE, {
    brokerageId:   params.brokerageId,
    entityType:    "brokerage",
    entityId:      params.brokerageId,    // self-referential — the brokerage IS the entity
    environmentId: params.environmentId,
    title:         `Sphere of Influence: ${brokerage.brokerageName}`,
    outcomeEvent,
    metadata: {
      sphere_size: String(snapshot.total),
      tier:        brokerage.tierKey,
    },
  })
}
