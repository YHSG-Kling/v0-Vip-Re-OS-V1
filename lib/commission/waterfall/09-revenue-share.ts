import { createServiceClient } from '@/lib/supabase/service'
import type { WaterfallContext } from '../types'
import {
  getRevenueShareModel,
  evaluateResidualRules,
  RESIDUAL_CORROBORATING_EDGES,
  type RevenueShareEdge,
  type ResidualGraphEdge,
} from '../revenue-share-model'

type Svc = ReturnType<typeof createServiceClient>

/**
 * The RESIDUAL RELATIONSHIP LOOKUP's graph half (wave 107, 107A): the producing agent's relationship_edges
 * (lib/kernel/relationship-graph.ts — the ONE edge store) of the corroborating types, plus the agents → users
 * map the graph keys on (agents.id ≠ users.id, §3) and the team leads behind member_of_team. READ-ONLY and
 * NEVER money-bearing: a refused or absent read returns measured:false — corroboration is then UNMEASURED,
 * the residual still pays on its agent_relationships terms (the graph prices nothing).
 */
async function loadResidualGraph(
  supabase: Svc,
  brokerageId: string,
  agentId: string,
  relationships: ReadonlyArray<{ sponsor_agent_id: string | null }>,
): Promise<{ measured: boolean; edges: ResidualGraphEdge[]; userIdByAgentId: Map<string, string>; teamLeadUserIdByTeamId: Map<string, string> }> {
  const userIdByAgentId = new Map<string, string>()
  const teamLeadUserIdByTeamId = new Map<string, string>()
  const unmeasured = { measured: false, edges: [] as ResidualGraphEdge[], userIdByAgentId, teamLeadUserIdByTeamId }
  const agentIds = Array.from(new Set([agentId, ...relationships.map((r) => r.sponsor_agent_id).filter((x): x is string => !!x)]))
  const { data: agentRows, error: agentErr } = await supabase.from('agents').select('id, user_id').eq('brokerage_id', brokerageId).in('id', agentIds)
  if (agentErr) { console.warn(`[revenue-share] residual graph agents read refused: ${agentErr.message}`); return unmeasured }
  for (const a of (agentRows ?? []) as Array<{ id: string; user_id: string | null }>) if (a.user_id) userIdByAgentId.set(a.id, a.user_id)
  const producerUser = userIdByAgentId.get(agentId)
  if (!producerUser) return unmeasured
  const types = Array.from(new Set(Object.values(RESIDUAL_CORROBORATING_EDGES).flat()))
  const { data: edgeRows, error: edgeErr } = await supabase
    .from('relationship_edges')
    .select('brokerage_id, relationship_type, from_entity_type, from_entity_id, to_entity_type, to_entity_id, effective_from, effective_to')
    .eq('brokerage_id', brokerageId)
    .in('relationship_type', types)
    .or(`from_entity_id.eq.${producerUser},to_entity_id.eq.${producerUser}`)
    .limit(500)
  if (edgeErr) { console.warn(`[revenue-share] residual graph edges read refused: ${edgeErr.message}`); return unmeasured }
  const edges = (edgeRows ?? []) as ResidualGraphEdge[]
  const teamIds = Array.from(new Set(edges.filter((e) => e.relationship_type === 'member_of_team' && e.to_entity_type === 'team').map((e) => e.to_entity_id)))
  if (teamIds.length > 0) {
    const { data: teamRows, error: teamErr } = await supabase.from('teams').select('id, team_lead_id').eq('brokerage_id', brokerageId).in('id', teamIds)
    if (teamErr) { console.warn(`[revenue-share] residual graph teams read refused: ${teamErr.message}`); return { ...unmeasured, edges } }
    for (const t of (teamRows ?? []) as Array<{ id: string; team_lead_id: string | null }>) if (t.team_lead_id) teamLeadUserIdByTeamId.set(t.id, t.team_lead_id)
  }
  return { measured: true, edges, userIdByAgentId, teamLeadUserIdByTeamId }
}

