"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Server,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
} from "lucide-react"

interface ProviderStatus {
  name: string
  status: "healthy" | "degraded" | "down"
  lastSync?: string
  issue?: string
}

interface BrokerProviderPressurePanelProps {
  providers: ProviderStatus[]
}

export function BrokerProviderPressurePanel({ providers }: BrokerProviderPressurePanelProps) {
  const statusStyles = {
    healthy: {
      icon: CheckCircle2,
      badge: "outline" as const,
      text: "text-green-600",
      label: "Healthy",
    },
    degraded: {
      icon: AlertTriangle,
      badge: "secondary" as const,
      text: "text-yellow-600",
      label: "Degraded",
    },
    down: {
      icon: XCircle,
      badge: "destructive" as const,
      text: "text-red-600",
      label: "Down",
    },
  }

  const healthyCount = providers.filter(p => p.status === "healthy").length
  const hasIssues = providers.some(p => p.status !== "healthy")

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="h-4 w-4" />
            Provider Status
          </CardTitle>
          <Badge variant={hasIssues ? "destructive" : "outline"} className="text-xs">
            {hasIssues ? `${providers.length - healthyCount} Issue${providers.length - healthyCount !== 1 ? "s" : ""}` : "All Systems OK"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {providers.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground text-sm">
            No integrations configured
          </div>
        ) : (
          providers.map((provider) => {
            const styles = statusStyles[provider.status]
            const Icon = styles.icon

            return (
              <div
                key={provider.name}
                className="flex items-center justify-between p-2 rounded-lg border bg-card"
              >
                <div className="flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${styles.text}`} />
                  <div>
                    <div className="font-medium text-sm">{provider.name}</div>
                    {provider.issue && (
                      <div className="text-xs text-muted-foreground">{provider.issue}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {provider.lastSync && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <RefreshCw className="h-3 w-3" />
                      {provider.lastSync}
                    </span>
                  )}
                  <Badge variant={styles.badge} className="text-xs">
                    {styles.label}
                  </Badge>
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
