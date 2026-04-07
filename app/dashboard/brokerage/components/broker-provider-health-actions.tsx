"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ActionConfirmSheet } from "@/app/components/action-framework/action-confirm-sheet"
import { saveProviderOverride } from "@/app/actions/settings/provider-settings-actions"
import { CheckCircle2, AlertTriangle, XCircle, Settings, ExternalLink } from "lucide-react"
import Link from "next/link"

type ProviderHealthStatus = "healthy" | "degraded" | "failing"

interface ProviderRow {
  name: string
  status: ProviderHealthStatus
}

interface Props {
  providerStatus: ProviderRow[]
  brokerageId: string
}

const STATUS_ICON: Record<ProviderHealthStatus, React.ReactNode> = {
  healthy: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
  degraded: <AlertTriangle className="h-4 w-4 text-amber-600" />,
  failing: <XCircle className="h-4 w-4 text-red-600" />,
}

const STATUS_BADGE: Record<ProviderHealthStatus, "outline" | "secondary" | "destructive"> = {
  healthy: "outline",
  degraded: "secondary",
  failing: "destructive",
}

export function BrokerProviderHealthActions({ providerStatus, brokerageId }: Props) {
  const [overrideTarget, setOverrideTarget] = useState<ProviderRow | null>(null)
  const [isPending, startTransition] = useTransition()

  const degraded = providerStatus.filter((p) => p.status !== "healthy")
  const allHealthy = degraded.length === 0

  async function handleOverride(provider: ProviderRow) {
    startTransition(async () => {
      await saveProviderOverride({
        provider_type: provider.name.toLowerCase().replace(/\s/g, "_"),
        provider_key: "default",
        enabled: true,
      }).catch(() => {})
      setOverrideTarget(null)
    })
  }

  return (
    <>
      <Card className="border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <Settings className="h-4 w-4 text-purple-600" />
              Provider Health Actions
            </CardTitle>
            {allHealthy ? (
              <Badge variant="outline" className="text-xs text-emerald-700 border-emerald-300">
                All Healthy
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-xs">
                {degraded.length} Issue{degraded.length !== 1 ? "s" : ""}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {providerStatus.map((provider) => (
            <div
              key={provider.name}
              className={`flex items-center justify-between p-2 rounded-lg border ${
                provider.status === "healthy"
                  ? "bg-muted/30 border-border"
                  : provider.status === "degraded"
                  ? "bg-amber-50 border-amber-200"
                  : "bg-red-50 border-red-200"
              }`}
            >
              <div className="flex items-center gap-2">
                {STATUS_ICON[provider.status]}
                <span className="text-sm font-medium">{provider.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={STATUS_BADGE[provider.status]} className="text-xs capitalize">
                  {provider.status}
                </Badge>
                {provider.status !== "healthy" && (
                  <>
                    <Link href="/dashboard/settings/integrations">
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                        Fix
                        <ExternalLink className="h-3 w-3 ml-1" />
                      </Button>
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setOverrideTarget(provider)}
                    >
                      Override
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}

          <Link href="/dashboard/settings/integrations">
            <Button variant="outline" size="sm" className="w-full mt-1">
              <Settings className="h-4 w-4 mr-2" />
              All Integrations
              <ExternalLink className="h-3 w-3 ml-2" />
            </Button>
          </Link>
        </CardContent>
      </Card>

      {overrideTarget && (
        <ActionConfirmSheet
          open={!!overrideTarget}
          onOpenChange={(open) => !open && setOverrideTarget(null)}
          title={`Override "${overrideTarget.name}" provider?`}
          description={`This will enable a default override for the ${overrideTarget.name} provider, bypassing the current ${overrideTarget.status} status. The override can be removed from Integrations settings.`}
          actionLabel="Apply Override"
          confirmingLabel="Applying..."
          onConfirm={() => handleOverride(overrideTarget)}
        />
      )}
    </>
  )
}
