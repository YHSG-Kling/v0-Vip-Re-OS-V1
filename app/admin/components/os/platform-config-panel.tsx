"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Settings, Shield, Zap, Globe, ExternalLink } from "lucide-react"

interface PlatformConfig {
  aiEnabled: boolean
  emergencyMode: boolean
  globalRateLimitPerMinute: number
}

interface FeatureFlag {
  id: string
  featureKey: string
  displayName: string
  enabled: boolean
  beta: boolean
  deprecated: boolean
}

interface PlatformConfigPanelProps {
  config: PlatformConfig
  featureFlags: FeatureFlag[]
}

export function PlatformConfigPanel({ config, featureFlags }: PlatformConfigPanelProps) {
  const enabledFlags = featureFlags.filter((f) => f.enabled).length
  const betaFlags = featureFlags.filter((f) => f.beta).length

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Platform Config
          </CardTitle>
          <Link href="/admin/config">
            <Button variant="ghost" size="sm" className="gap-1">
              <ExternalLink className="h-3 w-3" />
              Manage
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Emergency Mode Alert */}
        {config.emergencyMode && (
          <div className="p-3 bg-red-500/20 rounded-lg border border-red-500/40">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-red-600" />
              <span className="font-medium text-red-600">Emergency Mode Active</span>
            </div>
            <p className="text-xs text-red-600 mt-1">Platform is in restricted operation mode</p>
          </div>
        )}

        {/* Config Status */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="h-4 w-4 text-yellow-500" />
              <span className="text-sm font-medium">AI Engine</span>
            </div>
            <Badge variant={config.aiEnabled ? "default" : "destructive"} className={config.aiEnabled ? "bg-green-600" : ""}>
              {config.aiEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <Globe className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-medium">Rate Limit</span>
            </div>
            <span className="text-lg font-bold">{config.globalRateLimitPerMinute}/min</span>
          </div>
        </div>

        {/* Feature Flags Summary */}
        <div className="p-3 bg-muted/50 rounded-lg">
          <p className="text-sm font-medium mb-2">Feature Flags</p>
          <div className="flex items-center gap-4">
            <div>
              <span className="text-lg font-bold">{enabledFlags}</span>
              <span className="text-xs text-muted-foreground ml-1">/ {featureFlags.length} enabled</span>
            </div>
            {betaFlags > 0 && (
              <Badge variant="outline" className="text-xs">
                {betaFlags} beta
              </Badge>
            )}
          </div>
        </div>

        {/* Quick Flag List */}
        <div className="space-y-1 max-h-32 overflow-y-auto">
          {featureFlags.slice(0, 6).map((flag) => (
            <div key={flag.id} className="flex items-center justify-between py-1 text-sm">
              <span className={flag.enabled ? "" : "text-muted-foreground"}>{flag.displayName}</span>
              <div className="flex items-center gap-1">
                {flag.beta && (
                  <Badge variant="outline" className="text-xs px-1">
                    beta
                  </Badge>
                )}
                <div className={`h-2 w-2 rounded-full ${flag.enabled ? "bg-green-500" : "bg-gray-300"}`} />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
