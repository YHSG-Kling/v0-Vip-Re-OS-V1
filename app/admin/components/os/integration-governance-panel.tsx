"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Link2, CheckCircle, XCircle, AlertTriangle, ExternalLink } from "lucide-react"

interface Integration {
  id: string
  providerType: string
  providerName: string
  status: "active" | "error" | "pending" | "disconnected"
  brokerageCount: number
  lastError: string | null
}

interface IntegrationGovernancePanelProps {
  integrations: Integration[]
  totalIntegrations: number
  activeCount: number
  errorCount: number
}

export function IntegrationGovernancePanel({
  integrations,
  totalIntegrations,
  activeCount,
  errorCount,
}: IntegrationGovernancePanelProps) {
  const getStatusIcon = (status: string) => {
    switch (status) {
      case "active":
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case "error":
        return <XCircle className="h-4 w-4 text-red-500" />
      case "pending":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />
      default:
        return <XCircle className="h-4 w-4 text-gray-400" />
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Integration Governance
          </CardTitle>
          <Link href="/admin/integrations">
            <Button variant="ghost" size="sm" className="gap-1">
              <ExternalLink className="h-3 w-3" />
              Manage
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-2">
          <div className="p-2 bg-muted/50 rounded-lg text-center">
            <p className="text-lg font-bold">{totalIntegrations}</p>
            <p className="text-xs text-muted-foreground">Total</p>
          </div>
          <div className="p-2 bg-green-500/10 rounded-lg text-center">
            <p className="text-lg font-bold text-green-600">{activeCount}</p>
            <p className="text-xs text-muted-foreground">Active</p>
          </div>
          <div className="p-2 bg-red-500/10 rounded-lg text-center">
            <p className="text-lg font-bold text-red-600">{errorCount}</p>
            <p className="text-xs text-muted-foreground">Errors</p>
          </div>
        </div>

        {/* Integration List */}
        <div className="space-y-2">
          {integrations.slice(0, 5).map((integration) => (
            <div
              key={integration.id}
              className={`flex items-center justify-between p-2 rounded-lg ${
                integration.status === "error" ? "bg-red-500/10 border border-red-500/20" : "bg-muted/50"
              }`}
            >
              <div className="flex items-center gap-2">
                {getStatusIcon(integration.status)}
                <div>
                  <p className="text-sm font-medium">{integration.providerName}</p>
                  <p className="text-xs text-muted-foreground">{integration.providerType}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  {integration.brokerageCount} brokerages
                </Badge>
                {integration.status === "error" && (
                  <Link href={`/admin/integrations/${integration.id}`}>
                    <Button variant="outline" size="sm" className="text-xs">
                      Review
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Error Alerts */}
        {errorCount > 0 && (
          <div className="p-2 bg-red-500/10 rounded-lg border border-red-500/20">
            <p className="text-sm font-medium text-red-600">
              {errorCount} integration{errorCount > 1 ? "s" : ""} require attention
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
