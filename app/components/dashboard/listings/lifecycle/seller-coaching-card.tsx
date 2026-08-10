"use client"

import { Component, type ReactNode, useEffect, useState, useRef } from "react"
import { getListingCoaching, refreshSellerCoaching, dismissCoachingCard } from "@/app/actions/seller-coaching"
import type { SellerCoachingContent, SellerPersona } from "@/lib/seller-coaching"
import { Skeleton } from "@/components/ui/skeleton"
import { Button }   from "@/components/ui/button"
import { cn }       from "@/lib/utils"
import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Target,
  AlertTriangle,
  Heart,
} from "lucide-react"

// ── Helpers ──────────────────────────────────────────────────────────────────

const PERSONA_STYLES: Record<string, string> = {
  motivated:  "bg-green-100  text-green-800  border-green-300",
  skeptical:  "bg-orange-100 text-orange-800 border-orange-300",
  emotional:  "bg-purple-100 text-purple-800 border-purple-300",
  investor:   "bg-blue-100   text-blue-800   border-blue-300",
  indecisive: "bg-yellow-100 text-yellow-800 border-yellow-300",
  analytical: "bg-slate-100  text-slate-700  border-slate-300",
  standard:   "bg-gray-100   text-gray-600   border-gray-300",
}

function stageDisplayName(stage: string): string {
  return stage.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

function timeAgo(isoString?: string): string {
  if (!isoString) return "just now"
  const diff = Date.now() - new Date(isoString).getTime()
  const mins  = Math.floor(diff / 60_000)
  if (mins < 1)   return "just now"
  if (mins < 60)  return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Error Boundary ────────────────────────────────────────────────────────────
interface EBState { hasError: boolean }
class CoachingErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { hasError: false }
  static getDerivedStateFromError(): EBState { return { hasError: true } }
  render() {
    if (this.state.hasError) return null  // fail silently — page must not break
    return this.props.children
  }
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function CoachingCardSkeleton() {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-5 space-y-4">
      {/* header */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-7 w-20 rounded-md" />
      </div>
      {/* 3-column body */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
      {/* footer */}
      <Skeleton className="h-3 w-64" />
    </div>
  )
}

// ── Main card inner ───────────────────────────────────────────────────────────
interface CardProps {
  listingId:    string
  listingStage: string
  brokerageId:  string
  agentUserId?: string
}

function SellerCoachingCardInner({ listingId, listingStage, brokerageId, agentUserId }: CardProps) {
  const [coaching,    setCoaching]    = useState<SellerCoachingContent | null>(null)
  const [persona,     setPersona]     = useState<SellerPersona>(null)
  const [generatedAt, setGeneratedAt] = useState<string | undefined>()
  const [loading,     setLoading]     = useState(true)
  const [refreshing,  setRefreshing]  = useState(false)
  const [error,       setError]       = useState(false)
  const [collapsed,   setCollapsed]   = useState(false)
  /**
   * `dismissCoachingCard` records the `coaching.dismissed` activity that tells us
   * whether this AI coaching is worth generating at all — it is the only signal of
   * "the agent didn't want this". It had no caller, so the analytics lane was empty
   * while the card's collapse control (its actual dismissal) stayed purely local.
   *
   * Fire-and-forget: the collapse must never wait on, or be blocked by, an analytics
   * write. Recorded at most once per mount so repeatedly collapsing/expanding does
   * not inflate the signal.
   */
  const dismissRecorded = useRef(false)

  function collapseCard() {
    setCollapsed(true)
    if (dismissRecorded.current) return
    dismissRecorded.current = true
    void dismissCoachingCard(listingId).catch((err) => {
      console.error("[seller-coaching] dismissal not recorded:", err)
    })
  }

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else           setLoading(true)
    setError(false)
    try {
      const result = isRefresh
        ? await refreshSellerCoaching(listingId)
        : await getListingCoaching(listingId)
      if (result.success && result.coaching) {
        setCoaching(result.coaching)
        setPersona(result.persona ?? null)
        setGeneratedAt(result.generatedAt)
      } else {
        setError(true)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { load() }, [listingId, listingStage]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <CoachingCardSkeleton />

  if (error) {
    return (
      <div className="mb-4 rounded-xl border border-border bg-card px-5 py-4 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Coaching unavailable — click Refresh to try again.
        </p>
        <Button size="sm" variant="outline" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>
    )
  }

  if (!coaching && !loading) {
    return (
      <div className="mb-4 rounded-xl border border-border bg-card px-5 py-4 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Click Refresh to generate coaching for this stage.
        </p>
        <Button size="sm" variant="outline" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>
    )
  }

  if (!coaching) return null

  const personaLabel  = persona
    ? persona.charAt(0).toUpperCase() + persona.slice(1)
    : "Standard"
  const personaStyle  = PERSONA_STYLES[persona ?? "standard"] ?? PERSONA_STYLES.standard
  const talkingPoints = coaching.suggested_talking_points ?? []
  const avoidPoints   = (coaching as any).avoid_pitfalls  ?? coaching.risk_signals ?? []
  const sellerNeeds   = (coaching as any).seller_needs_now ?? ""
  const isCached      = !!(coaching as any).id

  if (collapsed) {
    return (
      <div className="mb-4 flex items-center justify-between rounded-xl border border-border bg-card px-5 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Target className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="text-sm font-medium truncate">
            AI Coaching — {stageDisplayName(listingStage)}
          </span>
          <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium flex-shrink-0", personaStyle)}>
            {personaLabel}
          </span>
        </div>
        <button onClick={() => setCollapsed(false)} className="ml-3 flex-shrink-0 text-xs text-primary underline underline-offset-2 hover:no-underline">
          Expand
        </button>
      </div>
    )
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Target className="h-4 w-4 flex-shrink-0 text-primary" />
          <h3 className="text-sm font-semibold text-foreground truncate">
            AI Coaching — {stageDisplayName(listingStage)}
          </h3>
          <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium flex-shrink-0", personaStyle)}>
            {personaLabel}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs gap-1"
            onClick={() => load(true)}
            disabled={refreshing}
            aria-label="Refresh coaching"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            Refresh
          </Button>
          <button
            onClick={collapseCard}
            className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Collapse"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 3-column body */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-0 divide-y md:divide-y-0 md:divide-x divide-border px-5 pb-4">
        {/* Col 1 — What to Say */}
        <div className="py-3 md:py-0 md:pr-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What to Say
          </p>
          <ul className="space-y-1.5">
            {talkingPoints.map((pt: string, i: number) => (
              <li key={i} className="flex items-start gap-2 text-sm text-foreground leading-snug">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                {pt}
              </li>
            ))}
            {talkingPoints.length === 0 && (
              <li className="text-xs text-muted-foreground italic">No talking points available.</li>
            )}
          </ul>
        </div>

        {/* Col 2 — What to Avoid */}
        <div className="py-3 md:py-0 md:px-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What to Avoid
          </p>
          <ul className="space-y-1.5">
            {avoidPoints.map((pt: string, i: number) => (
              <li key={i} className="flex items-start gap-2 text-sm text-foreground leading-snug">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500" />
                {pt}
              </li>
            ))}
            {avoidPoints.length === 0 && (
              <li className="text-xs text-muted-foreground italic">No pitfalls listed.</li>
            )}
          </ul>
        </div>

        {/* Col 3 — Seller Needs Now */}
        <div className="py-3 md:py-0 md:pl-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Seller Needs Now
          </p>
          {sellerNeeds ? (
            <div className="flex items-start gap-2">
              <Heart className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-rose-400" />
              <p className="text-sm text-foreground leading-snug">{sellerNeeds}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">No empathy prompt available.</p>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-border bg-muted/30 px-5 py-2">
        <p className="text-xs text-muted-foreground">
          Generated for <span className="font-medium text-foreground">{personaLabel}</span> seller
          {isCached && <> &middot; <span>Cached</span></>}
          {generatedAt && <> &middot; Last refreshed {timeAgo(generatedAt)}</>}
        </p>
      </div>
    </div>
  )
}

// ── Public export (wrapped in error boundary) ─────────────────────────────────
export function SellerCoachingCard(props: CardProps) {
  return (
    <CoachingErrorBoundary>
      <SellerCoachingCardInner {...props} />
    </CoachingErrorBoundary>
  )
}
