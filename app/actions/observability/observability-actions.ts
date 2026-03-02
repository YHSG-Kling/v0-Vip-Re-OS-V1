
'use server'

import { createClient } from '@/lib/supabase/server'
import {
  listAutomationErrors,
  listCalendarSyncLogs,
  getObservabilityDashboard,
} from '@/lib/kernel'

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
    limit: params.limit ?? 100,
    offset: params.offset ?? 0,
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
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  })
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
