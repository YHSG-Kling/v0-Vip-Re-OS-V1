"use server"

/**
 * Server-action thin wrapper around getAgentPatternInsights so client
 * components on the dashboard can fetch coaching insights without leaking
 * service-role access to the browser.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentPatternInsights, type AgentInsights } from "@/lib/workflow/intelligence/agent-pattern-insights"

export async function loadMyAgentInsights(): Promise<AgentInsights | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!userRow?.brokerage_id) return null

  return getAgentPatternInsights({
    agentUserId: user.id,
    brokerageId: userRow.brokerage_id,
  })
}
