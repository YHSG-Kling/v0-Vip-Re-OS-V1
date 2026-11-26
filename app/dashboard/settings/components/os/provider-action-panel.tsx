"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { 
  Zap,
  RefreshCw,
  AlertTriangle,
  Play 
} from "lucide-react"

interface ProviderAction {
  id: string
  providerName: string
  providerType: string
  status: "active" | "error" | "inactive"
  lastError?: string | null
}

interface ProviderActionPanelProps {
  providers: ProviderAction[]
  onTestProvider?: (providerId: string) => Promise<{ success: boolean; error?: string }>
  onReconnectProvider?: (providerId: string) => Promise<{ success: boolean; error?: string }>
}

export function ProviderActionPanel({ 
  providers,
  onTestProvider,
  onReconnectProvider,
}: ProviderActionPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [testingId, setTestingId] = useState<string | null>(null)
  
  const errorProviders = providers.filter((p) => p.status === "error")
  
  const handleTest = async (provider: ProviderAction) => {
    if (!onTestProvider) return
    setTestingId(provider.id)
    startTransition(async () => {
      const result = await onTestProvider(provider.id)
      if (result.success) {
        toast.success(`${provider.providerName} connection verified`)
      } else {
        toast.error(result.error || "Connection test failed")
      }
      setTestingId(null)
    })
  }
  
  const handleReconnect = async (provider: ProviderAction) => {
    if (!onReconnectProvider) return
    startTransition(async () => {
      const result = await onReconnectProvider(provider.id)
      if (result.success) {
        toast.success(`${provider.providerName} reconnected`)
      } else {
        toast.error(result.error || "Reconnection failed")
      }
    })
  }
  
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Provider Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Error Providers */}
        {errorProviders.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-red-600 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              Needs Attention ({errorProviders.length})
            </p>
            {errorProviders.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between py-2 px-3 bg-red-50 dark:bg-red-950/20 rounded-md"
              >
                <div>
                  <p className="text-sm font-medium">{provider.providerName}</p>
                  {provider.lastError && (
                    <p className="text-xs text-red-600 truncate max-w-[150px]">
                      {provider.lastError}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={isPending}
                  onClick={() => handleReconnect(provider)}
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Fix
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Quick Actions */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Quick Actions</p>
          <div className="grid grid-cols-2 gap-2">
            {providers.filter((p) => p.status === "active").slice(0, 4).map((provider) => (
              <Button
                key={provider.id}
                variant="outline"
                size="sm"
                className="text-xs justify-start"
                disabled={isPending || testingId === provider.id}
                onClick={() => handleTest(provider)}
              >
                {testingId === provider.id ? (
                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3 w-3 mr-1" />
                )}
                Test {provider.providerName}
              </Button>
            ))}
          </div>
        </div>

        {/* No Providers */}
        {providers.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No providers configured yet
          </p>
        )}
      </CardContent>
    </Card>
  )
}
