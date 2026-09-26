'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Bell, AlertTriangle, CheckCircle, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface SystemAlertsPanelProps {
  brokerageId: string
}

interface TrendAlert {
  id: string
  alert_type: string
  severity: string
  alert_message: string
  source_table: string
  source_id: string | null
  is_resolved: boolean
  created_at: string
  resolved_at: string | null
}

interface ProactiveIntervention {
  id: string
  issue_detected: string
  severity: string
  ai_recommendation: string
  resolved: boolean
  client_impacted: boolean
  created_at: string
}

export function SystemAlertsPanel({ brokerageId }: SystemAlertsPanelProps) {
  const [loading, setLoading] = useState(true)
  const [trendAlerts, setTrendAlerts] = useState<TrendAlert[]>([])
  const [interventions, setInterventions] = useState<ProactiveIntervention[]>([])

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const supabase = createClient()

        // Get recent trend alerts
        const { data: alertData } = await supabase
          .from('trend_alerts')
          .select('*')
          .eq('brokerage_id', brokerageId)
          .order('created_at', { ascending: false })
          .limit(10)

        // Get proactive interventions
        const { data: interventionData } = await supabase
          .from('proactive_interventions')
          .select('*')
          .eq('brokerage_id', brokerageId)
          .order('created_at', { ascending: false })
          .limit(5)

        setTrendAlerts(alertData || [])
        setInterventions(interventionData || [])
      } catch (error) {
        console.error('Error loading system alerts:', error)
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
          <Bell className="h-6 w-6 animate-pulse text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  const openAlerts = trendAlerts.filter(a => !a.is_resolved)
  const resolvedAlerts = trendAlerts.filter(a => a.is_resolved)
  const criticalAlerts = openAlerts.filter(a => a.severity === 'critical' || a.severity === 'high')
  const openInterventions = interventions.filter(i => !i.resolved)

  const severityColors: Record<string, string> = {
    critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
    medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    low: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            System Alerts
          </CardTitle>
          {openAlerts.length > 0 && (
            <Badge variant="destructive">{openAlerts.length} Open</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-red-50 dark:bg-red-950/20 p-3 text-center">
            <p className="text-2xl font-bold text-red-600">{criticalAlerts.length}</p>
            <p className="text-xs text-red-700 dark:text-red-400">Critical</p>
          </div>
          <div className="rounded-lg bg-yellow-50 dark:bg-yellow-950/20 p-3 text-center">
            <p className="text-2xl font-bold text-yellow-600">{openAlerts.length}</p>
            <p className="text-xs text-yellow-700 dark:text-yellow-400">Open</p>
          </div>
          <div className="rounded-lg bg-green-50 dark:bg-green-950/20 p-3 text-center">
            <p className="text-2xl font-bold text-green-600">{resolvedAlerts.length}</p>
            <p className="text-xs text-green-700 dark:text-green-400">Resolved</p>
          </div>
        </div>

        {/* Open Alerts */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">Recent Alerts</p>
          {openAlerts.length === 0 ? (
            <div className="flex items-center gap-2 text-green-600 rounded-lg bg-green-50 dark:bg-green-950/20 p-3">
              <CheckCircle className="h-4 w-4" />
              <span className="text-sm">No active alerts</span>
            </div>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {openAlerts.slice(0, 5).map(alert => (
                <div 
                  key={alert.id}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <AlertTriangle className={`h-4 w-4 mt-0.5 flex-shrink-0 ${
                        alert.severity === 'critical' ? 'text-red-500' :
                        alert.severity === 'high' ? 'text-orange-500' :
                        'text-yellow-500'
                      }`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{alert.alert_message}</p>
                        <p className="text-xs text-muted-foreground">{alert.source_table}</p>
                      </div>
                    </div>
                    <Badge className={`text-xs flex-shrink-0 ${severityColors[alert.severity] || severityColors.low}`}>
                      {alert.severity}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(alert.created_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Proactive Interventions */}
        {openInterventions.length > 0 && (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-medium text-muted-foreground">AI Interventions</p>
            {openInterventions.map(intervention => (
              <div 
                key={intervention.id}
                className="rounded-lg border border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/20 p-3"
              >
                <p className="text-sm font-medium text-orange-800 dark:text-orange-200">
                  {intervention.issue_detected}
                </p>
                <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                  {intervention.ai_recommendation}
                </p>
                {intervention.client_impacted && (
                  <Badge variant="destructive" className="mt-2 text-xs">
                    Client Impacted
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
