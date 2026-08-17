"use server"

/**
 * app/actions/connection-health.ts — connection health at the RIGHT scope
 * (owner fix: connections exist at brokerage/team/agent level, so each seat
 * sees its own). getMyConnectionHealth scopes to the AGENT's own connections;
 * getBrokerageConnectionHealth (broker/admin) shows the brokerage/team-run +
 * pooled fleet. Both reuse scanConnectivity + the pure impact translation —
 * no duplicate health logic.
 */

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { scanConnectivity } from "@/lib/agentic-os/resolve-connectivity"
import { composeConnectionImpact, composeConnectionHeadline, type ConnectionImpactRead } from "@/lib/agentic-os/connection-impact"

// TENANT ADMIN GATE (kept inline, brokerage-wide connectivity view):
// 'superadmin' removed — dead as users.user_type (0 live rows); broker_owner
// added — storable seat that owns the brokerage.
const BROKER_TYPES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

async function resolveCaller() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!(profile as any)?.brokerage_id) return null
  return { supabase, userId: user.id, brokerageId: (profile as any).brokerage_id as string, userType: String((profile as any).user_type ?? "") }
}

/** AGENT scope — the caller's OWN provider connections. */
export async function getMyConnectionHealth(): Promise<
  { success: true; read: ConnectionImpactRead; headline: string } | { success: false; error: string }
> {
  const caller = await resolveCaller()
  if (!caller) return { success: false, error: "Unauthorized" }
  const agentId = await resolveAgentId(caller.supabase, caller.userId).catch(() => null)
  const report = await scanConnectivity({ brokerageId: caller.brokerageId, agentId })
  const read = composeConnectionImpact(report)
  return { success: true, read, headline: composeConnectionHeadline(read) }
}

/** BROKER scope — the brokerage/team-run connections + the pooled fleet (no agent filter). */
export async function getBrokerageConnectionHealth(): Promise<
  { success: true; read: ConnectionImpactRead; headline: string } | { success: false; error: string }
> {
  const caller = await resolveCaller()
  if (!caller) return { success: false, error: "Unauthorized" }
  if (!BROKER_TYPES.has(caller.userType)) return { success: false, error: "Broker access required" }
  const report = await scanConnectivity({ brokerageId: caller.brokerageId }) // no agentId = brokerage-wide
  const read = composeConnectionImpact(report)
  return { success: true, read, headline: composeConnectionHeadline(read) }
}
