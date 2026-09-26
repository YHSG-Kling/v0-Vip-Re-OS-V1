import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plug, CheckCircle, AlertCircle, Settings, Gift, PlugZap, MoonStar } from 'lucide-react'
import { createServiceClient } from '@/lib/supabase/service'
import { getBrokerageProviderReadiness, type BrokerageReadinessState } from '@/lib/platform/provider-posture'
import Link from 'next/link'

/**
 * Provider Health — owned by platform_sentinel.
 *
 * This panel used to invent its own status: with no tenant override row on file it
 * defaulted every provider to `enabled ?? true` and painted a green check, so a
 * brokerage that had configured NOTHING still read "7/7 Providers Active". That is the
 * live-walkthrough finding "says all providers are up but we do not have any configured
 * yet" — the surface was reporting an assumption as a fact.
 *
 * There is already ONE credential-backed source of truth for this question:
 * getBrokerageProviderReadiness, which reads the three credential stores plus
 * brokerage_integrations and folds in platform env presence. This panel now reads it
 * instead of guessing, which also removes the second, weaker notion of provider status
 * from the OS. Five honest states replace the binary on/off:
 *
 *   live_connected  — the brokerage's own credentials are active
 *   live_platform   — provided by the platform, no tenant setup needed
 *   keyless         — free lane, always on
 *   needs_connection— a BYO lane the brokerage can switch on themselves (their job)
 *   platform_dark   — platform-scoped rail not lit at the platform level (staff's job)
 *
 * The distinction that matters to a broker is the last two: one is work they can do,
 * the other is work only platform staff can do. A green check told them neither.
 */

interface ProviderHealthPanelProps {
  brokerageId: string
}

const STATE_META: Record<BrokerageReadinessState, {
  label: string
  icon: typeof CheckCircle
  className: string
}> = {
  live_connected:   { label: 'Connected', icon: CheckCircle, className: 'text-emerald-500' },
  live_platform:    { label: 'Included',  icon: CheckCircle, className: 'text-blue-500' },
  keyless:          { label: 'Included',  icon: Gift,        className: 'text-blue-500' },
  needs_connection: { label: 'Connect',   icon: PlugZap,     className: 'text-amber-500' },
  platform_dark:    { label: 'Not lit',   icon: MoonStar,    className: 'text-muted-foreground' },
}

export async function ProviderHealthPanel({ brokerageId }: ProviderHealthPanelProps) {
  const svc = createServiceClient()
  const readiness = await getBrokerageProviderReadiness(svc, brokerageId)

  // The read: what a broker should actually do about this, ranked by whose job it is.
  const yourMove = readiness.needsConnection
  const staffsMove = readiness.platformDark

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <Plug className="h-5 w-5 text-primary" />
            Provider Health
          </CardTitle>
          <Link href="/settings/connections">
            <Badge variant="outline" className="cursor-pointer hover:bg-accent">
              <Settings className="h-3 w-3 mr-1" />
              Connect
            </Badge>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary — counted from real credentials, never assumed */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-muted/50 p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{readiness.ready}/{readiness.total}</p>
            <p className="text-xs text-muted-foreground">Usable right now</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{readiness.readinessPct}%</p>
            <p className="text-xs text-muted-foreground">Capability readiness</p>
          </div>
        </div>

        {/* The read — separates your work from platform staff's work */}
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm space-y-1">
          <p className="font-medium flex items-center gap-1.5">
            <AlertCircle className="h-4 w-4 text-primary" />
            Your AI team&apos;s read
          </p>
          {yourMove === 0 && staffsMove === 0 ? (
            <p className="text-muted-foreground">
              Every capability in the registry is usable — nothing is waiting on a connection.
            </p>
          ) : (
            <>
              {yourMove > 0 && (
                <p className="text-muted-foreground">
                  <span className="font-medium text-amber-600">{yourMove}</span>{' '}
                  {yourMove === 1 ? 'lane is' : 'lanes are'} waiting on you — connect the account in
                  Settings and {yourMove === 1 ? 'it' : 'they'} switch on.
                </p>
              )}
              {staffsMove > 0 && (
                <p className="text-muted-foreground">
                  <span className="font-medium">{staffsMove}</span>{' '}
                  {staffsMove === 1 ? 'rail is' : 'rails are'} not lit at the platform level — that is
                  platform staff&apos;s to enable, not yours.
                </p>
              )}
            </>
          )}
        </div>

        {/* Provider list — sorted by the evaluator so what needs attention leads */}
        <div className="space-y-2">
          {readiness.rows.map(row => {
            const meta = STATE_META[row.state]
            const Icon = meta.icon
            return (
              <div
                key={row.provider}
                className="flex items-center justify-between rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{row.label}</p>
                  <p className="text-xs text-muted-foreground">{row.note}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <span className={`text-xs ${meta.className}`}>{meta.label}</span>
                  <Icon className={`h-4 w-4 ${meta.className}`} />
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
