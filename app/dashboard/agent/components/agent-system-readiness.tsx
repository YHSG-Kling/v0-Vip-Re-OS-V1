"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Plug } from "lucide-react"

interface IntegrationStatus {
  label: string
  href: string
  status: 'connected' | 'pending' | 'not_confirmed'
}

export function AgentSystemReadiness() {
  // Conservative defaults - show gray "Not confirmed" unless parent passes live status
  const integrations: IntegrationStatus[] = [
    { label: 'Calendar Sync', href: '/dashboard/settings/calendar', status: 'not_confirmed' },
    { label: 'MLS / IDX', href: '/dashboard/settings/integrations/idx-broker', status: 'not_confirmed' },
    { label: 'Communications', href: '/dashboard/settings/integrations', status: 'not_confirmed' },
    { label: 'Video Profile', href: '/dashboard/videos/create', status: 'not_confirmed' },
    { label: 'Portal Access', href: '/portal', status: 'not_confirmed' },
  ]

  const getStatusColor = (status: IntegrationStatus['status']) => {
    switch (status) {
      case 'connected': return 'bg-green-500'
      case 'pending': return 'bg-amber-500'
      case 'not_confirmed': return 'bg-gray-400'
      default: return 'bg-gray-400'
    }
  }

  const getStatusText = (status: IntegrationStatus['status']) => {
    switch (status) {
      case 'connected': return 'Connected'
      case 'pending': return 'Pending'
      case 'not_confirmed': return 'Not confirmed'
      default: return 'Not confirmed'
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Plug className="h-5 w-5" />
          System Readiness
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {integrations.map((integration, idx) => (
          <div key={idx} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${getStatusColor(integration.status)}`} />
              <span className="text-sm">{integration.label}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{getStatusText(integration.status)}</span>
              <Link href={integration.href} className="text-xs text-primary hover:underline">
                Set up →
              </Link>
            </div>
          </div>
        ))}

        <div className="pt-2 border-t">
          <Link href="/dashboard/settings/integrations" className="text-sm text-primary hover:underline">
            Manage All Integrations →
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
