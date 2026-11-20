
'use server'

import { createClient } from '@/lib/supabase/server'
import {
  listAutomationErrors,
  listCalendarSyncLogs,
  getObservabilityDashboard,
} from '@/lib/kernel'
// ONE VOCABULARY (§6) for "p95 over a sorted-ascending latency array" — the
// same pure helper the agent_assistant_tool_calls reader uses, rather than a
// second spelling of the same rank math here.
import { percentile95 } from '@/lib/admin/tool-call-metrics'

type Severity = 'low' | 'medium' | 'high' | 'critical'
type Status = 'open' | 'investigating' | 'resolved'

function parseSeverity(value?: string): Severity | undefined {
  if (!value) return undefined
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'critical'
  ) return value
  return undefined
}

function parseStatus(value?: string): Status | undefined {
  if (!value) return undefined
  if (
    value === 'open' ||
    value === 'investigating' ||
    value === 'resolved'
  ) return value
  return undefined
}

export async function fetchAutomationErrors(params: {
  brokerageId: string
  severity?: string
  status?: string
  startDate?: string
  endDate?: string
  limit?: number
  offset?: number
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error('Unauthorized')

  return await listAutomationErrors({
    userId: user.id,
    brokerageId: params.brokerageId,
    type: 'automation',
    severity: parseSeverity(params.severity),
    status: parseStatus(params.status),
    startDate: params.startDate ? new Date(params.startDate) : undefined,
    endDate: params.endDate ? new Date(params.endDate) : undefined,
    limit: params.limit || 100,
    offset: params.offset || 0,
  })
}

export async function fetchCalendarSyncLogs(params: {
  brokerageId: string
  limit?: number
  offset?: number
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error('Unauthorized')

  return await listCalendarSyncLogs({
    userId: user.id,
    brokerageId: params.brokerageId,
    limit: params.limit || 50,
    offset: params.offset || 0,
  })
}

export interface OrchestratorHealthSummary {
  totalEvents: number
  failureCount: number
  failureRate: number
  p95ProcessingTimeMs: number | null
  byHandler: Array<{ handler: string; total: number; failures: number }>
  recentFailures: Array<{ eventId: string; handler: string; errorMessage: string | null; processingTimeMs: number | null; createdAt: string }>
}

/**
 * READER (orphan doctrine §1.2) for event_processing_log —
 * lib/orchestrator/internal.ts::logProcessingResults writes status/handler/
 * processing_time_ms/error_message on every dispatched event and nothing
 * read it back. Tenant-scoped (the brokerage the caller already picked on
 * this page) — a cron_manager/data_steward health rollup: status mix,
 * per-handler failure counts, p95 latency, and the newest failures with
 * their error text.
 */
export async function fetchEventProcessingHealth(brokerageId: string, windowHours = 24): Promise<OrchestratorHealthSummary> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error('Unauthorized')

  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('event_processing_log')
    .select('event_id, handler, status, processing_time_ms, error_message, created_at')
    .eq('brokerage_id', brokerageId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1000)
  if (error) throw new Error(`Could not read orchestrator health: ${error.message}`)

  const rows = (data ?? []) as Array<{
    event_id: string; handler: string; status: string
    processing_time_ms: number | null; error_message: string | null; created_at: string
  }>

  const totalEvents = rows.length
  const failureCount = rows.filter((r) => r.status === 'failure').length
  const latencies = rows.map((r) => r.processing_time_ms).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
  const p95ProcessingTimeMs = percentile95(latencies)

  const byHandlerMap = new Map<string, { total: number; failures: number }>()
  for (const r of rows) {
    const entry = byHandlerMap.get(r.handler) ?? { total: 0, failures: 0 }
    entry.total++
    if (r.status === 'failure') entry.failures++
    byHandlerMap.set(r.handler, entry)
  }
  const byHandler = Array.from(byHandlerMap.entries())
    .map(([handler, v]) => ({ handler, ...v }))
    .sort((a, b) => b.failures - a.failures)

  const recentFailures = rows
    .filter((r) => r.status === 'failure')
    .slice(0, 20)
    .map((r) => ({
      eventId: r.event_id,
      handler: r.handler,
      errorMessage: r.error_message,
      processingTimeMs: r.processing_time_ms,
      createdAt: r.created_at,
    }))

  return {
    totalEvents,
    failureCount,
    failureRate: totalEvents > 0 ? failureCount / totalEvents : 0,
    p95ProcessingTimeMs,
    byHandler,
    recentFailures,
  }
}

export async function fetchObservabilityDashboard(brokerageId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error('Unauthorized')

  return await getObservabilityDashboard({
    userId: user.id,
    brokerageId,
  })
}
