"use client"

import { useState, useTransition } from "react"
import { Check, Star, ChevronRight, Loader2, Eye, EyeOff } from "lucide-react"
import { cn } from "@/lib/utils"
import type { StageDefinition, ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"
import { advanceListingStage, setMilestonePortalVisibility } from "@/app/actions/listing-lifecycle"
import { StageAdvanceModal } from "./stage-advance-modal"

const MILESTONE_STAGES = new Set([
  "LISTING_AGREEMENT_SIGNED",
  "MLS_ACTIVE",
  "UNDER_CONTRACT",
  "CLOSED",
  "LIFETIME_CUSTOMER",
])

interface LifecycleEvent {
  id: string
  event_type: string
  metadata: Record<string, any> | null
  actor_user_id: string | null
  created_at: string
}

interface Props {
  listingId: string
  currentStage: ListingStage
  completedStages: Set<string>
  validNextStages: string[]
  allStages: StageDefinition[]
  enabledGates: string[]
  lifecycleEvents: LifecycleEvent[]
  canOverride: boolean
  userId: string
  brokerageId: string
}

export function StagePipeline({
  listingId,
  currentStage,
  completedStages,
  validNextStages,
  allStages,
  enabledGates,
  lifecycleEvents,
  canOverride,
  userId,
  brokerageId,
}: Props) {
  const [selectedStage, setSelectedStage] = useState<StageDefinition | null>(null)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Portal visibility state per milestone stage
  // Derived from the most recent lifecycle event for each milestone stage
  const [portalVisibility, setPortalVisibility] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {}
    for (const stage of MILESTONE_STAGES) {
      const events = lifecycleEvents
        .filter(e => e.metadata?.to_state === stage)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      if (events.length > 0) {
        map[stage] = events[0].metadata?.portal_visible === true
      }
    }
    return map
  })
  const [togglingStage, setTogglingStage] = useState<string | null>(null)

  async function handlePortalToggle(stage: string) {
    const newVisible = !portalVisibility[stage]
    setTogglingStage(stage)
    const result = await setMilestonePortalVisibility(listingId, stage, newVisible)
    if (result.success) {
      setPortalVisibility((prev: Record<string, boolean>) => ({ ...prev, [stage]: newVisible }))
    }
    setTogglingStage(null)
  }

  function handleStageClick(stage: StageDefinition) {
    if (!validNextStages.includes(stage.stage)) return
    setSelectedStage(stage)
    setError(null)
  }

  function handleConfirm(notes: string, isOverride: boolean, overrideReason: string) {
    if (!selectedStage) return
    setError(null)
    startTransition(async () => {
      try {
        // When override toggled on, pass the reason through. The server
        // action validates the user_type via requireOverrideActor and writes
        // a 'listing.stage_overridden' lifecycle_event audit row.
        await advanceListingStage(
          listingId,
          selectedStage.stage,
          userId,
          notes || undefined,
          isOverride && overrideReason ? overrideReason : undefined,
        )
        setSelectedStage(null)
        // Page will revalidate via server action
      } catch (e: any) {
        setError(e?.message ?? "Failed to advance stage")
      }
    })
  }

  // Build a map of stage → transition events for history rows
  const stageHistoryMap: Record<string, LifecycleEvent[]> = {}
  for (const evt of lifecycleEvents) {
    const toState = evt.metadata?.to_state as string | undefined
    if (toState) {
      if (!stageHistoryMap[toState]) stageHistoryMap[toState] = []
      stageHistoryMap[toState].push(evt)
    }
  }

  return (
    <>
      <div className="p-4 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">Stage Pipeline</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{allStages.length} stages</p>
      </div>

      {error && (
        <div className="mx-3 mt-3 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <ol className="p-3 space-y-1">
        {allStages.map((stage) => {
          const isCompleted = completedStages.has(stage.stage)
          const isCurrent = stage.stage === currentStage
          const isValidNext = validNextStages.includes(stage.stage)
          const isMilestone = MILESTONE_STAGES.has(stage.stage)
          const historyEvents = stageHistoryMap[stage.stage] ?? []

          return (
            <li key={stage.stage}>
              {/* Stage row */}
              <button
                type="button"
                disabled={!isValidNext || isPending}
                onClick={() => handleStageClick(stage)}
                className={cn(
                  "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors text-xs",
                  isCurrent && "bg-blue-50 text-blue-900 ring-1 ring-blue-200",
                  isCompleted && !isCurrent && "text-muted-foreground",
                  isValidNext && !isCurrent && "hover:bg-amber-50 cursor-pointer text-amber-900",
                  !isCompleted && !isCurrent && !isValidNext && "text-muted-foreground/50 cursor-default",
                )}
              >
                {/* Status dot */}
                <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                  {isCompleted ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : isCurrent ? (
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
                  ) : isValidNext ? (
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/20" />
                  )}
                </span>

                {/* Label */}
                <span className="flex-1 font-medium leading-tight">{stage.label}</span>

                {/* Milestone badge */}
                {isMilestone && (
                  <Star className="w-3 h-3 text-amber-500 flex-shrink-0 fill-amber-400" />
                )}

                {/* Arrow for valid next */}
                {isValidNext && (
                  <ChevronRight className="w-3 h-3 flex-shrink-0 text-amber-500" />
                )}

                {isPending && isValidNext && (
                  <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                )}
              </button>

              {/* Portal visibility toggle for completed milestones */}
              {isMilestone && isCompleted && (
                <div className="ml-7 mt-0.5 mb-1">
                  <button
                    type="button"
                    disabled={togglingStage === stage.stage}
                    onClick={() => handlePortalToggle(stage.stage)}
                    className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border transition-colors",
                      portalVisibility[stage.stage]
                        ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                        : "bg-muted text-muted-foreground border-border hover:bg-muted/70"
                    )}
                    title={portalVisibility[stage.stage] ? "Hide from client portal" : "Share with client portal"}
                  >
                    {togglingStage === stage.stage ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    ) : portalVisibility[stage.stage] ? (
                      <Eye className="w-2.5 h-2.5" />
                    ) : (
                      <EyeOff className="w-2.5 h-2.5" />
                    )}
                    {portalVisibility[stage.stage] ? "Shared with client" : "Share with client"}
                  </button>
                </div>
              )}

              {/* Stage history rows */}
              {historyEvents.map((evt) => {
                const isOverride = evt.metadata?.is_override === true
                const isFailed = evt.event_type?.includes("FAILED")
                const from = evt.metadata?.from_state as string | undefined
                const enteredAt = new Date(evt.created_at)
                let duration: string | null = null
                const laterIdx = lifecycleEvents.findIndex(
                  (e) => e.metadata?.from_state === stage.stage && new Date(e.created_at) > enteredAt
                )
                if (laterIdx !== -1) {
                  const ms = new Date(lifecycleEvents[laterIdx].created_at).getTime() - enteredAt.getTime()
                  const days = Math.floor(ms / 86400000)
                  duration = days === 0 ? "< 1 day" : `${days}d`
                }

                return (
                  <div
                    key={evt.id}
                    className="ml-7 mt-0.5 mb-1 px-2 py-1 rounded bg-muted/40 text-xs flex items-center gap-1.5"
                  >
                    {from && (
                      <span className="text-muted-foreground truncate">from {from.replace(/_/g, " ").toLowerCase()}</span>
                    )}
                    {duration && (
                      <span className="text-muted-foreground">· {duration}</span>
                    )}
                    {isOverride && (
                      <span className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800">
                        OVERRIDE
                      </span>
                    )}
                    {isFailed && (
                      <span className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-destructive/10 text-destructive">
                        FAILED
                      </span>
                    )}
                  </div>
                )
              })}

              {/* System gate chips */}
              {stage.enablesSystemGates?.map((gate) => (
                <div
                  key={gate}
                  className={cn(
                    "ml-7 mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium mr-1",
                    completedStages.has(stage.stage) || isCurrent
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : "bg-muted text-muted-foreground border border-border"
                  )}
                >
                  {gate.replace(/_/g, " ")} unlocked
                </div>
              ))}
            </li>
          )
        })}
      </ol>

      {/* Stage advance modal */}
      {selectedStage && (
        <StageAdvanceModal
          stage={selectedStage}
          listingId={listingId}
          canOverride={canOverride}
          isPending={isPending}
          onConfirm={handleConfirm}
          onClose={() => setSelectedStage(null)}
        />
      )}
    </>
  )
}
