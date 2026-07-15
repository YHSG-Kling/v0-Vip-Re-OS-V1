"use server"

/**
 * app/actions/connection-health.ts — the tenant's own connection health.
 * Self-scoped: the brokerage owner sees THEIR connectors' business impact,
 * resolved from their session. Reuses scanConnectivity (the connectivity
 * agent) + the pure impact translation — no duplicate health logic.
 */

import { createClient } from "@/lib/supabase/server"
import { scanConnectivity } from "@/lib/agentic-os/resolve-connectivity"
import { composeConnectionImpact, composeConnectionHeadline, type ConnectionImpactRead } from "@/lib/agentic-os/connection-impact"

export async function getMyConnectionHealth(): Promise<
  { success: true; read: ConnectionImpactRead; headline: string } | { success: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!(profile as any)?.brokerage_id) return { success: false, error: "No brokerage on user" }

  const report = await scanConnectivity({ brokerageId: (profile as any).brokerage_id })
  const read = composeConnectionImpact(report)
  return { success: true, read, headline: composeConnectionHeadline(read) }
}
