'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Eye, AlertTriangle, CheckCircle, Clock, TrendingDown } from 'lucide-react'
import { getAutomationErrors, getCronExecutionLogs, type AutomationError, type CronExecutionLog } from '@/app/actions/system-health'

interface ObservabilityPanelProps {
  brokerageId: string
}

export function ObservabilityPanel({ brokerageId }: ObservabilityPanelProps) {
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<AutomationError[]>([])
  const [cronLogs, setCronLogs] = useState<CronExecutionLog[]>([])
  const [byWorkflow, setByWorkflow] = useState<Record<string, { count: number; severity: string }[]>>({})

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const [errorData, cronData] = await Promise.all([
          getAutomationErrors(7),
          getCronExecutionLogs(20)
        ])
        setErrors(errorData.errors)
        setByWorkflow(errorData.byWorkflow)
        setCronLogs(cronData)
      } catch (error) {
        console.error('Error loading observability data:', error)
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
          <Eye className="h-6 w-6 animate-pulse text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  const recentErrors = errors.slice(0, 5)
  const openErrors = errors.filter(e => e.status === 'open')
  const criticalErrors = errors.filter(e => e.severity === 'critical')
  const failedCrons = cronLogs.filter(c => c.status === 'failed' || c.status === 'timeout')
  const topAffectedWorkflows = Object.entries(byWorkflow)
    .map(([name, severities]) => ({
      name,
      total: severities.reduce((sum, s) => sum + s.count, 0),
      hasCritical: severities.some(s => s.severity === 'critical')
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3)

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Eye className="h-5 w-5 text-primary" />
          Observability
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Error Summary */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-red-50 dark:bg-red-950/20 p-3 text-center">
            <p className="text-2xl font-bold text-red-600">{openErrors.length}</p>
            <p className="text-xs text-red-700 dark:text-red-400">Open Errors</p>
          </div>
          <div className="rounded-lg bg-orange-50 dark:bg-orange-950/20 p-3 text-center">
            <p className="text-2xl font-bold text-orange-600">{criticalErrors.length}</p>
            <p className="text-xs text-orange-700 dark:text-orange-400">Critical</p>
          </div>
          <div className="rounded-lg bg-yellow-50 dark:bg-yellow-950/20 p-3 text-center">
            <p className="text-2xl font-bold text-yellow-600">{failedCrons.length}</p>
            <p className="text-xs text-yellow-700 dark:text-yellow-400">Failed Jobs</p>
          </div>
        </div>

        {/* Top Affected Workflows */}
        {topAffectedWorkflows.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <TrendingDown className="h-3 w-3" />
              Top Affected Workflows
            </p>
            {topAffectedWorkflows.map(wf => (
              <div 
                key={wf.name}
                className="flex items-center justify-between rounded-lg border border-border p-2"
              >
                <span className="text-sm font-medium truncate">{wf.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">{wf.total} errors</span>
                  {wf.hasCritical && (
                    <Badge variant="destructive" className="text-xs">Critical</Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Recent Errors */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">Recent Failures</p>
          {recentErrors.length === 0 ? (
            <div className="flex items-center gap-2 text-green-600 rounded-lg bg-green-50 dark:bg-green-950/20 p-3">
              <CheckCircle className="h-4 w-4" />
              <span className="text-sm">No recent errors in the last 7 days</span>
            </div>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {recentErrors.map(error => (
                <div 
                  key={error.id}
                  className="flex items-center justify-between rounded-lg border border-border p-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertTriangle className={`h-3 w-3 flex-shrink-0 ${
                      error.severity === 'critical' ? 'text-red-500' :
                      error.severity === 'high' ? 'text-orange-500' :
                      'text-yellow-500'
                    }`} />
                    <span className="text-xs truncate">{error.workflow_name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      {new Date(error.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
