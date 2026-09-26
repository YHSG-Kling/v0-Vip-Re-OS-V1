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
 * THE REVERSE DIRECTION — agents.id → users.id.
 *
 * Needed because ~20 columns named `agent_id` FK `users` rather than `agents`
 * (review_requests, income_forecast_snapshots, podcast_episodes, …). Code that
 * legitimately holds an AGENTS id still has to write those, and the agents id is
 * FK-rejected there every single time — not "usually": no agents row's id is
 * also a users id, so the write can never land.
 *
 * The server-only resolver has this too, but it builds a service-role client and
 * cannot be imported from a module reachable by client bundling (see header).
 * This version takes the caller's client, so a server action can use it.
 *
 * Returns null when the agents row is gone — callers must treat that as "do not
 * write", never as "substitute the id I already have".
 */
export async function resolveUserIdForAgentRecord(
  supabase: SupabaseClient,
  agentRecordId: string
): Promise<string | null> {
  if (!agentRecordId) return null
  const { data } = await supabase
    .from('agents')
    .select('user_id')
    .eq('id', agentRecordId)
    .limit(1)
  return (data?.[0]?.user_id as string | undefined) ?? null
}

/**
 * THE REVERSE DIRECTION, BATCHED AND TENANT-PINNED — many agents.id → users.id.
 *
 * Same crossing as resolveUserIdForAgentRecord above (agents.user_id), for the
 * callers that hold a whole roster of agents ids at once — a report crediting the
 * CURRENT holder of each contact, or a miner whose supporting-agent list must be
 * written in the class its only reader compares against (users.id, see
 * lib/learning-router/resolve-agent-learning-context.ts). Pinned to the tenant:
 * an agents id from another brokerage resolves to nothing, never to a user.
 *
 * supabase-js RESOLVES a refused read, so a refusal is returned as a refusal —
 * never as an empty map that would read as "none of these agents has a login".
 * An agents id missing from the map is an agents row that is gone or foreign;
 * callers must not substitute the agents id for it.
 */
export async function resolveUserIdsForAgentRecords(
  supabase: Pick<SupabaseClient, 'from'>,
  brokerageId: string,
  agentRecordIds: ReadonlyArray<string>
): Promise<{ ok: true; userIdByAgentId: Map<string, string> } | { ok: false; error: string }> {
  const userIdByAgentId = new Map<string, string>()
  const ids = Array.from(new Set(agentRecordIds.filter(Boolean)))
  if (!brokerageId || ids.length === 0) return { ok: true, userIdByAgentId }
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from('agents')
      .select('id, user_id')
      .eq('brokerage_id', brokerageId)
      .in('id', ids.slice(i, i + 200))
    if (error) return { ok: false, error: `agents (agents.id → users.id) read refused: ${error.message}` }
    for (const row of (data ?? []) as Array<{ id: string; user_id: string | null }>) {
      if (row.user_id) userIdByAgentId.set(row.id, row.user_id)
    }
  }
  return { ok: true, userIdByAgentId }
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
