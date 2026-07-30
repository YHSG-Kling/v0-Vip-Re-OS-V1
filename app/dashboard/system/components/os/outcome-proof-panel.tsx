import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ShieldCheck, ShieldAlert, Clock, HelpCircle } from 'lucide-react'
import {
  summarizeReconciliations,
  TRUTH_SOURCES,
  type OutcomeChannel,
  type ReconciliationVerdict,
} from '@/lib/outcomes/reconciliation'
import { loadReconciliations } from '@/lib/outcomes/reconciliation-ledger'

/**
 * DID IT ACTUALLY LAND? — the proof board.
 *
 * Every other surface in this OS reports what the managers DID. This one reports
 * what the PROVIDERS confirmed, which is a different number, and the gap between
 * them is the only honest measure of whether autonomy can be trusted.
 *
 * The four verdicts are shown as four separate counts on purpose. Folding `pending`
 * into `confirmed` would reproduce the exact bug this closes — an SMS Twilio has
 * merely queued is not an SMS the client received, and the OS used to record both
 * as "sent". So the proven rate is computed over DECIDED outcomes only; pending is
 * shown beside it, never inside it.
 *
 * `unverifiable` is deliberately visible too. A lane with no provider truth source
 * cannot be proven, and a broker deserves to know which of their channels are
 * self-reported rather than discovering it during a listing presentation.
 */

interface OutcomeProofPanelProps {
  brokerageId: string
}

const VERDICT_META: Record<ReconciliationVerdict, {
  label: string; icon: typeof ShieldCheck; className: string; blurb: string
}> = {
  confirmed: {
    label: 'Proven', icon: ShieldCheck, className: 'text-emerald-500',
    blurb: 'the provider confirmed it landed',
  },
  contradicted: {
    label: 'Did not land', icon: ShieldAlert, className: 'text-red-600',
    blurb: 'we recorded it as done and the provider says otherwise',
  },
  pending: {
    label: 'Awaiting proof', icon: Clock, className: 'text-amber-500',
    blurb: 'handed to the provider, not yet confirmed — this is not success',
  },
  unverifiable: {
    label: 'No proof possible', icon: HelpCircle, className: 'text-muted-foreground',
    blurb: 'this lane has no provider signal that could confirm it',
  },
}

const CHANNEL_LABEL: Record<OutcomeChannel, string> = {
  email: 'Email', sms: 'Text', direct_mail: 'Direct mail', social: 'Social', video: 'Video',
}

export async function OutcomeProofPanel({ brokerageId }: OutcomeProofPanelProps) {
  const rows = await loadReconciliations(brokerageId, { limit: 200 })
  const summary = summarizeReconciliations(rows)
  const contradicted = rows.filter((r) => r.verdict === 'contradicted').slice(0, 6)

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          Did it actually land?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            No touches recorded yet. Once your AI team sends something, this board shows
            what the <span className="font-medium text-foreground">provider</span> confirmed —
            not what the OS recorded.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-2xl font-bold text-foreground">
                  {summary.provenRatePct === null ? '—' : `${summary.provenRatePct}%`}
                </p>
                <p className="text-xs text-muted-foreground">Proven, of what is decided</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className={`text-2xl font-bold ${summary.contradicted > 0 ? 'text-red-600' : 'text-foreground'}`}>
                  {summary.contradicted}
                </p>
                <p className="text-xs text-muted-foreground">Did not land</p>
              </div>
            </div>

            {/* The four verdicts, never folded together. */}
            <div className="space-y-1.5">
              {(['confirmed', 'contradicted', 'pending', 'unverifiable'] as ReconciliationVerdict[])
                .filter((v) => summary[v] > 0)
                .map((v) => {
                  const m = VERDICT_META[v]
                  const Icon = m.icon
                  return (
                    <div key={v} className="flex items-start justify-between gap-3 text-sm">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <Icon className={`h-4 w-4 shrink-0 ${m.className}`} />
                        <span className="font-medium">{m.label}</span>
                        <span className="text-xs text-muted-foreground truncate">— {m.blurb}</span>
                      </span>
                      <span className="font-semibold shrink-0">{summary[v]}</span>
                    </div>
                  )
                })}
            </div>

            {/* Why the proven rate excludes pending — stated, not assumed. */}
            {summary.pending > 0 && (
              <p className="text-xs text-muted-foreground">
                The proven rate counts only outcomes a provider has ruled on.{' '}
                {summary.pending} {summary.pending === 1 ? 'touch is' : 'touches are'} still
                awaiting confirmation and{' '}
                <span className="font-medium">are not counted as successes</span>.
              </p>
            )}

            {contradicted.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  These did not reach the client
                </p>
                {contradicted.map((r) => (
                  <div key={r.id} className="rounded-lg border border-red-500/40 bg-red-500/5 p-3">
                    <p className="text-sm font-medium">
                      {CHANNEL_LABEL[r.channel] ?? r.channel}
                      {r.providerStatus ? (
                        <span className="ml-1 font-normal text-muted-foreground">
                          — {r.providerStatus}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{r.explanation}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* WHERE the truth comes from, per lane. A broker should be able to see which
            of their channels can be proven at all. */}
        <div className="space-y-1.5 border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            How each lane is proven
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(TRUTH_SOURCES) as OutcomeChannel[]).map((ch) => (
              <Badge key={ch} variant="outline" className="text-xs font-normal">
                {CHANNEL_LABEL[ch]}:{' '}
                <span className="ml-1 text-muted-foreground">
                  {TRUTH_SOURCES[ch].source ?? 'no proof source'}
                </span>
              </Badge>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
