/**
 * lib/agents/spawn-helper.ts
 *
 * The shared spawn machinery used by every per-entity Managed Agent
 * (Deal Coordinator / Shopping Agent / Listing Concierge). Each agent
 * provides ONLY its kind-specific config (system prompt, model,
 * kickoff builder) — this helper handles:
 *   1. Look-or-create the brokerage's Anthropic agent (idempotent via
 *      managed_agents unique partial index on (brokerage, kind)).
 *   2. Idempotent session-per-entity (managed_agent_sessions lookup).
 *   3. Anthropic sessions.create + send the kickoff user.message.
 *   4. Persist the session row for the webhook handler to route events.
 *
 * Never throws — missing ANTHROPIC_API_KEY / ANTHROPIC_DEFAULT_ENVIRONMENT_ID
 * → graceful no-op so kernel events don't fail in dev/staging.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { createManagedAgent, createManagedSession, sendManagedSessionEvents } from "./managed-agents-egress"

export type AgentKind = "deal_coordinator" | "shopping_agent" | "listing_concierge"
export type EntityType = "transaction" | "contact" | "listing"

export interface AgentTemplate {
  /** The kind of agent — drives the (brokerage, kind) uniqueness. */
  kind:    AgentKind
  /** Display name template — agent is named per-brokerage so multi-brokerage workspaces
   *  can tell them apart. Receives the brokerage short id. */
  nameFor: (brokerageId: string) => string
  /** Claude model slug. */
  model:   string
  /** Full system prompt — versioned by content (a different hash means a new
   *  Anthropic agent will be created on the next spawn). */
  system:  string
  /** Tools array forwarded to Anthropic's agents.create. */
  tools?:  Array<Record<string, unknown>>
  /** MCP servers (managed credentials via vault_ids at session creation). */
  mcpServers?: Array<Record<string, unknown>>
}

export interface SpawnInput {
  brokerageId:   string
  entityType:    EntityType
  entityId:      string
  /** Override the environment_id — defaults to ANTHROPIC_DEFAULT_ENVIRONMENT_ID. */
  environmentId?: string
  /** Optional vault ids for MCP credentials. */
  vaultIds?:     string[]
  /** Session title shown in Anthropic Console / our admin UI. */
  title?:        string
  /** First user.message sent to the agent — typically the per-entity context. */
  kickoff:       string
  /** Metadata key/value pairs persisted on the Anthropic session and our row. */
  metadata?:     Record<string, string>
}

export interface SpawnResult {
  ok:              boolean
  session?:        { id: string; managedAgentId: string }
  /** Skip reason — when true but `ok=false` (or `ok=true` with skipped set), the
   *  spawn was an intentional no-op (env not configured, dup session). */
  skipped?:        "no-api-key" | "no-environment" | "already-running" | null
  error?:          string
}

/**
 * One canonical spawn entry — every per-entity agent calls this with its template.
 * Resolves (or creates) the brokerage's agent, then resolves (or creates) the
 * session for the entity, then sends the kickoff message.
 */
