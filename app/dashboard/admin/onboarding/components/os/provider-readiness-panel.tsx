import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle2, Clock } from 'lucide-react'

interface Provider {
  integration_type: string
  is_configured: boolean
  configured_at?: string
}

interface ProviderReadinessPanelProps {
  providers: Provider[]
  brokerageId: string
}

export function ProviderReadinessPanel({ providers, brokerageId }: ProviderReadinessPanelProps) {
  const configured = providers.filter(p => p.is_configured).length
  const total = providers.length
  const readiness = total > 0 ? Math.round((configured / total) * 100) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider Readiness</CardTitle>
        <CardDescription>Integration setup status</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overall Status */}
        <div className="text-center p-4 bg-blue-50 rounded-lg">
          <p className="text-3xl font-bold text-blue-600">{readiness}%</p>
          <p className="text-sm text-muted-foreground">Configured ({configured}/{total})</p>
        </div>

        {/* Provider List */}
        <div className="space-y-2">
          {providers.map(provider => (
            <div key={provider.integration_type} className="flex items-center justify-between p-2 bg-gray-50 rounded">
              <span className="text-sm font-medium">{provider.integration_type}</span>
              <div className="flex items-center gap-2">
                {provider.is_configured ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-xs text-green-600">Ready</span>
                  </>
                ) : (
                  <>
                    <Clock className="h-4 w-4 text-yellow-600" />
                    <span className="text-xs text-yellow-600">Pending</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