/**
 * STEP 9: Revenue Share
 * Multi-level revenue share to sponsors (eXp/REAL model).
 *
 * THE MODEL IS READ, NEVER ASSUMED (owner ruling 2026-08-27): the brokerage's
 * configured distribution model (m575 — revenue_share_source_of_funds /
 * revenue_share_rate_type / duration, lib/commission/revenue-share-model.ts)
 * gates this step. revenue_share_enabled (m264) alone pays NOTHING:
 *
 *   · disabled            → no-op (empty distributions), as before.
 *   · enabled, model UNCONFIGURED → no-op, skip reason recorded on the context
 *     and warned. NO-OP rather than REFUSE, deliberately: the waterfall's
 *     precedent for ABSENT money configuration is a no-op (step 07 with no cap
 *     row → 'n/a'; this step with no relationships → empty), and it THROWS only
 *     on contradictory configuration (an overdraft). Throwing here would fail
 *     the ENTIRE commission — the producing agent unpaid because a side-payout
 *     was never described — which is a worse invention than paying nothing.
 *   · enabled + configured → each ACTIVE edge inside its effective window pays
 *     its OWN stamped terms (flat cents per closing, else percent of the
 *     agent's rolling net), funded by its stamped source: 'agent' deducts from
 *     the agent's rolling balance, 'brokerage' deducts from the brokerage's
 *     final (conservation holds — step 11 validates gross == distributed +
 *     finals, and the pre-model code pushed brokerage-funded distributions
 *     with no deduction, so every brokerage-funded closing threw there).
 *     A brokerage-funded share the deal's company dollar CANNOT fund (post-cap
 *     it is $0 — owner ruling 2026-08-28: the cap ends the brokerage TAKING
 *     from the agent, not the brokerage PAYING its own obligations) is neither
 *     refused nor overdrafted in-deal: it becomes a company-books obligation
 *     (context.companyObligations, reason 'post_cap_company_books'), recorded
 *     by step 11 on company_books_obligations (m577) outside the deal's
 *     distribution set.
 *
 * DURATION is enforced here for the first time: effective_from/effective_to
 * existed on agent_relationships but were never read — an expired edge kept
 * paying forever. Rolling multi-level calculation preserved from the original.
 */
export async function applyRevenueShare(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  // GATE — the m264 opt-in AND the m575 distribution model, one read
  // (select("*") inside, so the same code runs before/after m575 is applied).
  const state = await getRevenueShareModel(context.brokerageId, supabase)
  if (!state.enabled) {
    return { ...context, revenueShareDistributions: [], revenueShareSkipped: 'disabled' }
  }
  if (!state.configured) {
    // NEVER SILENT: the mark is on but the brokerage has not described the
    // distribution — nothing pays until they do (fail-closed, published).
    console.warn(
      `[revenue-share] brokerage ${context.brokerageId} has revenue_share_enabled but no configured ` +
        `distribution model (missing: ${state.missing.join(', ')}) — no share paid on this closing.`
    )
    return { ...context, revenueShareDistributions: [], revenueShareSkipped: 'model_unconfigured' }
  }

  // Query revenue share relationships for this agent. select('*') keeps the
  // read valid pre-m575 (revenue_share_flat_cents simply absent → percent path).
  const { data: relationships, error } = await supabase
    .from('agent_relationships')
    .select('*')
    .eq('agent_id', context.agentId)
    .eq('brokerage_id', context.brokerageId)
    .eq('is_active', true)
    .order('depth_level', { ascending: true }) // Process direct sponsor first

  if (error) {
    throw new Error(`[revenue-share] Failed to fetch relationships: ${error.message}`)
  }

  // WAVE 107 (lane 107A) — EFFECTIVE DATES HONOURED AT THE CLOSE DATE. computeRevenueShare used to judge
  // every window on the wall clock, so a calculation run after an edge expired (or before it started)
  // paid by the day the button was pressed, not the day the deal closed. The economic EVENT's date is
  // transactions.close_date — the same date lib/kernel/economic-graph.ts resolveResidualTree judges on.
  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .select('close_date')
    .eq('id', context.transactionId)
    .eq('brokerage_id', context.brokerageId)
    .maybeSingle()
  if (txnErr) {
    throw new Error(`[revenue-share] Failed to read the close date the residual windows are judged on: ${txnErr.message}`)
  }

  const graph = await loadResidualGraph(supabase, context.brokerageId, context.agentId, (relationships ?? []) as Array<{ sponsor_agent_id: string | null }>)

  // THE DETERMINISTIC RULE EVALUATION (no model anywhere on this path — test:residual-economics censuses it).
  const evaluation = evaluateResidualRules({
    transactionId: context.transactionId,
    brokerageId: context.brokerageId,
    producingAgentId: context.agentId,
    closeDate: ((txn as { close_date?: string | null } | null)?.close_date ?? null),
    fallbackDate: new Date().toISOString().slice(0, 10),
    agentFinalNetCents: context.agentFinalNetCents,
    brokerageFinalCents: context.brokerageFinalCents,
    state,
    relationships: (relationships ?? []) as RevenueShareEdge[],
    graph,
  })
  if (evaluation.findings.length > 0) console.warn(`[revenue-share] ${context.transactionId}: ${evaluation.findings.join('; ')}`)
  const result = evaluation.computation

  return {
    ...context,
    residualEvaluation: evaluation,
    agentFinalNetCents: result.agentFinalNetCents,
    brokerageFinalCents: result.brokerageFinalCents,
    revenueShareDistributions: result.distributions,
    // Brokerage-funded shares this deal's company dollar could not fund (owner
    // ruling 2026-08-28: post-cap the brokerage stops TAKING, not PAYING) —
    // carried OUTSIDE the distribution collections so step 11's conservation
    // identity never sees them, and persisted by step 11 to the company payables
    // ledger (company_books_obligations, m577). Never silently dropped.
    companyObligations: result.companyObligations,
    revenueShareSkipped: result.skipped ?? undefined,
  }
}
