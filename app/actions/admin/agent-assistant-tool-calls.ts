'use server'

/**
 * READER (orphan doctrine §1.2) for agent_assistant_tool_calls — the audit row
 * app/api/agent-assistant/tool-call/route.ts writes on EVERY ElevenLabs voice
 * assistant tool call (success or failure), keyed by (brokerage_id, session_id,
 * tool_name, tool_input, tool_output, success, error_message, latency_ms, ts —
 * schema-snapshot.ts:44). Until now nothing read the 6 non-key columns back:
 * the row existed for "brokers can audit what did the AI do?" (the route's own
 * header) and no surface ever showed one.
 *
 * Two readers, two tenancy shapes:
 *   - getAgentAssistantToolCallSummary — a brokerage-scoped maintenance rollup
 *     (error rate, p95 latency, top tool_name) for the tenant's own AI Usage
 *     page. Tenant from the SESSION (§4): the caller's own brokerage_id, never
 *     a parameter.
 *   - getAgentAssistantToolCallReplay — the full-fidelity session replay
 *     (tool_input/tool_output verbatim) for platform debugging. Gated to
 *     platform_role (isPlatformSuperadminIdentity) INSIDE this function, not
 *     only by the calling page — a "use server" export is a public endpoint
 *     (§4) and every caller must pass the same door.
 */

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { isPlatformSuperadminIdentity } from '@/lib/platform/platform-staff-roster'
import { percentile95 } from '@/lib/admin/tool-call-metrics'

export interface ToolCallSummary {
  totalCalls: number
  errorCount: number
  errorRate: number
  p95LatencyMs: number | null
  topTools: Array<{ toolName: string; count: number; errorCount: number }>
  windowStart: string
  windowEnd: string
}

/**
 * Tenant-scoped maintenance summary — error rate, p95 latency, top tool_name —
 * over the caller's OWN brokerage's voice-assistant tool calls in the last
 * `windowDays` days. Returns null (not a zero) when the caller has no
 * brokerage — that is "cannot resolve tenant", not "no calls".
 */
export async function getAgentAssistantToolCallSummary(windowDays = 30): Promise<ToolCallSummary | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: profile } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle()
  const brokerageId = profile?.brokerage_id as string | null
  if (!brokerageId) return null

  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const windowEnd = new Date().toISOString()

  const { data, error } = await supabase
    .from('agent_assistant_tool_calls')
    .select('tool_name, success, latency_ms')
    .eq('brokerage_id', brokerageId)
    .gte('ts', windowStart)
    .lte('ts', windowEnd)
    .limit(5000)
  if (error) throw new Error(`Could not read tool-call summary: ${error.message}`)

  const rows = (data ?? []) as Array<{ tool_name: string; success: boolean; latency_ms: number | null }>
  const totalCalls = rows.length
  const errorCount = rows.filter((r) => !r.success).length
  const latencies = rows
    .map((r) => r.latency_ms)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b)

  const byTool = new Map<string, { count: number; errorCount: number }>()
  for (const r of rows) {
    const entry = byTool.get(r.tool_name) ?? { count: 0, errorCount: 0 }
    entry.count++
    if (!r.success) entry.errorCount++
    byTool.set(r.tool_name, entry)
  }
  const topTools = Array.from(byTool.entries())
    .map(([toolName, v]) => ({ toolName, count: v.count, errorCount: v.errorCount }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  return {
    totalCalls,
    errorCount,
    errorRate: totalCalls > 0 ? errorCount / totalCalls : 0,
    p95LatencyMs: percentile95(latencies),
    topTools,
    windowStart,
    windowEnd,
  }
}

export interface ToolCallReplayRow {
  id: string
  brokerageId: string
  sessionId: string
  toolName: string
  toolInput: unknown
  toolOutput: unknown
  success: boolean
  errorMessage: string | null
  latencyMs: number | null
  ts: string
}

/**
 * Platform-only session replay — the raw tool_input/tool_output pair for
 * recent calls, across every tenant. GATED HERE (not only by the calling
 * page's own check) because this is a "use server" export and every export in
 * one is a public HTTP endpoint (§4). Fails closed: a caller who is not a
 * verified platform superadmin gets a thrown refusal, never an empty array
 * that could read as "no calls happened".
 */
export async function getAgentAssistantToolCallReplay(limit = 50): Promise<ToolCallReplayRow[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: profile } = await supabase
    .from('users')
    .select('user_type, platform_role')
    .eq('id', user.id)
    .maybeSingle()
  if (!isPlatformSuperadminIdentity(profile?.user_type, (profile as { platform_role?: string | null } | null)?.platform_role)) {
    throw new Error('Forbidden — platform staff only')
  }

  // Platform staff are not necessarily members of any brokerage, so an RLS
  // client (scoped to the caller's own tenant) cannot see other tenants' rows
  // here. The gate above is what makes the service client safe to use.
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('agent_assistant_tool_calls')
    .select('id, brokerage_id, session_id, tool_name, tool_input, tool_output, success, error_message, latency_ms, ts')
    .order('ts', { ascending: false })
    .limit(Math.min(limit, 200))
  if (error) throw new Error(`Could not read tool-call replay: ${error.message}`)

  return ((data ?? []) as Array<{
    id: string; brokerage_id: string; session_id: string; tool_name: string
    tool_input: unknown; tool_output: unknown; success: boolean
    error_message: string | null; latency_ms: number | null; ts: string
  }>).map((r) => ({
    id: r.id,
    brokerageId: r.brokerage_id,
    sessionId: r.session_id,
    toolName: r.tool_name,
    toolInput: r.tool_input,
    toolOutput: r.tool_output,
    success: r.success,
    errorMessage: r.error_message,
    latencyMs: r.latency_ms,
    ts: r.ts,
  }))
}
