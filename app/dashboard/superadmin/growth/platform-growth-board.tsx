'use client'

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Loader2, Sparkles, FileText, Copy, CalendarCheck, UserPlus } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { advanceProspectAction, confirmProspectDemoAction, convertProspectToSubscriberAction, draftProspectOutreachAction, generateProspectProposalAction, listPlatformProspectsAction } from '@/app/actions/superadmin/platform-growth'
import { PROPOSAL_SECTIONS, PROSPECT_STATUSES, describeProspectNextTouch, proposalPricingLine, proposalToClipboardText, type ProspectProposal } from '@/lib/platform/growth-funnel'

// Lane 77B — the plans a staffer can convert a prospect onto (the SAME
// canonical tier vocabulary brokerages.plan_tier carries); 'fit' lets
// lib/platform/prospect-conversion.ts pick the band from their seat count.
const CONVERT_TIERS = ['fit', 'solo_agent', 'team', 'brokerage', 'multi_location'] as const
// Wave 78A — 'paid' = activate now: a hosted checkout (plan + the tier's
// one-time setup fee) is minted and returned; access opens when it clears. A
// setup-fee waiver is a staff decision with a reason, audited by the core.
interface ConvertForm { tier: (typeof CONVERT_TIERS)[number]; mode: 'trial' | 'paid' | 'active'; cycle: 'monthly' | 'annual'; customPricing: boolean; waiveSetupFee: boolean; waiverReason: string }

// ONE status list — the funnel vocabulary (lane 76B: 'demo_scheduled', m654).
const STATUSES: readonly string[] = PROSPECT_STATUSES
const STATUS_BADGE: Record<string, string> = {
  new: 'bg-slate-100 text-slate-700', contacted: 'bg-blue-100 text-blue-800', demo_scheduled: 'bg-amber-100 text-amber-800',
  trial: 'bg-violet-100 text-violet-800', converted: 'bg-emerald-100 text-emerald-800', lost: 'bg-slate-100 text-slate-400',
}

interface Prospect {
  // email is null for a phone-only capture (AI reception caller who gave no
  // email — l32-s01 made the column nullable); phone is the reachable channel then.
  id: string; name: string | null; email: string | null; phone?: string | null; company: string | null; role_interest: string; source: string; status: string
  followup_count?: number | null; last_followup_at?: string | null; created_at?: string | null
  details?: { proposal?: ProspectProposal; qualification?: Record<string, unknown>; conversion?: { brokerage_id: string; billing_mode: string; tier: string; human_reasons: string[]; converted_at: string } } & Record<string, unknown> | null
}
interface Funnel { total: number; byStatus: Record<string, number>; conversionRate: number; activationRate: number }

