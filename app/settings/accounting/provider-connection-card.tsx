"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { disconnectProvider } from "@/app/actions/accounting-sync"
import { CheckCircle2, XCircle, Loader2, ExternalLink } from "lucide-react"
import { toast } from "sonner"

interface ProviderConnectionCardProps {
  provider: "quickbooks" | "xero"
  connected: boolean
  companyName: string | null
  lastSyncedAt: string | null
  brokerageId: string
}

export function ProviderConnectionCard({
  provider,
  connected,
  companyName,
  lastSyncedAt,
  brokerageId,
}: ProviderConnectionCardProps) {
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)

  const providerName = provider === "quickbooks" ? "QuickBooks" : "Xero"
  const providerColor = provider === "quickbooks" ? "text-green-600" : "text-blue-600"
  const providerBgColor = provider === "quickbooks" ? "bg-green-50" : "bg-blue-50"

  const handleConnect = async () => {
    setIsConnecting(true)
    // In production, this would redirect to OAuth flow
    // For now, show a message about env vars needed
    const oauthUrl = provider === "quickbooks"
      ? `/api/auth/quickbooks/connect?brokerage_id=${brokerageId}`
      : `/api/auth/xero/connect?brokerage_id=${brokerageId}`

    // Redirect to OAuth (placeholder - requires QUICKBOOKS_CLIENT_ID etc.)
    window.location.href = oauthUrl
  }

  const handleDisconnect = async () => {
    if (!confirm(`Are you sure you want to disconnect ${providerName}?`)) return

    setIsDisconnecting(true)
    try {
      await disconnectProvider({ provider, brokerageId })
    } catch (error) {
      console.error("Failed to disconnect:", error)
      toast.error("Failed to disconnect provider")
    } finally {
      setIsDisconnecting(false)
    }
  }

  return (
    <Card className={connected ? providerBgColor : ""}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className={`text-lg ${providerColor}`}>
            {providerName}
          </CardTitle>
          <Badge variant={connected ? "default" : "secondary"}>
            {connected ? (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Connected
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                Not Connected
              </span>
            )}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {connected ? (
          <>
            {companyName && (
              <div className="text-sm">
                <span className="text-muted-foreground">Company: </span>
                <span className="font-medium">{companyName}</span>
              </div>
            )}
            {lastSyncedAt && (
              <div className="text-sm">
                <span className="text-muted-foreground">Last synced: </span>
                <span className="font-medium">
                  {new Date(lastSyncedAt).toLocaleString()}
                </span>
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              className="w-full"
            >
              {isDisconnecting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
              )}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Connect your {providerName} account to automatically sync commissions and expenses.
            </p>
            <Button
              onClick={handleConnect}
              disabled={isConnecting}
              className="w-full"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Connect {providerName}
                </>
              )}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
