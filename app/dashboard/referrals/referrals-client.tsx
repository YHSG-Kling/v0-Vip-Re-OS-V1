'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { format } from 'date-fns'
import {
  Share2, Gift, Star, Plus, ChevronRight, CheckCircle2,
  DollarSign, TrendingUp, Clock, Users, Sparkles, Brain,
  AlertCircle, BarChart3
} from 'lucide-react'
import { identifyReferralOpportunities, analyzeReferralProgram } from '@/app/actions/ai-referral-management'
import { toast } from 'sonner'

// ── Types ──────────────────────────────────────────────────────────────────────
type ReferralStatus = 'identified' | 'asked' | 'received' | 'converting' | 'converted' | 'lost'

interface Referral {
  id: string
  referral_name: string | null
  status: ReferralStatus
  value_estimate: number | null
  commission_potential: number | null
  source_contact_id: string | null
  source_contact_name: string | null
  referred_by: string | null
  created_at: string
  converted_at: string | null
  gift_sent: boolean
  thank_you_sent: boolean
}

interface GiftingItem {
  id: string
  referral_name: string | null
  source_contact_id: string | null
  source_contact_name: string | null
  converted_at: string | null
}

interface ReviewRequest {
  id: string
  contact_id: string | null
  contact_name: string | null
  status: string
  created_at: string
}

interface ROISummary {
  totalReferrals: number
  converted: number
  conversionRate: number
  totalValue: number
}

interface Props {
  referrals: Referral[]
  giftingItems: GiftingItem[]
  reviewRequests: ReviewRequest[]
  roiSummary: ROISummary
  agentId: string
}

// ── Constants ──────────────────────────────────────────────────────────────────
const REFERRAL_STATUSES: { key: ReferralStatus; label: string; color: string; bg: string; border: string }[] = [
  { key: 'identified',  label: 'Identified',   color: 'text-slate-600',  bg: 'bg-slate-50',   border: 'border-slate-200' },
  { key: 'asked',       label: 'Ask Sent',      color: 'text-blue-700',   bg: 'bg-blue-50',    border: 'border-blue-200' },
  { key: 'received',    label: 'Referral In',   color: 'text-amber-700',  bg: 'bg-amber-50',   border: 'border-amber-200' },
  { key: 'converting',  label: 'Converting',    color: 'text-orange-700', bg: 'bg-orange-50',  border: 'border-orange-200' },
  { key: 'converted',   label: 'Converted',     color: 'text-green-700',  bg: 'bg-green-50',   border: 'border-green-200' },
  { key: 'lost',        label: 'Lost',          color: 'text-red-600',    bg: 'bg-red-50',     border: 'border-red-200' },
]

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

