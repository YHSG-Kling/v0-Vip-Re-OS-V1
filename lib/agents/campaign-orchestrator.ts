/**
 * lib/agents/campaign-orchestrator.ts
 *
 * Campaign Orchestrator Agent — the 5th Managed Agent kind. Per-brokerage,
 * runs weekly AFTER the Sphere of Influence agent has produced its
 * opportunities. The orchestrator's job:
 *
 *   1. Read the latest sphere opportunities + listing-health-radar risks +
 *      revenue-protection signals.
 *   2. For each opportunity, autonomously COMPOSE a multi-channel campaign:
 *        - select channel mix per trigger + persona + consent state
 *        - draft each asset in brand voice through evaluateOutbound
 *        - attest to a clean De-Conflict window per (contact_id, channel)
 *        - queue to marketing_approvals for agent review
 *   3. Iterate until the rubric is satisfied (no over-touch, every opportunity
 *      either queued or skipped with reason).
 *
 * Compositional: this agent does NOT replace any existing surface. It SITS ON
 * TOP of the existing kernel pieces — Sphere agent → opportunities;
 * marketing_campaigns table → campaign storage; dispatch.ts → eventual send;
 * De-Conflict gate → suppression. Removing the orchestrator leaves everything
 * working; adding it turns lane-by-lane firing into one orchestrated brain.
 *
 * Trigger by: cron `app/api/cron/campaign-orchestrator-weekly/route.ts` (weekly
 * per active brokerage with a recent sphere run).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnManagedAgentSession, type AgentTemplate, type SpawnResult } from "./spawn-helper"
import { resolveBrokerageContext, renderBrokerageContextForKickoff } from "./brokerage-context"
import { buildOutcomeFor, buildDefineOutcomeEvent } from "./outcomes"

const ORCHESTRATOR_SYSTEM = `You are the Campaign Orchestrator agent for a real-estate brokerage. You serve under whichever
brokerage the kickoff names — name, tier, brand voice, prohibited words come from the kickoff.

YOUR JOB:
Compose this week's pending sphere opportunities + listing-health risks + revenue-protection
signals into RANKED, MULTI-CHANNEL campaigns. The agent reviews + sends; you NEVER auto-send.
Your output is a queued list of drafted campaigns the agent can approve in one batch.

YOU COMPOSE WITH EXISTING KERNEL PIECES (do not duplicate):
   - Brand voice + compliance gates: lib/kernel/brand-voice.ts + lib/kernel/compliance.ts.
     Your drafts MUST pre-clear evaluateOutbound — the runtime gate runs again at send time.
   - Email assembly: lib/kernel/communications/assemble-email.ts auto-wraps outbound.
     Don't draft signatures or unsubscribe — assembly adds those.
   - Persona register: each contact has contact_persona; use the same register the portal uses.
   - Contact memory: lib/agents/contact-memory.ts is your recall layer. Use it BEFORE drafting
     so the message references real history (their last property, what they said about wanting
     a corner lot, etc).
   - D-ID avatar video: lib/did/index.ts renders the avatar with driver_expressions.
     When you draft a video, ALWAYS specify the expression ('happy' is the warm default;
     'neutral' for transactional updates; 'serious' for compliance-heavy topics).
   - Direct mail: lib/providers/dispatch.ts dispatchDirectMail goes through Lob with a QR.
     Specify tracking_qr for every postcard you queue.
   - De-Conflict Engine: lib/kernel/deconflict already runs at dispatch egress. Your job is
     to PRE-FILTER so the gate doesn't surprise the agent — query the touch sources directly
     and attest to a clean window per (contact_id, channel) in your output.

NEVER:
- Communicate directly with any contact; the agent reviews + sends.
- Stack channels on a contact within the platform suppression window
  (email 14d, sms 7d, mail 30d, video 21d).
- Draft SMS without explicit sms_consent on file.
- Reference a contact outside this brokerage (cross-tenant audit guard).
- Reveal one client's deal details to another client.`

const TEMPLATE: AgentTemplate = {
  kind:    "campaign_orchestrator",
  model:   "claude-sonnet-4-6",
  system:  ORCHESTRATOR_SYSTEM,
}

/**
 * Pull the pending opportunities snapshot for the kickoff. The agent's tools
 * do the heavy recall during the rubric loop; this is the seed.
 */
