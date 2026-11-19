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

  // RECEIPT (wave 155, lane 155R5 — G11): the model call is claimed → run → settled on agent_action_ledger (who asked, under
  // which risk class); ai_tool_usage stays the cost ledger, written by the same inner call with the same numbers (CLAUDE.md §5).
  const brokerageId: string = userRow.brokerage_id
  const { ledgerToolCall } = await import("@/lib/kernel/action-ledger")
  return await ledgerToolCall({ brokerageId, action: "ai.agent_insights.generate", actor: { type: "user", userId: user.id }, subject: { type: "user", id: user.id }, reasonCode: "HUMAN_REQUESTED", riskClass: "READ", systemSource: "agent_insights" }, () => getAgentPatternInsights({
    agentUserId: user.id,
    brokerageId,
  })) as AgentInsights | null
}
