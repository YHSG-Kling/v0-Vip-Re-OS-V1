'use client'

import { Badge } from '@/components/ui/badge'
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import type { CoherenceFinding } from '@/lib/kernel/routes'

interface Props {
  findings: CoherenceFinding[]
  valid: number
  invalid: number
}

const SEVERITY_CONFIG = {
  info:     { icon: CheckCircle2, color: 'text-blue-600',  bg: 'bg-blue-50 border-blue-200',  badge: 'secondary' as const },
  warning:  { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200', badge: 'secondary' as const },
  critical: { icon: XCircle,      color: 'text-red-600',   bg: 'bg-red-50 border-red-200',    badge: 'destructive' as const },
}

export function ContractIntegrityPanel({ findings, valid, invalid }: Props) {
  if (findings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-green-200 bg-green-50 py-12">
        <CheckCircle2 className="h-8 w-8 text-green-600" />
        <p className="text-sm font-medium text-green-700">All route contracts are valid.</p>
        <p className="text-xs text-green-600">{valid} routes passed integrity checks.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-sm">
        <span className="flex items-center gap-1.5 text-green-600 font-medium">
          <CheckCircle2 className="h-4 w-4" />
          {valid} valid
        </span>
        <span className="flex items-center gap-1.5 text-red-600 font-medium">
          <XCircle className="h-4 w-4" />
          {invalid} invalid
        </span>
      </div>

      <div className="space-y-2">
        {findings.map((f, i) => {
          const config = SEVERITY_CONFIG[f.severity]
          const Icon = config.icon
          return (
            <div key={i} className={`rounded-lg border p-4 ${config.bg}`}>
              <div className="flex items-start gap-3">
                <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${config.color}`} />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={config.badge}>{f.severity}</Badge>
                    <span className="text-xs text-muted-foreground font-mono">{f.type}</span>
                  </div>
                  <p className="text-sm font-medium">{f.message}</p>
                  <p className="text-xs text-muted-foreground">{f.recommendation}</p>
                  {f.affected.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {f.affected.map((a) => (
                        <span key={a} className="inline-block font-mono text-xs bg-background rounded px-1.5 py-0.5 border">
                          {a}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