// ── Draft modal ────────────────────────────────────────────────────────────────
function DraftModal({ draft, onClose }: { draft: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6">
        <h3 className="font-semibold text-slate-900 mb-3">AI Thank-You Draft</h3>
        <textarea
          className="w-full border border-slate-200 rounded-lg p-3 text-sm text-slate-700 min-h-[180px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
          defaultValue={draft}
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
          >
            Close
          </button>
          <button
            onClick={() => { navigator.clipboard.writeText(draft); onClose() }}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Copy to Clipboard
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export function ReferralsClient({ referrals, giftingItems, reviewRequests, roiSummary, agentId }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [draft, setDraft] = useState<string | null>(null)
  const [loadingDraft, setLoadingDraft] = useState<string | null>(null)
  const [localGifting, setLocalGifting] = useState<Set<string>>(new Set())
  const [opportunities, setOpportunities] = useState<any>(null)
  const [programAnalysis, setProgramAnalysis] = useState<any>(null)
  const [aiLoading, setAiLoading] = useState<"opportunities" | "analysis" | null>(null)

  const grouped = REFERRAL_STATUSES.reduce<Record<ReferralStatus, Referral[]>>((acc, s) => {
    acc[s.key] = referrals.filter(r => r.status === s.key)
    return acc
  }, {} as Record<ReferralStatus, Referral[]>)

  async function advanceStatus(referralId: string, status: ReferralStatus) {
    await fetch('/api/referrals/advance-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referralId, status }),
    })
    startTransition(() => router.refresh())
  }

  async function markGiftSent(referralId: string) {
    setLocalGifting(prev => new Set([...prev, referralId]))
    await fetch('/api/referrals/advance-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referralId, status: 'converted' }),
    })
    // Mark gift_sent via a dedicated upsert — we use the existing advance-status route which just updates status,
    // so we call Supabase directly via a dedicated gift-sent endpoint pattern using the supabase client on the server.
    // For now, optimistic local state is applied and router refresh syncs.
    startTransition(() => router.refresh())
  }

  async function handleIdentifyOpportunities() {
    setAiLoading("opportunities")
    try {
      const result = await identifyReferralOpportunities(agentId)
      if (!result.success) {
        toast.error((result as any).error ?? "Could not identify opportunities")
      } else if ((result as any).analysis) {
        setOpportunities((result as any).analysis)
        toast.success("Referral opportunities identified")
      } else {
        toast.info("No referral opportunities found at this time")
      }
    } finally {
      setAiLoading(null)
    }
  }

  async function handleAnalyzeProgram() {
    setAiLoading("analysis")
    try {
      const result = await analyzeReferralProgram(agentId)
      if (result.success && (result as any).analysis) {
        setProgramAnalysis((result as any).analysis)
        toast.success("Program analysis complete")
      } else {
        toast.error((result as any).error ?? "Analysis failed")
      }
    } finally {
      setAiLoading(null)
    }
  }

  async function generateDraft(item: GiftingItem) {
    setLoadingDraft(item.id)
    try {
      const res = await fetch('/api/referrals/thank-you-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          referralId: item.id,
          contactId: item.source_contact_id,
          referralName: item.referral_name,
        }),
      })
      const { draft: d } = await res.json()
      setDraft(d)
    } finally {
      setLoadingDraft(null)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {draft && <DraftModal draft={draft} onClose={() => setDraft(null)} />}

      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-5">
        <div className="flex items-center justify-between max-w-screen-xl mx-auto">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
              <Share2 className="h-5 w-5 text-blue-600" />
              Referrals &amp; Reviews
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">Track referral pipeline, send gifts, and manage review requests</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleIdentifyOpportunities}
              disabled={aiLoading !== null}
              className="flex items-center gap-1.5 bg-purple-600 text-white text-sm font-medium px-3 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-60"
            >
              <Sparkles className="h-4 w-4" />
              {aiLoading === "opportunities" ? "Scanning..." : "Find Opportunities"}
            </button>
            <button
              onClick={handleAnalyzeProgram}
              disabled={aiLoading !== null}
              className="flex items-center gap-1.5 bg-indigo-600 text-white text-sm font-medium px-3 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-60"
            >
              <BarChart3 className="h-4 w-4" />
              {aiLoading === "analysis" ? "Analyzing..." : "Analyze Program"}
            </button>
            <button className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700">
              <Plus className="h-4 w-4" />
              Add Referral
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-screen-xl mx-auto px-6 py-6 space-y-6">

        {/* Metrics strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Total Referrals', value: roiSummary.totalReferrals, icon: Users, color: 'text-slate-700' },
            { label: 'Converted',       value: roiSummary.converted,       icon: CheckCircle2, color: 'text-green-600' },
            { label: 'Conversion Rate', value: `${roiSummary.conversionRate}%`, icon: TrendingUp, color: 'text-blue-600' },
            { label: 'Pipeline Value',  value: fmt(roiSummary.totalValue), icon: DollarSign, color: 'text-amber-600' },
          ].map(m => (
            <div key={m.label} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-slate-50">
                <m.icon className={`h-4 w-4 ${m.color}`} />
              </div>
              <div>
                <p className="text-xs text-slate-500">{m.label}</p>
                <p className="text-lg font-semibold text-slate-900">{m.value}</p>
              </div>
            </div>
          ))}
        </div>

        {/* AI Program Analysis */}
        {programAnalysis && (
          <div className="bg-white rounded-xl border border-indigo-200">
            <div className="px-5 py-4 border-b border-indigo-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-indigo-600" />
                <div>
                  <p className="text-sm font-semibold text-slate-800">Referral Program Analysis</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Health score: {programAnalysis.overallHealth?.score ?? "—"}/100 ·{" "}
                    <span className={
                      programAnalysis.overallHealth?.trend === "improving" ? "text-green-600" :
                      programAnalysis.overallHealth?.trend === "declining" ? "text-red-600" : "text-amber-600"
                    }>
                      {programAnalysis.overallHealth?.trend ?? "stable"}
                    </span>
                  </p>
                </div>
              </div>
              <button onClick={() => setProgramAnalysis(null)} className="text-xs text-slate-400 hover:text-slate-600">Dismiss</button>
            </div>
            <div className="px-5 py-4 space-y-4">
              {programAnalysis.overallHealth?.summary && (
                <p className="text-sm text-slate-600">{programAnalysis.overallHealth.summary}</p>
              )}
              {programAnalysis.recommendations?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">Recommendations</p>
                  <div className="space-y-2">
                    {programAnalysis.recommendations.slice(0, 4).map((rec: any, i: number) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          rec.effort === "low" ? "bg-green-500" :
                          rec.effort === "medium" ? "bg-amber-500" : "bg-red-500"
                        }`} />
                        <div>
                          <p className="text-sm text-slate-800">{rec.recommendation}</p>
                          <p className="text-xs text-slate-500">{rec.expectedImpact}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {programAnalysis.metrics?.topReferrers?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">Top Referrers</p>
                  <div className="flex flex-wrap gap-2">
                    {programAnalysis.metrics.topReferrers.map((r: any, i: number) => (
                      <span key={i} className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-2.5 py-1">
                        {r.name} · {r.referrals} referrals
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* AI Opportunities */}
        {opportunities && (
          <div className="bg-white rounded-xl border border-purple-200">
            <div className="px-5 py-4 border-b border-purple-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-purple-600" />
                <div>
                  <p className="text-sm font-semibold text-slate-800">AI Referral Opportunities</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {opportunities.topReferralCandidates?.length ?? 0} top candidates identified
                  </p>
                </div>
              </div>
              <button onClick={() => setOpportunities(null)} className="text-xs text-slate-400 hover:text-slate-600">Dismiss</button>
            </div>
            <div className="divide-y divide-slate-100">
              {(opportunities.topReferralCandidates ?? []).slice(0, 6).map((c: any) => (
                <div key={c.contactId} className="px-5 py-3 flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-slate-800">{c.contactName}</p>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                        c.networkStrength === "high" ? "bg-green-100 text-green-700" :
                        c.networkStrength === "medium" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
                      }`}>
                        {c.networkStrength}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">{c.bestApproach}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{c.suggestedTiming}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-bold text-purple-600">{c.referralScore}</p>
                    <p className="text-xs text-slate-500">score</p>
                  </div>
                </div>
              ))}
              {opportunities.campaignSuggestions?.length > 0 && (
                <div className="px-5 py-4">
                  <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">Suggested Campaigns</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {opportunities.campaignSuggestions.slice(0, 4).map((c: any, i: number) => (
                      <div key={i} className="p-2.5 rounded-lg bg-purple-50 border border-purple-100">
                        <p className="text-xs font-medium text-slate-800">{c.name}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{c.approach}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Pipeline kanban */}
        <div>
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">Referral Pipeline</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {REFERRAL_STATUSES.map(col => (
              <div key={col.key} className={`rounded-xl border ${col.border} ${col.bg} p-3`}>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-semibold ${col.color}`}>{col.label}</span>
                  <span className={`text-xs font-bold ${col.color}`}>{grouped[col.key].length}</span>
                </div>
                <div className="space-y-2">
                  {grouped[col.key].length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-3">None</p>
                  )}
                  {grouped[col.key].map(r => (
                    <div key={r.id} className="bg-white rounded-lg border border-slate-100 p-2.5 shadow-sm">
                      <p className="text-xs font-medium text-slate-800 truncate">
                        {r.referral_name ?? 'Unnamed referral'}
                      </p>
                      {r.source_contact_name && (
                        <p className="text-[11px] text-slate-500 mt-0.5 truncate">
                          From: {r.source_contact_name}
                        </p>
                      )}
                      {r.value_estimate != null && (
                        <p className="text-[11px] text-slate-600 mt-1 font-medium">{fmt(r.value_estimate)}</p>
                      )}
                      {/* Quick advance */}
                      {col.key !== 'converted' && col.key !== 'lost' && (
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {REFERRAL_STATUSES.filter(s => s.key !== col.key && s.key !== 'identified').map(s => (
                            <button
                              key={s.key}
                              onClick={() => advanceStatus(r.id, s.key)}
                              disabled={isPending}
                              className={`text-[10px] px-1.5 py-0.5 rounded ${s.color} ${s.bg} border ${s.border} hover:opacity-80`}
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Gifting queue */}
        {giftingItems.filter(g => !localGifting.has(g.id)).length > 0 && (
          <div className="bg-white rounded-xl border border-amber-200">
            <div className="px-5 py-4 border-b border-amber-100 flex items-center gap-2">
              <Gift className="h-4 w-4 text-amber-600" />
              <div>
                <p className="text-sm font-semibold text-slate-800">Gifting &amp; Thank-You Queue</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {giftingItems.filter(g => !localGifting.has(g.id)).length} converted referrals awaiting a gift or thank-you
                </p>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {giftingItems
                .filter(g => !localGifting.has(g.id))
                .map(item => (
                  <div key={item.id} className="flex items-center justify-between px-5 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-800">
                        {item.source_contact_name ?? 'Unknown contact'}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Referred {item.referral_name ?? 'a client'}
                        {item.converted_at && ` · Converted ${format(new Date(item.converted_at), 'MMM d')}`}
                      </p>
                    </div>
                    <div className="flex gap-2 ml-4 flex-shrink-0">
                      <button
                        onClick={() => markGiftSent(item.id)}
                        className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                      >
                        Mark Gift Sent
                      </button>
                      <button
                        onClick={() => generateDraft(item)}
                        disabled={loadingDraft === item.id}
                        className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                      >
                        {loadingDraft === item.id ? 'Drafting...' : 'Draft Thank-You'}
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Review request queue */}
        {reviewRequests.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
              <Star className="h-4 w-4 text-amber-500" />
              <div>
                <p className="text-sm font-semibold text-slate-800">Review Requests Pending</p>
                <p className="text-xs text-slate-500 mt-0.5">{reviewRequests.length} pending follow-ups</p>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {reviewRequests.map(req => (
                <div key={req.id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4 text-slate-400 flex-shrink-0" />
                    <div>
                      <p className="text-sm text-slate-800">{req.contact_name ?? 'Unknown contact'}</p>
                      <p className="text-xs text-slate-500">
                        Sent {format(new Date(req.created_at), 'MMM d, yyyy')}
                      </p>
                    </div>
                  </div>
                  {req.contact_id ? (
                    <Link
                      href={`/crm?contactId=${req.contact_id}`}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                    >
                      Follow Up <ChevronRight className="h-3 w-3" />
                    </Link>
                  ) : (
                    <span className="text-xs text-slate-400">No contact linked</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {referrals.length === 0 && giftingItems.length === 0 && reviewRequests.length === 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <Share2 className="h-10 w-10 text-slate-300 mx-auto mb-3" />
            <p className="font-medium text-slate-700">No referrals yet</p>
            <p className="text-sm text-slate-500 mt-1">Add your first referral to start tracking your pipeline.</p>
          </div>
        )}
      </div>
    </div>
  )
}