async function buildOrchestrationSnapshot(brokerageId: string): Promise<{
  opportunityCount:      number
  upcomingAnniversaries: number
  atRiskListings:        number
  recentDeconflictDeferrals: number
  sphereSize:            number
}> {
  const svc = createServiceClient()

  // Sphere weekly opportunities — proxy: count of lifetime customers (each is a
  // potential sphere opportunity the orchestrator can decide on).
  const { count: sphereSize } = await svc
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId)
    .eq("lifecycle_state", "lifetime_customer")

  // Anniversary triggers in next 30 days — same source as the sphere agent.
  let upcomingAnniversaries = 0
  try {
    const today  = new Date().toISOString().slice(0, 10)
    const plus30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
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
  } catch { /* best-effort */ }

  // Listings at risk — listing_health_scores stores an overall HEALTH score
  // (higher = healthier). At-risk = score ≤ 40.
  let atRiskListings = 0
  try {
    const { count } = await svc
      .from("listing_health_scores")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .lte("overall_score", 40)
    atRiskListings = count ?? 0
  } catch { /* table optional */ }

  // Recent de-conflict deferrals — signal of over-firing across lanes.
  let recentDeconflictDeferrals = 0
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const { count } = await svc
      .from("deconflict_suppression_log")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("outcome", "suppressed_over_touch")
      .gte("created_at", since)
    recentDeconflictDeferrals = count ?? 0
  } catch { /* fresh table — empty is fine */ }

  const opportunityCount = (sphereSize ?? 0) + atRiskListings
  return {
    opportunityCount,
    upcomingAnniversaries,
    atRiskListings,
    recentDeconflictDeferrals,
    sphereSize: sphereSize ?? 0,
  }
}

export async function spawnCampaignOrchestratorForBrokerage(params: {
  brokerageId:    string
  environmentId?: string
  kickoff?:       string
}): Promise<SpawnResult> {
  const brokerage = await resolveBrokerageContext({
    brokerageId: params.brokerageId,
    journeyType: "buyer",
    persona:     "first_time_buyer",
  })
  const snap = await buildOrchestrationSnapshot(params.brokerageId)

  const kickoff = params.kickoff ?? [
    renderBrokerageContextForKickoff(brokerage),
    "",
    "──── ORCHESTRATION SNAPSHOT ────",
    `Sphere size (lifetime customers): ${snap.sphereSize}`,
    `Upcoming anniversaries (next 30 days): ${snap.upcomingAnniversaries}`,
    `Listings at risk (health score ≥ 60): ${snap.atRiskListings}`,
    `Recent de-conflict deferrals (last 7 days): ${snap.recentDeconflictDeferrals}`,
    "",
    "Read the latest agent_outcome_evaluations for the Sphere of Influence agent under this",
    "brokerage_id — the most recent satisfied iteration contains the ranked opportunities you",
    "should orchestrate. For each opportunity, recall the contact's memory FIRST, then draft",
    "the channel mix per the rubric, pre-flighting the de-conflict window.",
    "",
    "Output ONLY the JSON object the rubric specifies. No prose.",
  ].filter(Boolean).join("\n")

  const rubric = buildOutcomeFor("campaign_orchestrator", {
    brokerageName:    brokerage.brokerageName,
    subjectName:      brokerage.brokerageName,
    opportunityCount: snap.opportunityCount,
  })
  const outcomeEvent = buildDefineOutcomeEvent(rubric, kickoff)

  return spawnManagedAgentSession(TEMPLATE, {
    brokerageId:   params.brokerageId,
    entityType:    "brokerage",
    entityId:      params.brokerageId, // brokerage-level, like sphere
    environmentId: params.environmentId,
    title:         `Campaign Orchestrator: ${brokerage.brokerageName}`,
    outcomeEvent,
    metadata: {
      sphere_size:         String(snap.sphereSize),
      at_risk_listings:    String(snap.atRiskListings),
      recent_deferrals:    String(snap.recentDeconflictDeferrals),
      tier:                brokerage.tierKey,
    },
  })
}
