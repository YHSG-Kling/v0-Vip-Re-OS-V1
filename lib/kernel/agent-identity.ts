/**
 * Agent Identity Resolution Utility — THE CALLER-FACING FACE OF ONE RESOLVER.
 *
 * NEVER do: agentId = agentRow?.id ?? user.id
 * ALWAYS do: agentId = await resolveAgentId(supabase, user.id)
 * If null → user has no agent profile yet → handle gracefully
 *
 * CONSOLIDATED (m340). This module and lib/kernel/agent-identity-resolver.ts
 * were TWO implementations of the same users→agents lookup — 57 files import
 * this one, 27 import that one, and they did not behave the same way:
 *
 *   · the resolver CACHES; this one hit the database on every call, and these
 *     are called inside per-agent loops in the rollup crons;
 *   · the resolver is BROKERAGE-SCOPED; this one was not. `.maybeSingle()` on
 *     an unscoped `user_id` match THROWS when a user has agents rows in two
 *     brokerages — a real shape in a platform that supports staff across
 *     tenants — so the more widely adopted of the two was the riskier one.
 *
 * Rather than churn 57 call sites, the SIGNATURES stay exactly as they were and
 * the implementation now delegates. One lookup, one cache, and the brokerage
 * question is answered in one file instead of two.
 *
 * Prefer resolveAgentIdInBrokerage when you know the tenant — it is the scoped,
 * cached path. resolveAgentId remains for the callers that genuinely do not have
 * a brokerage in hand, and it is honest about what it does.
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { resolveUserIdToAgentRecord } from './agent-identity-resolver'

/**
 * Resolves the agent ID from a user ID, WITHOUT a brokerage scope.
 * Returns null if the user has no agent profile.
 *
 * Uses the caller's supabase client (so it honours RLS on the anon/server
 * client) and takes the FIRST matching row rather than `.maybeSingle()`, which
 * threw for a user carrying agents rows in more than one brokerage. Ordering by
 * created_at makes the pick deterministic instead of whatever the planner
 * returned — but it is still a guess between tenants, which is why the scoped
 * variant below should be preferred wherever a brokerage is known.
 */
export async function resolveAgentId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  if (!userId) return null
  const { data } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
  return (data?.[0]?.id as string | undefined) ?? null
}

/**
 * The SCOPED, CACHED resolution — one agents row per (user, brokerage), which
 * is the only version that can be correct for a user who belongs to more than
 * one tenant. Delegates to the single canonical implementation.
 */
export async function resolveAgentIdInBrokerage(
  userId: string,
  brokerageId: string
): Promise<string | null> {
  return resolveUserIdToAgentRecord(userId, brokerageId)
}

/**
 * Resolves agent ID or throws if not found.
 * Use when agent profile is required for the operation.
 */
export async function requireAgentId(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const agentId = await resolveAgentId(supabase, userId)
  if (!agentId) {
    throw new Error('Agent profile not found. Please complete onboarding.')
  }
  return agentId
}
