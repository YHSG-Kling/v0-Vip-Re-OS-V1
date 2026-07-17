"use client"

import { useState, useTransition, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  Users, AlertTriangle, Clock, TrendingUp, CheckCircle2,
  ChevronDown, Loader2, Phone, Mail, Building2,
  Calendar, DollarSign, Award, X, UserPlus
} from "lucide-react"

// ── Types ────────────────────────────────────────────────────────────────────
export type Recruit = {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  status: string
  license_state: string | null
  current_brokerage: string | null
  years_experience: number | null
  annual_volume: number | null
  contact_method: string | null
  notes: string | null
  created_at: string
  last_contact_date: string | null
  recruiter_agent_id: string | null
  provisioned: boolean
}

type Props = {
  recruits: Recruit[]
  brokerageId: string
}

// ── Constants ────────────────────────────────────────────────────────────────
const STATUS_COLUMNS = [
  { key: "prospect",       label: "Prospects",       color: "bg-slate-100 text-slate-700",  dot: "bg-slate-400"  },
  { key: "contacted",      label: "Contacted",        color: "bg-blue-50 text-blue-700",     dot: "bg-blue-500"   },
  { key: "interviewing",   label: "Interviewing",     color: "bg-violet-50 text-violet-700", dot: "bg-violet-500" },
  { key: "offer_extended", label: "Offer Extended",   color: "bg-amber-50 text-amber-700",   dot: "bg-amber-500"  },
  { key: "joined",         label: "Joined",           color: "bg-green-50 text-green-700",   dot: "bg-green-500"  },
  { key: "declined",       label: "Declined",         color: "bg-red-50 text-red-700",       dot: "bg-red-400"    },
]

const NEXT_STATUS: Record<string, string | null> = {
  prospect:       "contacted",
  contacted:      "interviewing",
  interviewing:   "offer_extended",
  offer_extended: "joined",
  joined:         null,
  declined:       null,
}

const ALL_STATUSES = STATUS_COLUMNS.map(c => c.key).filter(k => k !== "joined" && k !== "declined")

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 9999
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
}

