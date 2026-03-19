'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, CheckCircle, XCircle, Clock, Calendar, Mail, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface SyncHealthPanelProps {
  brokerageId: string
}

interface SyncStatus {
  id: string
  direction: string
  status: string
  event_count: number | null
  error_message: string | null
  started_at: string
  completed_at: string | null
}

interface AccountingSync {
  id: string
  provider: string
  sync_type: string
  status: string
  records_synced: number
  records_failed: number
  error_summary: string | null
  started_at: string
  completed_at: string | null
}

export function SyncHealthPanel({ brokerageId }: SyncHealthPanelProps) {
  const [loading, setLoading] = useState(true)
  const [calendarSyncs, setCalendarSyncs] = useState<SyncStatus[]>([])
  const [accountingSyncs, setAccountingSyncs] = useState<AccountingSync[]>([])
  const [staleSyncCount, setStaleSyncCount] = useState(0)

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const supabase = createClient()

        // Get recent calendar sync logs
        const { data: calData } = await supabase
          .from('calendar_sync_logs')
          .select('*')
          .eq('brokerage_id', brokerageId)
          .order('started_at', { ascending: false })
          .limit(10)

        // Get recent accounting sync logs
        const { data: accData } = await supabase
          .from('accounting_sync_log')
          .select('*')
          .eq('brokerage_id', brokerageId)
          .order('started_at', { ascending: false })
          .limit(5)

        // Check for stale syncs (last sync > 24 hours ago)
        const oneDayAgo = new Date()
        oneDayAgo.setDate(oneDayAgo.getDate() - 1)

        const { data: staleAccounts, count } = await supabase
          .from('calendar_provider_accounts')
          .select('id', { count: 'exact', head: true })
          .eq('brokerage_id', brokerageId)
          .eq('is_active', true)
          .lt('last_sync_at', oneDayAgo.toISOString())

        setCalendarSyncs(calData || [])
        setAccountingSyncs(accData || [])
        setStaleSyncCount(count || 0)
      } catch (error) {
        console.error('Error loading sync health:', error)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="flex items-center justify-center py-8">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  const successfulSyncs = calendarSyncs.filter(s => s.status === 'success')
  const failedSyncs = calendarSyncs.filter(s => s.status === 'failed' || s.status === 'error')
  const inProgressSyncs = calendarSyncs.filter(s => s.status === 'in_progress' || s.status === 'started')

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-primary" />
          Sync Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Stats */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-green-50 dark:bg-green-950/20 p-3 text-center">
            <p className="text-2xl font-bold text-green-600">{successfulSyncs.length}</p>
            <p className="text-xs text-green-700 dark:text-green-400">Successful</p>
          </div>
          <div className="rounded-lg bg-red-50 dark:bg-red-950/20 p-3 text-center">
            <p className="text-2xl font-bold text-red-600">{failedSyncs.length}</p>
            <p className="text-xs text-red-700 dark:text-red-400">Failed</p>
          </div>
          <div className="rounded-lg bg-yellow-50 dark:bg-yellow-950/20 p-3 text-center">
            <p className="text-2xl font-bold text-yellow-600">{staleSyncCount}</p>
            <p className="text-xs text-yellow-700 dark:text-yellow-400">Stale</p>
          </div>
        </div>

        {/* Stale Sync Warning */}
        {staleSyncCount > 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-900 p-3">
            <AlertTriangle className="h-4 w-4 text-yellow-600 flex-shrink-0" />
            <span className="text-sm text-yellow-700 dark:text-yellow-400">
              {staleSyncCount} calendar account(s) haven't synced in 24+ hours
            </span>
          </div>
        )}

        {/* Calendar Syncs */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            Calendar Syncs
          </p>
          {calendarSyncs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent calendar syncs</p>
          ) : (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {calendarSyncs.slice(0, 5).map(sync => (
                <div 
                  key={sync.id}
                  className="flex items-center justify-between rounded-lg border border-border p-2"
                >
                  <div className="flex items-center gap-2">
                    {sync.status === 'success' ? (
                      <CheckCircle className="h-3 w-3 text-green-500" />
                    ) : sync.status === 'failed' || sync.status === 'error' ? (
                      <XCircle className="h-3 w-3 text-red-500" />
                    ) : (
                      <RefreshCw className="h-3 w-3 text-blue-500 animate-spin" />
                    )}
                    <span className="text-xs capitalize">{sync.direction}</span>
                    {sync.event_count !== null && (
                      <Badge variant="outline" className="text-xs">
                        {sync.event_count} events
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(sync.started_at).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Accounting Syncs */}
        {accountingSyncs.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Mail className="h-3 w-3" />
              Accounting Syncs
            </p>
            <div className="space-y-1">
              {accountingSyncs.slice(0, 3).map(sync => (
                <div 
                  key={sync.id}
                  className="flex items-center justify-between rounded-lg border border-border p-2"
                >
                  <div className="flex items-center gap-2">
                    {sync.status === 'success' || sync.status === 'completed' ? (
                      <CheckCircle className="h-3 w-3 text-green-500" />
                    ) : (
                      <XCircle className="h-3 w-3 text-red-500" />
                    )}
                    <span className="text-xs capitalize">{sync.provider}</span>
                    <Badge variant="outline" className="text-xs">
                      {sync.records_synced} synced
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
