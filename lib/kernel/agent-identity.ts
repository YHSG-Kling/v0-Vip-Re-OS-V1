/**
 * Agent Identity Resolution Utility — THE CALLER-FACING FACE OF ONE RESOLVER.
 *
 * NEVER do: agentId = agentRow?.id ?? user.id
 * ALWAYS do: agentId = await resolveAgentId(supabase, user.id)
 * If null → user has no agent profile yet → handle gracefully
 *
 * TWO MODULES, AND WHY THEY BOTH EXIST (m340 corrected by m344).
 *
 * This module and lib/kernel/agent-identity-resolver.ts both resolve
 * users→agents, and m340 tried to collapse them by having this one import that
 * one. That broke the production build: the resolver is `server-only` (it builds
 * its own service-role client), while THIS module takes the caller's client and
 * is imported from pages that webpack bundles outside the server graph —
 * app/analytics/page.tsx among them. The static import dragged "server-only"
 * into a Pages Router bundle. tsc cannot see that; only a real `next build` can.
 *
 * So they are NOT redundant, and calling them a duplicate was wrong:
 *   · agent-identity-resolver — SERVER-ONLY, service-role, cached, both
 *     directions. For kernel/cron/server-action code.
 *   · this module — client-agnostic, uses the SUPABASE CLIENT YOU PASS, so it
 *     honours RLS and is safe to import from anywhere.
 *
 * What m340 got right and this keeps: `.maybeSingle()` on an unscoped `user_id`
 * match THROWS when a user holds agents rows in two brokerages, so the unscoped
 * path is now an ordered `limit(1)`, and a brokerage-SCOPED variant exists for
 * callers that know their tenant. Prefer it whenever you do.
 */

import { SupabaseClient } from '@supabase/supabase-js'

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
 * The SCOPED resolution — one agents row per (user, brokerage), the only version
 * that can be correct for a user who belongs to more than one tenant.
 *
 * Implemented HERE against the caller's client rather than delegating to
 * agent-identity-resolver, and that is deliberate: see the header. Same query,
 * one extra filter.
 */
export async function resolveAgentIdInBrokerage(
  supabase: SupabaseClient,
  userId: string,
  brokerageId: string
): Promise<string | null> {
  if (!userId || !brokerageId) return null
  const { data } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', userId)
    .eq('brokerage_id', brokerageId)
    .limit(1)
  return (data?.[0]?.id as string | undefined) ?? null
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
