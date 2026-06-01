/**
 * lib/agents/deal-coordinator.ts
 *
 * Deal Coordinator — one Anthropic Managed Agent per brokerage that runs a per-transaction
 * session from OFFER_ACCEPTED through CLOSED. The agent watches deal-health, polls the
 * configured transaction provider (Dotloop / SkySlope / Brokermint / FormSimplicity)
 * through our existing `sync-from-provider` helper, drafts proactive client communications
 * via the canonical transparency_updates path, and escalates blocked items.
 *
 * Anti-pattern guard: `agents.create` is called ONCE per brokerage (idempotent via the
 * m107 `managed_agents` unique partial index on (brokerage_id, agent_kind)). After that,
 * every transaction spawn just calls `sessions.create` with the cached anthropic_agent_id.
 *
 * Side-effect contract: every action the agent takes flows through the kernel event bus
 * via `emitKernelEvent` → reactor fan-out, so notifications + sequences + portal cards
 * all run uniformly regardless of whether the trigger was a human or this agent.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { createManagedAgent, createManagedSession, sendManagedSessionEvents } from "./managed-agents-egress"

const AGENT_KIND = "deal_coordinator"
const AGENT_MODEL = "claude-sonnet-4-6"

// One canonical system prompt — versioned by content hash so an update creates a new
// Anthropic agent row only when the prompt actually changes. The prompt is intentionally
// terse: the agent's job is to monitor + summarize + escalate, NOT to act autonomously
// on the database (which our kernel + auth gates do anyway). Real actions are gated
// through our server actions, not the agent's free-form tool calls.
const DEAL_COORDINATOR_SYSTEM = `You are the Deal Coordinator for a real-estate transaction at a Vip-RE-OS brokerage.

YOUR JOB:
1. Read the transaction state (milestones, deal-health, document status from the configured provider).
2. Identify the top items at risk and their deadline pressure (next 7-14 days).
3. Draft proactive, plain-language updates for the buyer AND seller (separately) explaining
   what happened, what's next, who's responsible. Keep each update under 80 words.
4. Flag escalations the agent needs to handle PERSONALLY (e.g. inspection finding, lender
   underwriting issue, title cloud, low appraisal).

NEVER:
- Send anything directly to a client — your output is reviewed by the agent before publishing.
- Make commitments on behalf of the title/lender/inspector. Identify the responsible party only.
- Speculate about price, value, or comparables. The CMA tools handle that.
- Reveal one side's negotiation posture to the other. Keep buyer + seller updates separate.

RESPONSE FORMAT:
{
  "buyer_update":   "...",  // 80 words max, what to say to the buyer
  "seller_update":  "...",  // 80 words max, what to say to the seller
  "agent_briefing": "...",  // bullets — what needs the agent's attention TODAY
  "risk_score":     number, // 0-100, where 100 is highest urgency
  "next_check_at":  "ISO8601 timestamp — when YOU should re-evaluate this transaction"
}`

export interface SpawnDealCoordinatorResult {
  ok:                boolean
  session?:          { id: string; managedAgentId: string }
  /** When false but `skipped` is set, the spawn was intentionally a no-op (e.g.
   *  ANTHROPIC_API_KEY missing — we don't fail the kernel event in dev/staging). */
  skipped?:          "no-api-key" | "already-running" | null
  error?:            string
}

/**
 * Resolves (and creates if necessary) the Deal Coordinator Anthropic agent for the given
 * brokerage, then starts a Managed Agent session for the transaction. Idempotent at both
 * layers — the agent is reused across all sessions for the brokerage, and an already-
 * running session for the same transaction returns `skipped='already-running'` instead of
 * spawning a duplicate.
 */
