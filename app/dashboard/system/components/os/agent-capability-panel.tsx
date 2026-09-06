import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Bot, CheckCircle, PlugZap, MoonStar, Wrench, Clock, HelpCircle } from 'lucide-react'
import Link from 'next/link'
import {
  resolveAllAppCapabilities,
  blockExplanation,
  attentionExplanation,
  type AppCapabilityResolution,
} from '@/lib/agentic-os/resolve-app-capability'

/**
 * WHAT CAN MY AI TEAM ACTUALLY DO RIGHT NOW?
 *
 * Provider Health (beside this) answers "which providers are live". That is not the
 * question a broker asks before switching autonomy on — they ask what the agents can
 * DO, and a provider list does not translate: nobody knows that "SendGrid dark" means
 * the newsletter, the review request and the video-to-client all stop.
 *
 * The capability contract answers it directly, and until now it answered only to
 * machines: /api/agentic-os/actions and the MCP tools/list got `operable` and `dark`
 * with reasons, and no human surface showed it. So the same tenant could read
 * "7/7 providers" on screen while the MCP tool list was quietly withholding eight
 * capabilities. This panel closes that: one resolver, both audiences.
 *
 * Four states, ordered by whose move it is — which is the only distinction that
 * changes what a broker does next:
 *
 *   operable    it runs today
 *   expiring    it runs today, on a credential that lapses inside the week. This is
 *               the cheap window; the self-healer flags it, this surfaces it.
 *   healing     dark, and connector-healer already has an open repair. Nothing to do
 *               — and critically, NOT something to go re-connect by hand.
 *   connect     dark and the tenant can fix it
 *   platform    dark and only platform staff can fix it
 *   held        the dependency is real but is not a credential at all (a gifting
 *               vendor row; a handwritten note a human posts), so it is held rather
 *               than attempted. Honest, and deliberately visible.
 */

interface AgentCapabilityPanelProps {
  brokerageId: string
}

/** Human name from the capability key — the registry keys are machine-facing. */
function capabilityLabel(capability: string): string {
  return capability
    .split('_')
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

type Bucket = 'healing' | 'connect' | 'platform' | 'held'

function bucketOf(r: AppCapabilityResolution): Bucket {
  if (r.healingInFlight) return 'healing'
  if (r.reason === 'requirement_not_modelled') return 'held'
  if (r.reason === 'no_connection') return 'connect'
  return 'platform'
}

const BUCKET_META: Record<Bucket, { label: string; icon: typeof PlugZap; className: string }> = {
  healing:  { label: 'Repairing', icon: Wrench,     className: 'text-blue-500' },
  connect:  { label: 'Connect',   icon: PlugZap,    className: 'text-amber-500' },
  platform: { label: 'Not lit',   icon: MoonStar,   className: 'text-muted-foreground' },
  held:     { label: 'Held',      icon: HelpCircle, className: 'text-muted-foreground' },
}

export async function AgentCapabilityPanel({ brokerageId }: AgentCapabilityPanelProps) {
  const resolutions = await resolveAllAppCapabilities({ brokerageId })

  const operable = resolutions.filter((r) => r.operable)
  const expiring = operable.filter((r) => r.attention)
  const dark = resolutions.filter((r) => !r.operable)

  // Whose move it is, in the order a broker should read it.
  const ORDER: Bucket[] = ['healing', 'connect', 'platform', 'held']
  const grouped = ORDER.map((b) => ({ bucket: b, rows: dark.filter((r) => bucketOf(r) === b) }))
    .filter((g) => g.rows.length > 0)

  const yourMove = dark.filter((r) => bucketOf(r) === 'connect').length

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            What your AI team can do
          </CardTitle>
          <Link href="/settings/connections">
            <Badge variant="outline" className="cursor-pointer hover:bg-accent">
              <PlugZap className="h-3 w-3 mr-1" />
              Connect
            </Badge>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-muted/50 p-3 text-center">
            <p className="text-2xl font-bold text-foreground">
              {operable.length}/{resolutions.length}
            </p>
            <p className="text-xs text-muted-foreground">Runnable now</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-3 text-center">
            <p className={`text-2xl font-bold ${expiring.length > 0 ? 'text-amber-600' : 'text-foreground'}`}>
              {expiring.length}
            </p>
            <p className="text-xs text-muted-foreground">Expiring soon</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{dark.length}</p>
            <p className="text-xs text-muted-foreground">Held back</p>
          </div>
        </div>

        {/* The read. An agent that discovers its own limits by calling a tool and
            failing is the thing this replaces — so say plainly what is withheld. */}
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm space-y-1">
          <p className="font-medium">Your AI team&apos;s read</p>
          {dark.length === 0 ? (
            <p className="text-muted-foreground">
              Every capability the agents advertise can actually run — nothing is being
              withheld from the tool list.
            </p>
          ) : (
            <p className="text-muted-foreground">
              The agents will not attempt{' '}
              <span className="font-medium text-foreground">{dark.length}</span>{' '}
              {dark.length === 1 ? 'capability' : 'capabilities'} rather than fail at{' '}
              {dark.length === 1 ? 'it' : 'them'} in front of a client
              {yourMove > 0 ? (
                <>
                  {' '}— <span className="font-medium text-amber-600">{yourMove}</span> of those
                  {yourMove === 1 ? ' is' : ' are'} waiting on a connection you can make.
                </>
              ) : (
                '. None of it is waiting on you.'
              )}
            </p>
          )}
        </div>

        {/* Expiring: operable TODAY. Acting now is cheap; acting after the lapse is not. */}
        {expiring.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Working, but not for long
            </p>
            {expiring.map((r) => (
              <div
                key={r.capability}
                className="flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{capabilityLabel(r.capability)}</p>
                  <p className="text-xs text-muted-foreground">{attentionExplanation(r)}</p>
                </div>
                <Clock className="h-4 w-4 text-amber-500 shrink-0 ml-3" />
              </div>
            ))}
          </div>
        )}

        {/* Dark, grouped by whose job it is. */}
        {grouped.map((g) => {
          const meta = BUCKET_META[g.bucket]
          const Icon = meta.icon
          return (
            <div key={g.bucket} className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {meta.label}
              </p>
              {g.rows.map((r) => (
                <div
                  key={r.capability}
                  className="flex items-center justify-between rounded-lg border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{capabilityLabel(r.capability)}</p>
                    <p className="text-xs text-muted-foreground">{blockExplanation(r)}</p>
                  </div>
                  <Icon className={`h-4 w-4 shrink-0 ml-3 ${meta.className}`} />
                </div>
              ))}
            </div>
          )
        })}

        {operable.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Runnable now
            </p>
            <div className="flex flex-wrap gap-1.5">
              {operable
                .filter((r) => !r.attention)
                .map((r) => (
                  <Badge key={r.capability} variant="outline" className="text-xs font-normal">
                    <CheckCircle className="h-3 w-3 mr-1 text-emerald-500" />
                    {capabilityLabel(r.capability)}
                  </Badge>
                ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
