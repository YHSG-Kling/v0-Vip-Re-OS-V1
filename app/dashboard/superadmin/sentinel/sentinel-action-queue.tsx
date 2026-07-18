'use client'

// Sentinel — today's proposed actions. The staff approval queue the Platform
// Sentinel Manager cron fills daily (engagement risk, connection expiry,
// dunning, support SLA, expiring trials), each with drafted outreach composed
// from real facts. Staff approve (optionally sending email drafts through the
// platform's real send rail), or dismiss — every decision is audited.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ClipboardList, Loader2, Check, Send, X, Copy, Brain } from 'lucide-react'
import {
  listSentinelActionsAction,
  approveSentinelActionAction,
  dismissSentinelActionAction,
  type SentinelActionRow,
  type SentinelQueue,
  type SentinelLearningView,
} from '@/app/actions/superadmin/platform-sentinel'

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  warn: 'bg-amber-100 text-amber-800',
  info: 'bg-slate-100 text-slate-700',
}

const KIND_LABEL: Record<string, string> = {
  engagement_risk: 'Engagement risk',
  connection_expiry: 'Connection expiry',
  dunning_risk: 'Dunning',
  support_sla: 'Support SLA',
  growth_opportunity: 'Growth',
  demo_followup: 'Demo follow-up',
}

const STATUS_BADGE: Record<string, string> = {
  approved: 'bg-blue-100 text-blue-800',
  sent: 'bg-emerald-100 text-emerald-800',
  dismissed: 'bg-slate-100 text-slate-600',
}

const CHANNEL_LABEL: Record<string, string> = {
  email: 'email draft',
  sms: 'SMS draft',
  call: 'call script',
  none: 'internal action',
}

/** THE SENTINEL FLYWHEEL readout — what staff verdicts have taught the
 *  sentinel: per-kind approve/dismiss stats (with any active kind-level
 *  severity downgrades) and the tenant-level suppressions in force. No
 *  "unsuppress" button on purpose: a suppression is just a run of most-recent
 *  dismissals, so the honest control is stated, not faked. */
