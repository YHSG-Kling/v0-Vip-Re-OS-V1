import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Resolves the AI-ISA system actor's user_id for a brokerage.
 *
 * Every brokerage has exactly one ISA actor (auth.users entry +
 * public.users mirror with platform_role='ai_isa_system'). The
 * brokerages.ai_isa_system_user_id column caches the mapping so this
 * is a single-row lookup.
 *
 * Returns null if the brokerage has not been provisioned. Callers
 * that need to write `actor_user_id` to audit tables (compliance_events,
 * lifecycle_events, tenant_transition_log) MUST fall back to the
 * brokerage admin's user_id rather than writing a literal string —
 * those columns are UUID-typed.
 */
export async function getIsaSystemUserId(
  client: SupabaseClient,
  brokerageId: string | null | undefined
): Promise<string | null> {
  if (!brokerageId) return null
  const { data } = await client
    .from("brokerages")
    .select("ai_isa_system_user_id")
    .eq("id", brokerageId)
    .maybeSingle()
  return (data?.ai_isa_system_user_id as string | null) ?? null
}

const isaActorCache = new Map<string, { value: string | null; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

/** Same as getIsaSystemUserId but memoizes per process for 5 minutes. */
export async function getIsaSystemUserIdCached(
  client: SupabaseClient,
  brokerageId: string | null | undefined
): Promise<string | null> {
  if (!brokerageId) return null
  const now = Date.now()
  const cached = isaActorCache.get(brokerageId)
  if (cached && cached.expiresAt > now) return cached.value
  const value = await getIsaSystemUserId(client, brokerageId)
  isaActorCache.set(brokerageId, { value, expiresAt: now + CACHE_TTL_MS })
  return value
}
