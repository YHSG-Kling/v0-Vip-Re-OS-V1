"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Activity,
  Wifi,
  WifiOff 
} from "lucide-react"

interface ProviderStatus {
  id: string
  provider_name: string
  provider_type: string
  status: "active" | "error" | "inactive" | "pending"
  last_error?: string | null
  last_health_check_at?: string | null
}

interface ProviderHealthRadarProps {
  providers: ProviderStatus[]
  totalIntegrations: number
  healthyCount: number
  errorCount: number
  pendingCount: number
}

export function ProviderHealthRadar({
  providers,
  totalIntegrations,
  healthyCount,
  errorCount,
  pendingCount,
}: ProviderHealthRadarProps) {
  const healthPct = totalIntegrations > 0 ? Math.round((healthyCount / totalIntegrations) * 100) : 0
  
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Provider Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Health Score */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-3xl font-bold">{healthPct}%</p>
            <p className="text-xs text-muted-foreground">Overall Health</p>
          </div>
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-1">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <span>{healthyCount}</span>
            </div>
            <div className="flex items-center gap-1">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span>{pendingCount}</span>
            </div>
            <div className="flex items-center gap-1">
              <XCircle className="h-4 w-4 text-red-500" />
              <span>{errorCount}</span>
            </div>
          </div>
        </div>

        {/* Provider List */}
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {providers.slice(0, 8).map((provider) => (
            <div
              key={provider.id}
              className="flex items-center justify-between py-1 border-b border-border/50 last:border-0"
            >
              <div className="flex items-center gap-2">
                {provider.status === "active" ? (
                  <Wifi className="h-3 w-3 text-green-500" />
                ) : provider.status === "error" ? (
                  <WifiOff className="h-3 w-3 text-red-500" />
                ) : (
                  <WifiOff className="h-3 w-3 text-muted-foreground" />
                )}
                <span className="text-sm">{provider.provider_name}</span>
              </div>
              <Badge
                variant={
                  provider.status === "active"
                    ? "default"
                    : provider.status === "error"
                    ? "destructive"
                    : "secondary"
                }
                className="text-xs"
              >
                {provider.status}
              </Badge>
            </div>
          ))}
          {providers.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No providers configured
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
