"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { 
  Settings, 
  CheckCircle2,
  XCircle,
  AlertCircle,
  ExternalLink,
  RefreshCw
} from "lucide-react"

interface ProviderStatus {
  id: string
  providerName: string
  providerType: string
  status: 'connected' | 'pending' | 'error' | 'not_configured'
  lastHealthCheck: string | null
  lastError: string | null
}

interface ProviderReadinessPanelProps {
  providers: ProviderStatus[]
  onRefresh?: (providerId: string) => void
}

const statusConfig = {
  connected: {
    icon: CheckCircle2,
    color: "text-green-500",
    badge: "bg-green-100 text-green-700",
    label: "Connected",
  },
  pending: {
    icon: AlertCircle,
    color: "text-yellow-500",
    badge: "bg-yellow-100 text-yellow-700",
    label: "Pending",
  },
  error: {
    icon: XCircle,
    color: "text-red-500",
    badge: "bg-red-100 text-red-700",
    label: "Error",
  },
  not_configured: {
    icon: Settings,
    color: "text-gray-400",
    badge: "bg-gray-100 text-gray-700",
    label: "Not Set Up",
  },
}

const providerTypeLabels: Record<string, string> = {
  mls: "MLS",
  crm: "CRM",
  email: "Email",
  calendar: "Calendar",
  accounting: "Accounting",
  esign: "E-Sign",
  transaction_mgmt: "Transaction Mgmt",
  marketing: "Marketing",
}

export function ProviderReadinessPanel({ providers, onRefresh }: ProviderReadinessPanelProps) {
  const connectedCount = providers.filter(p => p.status === 'connected').length
  const totalCount = providers.length

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Settings className="h-4 w-4" />
          Provider Readiness
          <Badge variant="outline" className="ml-auto">
            {connectedCount}/{totalCount} Ready
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {providers.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground">
            <p className="text-sm">No providers configured yet</p>
            <Link href="/dashboard/onboarding/tech-stack">
              <Button size="sm" className="mt-2">Set Up Tech Stack</Button>
            </Link>
          </div>
        ) : (
          <>
            {providers.map((provider) => {
              const config = statusConfig[provider.status]
              const Icon = config.icon
              
              return (
                <div 
                  key={provider.id}
                  className="flex items-center gap-3 p-2 rounded-lg border bg-card"
                >
                  <Icon className={`h-4 w-4 ${config.color} shrink-0`} />
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{provider.providerName}</span>
                      <Badge variant="outline" className="text-xs">
                        {providerTypeLabels[provider.providerType] || provider.providerType}
                      </Badge>
                    </div>
                    {provider.lastError && provider.status === 'error' && (
                      <p className="text-xs text-red-500 truncate">{provider.lastError}</p>
                    )}
                  </div>
                  
                  <div className="flex items-center gap-1">
                    <Badge className={`text-xs ${config.badge}`}>
                      {config.label}
                    </Badge>
                    {provider.status === 'error' && onRefresh && (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-6 w-6 p-0"
                        onClick={() => onRefresh(provider.id)}
                      >
                        <RefreshCw className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
            
            <Link href="/dashboard/onboarding/tech-stack">
              <Button variant="outline" size="sm" className="w-full mt-2">
                Manage Integrations
              </Button>
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  )
}
