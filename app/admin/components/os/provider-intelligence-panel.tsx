"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Plug,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronRight,
  AlertCircle,
  Loader2,
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface ProviderStat {
  key: string
  name: string
  status: "live" | "mock" | "disconnected" | "degraded"
}

function StatusDot({ status }: { status: ProviderStat["status"] }) {
  switch (status) {
    case "live":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
    case "mock":
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
    case "degraded":
      return <AlertCircle className="h-3.5 w-3.5 text-orange-500" />
    case "disconnected":
      return <XCircle className="h-3.5 w-3.5 text-red-500" />
  }
}

export function ProviderIntelligencePanel() {
  const [providers, setProviders] = useState<ProviderStat[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from("brokerage_integrations")
      .select("id, provider_type, provider_name, status")
      .order("provider_type")
      .limit(12)
      .then(({ data }) => {
        if (!data) {
          setProviders([])
          setLoading(false)
          return
        }
        // Aggregate by provider_type — if any instance is error → degraded, none connected → disconnected
        const byType = new Map<string, { name: string; statuses: string[] }>()
        for (const row of data) {
          const key = row.provider_type ?? "unknown"
          const name = row.provider_name ?? row.provider_type ?? "Unknown"
          if (!byType.has(key)) byType.set(key, { name, statuses: [] })
          byType.get(key)!.statuses.push(row.status ?? "disconnected")
        }

        const resolved: ProviderStat[] = Array.from(byType.entries()).map(([key, { name, statuses }]) => {
          let status: ProviderStat["status"] = "disconnected"
          if (statuses.some((s) => s === "error")) status = "degraded"
          else if (statuses.every((s) => s === "active")) status = "live"
          else if (statuses.some((s) => s === "active")) status = "mock"
          return { key, name, status }
        })

        setProviders(resolved)
        setLoading(false)
      })
  }, [])

  const liveCount = providers.filter((p) => p.status === "live").length
  const issueCount = providers.filter((p) => p.status !== "live").length
  const hasIssues = issueCount > 0

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Plug className="h-4 w-4 text-primary" />
            Provider Intelligence
          </CardTitle>
          {!loading && (
            <Badge
              variant="outline"
              className={`text-xs ${hasIssues ? "border-amber-300 text-amber-700 bg-amber-50" : "border-emerald-300 text-emerald-700 bg-emerald-50"}`}
            >
              {liveCount}/{providers.length} Live
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : providers.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No integrations configured yet
          </p>
        ) : (
          <>
            {/* Provider grid */}
            <div className="grid grid-cols-2 gap-2">
              {providers.map((p) => (
                <div
                  key={p.key}
                  className={`p-2 rounded-lg border flex items-center gap-2 ${
                    p.status === "live"
                      ? "bg-emerald-50/50 border-emerald-200"
                      : p.status === "mock"
                      ? "bg-amber-50/50 border-amber-200"
                      : p.status === "degraded"
                      ? "bg-orange-50/50 border-orange-200"
                      : "bg-red-50/50 border-red-200"
                  }`}
                >
                  <StatusDot status={p.status} />
                  <p className="text-xs font-medium truncate">{p.name}</p>
                </div>
              ))}
            </div>

            {/* Issue alert */}
            {hasIssues && (
              <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                <span className="text-xs text-amber-700">
                  {issueCount} provider{issueCount > 1 ? "s" : ""} need attention
                </span>
              </div>
            )}
          </>
        )}

        {/* CTA */}
        <div className="pt-1">
          <Link href="/admin/providers">
            <Button
              variant={hasIssues ? "default" : "outline"}
              size="sm"
              className="w-full justify-between"
            >
              <span>View Provider Health</span>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