export async function spawnDealCoordinatorForTransaction(params: {
  brokerageId:    string
  transactionId:  string
  /** Optional environment_id from the brokerage's Anthropic workspace. Defaults to
   *  process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID. */
  environmentId?: string
  /** Kickoff message — overrides the default "summarize current state" prompt. */
  kickoff?:       string
}): Promise<SpawnDealCoordinatorResult> {
  // ── Defensive: no key → graceful no-op so kernel events don't fail in dev. ──
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, skipped: "no-api-key" }
  }
  const environmentId = params.environmentId ?? process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID
  if (!environmentId) {
    return { ok: false, error: "ANTHROPIC_DEFAULT_ENVIRONMENT_ID not configured" }
  }

  const svc = createServiceClient()

  // 1. Idempotency — already-running session for this transaction? skip.
  const { data: existing } = await svc
    .from("managed_agent_sessions")
    .select("id, anthropic_session_id, status")
    .eq("entity_type", "transaction")
    .eq("entity_id", params.transactionId)
    .in("status", ["running", "idle"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) {
    return {
      ok:      true,
      session: { id: existing.anthropic_session_id as string, managedAgentId: "" },
      skipped: "already-running",
    }
  }

  // 2. Resolve (or create) the brokerage's Deal Coordinator agent.
  const { data: existingAgent } = await svc
    .from("managed_agents")
    .select("id, anthropic_agent_id")
    .eq("brokerage_id", params.brokerageId)
    .eq("agent_kind", AGENT_KIND)
    .is("archived_at", null)
    .maybeSingle()

  let managedAgentRowId: string
  let anthropicAgentId: string

  if (existingAgent) {
    managedAgentRowId = existingAgent.id as string
    anthropicAgentId  = existingAgent.anthropic_agent_id as string
  } else {
    const created = await createManagedAgent({
      name:   `Deal Coordinator (${params.brokerageId.slice(0, 8)})`,
      model:  AGENT_MODEL,
      system: DEAL_COORDINATOR_SYSTEM,
      tools:  [{ type: "agent_toolset_20260401", default_config: { enabled: true } }],
      metadata: { brokerage_id: params.brokerageId, kind: AGENT_KIND },
    })
    if (!created.ok || !created.agent) {
      return { ok: false, error: created.error ?? "createManagedAgent failed" }
    }
    anthropicAgentId = created.agent.id

    const { data: inserted, error: insErr } = await svc.from("managed_agents").insert({
      brokerage_id:       params.brokerageId,
      agent_kind:         AGENT_KIND,
      anthropic_agent_id: anthropicAgentId,
      anthropic_version:  created.agent.version != null ? String(created.agent.version) : null,
      model:              AGENT_MODEL,
      config:             {},
    }).select("id").single()
    if (insErr || !inserted) {
      return { ok: false, error: `managed_agents insert failed: ${insErr?.message ?? "unknown"}` }
    }
    managedAgentRowId = inserted.id as string
  }

  // 3. Start the session referencing the agent. Resources include the transaction's
  //    metadata so the agent has context up front (without needing tool calls to find it).
  const { data: txn } = await svc
    .from("transactions")
    .select("id, deal_name, property_address, stage, status, contract_date, purchase_price, external_provider_source, external_provider_transaction_id")
    .eq("id", params.transactionId)
    .single()
  if (!txn) return { ok: false, error: "transaction not found" }

  const session = await createManagedSession({
    agent:          anthropicAgentId,
    environment_id: environmentId,
    title:          `Deal: ${txn.deal_name ?? txn.property_address ?? params.transactionId.slice(0,8)}`,
    metadata: {
      transaction_id:  params.transactionId,
      brokerage_id:    params.brokerageId,
      provider:        (txn.external_provider_source as string | null) ?? "none",
    },
  })
  if (!session.ok || !session.session) {
    return { ok: false, error: session.error ?? "createManagedSession failed" }
  }

  // 4. Persist the session row so the webhook handler can route incoming events back.
  await svc.from("managed_agent_sessions").insert({
    managed_agent_id:     managedAgentRowId,
    brokerage_id:         params.brokerageId,
    anthropic_session_id: session.session.id,
    entity_type:          "transaction",
    entity_id:            params.transactionId,
    status:               session.session.status ?? "running",
  })

  // 5. Send the kickoff user.message — gives the agent its first task with the
  //    transaction context inlined.
  const kickoff = params.kickoff ?? `Transaction ${txn.deal_name ?? txn.property_address ?? "(unnamed)"} just went under contract.
- Stage: ${txn.stage ?? "n/a"}
- Status: ${txn.status ?? "n/a"}
- Contract date: ${txn.contract_date ?? "n/a"}
- Purchase price: ${txn.purchase_price ?? "n/a"}
- Provider: ${txn.external_provider_source ?? "none"}

Produce your initial buyer + seller update + agent briefing per your response format.`

  await sendManagedSessionEvents({
    session_id: session.session.id,
    events: [{ type: "user.message", content: [{ type: "text", text: kickoff }] }],
  })

  return {
    ok:      true,
    session: { id: session.session.id, managedAgentId: managedAgentRowId },
  }
}
