"use client"

import { useState, useTransition } from "react"
import { Badge }   from "@/components/ui/badge"
import { Button }  from "@/components/ui/button"
import { cn }      from "@/lib/utils"
import { ChevronRight, Loader2 } from "lucide-react"
import { agentAdvanceBuyer } from "@/app/actions/buyer-execution"
import { toast } from "sonner"

const BUYER_STAGES = [
  { key: "BUYER_CONTACT_CREATED",      label: "Contact Created",       milestone: false },
  { key: "BUYER_FINANCIALLY_VERIFIED", label: "Financially Verified",  milestone: true  },
  { key: "BUYER_SEARCH_CONFIGURED",    label: "Search Configured",     milestone: false },
  { key: "BUYER_SEARCHING",            label: "Searching",             milestone: false },
  { key: "BUYER_TOUR_ELIGIBLE",        label: "Tour Eligible",         milestone: false },
  { key: "BUYER_TOURING",              label: "Touring",               milestone: false },
  { key: "BUYER_OFFER_ELIGIBLE",       label: "Offer Eligible",        milestone: false },
  { key: "BUYER_OFFER_SUBMITTED",      label: "Offer Submitted",       milestone: false },
  { key: "BUYER_UNDER_CONTRACT",       label: "Under Contract",        milestone: true  },
  { key: "BUYER_ON_HOLD",              label: "On Hold",               milestone: false },
  { key: "BUYER_DISENGAGED",           label: "Disengaged",            milestone: false },
  { key: "BUYER_CLOSED",               label: "Closed",                milestone: true  },
  { key: "BUYER_LIFETIME",             label: "Lifetime Customer",     milestone: false },
] as const

type BuyerStageKey = typeof BUYER_STAGES[number]["key"]

interface BuyerStageProgressProps {
  currentStage:  string | null
  blockers?:     string[]
  contactId?:    string
  agentId?:      string
  onAdvanced?:   (newStage: string) => void
}

export function BuyerStageProgress({ currentStage, blockers, contactId, agentId, onAdvanced }: BuyerStageProgressProps) {
  const [confirmStage, setConfirmStage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const currentIdx = BUYER_STAGES.findIndex(s => s.key === currentStage)
  const displayIdx = currentIdx === -1 ? 0 : currentIdx
  const pct        = Math.round(((displayIdx + 1) / BUYER_STAGES.length) * 100)
  const nextStage  = BUYER_STAGES[displayIdx + 1] ?? null

  const handleAdvance = (targetStage: string) => {
    if (!contactId || !agentId) return
    setConfirmStage(null)
    startTransition(async () => {
      const result = await agentAdvanceBuyer({ contactId, agentId, targetState: targetStage })
      if ((result as any).success === false) {
        toast.error((result as any).error ?? "Failed to advance stage")
      } else {
        toast.success(`Buyer advanced to ${BUYER_STAGES.find(s => s.key === targetStage)?.label ?? targetStage}`)
        onAdvanced?.(targetStage)
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Progress header */}
      <div className="px-4 pt-4 pb-2 border-b border-border">
        <p className="text-xs font-medium text-muted-foreground">
          Stage {displayIdx + 1} of {BUYER_STAGES.length} &middot; {pct}% complete
        </p>
        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Stage list */}
      <ol className="flex flex-col gap-0.5 px-2 pb-2">
        {BUYER_STAGES.map((stage, idx) => {
          const isCompleted = idx < displayIdx
          const isCurrent   = idx === displayIdx
          const isFuture    = idx > displayIdx

          return (
            <li
              key={stage.key}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                isCurrent && "bg-primary/8 font-medium",
                isFuture  && "text-muted-foreground",
              )}
            >
              {/* State dot */}
              <span
                className={cn(
                  "flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full text-xs",
                  isCompleted && "bg-primary text-primary-foreground",
                  isCurrent   && "bg-primary text-primary-foreground ring-2 ring-primary/30",
                  isFuture    && "border-2 border-muted-foreground/30 text-transparent",
                )}
              >
                {isCompleted && (
                  <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
                {isCurrent && <span className="w-2 h-2 rounded-full bg-primary-foreground" />}
              </span>

              <span className="flex-1 leading-tight">{stage.label}</span>

              {/* Milestone star */}
              {stage.milestone && (
                <svg viewBox="0 0 16 16" className="w-3 h-3 flex-shrink-0 text-amber-500" fill="currentColor">
                  <path d="M8 1l1.8 3.6 4 .6-2.9 2.8.7 4L8 10l-3.6 1.9.7-4L2.2 5.2l4-.6z"/>
                </svg>
              )}
            </li>
          )
        })}
      </ol>

      {/* Advance stage */}
      {nextStage && contactId && agentId && (
        <div className="mx-2 mb-2">
          {confirmStage === nextStage.key ? (
            <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 space-y-2">
              <p className="text-xs text-foreground">Advance to <strong>{nextStage.label}</strong>?</p>
              <div className="flex gap-2">
                <Button size="sm" className="h-6 text-xs" onClick={() => handleAdvance(nextStage.key)} disabled={isPending}>
                  {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setConfirmStage(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmStage(nextStage.key)}
              disabled={isPending}
              className="w-full flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary hover:bg-primary/10 transition-colors"
            >
              <span>Advance to {nextStage.label}</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Blockers banner */}
      {blockers && blockers.length > 0 && (
        <div className="mx-2 mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-xs font-medium text-destructive mb-1">Blockers</p>
          <ul className="space-y-0.5">
            {blockers.map((b, i) => (
              <li key={i} className="text-xs text-destructive/80">{b}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
