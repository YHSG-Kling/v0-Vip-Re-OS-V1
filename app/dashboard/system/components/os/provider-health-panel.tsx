'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plug, CheckCircle, XCircle, AlertCircle, Settings } from 'lucide-react'
import { getSystemProviderStatus, getProviderSettings, type ProviderOverrideRow } from '@/app/actions/settings/provider-settings-actions'
import Link from 'next/link'

interface ProviderHealthPanelProps {
  brokerageId: string
}

export function ProviderHealthPanel({ brokerageId }: ProviderHealthPanelProps) {
  const [loading, setLoading] = useState(true)
  const [systemStatus, setSystemStatus] = useState<{
    directMailEnabled: boolean
    videoEnabled: boolean
  } | null>(null)
  const [overrides, setOverrides] = useState<ProviderOverrideRow[]>([])

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const [status, settings] = await Promise.all([
          getSystemProviderStatus(),
          getProviderSettings()
        ])
        setSystemStatus(status)
        setOverrides(settings.overrides)
      } catch (error) {
        console.error('Error loading provider health:', error)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="flex items-center justify-center py-8">
          <Plug className="h-6 w-6 animate-pulse text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  // Standard provider types that brokerages can configure
  const providerTypes = [
    { key: 'email', label: 'Email', icon: '📧', default: 'sendgrid' },
    { key: 'sms', label: 'SMS', icon: '💬', default: 'twilio' },
    { key: 'phone', label: 'Phone/Voice', icon: '📞', default: 'twilio' },
    { key: 'calendar', label: 'Calendar', icon: '📅', default: 'google' },
    { key: 'esign', label: 'E-Sign', icon: '✍️', default: 'dotloop' },
    { key: 'payment', label: 'Payments', icon: '💳', default: 'stripe' },
    { key: 'ai', label: 'AI', icon: '🤖', default: 'anthropic' },
  ]

  const getProviderStatus = (providerType: string) => {
    const override = overrides.find(o => o.provider_type === providerType)
    return {
      configured: !!override,
      enabled: override?.enabled ?? true,
      providerKey: override?.provider_key || providerTypes.find(p => p.key === providerType)?.default || 'default'
    }
  }

  const enabledCount = providerTypes.filter(p => getProviderStatus(p.key).enabled).length
  const configuredCount = overrides.length

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <Plug className="h-5 w-5 text-primary" />
            Provider Health
          </CardTitle>
          <Link href="/settings/providers">
            <Badge variant="outline" className="cursor-pointer hover:bg-accent">
              <Settings className="h-3 w-3 mr-1" />
              Configure
            </Badge>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-muted/50 p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{enabledCount}/{providerTypes.length}</p>
            <p className="text-xs text-muted-foreground">Providers Active</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{configuredCount}</p>
            <p className="text-xs text-muted-foreground">Custom Overrides</p>
          </div>
        </div>

        {/* Provider List */}
        <div className="space-y-2">
          {providerTypes.map(provider => {
            const status = getProviderStatus(provider.key)
            return (
              <div 
                key={provider.key}
                className="flex items-center justify-between rounded-lg border border-border p-3"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{provider.icon}</span>
                  <div>
                    <p className="font-medium text-sm">{provider.label}</p>
                    <p className="text-xs text-muted-foreground capitalize">{status.providerKey}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {status.configured && (
                    <Badge variant="outline" className="text-xs">Custom</Badge>
                  )}
                  {status.enabled ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* System-Controlled Providers */}
        <div className="border-t border-border pt-4">
          <p className="text-xs text-muted-foreground mb-2">System-Controlled (Admin Only)</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-border p-2">
              <span>📬</span>
              <span className="text-sm">Direct Mail</span>
              {systemStatus?.directMailEnabled ? (
                <CheckCircle className="h-3 w-3 text-green-500 ml-auto" />
              ) : (
                <AlertCircle className="h-3 w-3 text-yellow-500 ml-auto" />
              )}
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border p-2">
              <span>🎬</span>
              <span className="text-sm">Video</span>
              {systemStatus?.videoEnabled ? (
                <CheckCircle className="h-3 w-3 text-green-500 ml-auto" />
              ) : (
                <AlertCircle className="h-3 w-3 text-yellow-500 ml-auto" />
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
