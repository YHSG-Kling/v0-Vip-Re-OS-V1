'use client'

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Loader2, Sparkles, FileText, Copy } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { advanceProspectAction, draftProspectOutreachAction, generateProspectProposalAction, listPlatformProspectsAction } from '@/app/actions/superadmin/platform-growth'
import { PROPOSAL_SECTIONS, proposalPricingLine, proposalToClipboardText, type ProspectProposal } from '@/lib/platform/growth-funnel'

const STATUSES = ['new', 'contacted', 'trial', 'converted', 'lost']
const STATUS_BADGE: Record<string, string> = {
  new: 'bg-slate-100 text-slate-700', contacted: 'bg-blue-100 text-blue-800', trial: 'bg-violet-100 text-violet-800',
  converted: 'bg-emerald-100 text-emerald-800', lost: 'bg-slate-100 text-slate-400',
}

interface Prospect {
  // email is null for a phone-only capture (AI reception caller who gave no
  // email — l32-s01 made the column nullable); phone is the reachable channel then.
  id: string; name: string | null; email: string | null; phone?: string | null; company: string | null; role_interest: string; source: string; status: string
  details?: { proposal?: ProspectProposal } | null
}
interface Funnel { total: number; byStatus: Record<string, number>; conversionRate: number; activationRate: number }

export function PlatformGrowthBoard({ initialProspects, initialFunnel, brandName }: { initialProspects: Prospect[]; initialFunnel: Funnel; brandName: string }) {
  const [prospects, setProspects] = useState<Prospect[]>(initialProspects)
  const [funnel, setFunnel] = useState<Funnel>(initialFunnel)
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null)
  const [proposalView, setProposalView] = useState<{ prospect: Prospect; proposal: ProspectProposal } | null>(null)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function reload() { listPlatformProspectsAction().then((r) => { if (r.ok) { setProspects(r.prospects as Prospect[]); setFunnel(r.funnel as Funnel) } }) }
  function advance(id: string, status: string) {
    startTransition(async () => { const r = await advanceProspectAction({ id, status }); if (r.ok) reload(); else toast({ title: 'Error', description: r.error, variant: 'destructive' }) })
  }
  function pitch(id: string) {
    startTransition(async () => { const r = await draftProspectOutreachAction(id); if (r.ok) setDraft({ subject: r.subject, body: r.body }); else toast({ title: 'Error', description: r.error, variant: 'destructive' }) })
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

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <Card><CardContent className="p-3"><div className="text-2xl font-bold">{funnel.total}</div><div className="text-[11px] text-muted-foreground">Prospects</div></CardContent></Card>
        {STATUSES.map((s) => (
          <Card key={s}><CardContent className="p-3"><div className="text-2xl font-bold">{funnel.byStatus[s] ?? 0}</div><div className="text-[11px] text-muted-foreground capitalize">{s}</div></CardContent></Card>
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

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Prospects ({prospects.length})</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2">Name / Company</th><th className="px-4 py-2">Reach</th><th className="px-4 py-2">Interest</th><th className="px-4 py-2">Source</th><th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Actions</th>
            </tr></thead>
            <tbody>
              {prospects.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{p.name || '—'}<span className="block text-[11px] text-muted-foreground">{p.company}</span></td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{p.email ?? p.phone ?? '—'}{p.email && p.phone ? <span className="block">{p.phone}</span> : null}</td>
                  <td className="px-4 py-2 text-xs">{p.role_interest}</td>
                  <td className="px-4 py-2 text-xs">{p.source}</td>
                  <td className="px-4 py-2"><Badge className={'text-[10px] ' + (STATUS_BADGE[p.status] ?? '')}>{p.status}</Badge></td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex items-center gap-2">
                      <select className="rounded border p-1 text-xs" value={p.status} disabled={pending} onChange={(e) => advance(p.id, e.target.value)}>
                        {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => pitch(p.id)} title="Draft pitch">
                        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => openProposal(p)}
                        title={p.details?.proposal ? 'View proposal' : 'Generate proposal'}>
                        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className={'h-3.5 w-3.5 ' + (p.details?.proposal ? 'text-primary' : '')} />}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {prospects.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">No prospects yet — hand-raises from the site land here.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
