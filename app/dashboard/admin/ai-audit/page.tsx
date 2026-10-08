import { redirect } from 'next/navigation'
import { RoleGateNotice } from '@/app/components/shared/role-gate-notice'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sparkles, Eye, CheckCircle2, TrendingUp } from 'lucide-react'
import Link from 'next/link'
import { getAgentContext } from '@/lib/identity'
import { toCanonicalRoleOrDefault } from '@/lib/security'
import { getEntityCausalChain, replayTenantDecisions, getTenantExperimentPolicy, setExperimentKillSwitch } from '@/app/actions/flight-recorder'
import { revalidatePath } from 'next/cache'

export const dynamic = 'force-dynamic'

export default async function AIAuditPage({ searchParams }: { searchParams: Promise<{ entityType?: string; entityId?: string; replay?: string; replaySince?: string; replaySubjectType?: string; replaySubjectId?: string }> }) {
  // Kernel OS: getAgentContext — canonical identity, never raw auth.getUser()
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect('/login')

  const userRole = toCanonicalRoleOrDefault(ctx.userType, 'agent')
  if (!['admin', 'superadmin', 'compliance_officer'].includes(userRole)) {
    return <RoleGateNotice surface="The AI audit" audience="brokerage admins and the compliance officer" />
  }

  const supabase = await createClient()

  // Fetch AI quality metrics — ai_generated_content is the canonical AI output
  // log (ai_content_outputs was a writer-less legacy twin; same columns).
  const { data: aiOutputs } = await supabase
    .from('ai_generated_content')
    .select('id, content_type, compliance_approved, created_at, agent_id')
    .order('created_at', { ascending: false })
    .limit(50)

  const outputs = aiOutputs || []

  // FLIGHT RECORDER (wave 97): "why did the AI send this?" for one contact / lead / listing /
  // transaction. The action gates on the SESSION's tenant itself; this page only names the entity.
  const sp = await searchParams
  const flight = sp?.entityType && sp?.entityId
    ? await getEntityCausalChain({ entityType: sp.entityType, entityId: sp.entityId })
    : null
  // DECISION REPLAY (wave 101, 101B): re-run the CURRENT planner on recorded NBA decisions. The
  // action takes the tenant from the session; this page passes only the window / subject.
  const replay = sp?.replay
    ? await replayTenantDecisions({ since: sp.replaySince ? `${sp.replaySince}T00:00:00Z` : null, subjectType: sp.replaySubjectType ?? null, subjectId: sp.replaySubjectId || null })
    : null
  const experimentPolicy = await getTenantExperimentPolicy()
  const total = outputs.length
  const approved = outputs.filter((o: any) => o.compliance_approved).length
  const pending = outputs.filter((o: any) => !o.compliance_approved).length
  const approvalRate = total > 0 ? Math.round((approved / total) * 100) : 0

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-600" />
            AI Quality Audit
          </h1>
          <p className="text-gray-500 text-sm">Monitor AI output quality and compliance across all agents</p>
        </div>
        <Link href="/dashboard/ai-quality">
          <Button variant="outline" size="sm">Full AI Quality Dashboard</Button>
        </Link>
      </div>

      {/* ── Your AI team's read ──────────────────────────────────────────────
          The compliance question this page exists to answer isn't "what's the
          approval rate" — it's "what AI output went out that nobody reviewed,
          and how long has it been sitting." Deterministic over the same rows
          the cards below count. Signal ownership: AI output review is the
          compliance_officer's domain (lib/kernel/manager-registry.ts). */}
      {(() => {
        const unapproved = outputs.filter((o: any) => !o.compliance_approved)
        const reads: Array<{ severity: 'urgent' | 'warn' | 'good'; text: string }> = []

        if (total === 0) {
          reads.push({
            severity: 'good',
            text: 'No AI output logged yet — nothing to review. This surface fills as your AI team produces content.',
          })
        } else {
          if (unapproved.length > 0) {
            const oldest = unapproved.reduce((a: any, b: any) =>
              new Date(a.created_at) <= new Date(b.created_at) ? a : b)
            const ageDays = Math.floor((Date.now() - new Date(oldest.created_at).getTime()) / 86_400_000)
            reads.push({
              severity: ageDays >= 7 ? 'urgent' : 'warn',
              text: `${unapproved.length} AI output${unapproved.length === 1 ? '' : 's'} ${unapproved.length === 1 ? 'has' : 'have'} never been compliance-reviewed — the oldest is ${ageDays} day${ageDays === 1 ? '' : 's'} old. Unreviewed AI content is the regulatory exposure this desk exists to close.`,
            })
            // Which content type dominates the unreviewed pile — where to start.
            const byType = new Map<string, number>()
            for (const o of unapproved) {
              const t = (o as any).content_type ?? 'unknown'
              byType.set(t, (byType.get(t) ?? 0) + 1)
            }
            const [topType, topCount] = [...byType.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
            if (topCount >= 2 && byType.size > 1) {
              reads.push({
                severity: 'warn',
                text: `${topCount} of them are ${topType.replace(/_/g, ' ')} — reviewing that one type clears most of the backlog in a single pass.`,
              })
            }
          }
          if (approvalRate >= 90 && total >= 5) {
            reads.push({
              severity: 'good',
              text: `${approvalRate}% of AI output cleared compliance — the generation gates are holding, not just the review desk.`,
            })
          } else if (approvalRate < 60 && total >= 5) {
            reads.push({
              severity: 'urgent',
              text: `Only ${approvalRate}% cleared compliance — a low rate points upstream at the prompts/brand voice, not at the reviewers. Fix the generator and the queue shrinks itself.`,
            })
          }
        }

        const STYLE: Record<string, string> = {
          urgent: 'border-red-200 bg-red-50/60', warn: 'border-amber-200 bg-amber-50/60', good: 'border-emerald-200 bg-emerald-50/60',
        }
        const DOT: Record<string, string> = { urgent: 'bg-red-500', warn: 'bg-amber-500', good: 'bg-emerald-500' }

        return (
          <Card className="border-indigo-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Your AI team&apos;s read</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {reads.map((r, i) => (
                <div key={i} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${STYLE[r.severity]}`}>
                  <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${DOT[r.severity]}`} />
                  <p className="text-sm leading-relaxed">{r.text}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        )
      })()}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total AI Outputs', value: total, icon: Sparkles, color: 'text-purple-600' },
          { label: 'Compliance Approved', value: approved, icon: CheckCircle2, color: 'text-green-600' },
          { label: 'Pending Review', value: pending, icon: Eye, color: 'text-yellow-600' },
          { label: 'Approval Rate', value: `${approvalRate}%`, icon: TrendingUp, color: approvalRate >= 80 ? 'text-green-600' : 'text-red-600' },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4 flex items-center gap-3">
              <stat.icon className={`w-8 h-8 ${stat.color}`} />
              <div>
                <p className="text-2xl font-bold">{stat.value}</p>
                <p className="text-xs text-gray-500">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Flight recorder</CardTitle>
          <CardDescription>Why did the AI act? Events and actions for one record, in order, with reason codes.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="flex flex-wrap gap-2 text-sm">
            <select name="entityType" defaultValue={sp?.entityType ?? 'contact'} className="border rounded px-2 py-1">
              {['contact', 'lead', 'listing', 'transaction'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input name="entityId" defaultValue={sp?.entityId ?? ''} placeholder="record id (uuid)" className="border rounded px-2 py-1 flex-1 min-w-[16rem]" />
            <Button type="submit" size="sm" variant="outline">Trace</Button>
          </form>
          {flight && !flight.ok && <p className="text-sm text-red-600">{flight.error}</p>}
          {flight?.ok && (flight.chain.length === 0
            ? <p className="text-sm text-gray-500">Nothing recorded for this record.</p>
            : <ol className="space-y-1 text-sm">
                {flight.chain.map((l) => (
                  <li key={`${l.kind}-${l.id}`} className="flex flex-wrap gap-2">
                    <span className="text-xs text-gray-500">{new Date(l.at).toLocaleString()}</span>
                    <span className="font-medium">{l.name}</span>
                    {l.kind === 'action' && <Badge variant="outline">{l.status} · {l.reasonCode}{l.settledAt ? ` · settled ${new Date(l.settledAt).toLocaleString()}` : ''}{l.error ? ` · ${l.error}` : ''}</Badge>}
                    {l.kind === 'action' && (l.actor || l.costUsd != null || l.riskClass || l.source || l.subjectRef) && <span className="text-xs text-muted-foreground" title={l.detail ? JSON.stringify(l.detail) : undefined}>{[l.actor && `by ${l.actor}`, l.riskClass, l.source, l.subjectRef, l.costUsd != null && `$${l.costUsd.toFixed(4)}`].filter(Boolean).join(' · ')}</span>}
                    {l.kind === 'action' && l.policyRef && <span className="text-xs text-muted-foreground" title="Which tenant policy permitted this action (policy_key@version — see the Operating Constitution)">permitted by {l.policyRef}</span>}
                    {l.because && l.because.length > 0 && <span className="text-xs text-gray-500">because {l.because.join(' → ')}</span>}
                    {l.kind === 'action' && (() => {
                      // Wave 100A: what this action EARNED (last-touch / all-touch credit, deterministic rule).
                      const mine = flight.attribution?.credits.filter((c) => c.actionId === l.id) ?? []
                      if (mine.length === 0) return null
                      const last = mine.filter((c) => c.model === 'last_touch')
                      const allCents = mine.filter((c) => c.model === 'all_touch').reduce((s, c) => s + c.cents, 0)
                      return <Badge className="bg-emerald-50 text-emerald-800 border-emerald-200">credited: {[...new Set(mine.map((c) => c.kind))].join(', ')}{last.length > 0 ? ` · last touch ×${last.length}` : ''}{allCents > 0 ? ` · $${Math.round(allCents / 100).toLocaleString()} all-touch` : ''}</Badge>
                    })()}
                  </li>
                ))}
              </ol>)}
          {flight?.ok && flight.attribution && (
            <div className="rounded border px-3 py-2 text-sm space-y-1">
              <p className="font-medium">Outcomes → credited actions</p>
              <p className="text-xs text-muted-foreground">
                {flight.attribution.outcomes.length} outcome{flight.attribution.outcomes.length === 1 ? '' : 's'} (reply · appointment · contract · closed GCI);
                {' '}{flight.attribution.outcomes.length - flight.attribution.uncredited.length} credited to a preceding ledger action or NBA decision of this tenant.
                Rule: last-touch = 100% to the latest executed action before the outcome; all-touch = equal split across every executed action and NBA decision in the window. Actions after the outcome earn nothing.
              </p>
              {flight.attribution.byReasonCode.length > 0 && (
                <p className="text-xs">By reason code: {flight.attribution.byReasonCode.map((r) => `${r.key} ($${Math.round(r.lastTouchCents / 100).toLocaleString()} last / $${Math.round(r.allTouchCents / 100).toLocaleString()} all)`).join(' · ')}</p>
              )}
              {flight.attribution.uncredited.length > 0 && <p className="text-xs text-amber-700">Not credited (no preceding ledger row): {flight.attribution.uncredited.join(', ')}</p>}
            </div>
          )}
          {flight?.ok && flight.attributionError && <p className="text-xs text-red-600">Outcome attribution could not be read: {flight.attributionError}</p>}
          {flight?.ok && !flight.ledgerAvailable && <p className="text-xs text-amber-700">Action ledger not deployed yet — showing events only.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Decision replay &amp; experiments</CardTitle>
          <CardDescription>
            Re-runs today&apos;s next-best-action planner on what each recorded wait / do-nothing decision saw. Deterministic — no AI model is called.
            Disagreements show what that decision went on to earn (same attribution rule as the flight recorder).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <form className="flex flex-wrap gap-2">
            <input type="hidden" name="replay" value="1" />
            <label className="flex items-center gap-1 text-xs text-gray-500">since
              <input type="date" name="replaySince" defaultValue={sp?.replaySince ?? ''} className="border rounded px-2 py-1" />
            </label>
            <select name="replaySubjectType" defaultValue={sp?.replaySubjectType ?? 'lead'} className="border rounded px-2 py-1">
              {['lead', 'contact'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input name="replaySubjectId" defaultValue={sp?.replaySubjectId ?? ''} placeholder="one record id (optional)" className="border rounded px-2 py-1 flex-1 min-w-[14rem]" />
            <Button type="submit" size="sm" variant="outline">Replay</Button>
          </form>
          {replay && !replay.ok && <p className="text-red-600">{replay.error}</p>}
          {replay?.ok && (() => {
            const r = replay.report
            const pct = r.agreementRate == null ? 'n/a' : `${Math.round(r.agreementRate * 1000) / 10}%`
            return (
              <div className="space-y-2">
                <p>
                  {r.examined} recorded decision{r.examined === 1 ? '' : 's'} · {r.replayed} replayable · <span className="font-medium">{r.agreements} agree ({pct})</span> · {r.disagreements.length} would change
                  {replay.truncated ? ' · first 2,000 only' : ''}
                </p>
                {(r.unreplayable.noSnapshot + r.unreplayable.unknownVersion + r.unreplayable.plannerNull) > 0 && (
                  <p className="text-xs text-amber-700">
                    Not replayable: {r.unreplayable.noSnapshot} recorded before decision inputs were stored · {r.unreplayable.unknownVersion} unknown snapshot version · {r.unreplayable.plannerNull} incomplete.
                  </p>
                )}
                {r.byReasonCode.length > 0 && (
                  <p className="text-xs">By reason code: {r.byReasonCode.map((b) => `${b.recordedCode} ${b.agreed}/${b.replayed}${b.disagreed > 0 ? ` → ${Object.entries(b.changedTo).map(([k, n]) => `${k}×${n}`).join(', ')}` : ''}`).join(' · ')}</p>
                )}
                {r.disagreements.length > 0 && (
                  <ol className="space-y-1 text-xs">
                    {r.disagreements.slice(0, 25).map((d) => (
                      <li key={d.actionId} className="flex flex-wrap gap-2">
                        <span className="text-gray-500">{new Date(d.recordedAt).toLocaleString()}</span>
                        <Link className="underline" href={`/dashboard/admin/ai-audit?entityType=${d.subjectType}&entityId=${d.subjectId ?? ''}`}>{d.subjectType}</Link>
                        <Badge variant="outline">{d.recordedAction}:{d.recordedCode} → {d.replayedAction}:{d.replayedCode}</Badge>
                        {d.outcomes.length > 0 && <Badge className="bg-emerald-50 text-emerald-800 border-emerald-200">then: {[...new Set(d.outcomes.map((o) => o.kind))].join(', ')}{d.outcomes.some((o) => o.cents > 0) ? ` · $${Math.round(d.outcomes.filter((o) => o.model === 'all_touch').reduce((s, o) => s + o.cents, 0) / 100).toLocaleString()} all-touch` : ''}</Badge>}
                      </li>
                    ))}
                  </ol>
                )}
                {replay.attributionError && <p className="text-xs text-red-600">Outcome join could not be read: {replay.attributionError}</p>}
                {!replay.ledgerAvailable && <p className="text-xs text-amber-700">Action ledger not deployed yet — nothing to replay.</p>}
              </div>
            )
          })()}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <span className="font-medium">Experiments:</span>
            {experimentPolicy.ok
              ? <span className={experimentPolicy.killSwitch ? 'text-amber-700' : 'text-gray-600'}>
                  {!experimentPolicy.readable ? 'policy unreadable — every experiment assigns its control arm' : experimentPolicy.killSwitch ? 'kill switch ON — every experiment assigns its control arm' : `running${experimentPolicy.disabled.length > 0 ? ` (disabled: ${experimentPolicy.disabled.join(', ')})` : ''}`}
                </span>
              : <span className="text-red-600">{experimentPolicy.error}</span>}
            {experimentPolicy.ok && experimentPolicy.readable && (
              <form action={async () => {
                'use server'
                await setExperimentKillSwitch({ on: !experimentPolicy.killSwitch })
                revalidatePath('/dashboard/admin/ai-audit')
              }}>
                <Button type="submit" size="sm" variant="outline">{experimentPolicy.killSwitch ? 'Resume experiments' : 'Stop all experiments'}</Button>
              </form>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent AI Outputs</CardTitle>
          <CardDescription>Last 50 AI-generated content items</CardDescription>
        </CardHeader>
        <CardContent>
          {outputs.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No AI outputs recorded yet</p>
          ) : (
            <div className="space-y-2">
              {outputs.map((output: any) => (
                <div key={output.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{output.content_type || 'AI Content'}</p>
                    <p className="text-xs text-gray-500">{new Date(output.created_at).toLocaleString()}</p>
                  </div>
                  <Badge className={output.compliance_approved ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}>
                    {output.compliance_approved ? 'Approved' : 'Pending'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