function LearningStrip({ learning }: { learning: SentinelLearningView }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
      <h3 className="text-xs font-semibold flex items-center gap-1.5">
        <Brain className="h-3.5 w-3.5 text-primary" />What the sentinel has learned
        {learning.decisions > 0 && (
          <span className="font-normal text-muted-foreground">
            — from {learning.decisions} decision{learning.decisions === 1 ? '' : 's'} in the last {learning.windowDays} days
          </span>
        )}
      </h3>

      {learning.decisions === 0 ? (
        <p className="text-xs text-muted-foreground">
          No decisions yet — the sentinel learns from your first approvals and dismissals. Kinds you
          approve keep their urgency; kinds you consistently dismiss get quieter on their own.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {learning.kinds.map((k) => (
              <div key={k.kind} className="rounded border bg-background px-2 py-1 text-[11px] leading-4">
                <span className="font-medium">{KIND_LABEL[k.kind] ?? k.kind}</span>{' '}
                <span className="text-muted-foreground tabular-nums">
                  {k.approved + k.sent} approved · {k.dismissed} dismissed ({k.dismissalRate}%)
                </span>
                {k.downgraded && (
                  <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800">
                    severity lowered
                  </span>
                )}
              </div>
            ))}
          </div>

          {learning.suppressions.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium">Suppressed for specific tenants:</p>
              <ul className="space-y-0.5">
                {learning.suppressions.map((s) => (
                  <li key={`${s.kind}:${s.brokerageId}`} className="text-[11px] text-muted-foreground">
                    <span className="text-foreground">{KIND_LABEL[s.kind] ?? s.kind}</span> for{' '}
                    <Link href={`/dashboard/superadmin/brokerages/${s.brokerageId}`} className="text-indigo-600 font-medium">
                      {s.brokerageName ?? 'this tenant'}
                    </Link>{' '}
                    — you dismissed the last {s.streak} in a row, so the sentinel stopped proposing it there.
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                There is no unsuppress switch because none is needed: the suppression is just your run of
                most-recent dismissals. Approving any still-open proposal of that kind for that tenant clears
                it immediately, and old dismissals age out of the {learning.windowDays}-day learning window on
                their own.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ActionCard({
  a, emailRailReady, busy, note,
  onApprove, onApproveSend, onDismiss,
}: {
  a: SentinelActionRow
  emailRailReady: boolean
  busy: string | null
  note: string | null
  onApprove: () => void
  onApproveSend: () => void
  onDismiss: () => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const isBusy = busy !== null
  const canSend = a.draftChannel === 'email' && emailRailReady

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${SEVERITY_BADGE[a.severity] ?? SEVERITY_BADGE.info}`}>{a.severity}</span>
            <Badge variant="outline" className="text-[10px]">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
            <span className="text-sm font-medium">{a.title}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{a.detail}</p>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
            {a.brokerageId && (
              <Link href={`/dashboard/superadmin/brokerages/${a.brokerageId}`} className="text-indigo-600 font-medium">
                {a.brokerageName ?? 'Tenant'} →
              </Link>
            )}
            <span>{new Date(a.createdAt).toLocaleDateString()}</span>
            <span>· {CHANNEL_LABEL[a.draftChannel] ?? a.draftChannel}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={isBusy} onClick={onApprove}>
            {busy === 'approve' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}Approve
          </Button>
          {a.draftChannel === 'email' && (
            <Button
              size="sm" className="h-7 px-2 text-xs" disabled={isBusy || !canSend} onClick={onApproveSend}
              title={canSend ? 'Approve and send the email draft now' : 'Email sending is not configured (SendGrid) — approve and copy the draft instead'}
            >
              {busy === 'send' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}Approve &amp; send
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" disabled={isBusy} onClick={onDismiss}>
            {busy === 'dismiss' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3 mr-1" />}Dismiss
          </Button>
        </div>
      </div>

      {a.draftText && (
        <div>
          <button onClick={() => setOpen((v) => !v)} className="text-xs text-muted-foreground underline">
            {open ? 'Hide draft' : `Show ${CHANNEL_LABEL[a.draftChannel] ?? 'draft'}`}
          </button>
          {open && (
            <div className="mt-2 rounded-md bg-muted/40 p-3">
              <pre className="text-xs whitespace-pre-wrap font-sans">{a.draftText}</pre>
              <button
                className="mt-2 text-xs text-indigo-600 flex items-center gap-1"
                onClick={() => {
                  navigator.clipboard?.writeText(a.draftText).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
              >
                <Copy className="h-3 w-3" />{copied ? 'Copied' : 'Copy draft'}
              </button>
            </div>
          )}
        </div>
      )}

      {note && <p className="text-xs text-amber-700">{note}</p>}
    </div>
  )
}

export function SentinelActionQueue() {
  const [queue, setQueue] = useState<SentinelQueue | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<{ id: string; op: string } | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  function refresh() {
    setLoading(true)
    listSentinelActionsAction().then((r) => {
      if (r.ok) { setQueue(r.data); setErr(null) } else setErr(r.error)
      setLoading(false)
    })
  }
  useEffect(refresh, [])

  async function act(id: string, op: 'approve' | 'send' | 'dismiss') {
    setBusyId({ id, op })
    try {
      if (op === 'dismiss') {
        const r = await dismissSentinelActionAction(id)
        if (!r.ok) setNotes((n) => ({ ...n, [id]: r.error ?? 'Dismiss failed' }))
      } else {
        const r = await approveSentinelActionAction(id, { send: op === 'send' })
        if (!r.ok) setNotes((n) => ({ ...n, [id]: r.error ?? 'Approve failed' }))
        else if (r.sendNote) setNotes((n) => ({ ...n, [id]: r.sendNote! }))
      }
    } finally {
      setBusyId(null)
      refresh()
    }
  }

  return (
    <Card id="proposed-actions">
      <CardHeader className="pb-3 flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-primary" />Sentinel — today&apos;s proposed actions
        </CardTitle>
        <div className="flex items-center gap-2">
          {queue && <Badge variant="secondary" className="text-xs tabular-nums">{queue.proposed.length} proposed</Badge>}
          <button onClick={refresh} className="text-xs text-muted-foreground underline">refresh</button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          The Platform Sentinel Manager watches the whole subscriber fleet daily — engagement risk,
          expiring connections, dunning, support SLA breaches, expiring trials — and drafts the outreach.
          You approve; it never sends without you.
          {queue && !queue.emailRailReady && (
            <span className="text-amber-700"> Email sending is not configured (SendGrid), so approving keeps the draft here for you to copy.</span>
          )}
        </p>

        {loading && !queue ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading the proposed-action queue…</p>
        ) : err ? (
          <p className="text-sm text-red-600">{err}</p>
        ) : !queue ? null : (
          <>
            <LearningStrip learning={queue.learning} />

            {queue.proposed.length === 0 ? (
              <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                Nothing proposed right now — the fleet looks healthy. The sentinel sweeps daily and new proposals will land here.
              </div>
            ) : (
              <div className="space-y-2">
                {queue.proposed.map((a) => (
                  <ActionCard
                    key={a.id}
                    a={a}
                    emailRailReady={queue.emailRailReady}
                    busy={busyId?.id === a.id ? busyId.op : null}
                    note={notes[a.id] ?? null}
                    onApprove={() => act(a.id, 'approve')}
                    onApproveSend={() => act(a.id, 'send')}
                    onDismiss={() => act(a.id, 'dismiss')}
                  />
                ))}
              </div>
            )}

            {queue.recent.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-muted-foreground mb-2">Recent decisions</h3>
                <ul className="space-y-1.5">
                  {queue.recent.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-xs">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[a.status] ?? 'bg-slate-100 text-slate-600'}`}>{a.status}</span>
                      <span className="truncate">{a.title}</span>
                      <span className="ml-auto text-muted-foreground shrink-0">{a.actedAt ? new Date(a.actedAt).toLocaleDateString() : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
