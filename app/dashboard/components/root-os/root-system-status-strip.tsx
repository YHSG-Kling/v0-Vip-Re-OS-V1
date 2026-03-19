'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { 
  CheckCircle2, 
  AlertTriangle, 
  XCircle,
  Activity,
  Loader2 
} from 'lucide-react'
import { getServiceStatuses, type ServiceStatus } from '@/app/actions/system-health'

type OverallStatus = 'healthy' | 'degraded' | 'down' | 'unknown'

interface SystemStatusSummary {
  overall: OverallStatus
  healthyCount: number
  degradedCount: number
  downCount: number
  criticalIssue: string | null
}

export function RootSystemStatusStrip() {
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<SystemStatusSummary>({
    overall: 'unknown',
    healthyCount: 0,
    degradedCount: 0,
    downCount: 0,
    criticalIssue: null,
  })

  useEffect(() => {
    async function loadStatus() {
      try {
        const result = await getServiceStatuses()
        
        if (result.services && Array.isArray(result.services)) {
          const services = result.services as ServiceStatus[]
          
          let healthyCount = 0
          let degradedCount = 0
          let downCount = 0
          let criticalIssue: string | null = null

          services.forEach((svc) => {
            if (svc.current_status === 'healthy') {
              healthyCount++
            } else if (svc.current_status === 'degraded') {
              degradedCount++
            } else if (svc.current_status === 'down') {
              downCount++
              if (svc.is_critical && !criticalIssue) {
                criticalIssue = `${svc.service_name} is down`
              }
            }
          })

          let overall: OverallStatus = 'healthy'
          if (downCount > 0) {
            overall = 'down'
          } else if (degradedCount > 0) {
            overall = 'degraded'
          }

          setStatus({
            overall,
            healthyCount,
            degradedCount,
            downCount,
            criticalIssue,
          })
        }
      } catch (error) {
        console.error('[RootSystemStatusStrip] Error loading status:', error)
        setStatus((prev) => ({ ...prev, overall: 'unknown' }))
      } finally {
        setLoading(false)
      }
    }

    loadStatus()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 rounded-lg">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Checking systems...</span>
      </div>
    )
  }

  const getStatusConfig = () => {
    switch (status.overall) {
      case 'healthy':
        return {
          icon: CheckCircle2,
          color: 'text-emerald-600',
          bgColor: 'bg-emerald-50 border-emerald-200',
          label: 'All Systems Operational',
        }
      case 'degraded':
        return {
          icon: AlertTriangle,
          color: 'text-amber-600',
          bgColor: 'bg-amber-50 border-amber-200',
          label: `${status.degradedCount} service${status.degradedCount > 1 ? 's' : ''} degraded`,
        }
      case 'down':
        return {
          icon: XCircle,
          color: 'text-destructive',
          bgColor: 'bg-destructive/10 border-destructive/20',
          label: status.criticalIssue || `${status.downCount} service${status.downCount > 1 ? 's' : ''} down`,
        }
      default:
        return {
          icon: Activity,
          color: 'text-muted-foreground',
          bgColor: 'bg-muted border-border',
          label: 'Status Unknown',
        }
    }
  }

  const config = getStatusConfig()
  const Icon = config.icon

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${config.bgColor}`}>
      <Icon className={`h-3.5 w-3.5 ${config.color}`} />
      <span className={`text-xs font-medium ${config.color}`}>{config.label}</span>
      {status.overall === 'healthy' && (
        <Badge variant="outline" className="text-xs py-0 h-5 ml-auto">
          {status.healthyCount} services
        </Badge>
      )}
    </div>
  )
}
