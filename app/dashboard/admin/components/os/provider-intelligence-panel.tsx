"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plug,
  Monitor,
  Wrench,
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface ProviderIntelligencePanelProps {
  brokerageId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stats?: any
}

interface ProviderStatus {
  provider_type: string
  provider_key: string
  enabled: boolean
}

export function ProviderIntelligencePanel({ brokerageId }: ProviderIntelligencePanelProps) {
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadProviders() {
      if (!brokerageId) {
        setLoading(false)
        return
      }

      const supabase = createClient()

      const { data } = await supabase
        .from("provider_overrides")
        .select("provider_type, provider_key, enabled")
        .eq("scope_type", "brokerage")
        .eq("scope_id", brokerageId)

      setProviders(data || [])
      setLoading(false)
    }

    loadProviders()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border">
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  const enabledCount = providers.filter((p) => p.enabled).length
  const disabledCount = providers.filter((p) => !p.enabled).length
  const hasIssues = disabledCount > 0

  // Define default providers to show status for
  const defaultProviders = [
    { type: "email", label: "Email", default: "sendgrid" },
    { type: "sms", label: "SMS", default: "twilio" },
    { type: "calendar", label: "Calendar", default: "google" },
    { type: "esign", label: "E-Sign", default: "dotloop" },
    { type: "ai", label: "AI", default: "anthropic" },
    { type: "social", label: "Social", default: "buffer" },
  ]

  const providerMap = new Map(providers.map((p) => [p.provider_type, p]))

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Plug className="h-4 w-4 text-purple-600" />
            Provider Intelligence
          </CardTitle>
          <Badge 
            variant={hasIssues ? "secondary" : "outline"}
            className="text-xs"
          >
            {enabledCount} Active
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {defaultProviders.map((dp) => {
            const provider = providerMap.get(dp.type)
            const isConfigured = !!provider
            const isEnabled = provider?.enabled ?? true // Default to enabled if not configured

            return (
              <div
                key={dp.type}
                className={`p-2 rounded-lg border flex items-center gap-2 ${
                  isEnabled 
                    ? "bg-emerald-50/50 border-emerald-200" 
                    : "bg-amber-50/50 border-amber-200"
                }`}
              >
                {isEnabled ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{dp.label}</p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {provider?.provider_key || dp.default}
                  </p>
                </div>
              </div>
            )
          })}
        </div>

        {disabledCount > 0 && (
          <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              <span className="text-xs text-amber-700">
                {disabledCount} provider{disabledCount > 1 ? "s" : ""} disabled
              </span>
            </div>
          </div>
        )}

        {/* System Health Quick Fixes */}
        <div className="border-t pt-3 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">System Health</p>
          <Link href="/dashboard/system">
            <Button variant="outline" size="sm" className="w-full justify-start">
              <Monitor className="h-4 w-4 mr-2" />
              View System Dashboard
              <ChevronRight className="h-4 w-4 ml-auto" />
            </Button>
          </Link>
          <Link href="/dashboard/settings/integrations">
            <Button
              variant={disabledCount > 0 ? "default" : "outline"}
              size="sm"
              className="w-full justify-start"
            >
              <Wrench className="h-4 w-4 mr-2" />
              Fix Provider Issues
              {disabledCount > 0 && (
                <span className="ml-auto text-xs bg-white/20 rounded px-1">{disabledCount}</span>
              )}
            </Button>
          </Link>
        </div>

        <Link href="/dashboard/admin/provider-intelligence">
          <Button variant="ghost" size="sm" className="w-full">
            Manage All Providers
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
