import { createServiceClient } from '@/lib/supabase/service'
import type { WaterfallContext } from '../types'
import {
  getRevenueShareModel,
  computeRevenueShare,
  type RevenueShareEdge,
} from '../revenue-share-model'

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

  const result = computeRevenueShare({
    agentId: context.agentId,
    agentFinalNetCents: context.agentFinalNetCents,
    brokerageFinalCents: context.brokerageFinalCents,
    state,
    relationships: (relationships ?? []) as RevenueShareEdge[],
  })

  return {
    ...context,
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
