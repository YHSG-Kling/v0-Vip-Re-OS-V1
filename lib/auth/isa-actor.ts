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
// Module-private since 2026-09-08 — no importer outside this file; outside mentions are prose (category B tranche 2).
async function getIsaSystemUserId(
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

/**
 * THE AUDIT-ROW FORM OF THE ISA ACTOR RULE (wave 101C — "isa is a system ai isa"). The ledger form is
 * lib/kernel/action-ledger.ts attributedActor; this is the same rule for the plain audit columns an
 * ISA send/call writes OUTSIDE the ledger (compliance_events.actor_user_id from the suppression gate
 * and the content-safety backstop, outbound_message_compliance_log.initiated_by from the TCPA gate):
 * an AI-ISA action names the ISA's SYSTEM user, never the human whose record or line it ran beside.
 * That human rides as `onBehalfOfUserId` (context, not credit). A refused / missing ISA identity
 * names NO user — never falls back to the human.
 */
export async function isaAuditActor(
  client: SupabaseClient,
  brokerageId: string | null | undefined,
  humanUserId: string | null | undefined,
): Promise<{ actorUserId: string | null; onBehalfOfUserId: string | null }> {
  let isa: string | null = null
  try {
    isa = await getIsaSystemUserIdCached(client, brokerageId)
  } catch {
    isa = null
  }
  return { actorUserId: isa, onBehalfOfUserId: humanUserId && humanUserId !== isa ? humanUserId : null }
}

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
