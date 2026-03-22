"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Shield,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  AlertCircle,
  Settings,
  ChevronRight,
  Zap,
} from "lucide-react"

interface ProviderStatus {
  key: string
  name: string
  category: string
  status: "live" | "mock" | "disconnected" | "degraded"
  liveCount: number
  totalBrokerages: number
  affectedFeatures: string[]
  configPath: string
  lastError: string | null
  lastCheckedAt: string | null
}

interface Summary {
  liveCount: number
  mockCount: number
  disconnectedCount: number
  degradedCount: number
}

interface ProvidersHealthClientProps {
  providers: ProviderStatus[]
  summary: Summary
}

function StatusBadge({ status }: { status: ProviderStatus["status"] }) {
  switch (status) {
    case "live":
      return (
        <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Live
        </Badge>
      )
    case "mock":
      return (
        <Badge className="bg-amber-100 text-amber-700 border-amber-200 gap-1">
          <AlertTriangle className="h-3 w-3" />
          Mock / Partial
        </Badge>
      )
    case "degraded":
      return (
        <Badge className="bg-orange-100 text-orange-700 border-orange-200 gap-1">
          <AlertCircle className="h-3 w-3" />
          Degraded
        </Badge>
      )
    case "disconnected":
      return (
        <Badge className="bg-red-100 text-red-700 border-red-200 gap-1">
          <XCircle className="h-3 w-3" />
          Disconnected
        </Badge>
      )
  }
}

function StatusIcon({ status }: { status: ProviderStatus["status"] }) {
  switch (status) {
    case "live":
      return <CheckCircle2 className="h-5 w-5 text-emerald-500" />
    case "mock":
      return <AlertTriangle className="h-5 w-5 text-amber-500" />
    case "degraded":
      return <AlertCircle className="h-5 w-5 text-orange-500" />
    case "disconnected":
      return <XCircle className="h-5 w-5 text-red-500" />
  }
}

const CATEGORY_ORDER = ["CRM", "Transactions", "AI", "Communications", "MLS", "Billing", "Marketing", "Calendar"]

export function ProvidersHealthClient({ providers, summary }: ProvidersHealthClientProps) {
  const totalIssues = summary.mockCount + summary.disconnectedCount + summary.degradedCount

  // Group providers by category
  const byCategory = CATEGORY_ORDER.reduce<Record<string, ProviderStatus[]>>((acc, cat) => {
    const items = providers.filter((p) => p.category === cat)
    if (items.length > 0) acc[cat] = items
    return acc
  }, {})

  // Remaining categories not in CATEGORY_ORDER
  providers.forEach((p) => {
    if (!CATEGORY_ORDER.includes(p.category)) {
      if (!byCategory[p.category]) byCategory[p.category] = []
      byCategory[p.category].push(p)
    }
  })

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Shield className="h-8 w-8 text-primary" />
            Provider Health
          </h1>
          <p className="text-muted-foreground mt-1 max-w-xl">
            Live vs mock/fallback status for all platform integrations. Users cannot tell when providers are in mock mode.
          </p>
        </div>
        <Link href="/admin/integrations">
          <Button variant="outline" className="gap-2">
            <Settings className="h-4 w-4" />
            Manage Integrations
          </Button>
        </Link>
      </div>

      {/* Summary Strip */}
      <Card className={totalIssues > 0 ? "border-amber-200 bg-amber-50/30" : "border-emerald-200 bg-emerald-50/30"}>
        <CardContent className="p-4">
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">Provider Status:</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span className="text-sm font-semibold text-emerald-700">
                {summary.liveCount} providers live
              </span>
            </div>
            {summary.mockCount > 0 && (
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-semibold text-amber-700">
                  {summary.mockCount} running in mock mode
                </span>
              </div>
            )}
            {summary.degradedCount > 0 && (
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-orange-500" />
                <span className="text-sm font-semibold text-orange-700">
                  {summary.degradedCount} degraded
                </span>
              </div>
            )}
            {summary.disconnectedCount > 0 && (
              <div className="flex items-center gap-2">
                <XCircle className="h-4 w-4 text-red-500" />
                <span className="text-sm font-semibold text-red-700">
                  {summary.disconnectedCount} disconnected
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Provider Grid by Category */}
      <div className="space-y-6">
        {Object.entries(byCategory).map(([category, categoryProviders]) => (
          <div key={category}>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {category}
            </h2>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {categoryProviders.map((provider) => (
                <Card
                  key={provider.key}
                  className={`transition-colors ${
                    provider.status === "disconnected"
                      ? "border-red-200 bg-red-50/20"
                      : provider.status === "degraded"
                      ? "border-orange-200 bg-orange-50/20"
                      : provider.status === "mock"
                      ? "border-amber-200 bg-amber-50/20"
                      : "border-emerald-200/50"
                  }`}
                >
                  <CardHeader className="pb-2 pt-4 px-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <StatusIcon status={provider.status} />
                        <CardTitle className="text-sm font-semibold truncate">
                          {provider.name}
                        </CardTitle>
                      </div>
                      <StatusBadge status={provider.status} />
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-4 space-y-3">
                    {/* Connection coverage */}
                    {provider.totalBrokerages > 0 && (
                      <div>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-muted-foreground">Tenant coverage</span>
                          <span className="font-medium">
                            {provider.liveCount}/{provider.totalBrokerages} brokerages
                          </span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              provider.status === "live"
                                ? "bg-emerald-500"
                                : provider.status === "mock"
                                ? "bg-amber-500"
                                : "bg-red-500"
                            }`}
                            style={{
                              width: `${provider.totalBrokerages > 0 ? (provider.liveCount / provider.totalBrokerages) * 100 : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Affected features */}
                    {(provider.status === "disconnected" || provider.status === "mock" || provider.status === "degraded") && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">
                          Affected features:
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {provider.affectedFeatures.map((feat) => (
                            <span
                              key={feat}
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground"
                            >
                              {feat}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Last error */}
                    {provider.lastError && (
                      <p className="text-[11px] text-red-600 bg-red-50 rounded p-1.5 line-clamp-2">
                        {provider.lastError}
                      </p>
                    )}

                    {/* Configure button */}
                    <Link href={provider.configPath}>
                      <Button
                        variant={provider.status !== "live" ? "default" : "outline"}
                        size="sm"
                        className="w-full mt-1"
                      >
                        <Settings className="h-3.5 w-3.5 mr-1.5" />
                        Configure
                        <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                      </Button>
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
