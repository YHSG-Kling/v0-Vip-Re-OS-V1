'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Activity, Users, Workflow, AlertCircle, CheckCircle, TrendingUp } from 'lucide-react'
import { getServiceStatuses, getAutomationErrors, getSLASummary, type ServiceStatus } from '@/app/actions/system-health'

interface OperationalImpactPanelProps {
  brokerageId: string
}

interface ImpactMetrics {
  affectedWorkflows: string[]
  affectedRoles: string[]
  criticalServices: ServiceStatus[]
  slaSummary: Array<{
    service_key: string
    service_name: string
    uptime_30d: number
    avg_response_ms: number
    total_incidents: number
  }>
  /** The server's verdict on whether service health was measurable at all. */
  serviceReadStatus: 'ok' | 'empty' | 'unavailable'
  serviceReadDetail: string | null
}

export function OperationalImpactPanel({ brokerageId }: OperationalImpactPanelProps) {
  const [loading, setLoading] = useState(true)
  const [metrics, setMetrics] = useState<ImpactMetrics | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        setLoadError(null)

        const [serviceData, errorData, slaData] = await Promise.all([
          getServiceStatuses(),
          getAutomationErrors(7),
          getSLASummary(30)
        ])

        // Determine affected workflows from errors
        const affectedWorkflows = Object.keys(errorData.byWorkflow).slice(0, 5)

        // Determine affected roles based on service categories
        const affectedRoles: string[] = []
        const degradedServices = serviceData.services.filter(
          s => s.current_status === 'degraded' || s.current_status === 'down'
        )
        
        degradedServices.forEach(service => {
          if (service.service_category === 'communication' || service.service_category === 'email') {
            if (!affectedRoles.includes('Agents')) affectedRoles.push('Agents')
            if (!affectedRoles.includes('Coordinators')) affectedRoles.push('Coordinators')
          }
          if (service.service_category === 'calendar') {
            if (!affectedRoles.includes('Agents')) affectedRoles.push('Agents')
          }
          if (service.service_category === 'payment' || service.service_category === 'accounting') {
            if (!affectedRoles.includes('Admin')) affectedRoles.push('Admin')
            if (!affectedRoles.includes('Broker')) affectedRoles.push('Broker')
          }
          if (service.service_category === 'ai') {
            if (!affectedRoles.includes('All Users')) affectedRoles.push('All Users')
          }
        })

        setMetrics({
          affectedWorkflows,
          affectedRoles,
          criticalServices: serviceData.criticalIssues,
          slaSummary: slaData.slice(0, 5), // Show worst performing services
          serviceReadStatus: serviceData.readStatus,
          serviceReadDetail: serviceData.readDetail,
        })
      } catch (error) {
        console.error('Error loading operational impact:', error)
        setMetrics(null)
        setLoadError(error instanceof Error ? error.message : 'Operational impact could not be read.')
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
          <Activity className="h-6 w-6 animate-pulse text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  const hasImpact =
    (metrics?.affectedWorkflows.length || 0) > 0 ||
    (metrics?.affectedRoles.length || 0) > 0 ||
    (metrics?.criticalServices.length || 0) > 0

  // "No impact" is only a claim we may make when service health was actually
  // read. An empty or refused read means impact is UNKNOWN.
  const serviceHealthMeasured = metrics !== null && metrics.serviceReadStatus === 'ok'
  const unmeasuredDetail =
    loadError ?? metrics?.serviceReadDetail ?? 'Service health could not be read.'

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Operational Impact
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!serviceHealthMeasured ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-4">
            <AlertCircle className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium">Operational Impact UNKNOWN</p>
              <p className="text-sm text-muted-foreground">{unmeasuredDetail}</p>
            </div>
          </div>
        ) : !hasImpact ? (
          <div className="flex items-center gap-2 text-green-600 rounded-lg bg-green-50 dark:bg-green-950/20 p-4">
            <CheckCircle className="h-5 w-5" />
            <div>
              <p className="font-medium">No Operational Impact</p>
              <p className="text-sm opacity-80">All systems are operating normally</p>
            </div>
          </div>
        ) : (
          <>
            {/* Affected Workflows */}
            {metrics?.affectedWorkflows && metrics.affectedWorkflows.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                  <Workflow className="h-3 w-3" />
                  Affected Workflows
                </p>
                <div className="flex flex-wrap gap-2">
                  {metrics.affectedWorkflows.map(wf => (
                    <Badge key={wf} variant="outline" className="text-xs">
                      {wf}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Affected Roles */}
            {metrics?.affectedRoles && metrics.affectedRoles.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  Affected Roles
                </p>
                <div className="flex flex-wrap gap-2">
                  {metrics.affectedRoles.map(role => (
                    <Badge key={role} variant="secondary" className="text-xs">
                      {role}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Critical Services */}
            {metrics?.criticalServices && metrics.criticalServices.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 text-red-500" />
                  Critical Services Down
                </p>
                <div className="space-y-1">
                  {metrics.criticalServices.map(service => (
                    <div 
                      key={service.id}
                      className="flex items-center justify-between rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-2"
                    >
                      <span className="text-sm font-medium text-red-800 dark:text-red-200">
                        {service.service_name}
                      </span>
                      <Badge variant="destructive" className="text-xs">
                        Down
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* SLA Summary */}
        {metrics?.slaSummary && metrics.slaSummary.length > 0 && (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              30-Day Service Health
            </p>
            <div className="space-y-1">
              {metrics.slaSummary.map(service => (
                <div 
                  key={service.service_key}
                  className="flex items-center justify-between rounded-lg border border-border p-2"
                >
                  <span className="text-sm truncate">{service.service_name}</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${
                      service.uptime_30d >= 99 ? 'text-green-600' :
                      service.uptime_30d >= 95 ? 'text-yellow-600' :
                      'text-red-600'
                    }`}>
                      {service.uptime_30d.toFixed(1)}%
                    </span>
                    {service.total_incidents > 0 && (
                      <Badge variant="outline" className="text-xs">
                        {service.total_incidents} incidents
                      </Badge>
                    )}
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
