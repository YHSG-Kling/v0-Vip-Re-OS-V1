import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle2, Cloud, Gift, PlugZap, CircleDashed } from 'lucide-react'
import type {
  BrokerageProviderReadiness,
  BrokerageReadinessState,
} from '@/lib/platform/provider-posture'

interface ProviderReadinessPanelProps {
  readiness: BrokerageProviderReadiness
}

const STATE_META: Record<
  BrokerageReadinessState,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  live_connected: { label: 'Connected', className: 'text-green-600', Icon: CheckCircle2 },
  live_platform: { label: 'Included', className: 'text-blue-600', Icon: Cloud },
  keyless: { label: 'Included', className: 'text-emerald-600', Icon: Gift },
  needs_connection: { label: 'Connect', className: 'text-amber-600', Icon: PlugZap },
  platform_dark: { label: 'Pending', className: 'text-muted-foreground', Icon: CircleDashed },
}

export function ProviderReadinessPanel({ readiness }: ProviderReadinessPanelProps) {
  const { readinessPct, ready, total, needsConnection, platformDark, rows } = readiness

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider Readiness</CardTitle>
        <CardDescription>What your AI can use right now — platform-provided, free, and your own connections</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overall — count LIVE capabilities, not just tenant connections */}
        <div className="text-center p-4 bg-blue-50 rounded-lg">
          <p className="text-3xl font-bold text-blue-600">{readinessPct}%</p>
          <p className="text-sm text-muted-foreground">{ready} of {total} capabilities live</p>
          {(needsConnection > 0 || platformDark > 0) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {needsConnection > 0 && <span>{needsConnection} you can connect</span>}
              {needsConnection > 0 && platformDark > 0 && <span> · </span>}
              {platformDark > 0 && <span>{platformDark} platform-pending</span>}
            </p>
          )}
        </div>

        {/* Provider list — honest per-capability state */}
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {rows.map((r) => {
            const meta = STATE_META[r.state]
            const Icon = meta.Icon
            return (
              <div key={r.provider} className="flex items-center justify-between p-2 bg-gray-50 rounded" title={r.note}>
                <span className="text-sm font-medium">{r.label}</span>
                <div className="flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${meta.className}`} />
                  <span className={`text-xs ${meta.className}`}>{meta.label}</span>
                </div>
              </div>
            )
          })}
          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No providers registered.</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
