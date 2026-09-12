'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AlertTriangle, CheckCircle2, Activity, RefreshCw, Server } from 'lucide-react'
import { getServiceStatuses, triggerManualHealthCheck, type ServiceStatus } from '@/app/actions/system-health'

interface SystemCommandStripProps {
  brokerageId: string
}

export function SystemCommandStrip({ brokerageId }: SystemCommandStripProps) {
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [data, setData] = useState<{
    services: ServiceStatus[]
    overallStatus: 'operational' | 'critical' | 'degraded' | 'unknown'
    criticalIssues: ServiceStatus[]
    lastCheckedAt: string | null
    readStatus: 'ok' | 'empty' | 'unavailable'
    readDetail: string | null
  } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadData = async () => {
    try {
      setLoading(true)
      setLoadError(null)
      const result = await getServiceStatuses()
      setData(result)
    } catch (error) {
      // A thrown action is NOT a healthy platform — say so instead of falling
      // through to the "All systems operational" banner with data === null.
      console.error('Error loading system status:', error)
      setData(null)
      setLoadError(error instanceof Error ? error.message : 'System status could not be read.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [brokerageId])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await triggerManualHealthCheck()
      // Wait a moment for the health check to complete
      await new Promise(resolve => setTimeout(resolve, 2000))
      await loadData()
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="flex items-center justify-center py-8">
          <Activity className="h-6 w-6 animate-pulse text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  const degradedServices = data?.services.filter(s => s.current_status === 'degraded') || []
  const downServices = data?.services.filter(s => s.current_status === 'down') || []
  const healthyServices = data?.services.filter(s => s.current_status === 'healthy') || []

  // "unknown" is the server's verdict when nothing has been measured or the
  // read was refused. It must never collapse into the green branch.
  const measured = data !== null && data.overallStatus !== 'unknown'
  const unmeasuredDetail =
    loadError ??
    data?.readDetail ??
    'System status could not be read.'

  const priorityAction = !measured
    ? { label: 'System status UNKNOWN — nothing measured', severity: 'unknown' as const }
    : data!.criticalIssues[0]
    ? { label: `Critical: ${data!.criticalIssues[0].service_name} is down`, severity: 'critical' as const }
    : downServices.length > 0
    ? { label: `${downServices.length} service(s) down`, severity: 'high' as const }
    : degradedServices.length > 0
    ? { label: `${degradedServices.length} service(s) degraded`, severity: 'medium' as const }
    : { label: 'All systems operational', severity: 'low' as const }

  const severityColors = {
    critical: 'bg-destructive text-destructive-foreground',
    high: 'bg-orange-500 text-white',
    medium: 'bg-yellow-500 text-yellow-900',
    low: 'bg-green-500 text-white',
    unknown: 'bg-muted text-foreground border border-border',
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            System Command Center
          </CardTitle>
          <Button 
            variant="outline" 
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Priority Action Banner */}
        <div className={`rounded-lg p-4 ${severityColors[priorityAction.severity]}`}>
          <div className="flex items-center gap-3">
            {priorityAction.severity === 'low' ? (
              <CheckCircle2 className="h-6 w-6" />
            ) : (
              <AlertTriangle className="h-6 w-6" />
            )}
            <div>
              <p className="font-semibold">{priorityAction.label}</p>
              {!measured && (
                <p className="text-sm opacity-80">{unmeasuredDetail}</p>
              )}
              {measured && data?.lastCheckedAt && (
                <p className="text-sm opacity-80">
                  Last checked: {new Date(data.lastCheckedAt).toLocaleString()}
                </p>
              )}
              {measured && !data?.lastCheckedAt && (
                <p className="text-sm opacity-80">Never checked.</p>
              )}
            </div>
          </div>
        </div>

        {/* Quick Stats — counts are only shown when something was actually
            measured. Three zeroes under a green tick is the false-confidence
            defect this panel used to render from an empty table. */}
        {measured ? (
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-green-50 dark:bg-green-950/20 p-3 text-center">
              <p className="text-2xl font-bold text-green-600">{healthyServices.length}</p>
              <p className="text-xs text-green-700 dark:text-green-400">Healthy</p>
            </div>
            <div className="rounded-lg bg-yellow-50 dark:bg-yellow-950/20 p-3 text-center">
              <p className="text-2xl font-bold text-yellow-600">{degradedServices.length}</p>
              <p className="text-xs text-yellow-700 dark:text-yellow-400">Degraded</p>
            </div>
            <div className="rounded-lg bg-red-50 dark:bg-red-950/20 p-3 text-center">
              <p className="text-2xl font-bold text-red-600">{downServices.length}</p>
              <p className="text-xs text-red-700 dark:text-red-400">Down</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground rounded-lg border border-dashed border-border p-3">
            No healthy/degraded/down counts are shown because none were measured.
          </p>
        )}

        {/* Critical Issues */}
        {(data?.criticalIssues || []).length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Critical Issues</p>
            {data?.criticalIssues.map(issue => (
              <div key={issue.id} className="flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                <div>
                  <p className="font-medium text-destructive">{issue.service_name}</p>
                  <p className="text-xs text-muted-foreground">{issue.error_message || 'Service unavailable'}</p>
                </div>
                <Badge variant="destructive">Critical</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