export async function spawnManagedAgentSession(
  tpl: AgentTemplate,
  input: SpawnInput,
): Promise<SpawnResult> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, skipped: "no-api-key" }
  const environmentId = input.environmentId ?? process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID
  if (!environmentId) return { ok: false, skipped: "no-environment", error: "ANTHROPIC_DEFAULT_ENVIRONMENT_ID not configured" }

  const svc = createServiceClient()

  // 1. Idempotency at the session level — already running for this entity?
  const { data: existingSession } = await svc
    .from("managed_agent_sessions")
    .select("id, anthropic_session_id, status")
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
    .in("status", ["running", "idle"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingSession) {
    return {
      ok:      true,
      session: { id: existingSession.anthropic_session_id as string, managedAgentId: "" },
      skipped: "already-running",
    }
  }

  // 2. Resolve (or create) the brokerage's Anthropic agent.
  const { data: existingAgent } = await svc
    .from("managed_agents")
    .select("id, anthropic_agent_id")
    .eq("brokerage_id", input.brokerageId)
    .eq("agent_kind", tpl.kind)
    .is("archived_at", null)
    .maybeSingle()

  let managedAgentRowId: string
  let anthropicAgentId: string

  if (existingAgent) {
    managedAgentRowId = existingAgent.id as string
    anthropicAgentId  = existingAgent.anthropic_agent_id as string
  } else {
    const created = await createManagedAgent({
      name:        tpl.nameFor(input.brokerageId),
      model:       tpl.model,
      system:      tpl.system,
      tools:       tpl.tools       ?? [{ type: "agent_toolset_20260401", default_config: { enabled: true } }],
      mcp_servers: tpl.mcpServers,
      metadata:    { brokerage_id: input.brokerageId, kind: tpl.kind },
    })
    if (!created.ok || !created.agent) return { ok: false, error: created.error ?? "createManagedAgent failed" }
    anthropicAgentId = created.agent.id

    const { data: inserted, error: insErr } = await svc.from("managed_agents").insert({
      brokerage_id:       input.brokerageId,
      agent_kind:         tpl.kind,
      anthropic_agent_id: anthropicAgentId,
      anthropic_version:  created.agent.version != null ? String(created.agent.version) : null,
      model:              tpl.model,
      config:             {},
    }).select("id").single()
    if (insErr || !inserted) return { ok: false, error: `managed_agents insert: ${insErr?.message ?? "unknown"}` }
    managedAgentRowId = inserted.id as string
  }

  // 3. Start the session.
  const session = await createManagedSession({
    agent:          anthropicAgentId,
    environment_id: environmentId,
    title:          input.title ?? `${tpl.kind}: ${input.entityId.slice(0, 8)}`,
    vault_ids:      input.vaultIds,
    metadata:       { ...(input.metadata ?? {}), brokerage_id: input.brokerageId, kind: tpl.kind },
  })
  if (!session.ok || !session.session) return { ok: false, error: session.error ?? "createManagedSession failed" }

  // 4. Persist for the webhook handler to route incoming events back. The partial UNIQUE
  //    index `uq_managed_agent_sessions_active_per_entity` (m108) makes this race-safe —
  //    a concurrent spawn that won the Anthropic session race will hit the constraint
  //    here, and we treat that as "already-running" (returning the existing session id)
  //    so the second caller observes the idempotent result. If the insert fails for any
  //    OTHER reason, surface the error rather than silently orphaning the Anthropic session.
  const { error: insErr } = await svc.from("managed_agent_sessions").insert({
    managed_agent_id:     managedAgentRowId,
    brokerage_id:         input.brokerageId,
    anthropic_session_id: session.session.id,
    entity_type:          input.entityType,
    entity_id:            input.entityId,
    status:               session.session.status ?? "running",
  })
  if (insErr) {
    // 23505 = unique_violation — race lost cleanly.
    if ((insErr as { code?: string }).code === "23505") {
      const { data: winner } = await svc
        .from("managed_agent_sessions")
        .select("anthropic_session_id")
        .eq("entity_type", input.entityType)
        .eq("entity_id", input.entityId)
        .in("status", ["running", "idle"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      return {
        ok:       true,
        session:  { id: (winner?.anthropic_session_id as string) ?? session.session.id, managedAgentId: managedAgentRowId },
        skipped:  "already-running",
      }
    }
    return { ok: false, error: `managed_agent_sessions insert: ${insErr.message}` }
  }

  // 5. Send kickoff. A failure here leaves the agent with no entity context, so
  //    surface the error rather than silently returning "ok"; callers can decide whether
  //    to retry. The session row stays — the webhook will still route status changes
  //    and the agent can be re-kicked manually.
  const send = await sendManagedSessionEvents({
    session_id: session.session.id,
    events:     [{ type: "user.message", content: [{ type: "text", text: input.kickoff }] }],
  })
  if (!send.ok) {
    return { ok: false, error: send.error ?? "kickoff send failed (session created but no kickoff delivered)" }
  }

  return { ok: true, session: { id: session.session.id, managedAgentId: managedAgentRowId } }
}
