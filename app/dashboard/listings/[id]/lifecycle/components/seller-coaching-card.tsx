"use client"

import { useEffect, useRef, useState } from "react"
import { getListingCoaching, dismissCoachingCard } from "@/app/actions/seller-coaching"
import type { SellerCoachingContent, SellerPersona } from "@/lib/seller-coaching"
import { Badge }   from "@/components/ui/badge"
import { Button }  from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import {
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Target,
  CheckCircle2,
  AlertTriangle,
  X,
} from "lucide-react"

// ── Persona badge colours ────────────────────────────────────────────────────
const PERSONA_STYLES: Record<string, string> = {
  motivated:  "bg-green-100  text-green-800  border-green-300",
  skeptical:  "bg-orange-100 text-orange-800 border-orange-300",
  emotional:  "bg-purple-100 text-purple-800 border-purple-300",
  investor:   "bg-blue-100   text-blue-800   border-blue-300",
  indecisive: "bg-yellow-100 text-yellow-800 border-yellow-300",
  analytical: "bg-slate-100  text-slate-700  border-slate-300",
}

function PersonaBadge({ persona }: { persona: SellerPersona }) {
  const label  = persona ? persona.charAt(0).toUpperCase() + persona.slice(1) : "Unknown Persona"
  const styles = persona ? (PERSONA_STYLES[persona] ?? "") : "bg-gray-100 text-gray-600 border-gray-300"
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", styles)}>
      {label}
    </span>
  )
}

// ── Card skeleton ────────────────────────────────────────────────────────────
function CoachingCardSkeleton() {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-5 space-y-3">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-16 w-full" />
      <div className="space-y-2">
        {[1,2,3,4].map(i => <Skeleton key={i} className="h-3 w-full" />)}
      </div>
    </div>
  )
}

// ── Objections section (collapsible) ─────────────────────────────────────────
function ObjectionsSection({
  objections,
}: {
  objections: { objection: string; response: string }[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-border pt-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
      >
        COMMON OBJECTIONS
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {objections.map((o, i) => (
            <div key={i} className="rounded-md bg-muted/40 p-3">
              <p className="text-sm font-medium text-foreground before:content-['▸_'] text-[13px]">
                &ldquo;{o.objection}&rdquo;
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Response: </span>
                {o.response}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main card ─────────────────────────────────────────────────────────────────
interface SellerCoachingCardProps {
  listingId:    string
  listingStage: string
  agentUserId?: string
}

export function SellerCoachingCard({ listingId, listingStage, agentUserId }: SellerCoachingCardProps) {
  const [coaching,   setCoaching]   = useState<SellerCoachingContent | null>(null)
  const [persona,    setPersona]    = useState<SellerPersona>(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(false)
  const [collapsed,  setCollapsed]  = useState(false)
  const [dismissed,  setDismissed]  = useState(false)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      const result = await getListingCoaching(listingId)
      if (result.success && result.coaching) {
        setCoaching(result.coaching)
        setPersona(result.persona ?? null)
      } else {
        setError(true)
        // Auto-retry after 30 s
        retryRef.current = setTimeout(() => load(), 30_000)
      }
    } catch {
      setError(true)
      retryRef.current = setTimeout(() => load(), 30_000)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current)
    }
  }, [listingId, listingStage]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDismiss = async () => {
    setDismissed(true)
    if (agentUserId) {
      await dismissCoachingCard(listingId, agentUserId).catch(() => {})
    }
  }

  if (dismissed) return null
  if (loading)   return <CoachingCardSkeleton />

  if (error) {
    return (
      <div className="mb-4 rounded-xl border border-border bg-card px-5 py-4">
        <p className="text-sm text-muted-foreground">
          Coaching content is being prepared — check back in a moment.
        </p>
      </div>
    )
  }

  if (!coaching) return null

  // Collapsed view
  if (collapsed) {
    return (
      <div className="mb-4 flex items-center justify-between rounded-xl border border-border bg-card px-5 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Target className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="text-sm font-medium text-foreground truncate">{coaching.coaching_headline}</span>
        </div>
        <button
          onClick={() => setCollapsed(false)}
          className="ml-3 flex-shrink-0 text-xs text-primary underline underline-offset-2 hover:no-underline"
        >
          Expand coaching
        </button>
      </div>
    )
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="flex items-start gap-2 min-w-0">
          <Target className="h-4 w-4 flex-shrink-0 mt-0.5 text-primary" />
          <h3 className="text-sm font-semibold text-foreground leading-snug">
            {coaching.coaching_headline}
          </h3>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setCollapsed(true)}
            className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Collapse"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            onClick={handleDismiss}
            className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Persona + Stage meta */}
      <div className="flex items-center gap-2 px-5 pb-3">
        <PersonaBadge persona={persona} />
        <span className="text-xs text-muted-foreground">
          Stage: <span className="text-foreground font-medium">{listingStage.replace(/_/g, " ")}</span>
          {coaching.estimated_stage_duration && (
            <> &middot; Typically <span className="text-foreground font-medium">{coaching.estimated_stage_duration}</span></>
          )}
        </span>
      </div>

      <div className="px-5 pb-5 space-y-4">
        {/* Coaching body */}
        <p className="text-sm text-muted-foreground leading-relaxed">{coaching.coaching_body}</p>

        {/* Talking points */}
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Talking Points
          </p>
          <ul className="space-y-1">
            {coaching.suggested_talking_points.map((pt, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                {pt}
              </li>
            ))}
          </ul>
        </div>

        {/* Objections */}
        <ObjectionsSection objections={coaching.common_objections} />

        {/* Success + Risk signals */}
        <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Success Signals
            </p>
            <ul className="space-y-1">
              {coaching.success_signals.map((s, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-green-600" />
                  {s}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Watch For
            </p>
            <ul className="space-y-1">
              {coaching.risk_signals.map((r, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-foreground">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-500" />
                  {r}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Next action footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">
              Next Action
            </p>
            <p className="text-sm text-foreground">{coaching.next_action_prompt}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="flex-shrink-0 gap-1"
            onClick={() => setCollapsed(true)}
          >
            Got it
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