function fmtVolume(v: number | null) {
  if (!v) return "—"
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`
  return `$${v}`
}

// ── Provision Modal ──────────────────────────────────────────────────────────
function ProvisionModal({
  recruit, onClose, onProvision,
}: {
  recruit: Recruit
  onClose: () => void
  onProvision: () => Promise<void>
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const handle = async () => {
    setLoading(true)
    setError(null)
    try {
      await onProvision()
      setDone(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600">
          <X className="h-4 w-4" />
        </button>
        {done ? (
          <div className="text-center py-4">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-3" />
            <h3 className="font-semibold text-lg text-slate-900">Agent Provisioned</h3>
            <p className="text-sm text-slate-500 mt-1">
              An invitation has been sent to <strong>{recruit.email}</strong>. They will appear in
              Agents once they complete onboarding.
            </p>
            <button onClick={onClose} className="mt-4 px-4 py-2 bg-slate-900 text-white text-sm rounded-lg">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-semibold text-sm">
                {recruit.first_name[0]}{recruit.last_name[0]}
              </div>
              <div>
                <h3 className="font-semibold text-slate-900">{recruit.first_name} {recruit.last_name}</h3>
                <p className="text-sm text-slate-500">{recruit.email}</p>
              </div>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              This will send an auth invite to <strong>{recruit.email}</strong>, create an agent record,
              and start onboarding. This action cannot be undone.
            </p>
            {recruit.current_brokerage && (
              <div className="flex items-center gap-2 text-sm text-slate-500 mb-4">
                <Building2 className="h-4 w-4" />
                Currently at: <span className="font-medium text-slate-700">{recruit.current_brokerage}</span>
              </div>
            )}
            {error && (
              <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</div>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button
                onClick={handle}
                disabled={loading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg flex items-center gap-2 hover:bg-blue-700 disabled:opacity-60"
              >
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Provision as Agent
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Recruit Card ─────────────────────────────────────────────────────────────
function RecruitCard({
  recruit,
  onAdvance,
  onProvision,
  onMoveTo,
  isLoading,
}: {
  recruit: Recruit
  onAdvance: (id: string, to: string) => void
  onProvision: (recruit: Recruit) => void
  onMoveTo: (id: string, to: string) => void
  isLoading: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const daysSinceContact = daysSince(recruit.last_contact_date)
  const isStale = daysSinceContact > 7

  const nextStatus = NEXT_STATUS[recruit.status]
  const col = STATUS_COLUMNS.find(c => c.key === recruit.status)

  return (
    <div className={`bg-white border rounded-lg p-3 shadow-sm transition-shadow hover:shadow-md ${isStale && !["joined","declined"].includes(recruit.status) ? "border-amber-200" : "border-slate-200"}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-8 w-8 rounded-full bg-slate-100 flex-shrink-0 flex items-center justify-center text-slate-600 font-semibold text-xs">
            {recruit.first_name[0]}{recruit.last_name[0]}
          </div>
          <div className="min-w-0">
            <p className="font-medium text-sm text-slate-900 truncate">
              {recruit.first_name} {recruit.last_name}
            </p>
            {recruit.current_brokerage && (
              <p className="text-xs text-slate-500 truncate">{recruit.current_brokerage}</p>
            )}
          </div>
        </div>
        {isStale && !["joined","declined"].includes(recruit.status) && (
          <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
        {recruit.years_experience != null && (
          <span className="flex items-center gap-1"><Award className="h-3 w-3" />{recruit.years_experience}yr</span>
        )}
        {recruit.annual_volume != null && (
          <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" />{fmtVolume(recruit.annual_volume)}</span>
        )}
        {recruit.license_state && (
          <span className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-600 font-medium">{recruit.license_state}</span>
        )}
      </div>

      {/* Last contact */}
      <div className={`flex items-center gap-1 mt-1.5 text-xs ${isStale && !["joined","declined"].includes(recruit.status) ? "text-amber-600" : "text-slate-400"}`}>
        <Clock className="h-3 w-3" />
        {recruit.last_contact_date
          ? `${daysSinceContact}d ago`
          : "Never contacted"
        }
      </div>

      {/* Expanded note */}
      {expanded && recruit.notes && (
        <p className="mt-2 text-xs text-slate-600 bg-slate-50 rounded px-2 py-1.5 leading-relaxed line-clamp-3">
          {recruit.notes}
        </p>
      )}

      {/* Action row */}
      <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
        {/* Contact links */}
        {recruit.email && (
          <a href={`mailto:${recruit.email}`}
            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
            title="Send email">
            <Mail className="h-3.5 w-3.5" />
          </a>
        )}
        {recruit.phone && (
          <a href={`tel:${recruit.phone}`}
            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
            title="Call">
            <Phone className="h-3.5 w-3.5" />
          </a>
        )}
        <button
          onClick={() => setExpanded(e => !e)}
          className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors"
          title="Toggle notes"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Provision (joined only) */}
        {recruit.status === "joined" && !recruit.provisioned && (
          <button
            onClick={() => onProvision(recruit)}
            disabled={isLoading}
            className="flex items-center gap-1 text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
          >
            <UserPlus className="h-3 w-3" />
            Provision
          </button>
        )}
        {recruit.status === "joined" && recruit.provisioned && (
          <span className="text-xs text-green-600 font-medium flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" /> Provisioned
          </span>
        )}

        {/* Move to any status */}
        {!["joined","declined"].includes(recruit.status) && (
          <div className="relative">
            <button
              onClick={() => setMoveOpen(o => !o)}
              disabled={isLoading}
              className="text-xs px-2 py-1 border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Move
            </button>
            {moveOpen && (
              <div className="absolute right-0 bottom-full mb-1 bg-white border border-slate-200 rounded-lg shadow-lg z-20 min-w-[140px]">
                {STATUS_COLUMNS.filter(c => c.key !== recruit.status).map(c => (
                  <button key={c.key} onClick={() => { setMoveOpen(false); onMoveTo(recruit.id, c.key) }}
                    className="w-full text-left text-xs px-3 py-2 hover:bg-slate-50 text-slate-700 flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Quick advance */}
        {nextStatus && (
          <button
            onClick={() => onAdvance(recruit.id, nextStatus)}
            disabled={isLoading}
            className="text-xs px-2 py-1 bg-slate-900 text-white rounded hover:bg-slate-700 disabled:opacity-50 flex items-center gap-1"
          >
            {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {STATUS_COLUMNS.find(c => c.key === nextStatus)?.label} →
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main Client ──────────────────────────────────────────────────────────────
export function RecruitingPipelineClient({ recruits: initialRecruits, brokerageId }: Props) {
  const router = useRouter()
  const [recruits, setRecruits] = useState<Recruit[]>(initialRecruits)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [provisionTarget, setProvisionTarget] = useState<Recruit | null>(null)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // ── Computed groups ────────────────────────────────────────────────────────
  const grouped = STATUS_COLUMNS.reduce((acc, col) => {
    acc[col.key] = recruits.filter(r => r.status === col.key)
    return acc
  }, {} as Record<string, Recruit[]>)

  const activePipeline = recruits.filter(r => !["joined", "declined"].includes(r.status))
  const joinedCount = recruits.filter(r => r.status === "joined").length
  const avgDaysToClose = (() => {
    const closed = recruits.filter(r => r.status === "joined" && r.last_contact_date)
    if (!closed.length) return null
    const avg = closed.reduce((s, r) => s + daysSince(r.created_at), 0) / closed.length
    return Math.round(avg)
  })()

  const staleProspects = recruits.filter(r =>
    r.status === "prospect" && daysSince(r.last_contact_date) > 7
  )
  const stalePipeline = recruits.filter(r =>
    ["contacted", "interviewing"].includes(r.status) && daysSince(r.last_contact_date) > 14
  )
  const readyToProvision = recruits.filter(r => r.status === "joined" && !r.provisioned)

  const needsAttention = [...new Map([...staleProspects, ...stalePipeline, ...readyToProvision]
    .map(r => [r.id, r])).values()]

  // ── Handlers ───────────────────────────────────────────────────────────────
  const advanceStage = useCallback(async (recruitId: string, toStatus: string) => {
    setLoadingId(recruitId)
    setError(null)
    try {
      const res = await fetch("/api/recruiting/advance-stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recruitId, toStatus }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? "Failed to update")
      }
      setRecruits(prev => prev.map(r => r.id === recruitId
        ? { ...r, status: toStatus, last_contact_date: new Date().toISOString() }
        : r
      ))
      startTransition(() => router.refresh())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingId(null)
    }
  }, [router])

  const provisionAgent = useCallback(async (recruit: Recruit) => {
    const res = await fetch("/api/recruiting/provision-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recruitId: recruit.id }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? "Failed to provision")
    setRecruits(prev => prev.map(r => r.id === recruit.id
      ? { ...r, provisioned: true }
      : r
    ))
    startTransition(() => router.refresh())
  }, [router])

  // ── Stats strip ────────────────────────────────────────────────────────────
  const topSource = (() => {
    const counts: Record<string, number> = {}
    recruits.forEach(r => { if (r.contact_method) counts[r.contact_method] = (counts[r.contact_method] ?? 0) + 1 })
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    return sorted[0]?.[0] ?? null
  })()

  return (
    <div className="flex flex-col gap-6">
      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { icon: Users,       label: "Active Pipeline",    value: activePipeline.length,      sub: "in-progress recruits" },
          { icon: CheckCircle2,label: "Joined",             value: joinedCount,                sub: "this year" },
          { icon: TrendingUp,  label: "Avg Days to Close",  value: avgDaysToClose ?? "—",      sub: "created → joined" },
          { icon: Calendar,    label: "Top Contact Method", value: topSource ?? "—",           sub: "most common" },
        ].map(({ icon: Icon, label, value, sub }) => (
          <div key={label} className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
              <Icon className="h-3.5 w-3.5" />
              {label}
            </div>
            <p className="text-2xl font-bold text-slate-900">{value}</p>
            <p className="text-xs text-slate-400">{sub}</p>
          </div>
        ))}
      </div>

      {/* Needs Attention */}
      {needsAttention.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3 text-amber-800 font-semibold text-sm">
            <AlertTriangle className="h-4 w-4" />
            Needs Attention ({needsAttention.length})
          </div>
          <div className="flex flex-col gap-2">
            {needsAttention.map(r => {
              const isProvision = r.status === "joined" && !r.provisioned
              const days = daysSince(r.last_contact_date)
              return (
                <div key={r.id} className="flex items-center justify-between gap-3 bg-white border border-amber-100 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="h-7 w-7 rounded-full bg-amber-100 flex-shrink-0 flex items-center justify-center text-amber-700 font-semibold text-xs">
                      {r.first_name[0]}{r.last_name[0]}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{r.first_name} {r.last_name}</p>
                      <p className="text-xs text-amber-700">
                        {isProvision
                          ? "Joined — ready to provision"
                          : `No contact in ${days === 9999 ? "unknown" : days + "d"}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {isProvision ? (
                      <button
                        onClick={() => setProvisionTarget(r)}
                        className="text-xs px-2.5 py-1 bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1"
                      >
                        <UserPlus className="h-3 w-3" /> Provision
                      </button>
                    ) : (
                      <button
                        onClick={() => advanceStage(r.id, NEXT_STATUS[r.status] ?? r.status)}
                        disabled={loadingId === r.id || !NEXT_STATUS[r.status]}
                        className="text-xs px-2.5 py-1 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 flex items-center gap-1"
                      >
                        {loadingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        Log Touch
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 flex items-center justify-between">
          {error}
          <button onClick={() => setError(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Kanban columns — horizontal scroll on mobile */}
      <div className="overflow-x-auto pb-4">
        <div className="flex gap-4 min-w-max">
          {STATUS_COLUMNS.map(col => {
            const cards = grouped[col.key] ?? []
            return (
              <div key={col.key} className="w-72 flex-shrink-0 flex flex-col gap-3">
                {/* Column header */}
                <div className={`flex items-center justify-between px-3 py-2 rounded-lg ${col.color}`}>
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <span className={`h-2 w-2 rounded-full ${col.dot}`} />
                    {col.label}
                  </div>
                  <span className="text-xs font-bold bg-white/60 rounded-full px-1.5 py-0.5">{cards.length}</span>
                </div>
                {/* Cards */}
                <div className="flex flex-col gap-2">
                  {cards.length === 0 && (
                    <div className="border-2 border-dashed border-slate-200 rounded-lg py-6 text-center text-xs text-slate-400">
                      No recruits
                    </div>
                  )}
                  {cards.map(r => (
                    <RecruitCard
                      key={r.id}
                      recruit={r}
                      onAdvance={advanceStage}
                      onProvision={setProvisionTarget}
                      onMoveTo={advanceStage}
                      isLoading={loadingId === r.id}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Provision modal */}
      {provisionTarget && (
        <ProvisionModal
          recruit={provisionTarget}
          onClose={() => setProvisionTarget(null)}
          onProvision={() => provisionAgent(provisionTarget)}
        />
      )}
    </div>
  )
}