export function PlatformGrowthBoard({ initialProspects, initialFunnel, brandName }: { initialProspects: Prospect[]; initialFunnel: Funnel; brandName: string }) {
  const [prospects, setProspects] = useState<Prospect[]>(initialProspects)
  const [funnel, setFunnel] = useState<Funnel>(initialFunnel)
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null)
  const [proposalView, setProposalView] = useState<{ prospect: Prospect; proposal: ProspectProposal } | null>(null)
  const [convertView, setConvertView] = useState<{ prospect: Prospect; form: ConvertForm } | null>(null)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  // Lane 77B — convert a prospect into a tenant through the ONE tenant-creation
  // core; the action derives the facts from the prospect row and returns the
  // new brokerage id. Honest toast: invite sent or not, and whether a person
  // was pulled in (enterprise / custom pricing / CRM migration).
  function convert() {
    if (!convertView) return
    const { prospect, form } = convertView
    startTransition(async () => {
      if (form.mode === 'paid' && form.waiveSetupFee && !form.waiverReason.trim()) {
        toast({ title: 'A waiver needs a reason', description: 'The setup-fee waiver is audited under your name — say why.', variant: 'destructive' }); return
      }
      const r = await convertProspectToSubscriberAction({
        prospectId: prospect.id,
        tier: form.tier === 'fit' ? null : form.tier,
        billing: form.mode === 'active'
          ? { mode: 'active', billingCycle: form.cycle }
          : form.mode === 'paid'
          ? { mode: 'paid', billingCycle: form.cycle, setupFeeWaiverReason: form.waiveSetupFee ? form.waiverReason : null }
          : { mode: 'trial' },
        customPricingRequested: form.customPricing,
      })
      if (!r.ok) { toast({ title: 'Could not convert', description: r.error, variant: 'destructive' }); return }
      if (r.alreadyConverted) toast({ title: 'Already a subscriber', description: `This prospect is linked to tenant ${r.brokerageId}.` })
      else toast({
        title: `Converted — ${(r.tier ?? '').replace(/_/g, ' ')} ${form.mode === 'trial' ? 'trial' : form.mode === 'paid' ? 'paid activation' : 'subscription'}`,
        description: `Sign-in link ${r.inviteSent ? 'sent' : `NOT sent${r.inviteError ? ` (${r.inviteError})` : ''}`}.${form.mode === 'paid' ? (r.checkoutUrl ? ` Activation checkout created (${r.setupFeeWaived ? 'setup fee WAIVED' : r.setupFeeCents ? `one-time setup $${(r.setupFeeCents / 100).toLocaleString('en-US')}` : 'no setup fee on this plan'}) — copy it from the tenant page or let the customer activate after sign-in: ${r.checkoutUrl}` : ` Checkout NOT created${r.checkoutError ? ` (${r.checkoutError})` : ''} — the customer can activate from the billing page after sign-in.`) : ''}${(r.humanReasons?.length ?? 0) > 0 ? ` White-glove task raised (${r.humanReasons!.join(', ')}) — ${r.staffNotified} staff notified.` : ' Fully autonomous — no human task needed.'}${r.demoDisposition === 'hold_released' ? ' Pending demo hold released.' : r.demoDisposition === 'kept_as_onboarding' ? ' Confirmed demo kept as the onboarding session.' : ''}`,
      })
      setConvertView(null); reload()
    })
  }

  function reload() { listPlatformProspectsAction().then((r) => { if (r.ok) { setProspects(r.prospects as Prospect[]); setFunnel(r.funnel as Funnel) } }) }
  function advance(id: string, status: string) {
    startTransition(async () => { const r = await advanceProspectAction({ id, status }); if (r.ok) reload(); else toast({ title: 'Error', description: r.error, variant: 'destructive' }) })
  }
  function pitch(id: string) {
    startTransition(async () => { const r = await draftProspectOutreachAction(id); if (r.ok) setDraft({ subject: r.subject, body: r.body }); else toast({ title: 'Error', description: r.error, variant: 'destructive' }) })
  }
  // Lane 76B — the rep's one-click demo confirm: flips the calendar hold to
  // confirmed and sends both calendar invites (ICS). Honest toast on the sends.
  function confirmDemo(id: string) {
    startTransition(async () => {
      const r = await confirmProspectDemoAction({ prospectId: id })
      if (r.ok) { toast({ title: 'Demo confirmed', description: `Invite to prospect: ${r.icsSentToProspect ? 'sent' : 'NOT sent'} · to rep: ${r.icsSentToRep ? 'sent' : 'NOT sent'}` }); reload() }
      else toast({ title: 'Could not confirm', description: r.error, variant: 'destructive' })
    })
  }
  // Assisted-sale proposal — AI-authored + persisted on the prospect row; a stored
  // proposal opens instantly, "Regenerate" re-authors. Honest-absence on AI failure.
  function generateProposal(p: Prospect) {
    startTransition(async () => {
      const r = await generateProspectProposalAction(p.id)
      if (r.ok) { setProposalView({ prospect: p, proposal: r.proposal }); reload() }
      else toast({ title: 'Proposal not generated', description: r.error, variant: 'destructive' })
    })
  }
  function openProposal(p: Prospect) {
    const stored = p.details?.proposal
    if (stored) setProposalView({ prospect: p, proposal: stored })
    else generateProposal(p)
  }
  function copyProposal() {
    if (!proposalView) return
    navigator.clipboard.writeText(proposalToClipboardText(proposalView.proposal, brandName, proposalView.prospect.name))
      .then(() => toast({ title: 'Copied', description: 'Proposal copied to clipboard.' }))
      .catch(() => toast({ title: 'Copy failed', description: 'Select the text and copy manually.', variant: 'destructive' }))
  }

  const pct = (n: number) => `${Math.round(n * 100)}%`
  const qualLine = (p: Prospect): string => {
    const q = (p.details?.qualification ?? null) as Record<string, unknown> | null
    if (!q) return ''
    return [q.size_seats ? `${q.size_seats} seats` : null, q.role_title, q.timeline, q.territory].filter(Boolean).join(' · ')
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
        <Card><CardContent className="p-3"><div className="text-2xl font-bold">{funnel.total}</div><div className="text-[11px] text-muted-foreground">Prospects</div></CardContent></Card>
        {STATUSES.map((s) => (
          <Card key={s}><CardContent className="p-3"><div className="text-2xl font-bold">{funnel.byStatus[s] ?? 0}</div><div className="text-[11px] text-muted-foreground capitalize">{s.replace('_', ' ')}</div></CardContent></Card>
        ))}
      </div>
      <div className="flex gap-4 text-sm">
        <span>Conversion: <b className="text-emerald-700">{pct(funnel.conversionRate)}</b></span>
        <span>Activation (trial+): <b className="text-violet-700">{pct(funnel.activationRate)}</b></span>
      </div>

      {draft && (
        <Card className="border-primary">
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-primary" />Product pitch draft (review before sending)</CardTitle>
            <button className="text-xs underline" onClick={() => setDraft(null)}>close</button>
          </CardHeader>
          <CardContent><p className="text-sm font-medium mb-1">{draft.subject}</p><pre className="text-xs whitespace-pre-wrap text-muted-foreground">{draft.body}</pre></CardContent>
        </Card>
      )}

      {/* Assisted-sale proposal — AI-authored sections + DB-driven pricing, copy-ready */}
      <Dialog open={!!proposalView} onOpenChange={(o) => { if (!o) setProposalView(null) }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              Proposal — {proposalView?.prospect.name || proposalView?.prospect.email}
            </DialogTitle>
          </DialogHeader>
          {proposalView && (
            <div className="space-y-4 text-sm">
              <p className="text-xs text-muted-foreground">
                Generated {new Date(proposalView.proposal.generatedAt).toLocaleString()} · recommended plan:{' '}
                <b>{proposalView.proposal.tier.displayName}</b>
              </p>
              {PROPOSAL_SECTIONS.map((s) => (
                <div key={s.key}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.title}</p>
                  <p className="mt-1 whitespace-pre-wrap">{proposalView.proposal.sections[s.key]}</p>
                  {s.key === 'recommendation' && (
                    <p className="mt-1 rounded bg-muted/40 px-2 py-1 text-xs font-medium">{proposalPricingLine(proposalView.proposal.tier)}</p>
                  )}
                </div>
              ))}
              <p className="text-xs text-muted-foreground">Demo link: {proposalView.proposal.demoUrl}</p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => generateProposal(proposalView.prospect)}>
                  {pending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}Regenerate
                </Button>
                <Button size="sm" onClick={copyProposal}><Copy className="h-3.5 w-3.5 mr-1.5" />Copy to clipboard</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Lane 77B — Convert to subscriber: plan + trial/active, then the ONE tenant-creation core */}
      <Dialog open={!!convertView} onOpenChange={(o) => { if (!o) setConvertView(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><UserPlus className="h-4 w-4 text-primary" />Convert to subscriber — {convertView?.prospect.name || convertView?.prospect.email}</DialogTitle>
          </DialogHeader>
          {convertView && (
            <div className="space-y-3 text-sm">
              <p className="text-xs text-muted-foreground">
                Creates the tenant from what the assistant already learned ({convertView.prospect.company || 'company on file'}{qualLine(convertView.prospect) ? ` · ${qualLine(convertView.prospect)}` : ''}), invites {convertView.prospect.email ?? 'their email'} as the owner, stamps this prospect, releases a pending demo hold and kicks off onboarding. A person is pulled in only for enterprise size, custom pricing or a CRM migration.
              </p>
              {!convertView.prospect.email && <p className="text-xs text-red-600">This prospect has no email on file — the sign-in link has nowhere to go. Add one first (phone-only capture).</p>}
              <label className="block text-xs">Plan
                <select className="mt-1 w-full rounded border p-1 text-xs" value={convertView.form.tier} onChange={(e) => setConvertView({ ...convertView, form: { ...convertView.form, tier: e.target.value as ConvertForm['tier'] } })}>
                  {CONVERT_TIERS.map((t) => <option key={t} value={t}>{t === 'fit' ? 'Fit to their size (recommended)' : t.replace(/_/g, ' ')}</option>)}
                </select>
              </label>
              <label className="block text-xs">Billing
                <select className="mt-1 w-full rounded border p-1 text-xs" value={convertView.form.mode} onChange={(e) => setConvertView({ ...convertView, form: { ...convertView.form, mode: e.target.value as ConvertForm['mode'] } })}>
                  <option value="trial">14-day trial — no card, they add billing in-app</option>
                  <option value="paid">Activate now — checkout for the plan + the plan&apos;s one-time setup fee; access opens when it clears</option>
                  <option value="active">Active subscription — invoiced outside checkout (enterprise / contract)</option>
                </select>
              </label>
              {(convertView.form.mode === 'active' || convertView.form.mode === 'paid') && (
                <label className="block text-xs">Cycle
                  <select className="mt-1 w-full rounded border p-1 text-xs" value={convertView.form.cycle} onChange={(e) => setConvertView({ ...convertView, form: { ...convertView.form, cycle: e.target.value as ConvertForm['cycle'] } })}>
                    <option value="monthly">monthly</option><option value="annual">annual</option>
                  </select>
                </label>
              )}
              {convertView.form.mode === 'paid' && (
                <div className="rounded border bg-muted/30 p-2 space-y-1.5">
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={convertView.form.waiveSetupFee} onChange={(e) => setConvertView({ ...convertView, form: { ...convertView.form, waiveSetupFee: e.target.checked } })} />
                    Waive the setup fee (audited under your name — the plan&apos;s fee is otherwise charged on the first invoice)
                  </label>
                  {convertView.form.waiveSetupFee && (
                    <input className="w-full rounded border p-1 text-xs" placeholder="Reason for the waiver (required)" value={convertView.form.waiverReason} onChange={(e) => setConvertView({ ...convertView, form: { ...convertView.form, waiverReason: e.target.value } })} />
                  )}
                </div>
              )}
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={convertView.form.customPricing} onChange={(e) => setConvertView({ ...convertView, form: { ...convertView.form, customPricing: e.target.checked } })} />
                They asked for custom pricing / a contract (raises the white-glove task)
              </label>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setConvertView(null)}>Cancel</Button>
                <Button size="sm" disabled={pending || !convertView.prospect.email} onClick={convert}>
                  {pending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5 mr-1.5" />}Convert
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Prospects ({prospects.length})</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2">Name / Company</th><th className="px-4 py-2">Reach</th><th className="px-4 py-2">Interest</th><th className="px-4 py-2">Source</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Next touch / demo</th><th className="px-4 py-2 text-right">Actions</th>
            </tr></thead>
            <tbody>
              {prospects.map((p) => {
                const next = describeProspectNextTouch(p)
                return (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{p.name || '—'}<span className="block text-[11px] text-muted-foreground">{p.company}</span>{qualLine(p) && <span className="block text-[11px] text-muted-foreground">{qualLine(p)}</span>}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{p.email ?? p.phone ?? '—'}{p.email && p.phone ? <span className="block">{p.phone}</span> : null}</td>
                  <td className="px-4 py-2 text-xs">{p.role_interest}</td>
                  <td className="px-4 py-2 text-xs">{p.source}</td>
                  <td className="px-4 py-2"><Badge className={'text-[10px] ' + (STATUS_BADGE[p.status] ?? '')}>{p.status.replace('_', ' ')}</Badge></td>
                  <td className="px-4 py-2 text-xs">
                    <span className={next.handoffOpen ? 'text-amber-700' : ''}>{next.label}</span>
                    {next.at && <span className="block text-muted-foreground">{new Date(next.at).toLocaleString()}</span>}
                    {p.details?.conversion && (
                      <span className="block text-emerald-700">Subscriber since {new Date(p.details.conversion.converted_at).toLocaleDateString()} · {p.details.conversion.tier.replace(/_/g, ' ')} {p.details.conversion.billing_mode}{p.details.conversion.human_reasons.length > 0 ? ' · white-glove' : ''}</span>
                    )}
                    {next.demoState === 'pending_rep_confirmation' && (
                      <Button size="sm" variant="outline" className="mt-1 h-7 text-[11px]" disabled={pending} onClick={() => confirmDemo(p.id)}>
                        <CalendarCheck className="h-3 w-3 mr-1" />Confirm demo
                      </Button>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex items-center gap-2">
                      <select className="rounded border p-1 text-xs" value={p.status} disabled={pending} onChange={(e) => advance(p.id, e.target.value)}>
                        {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                      </select>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => pitch(p.id)} title="Draft pitch">
                        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => openProposal(p)}
                        title={p.details?.proposal ? 'View proposal' : 'Generate proposal'}>
                        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className={'h-3.5 w-3.5 ' + (p.details?.proposal ? 'text-primary' : '')} />}
                      </Button>
                      {!p.details?.conversion && p.status !== 'converted' && p.status !== 'lost' && (
                        <Button size="sm" variant="ghost" disabled={pending} title="Convert to subscriber"
                          onClick={() => setConvertView({ prospect: p, form: { tier: 'fit', mode: 'trial', cycle: 'monthly', customPricing: false, waiveSetupFee: false, waiverReason: '' } })}>
                          <UserPlus className="h-3.5 w-3.5 text-emerald-700" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )})}
              {prospects.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">No prospects yet — hand-raises from the site, the phone line and the site assistant land here.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
