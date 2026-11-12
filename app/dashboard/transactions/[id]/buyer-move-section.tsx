"use client"

// app/dashboard/transactions/[id]/buyer-move-section.tsx
//
// BUYER MOVE SERVICES — the post-contract move-in concierge on the deal detail page (Deal Coordinator).
// Renders the dated move-in checklist (essentials → admin → optional), the current move-in friction,
// and the service-mode recommendation (guided-DIY in-app vs a Utility Connect handoff). The buyer/agent
// checks off each utility as it's set up; friction + the recommendation recompute live. The handoff
// EXECUTION is feature-flagged off until Utility Connect creds exist — until then choosing "handle it
// for me" records the preference and the agent coordinates manually (no external lead is pushed).
//
// Auto-created when a buyer-side deal enters CLOSING_PREP; for deals already in/near closing a one-click
// "Set up move-in concierge" bootstraps the case.

import { useEffect, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/hooks/use-toast"
import { Truck, Loader2, Sparkles } from "lucide-react"
import {
  ensureBuyerMoveCaseAction,
  getBuyerMoveCaseAction,
  updateMoveTaskAction,
  setServiceModeAction,
} from "@/app/actions/buyer-move"
import type { BuyerMoveCase, MoveTask, MoveTaskType, MoveTaskGroup } from "@/lib/transactions/buyer-move"

const GROUP_LABEL: Record<MoveTaskGroup, string> = {
  essential: "Essentials",
  admin: "Paperwork",
  optional: "Nice to have",
}
const GROUP_ORDER: MoveTaskGroup[] = ["essential", "admin", "optional"]

function frictionBadge(score: number): { label: string; className: string } {
  if (score >= 0.6) return { label: `High friction (${score.toFixed(2)})`, className: "bg-red-100 text-red-800 border-red-200" }
  if (score >= 0.3) return { label: `Some friction (${score.toFixed(2)})`, className: "bg-amber-100 text-amber-800 border-amber-200" }
  return { label: "On track", className: "bg-emerald-50 text-emerald-700 border-emerald-200" }
}

export function BuyerMoveSection({
  transactionId,
  brokerageId,
  initialCase,
  canBootstrap,
  utilityConnectEnabled,
}: {
  transactionId: string
  brokerageId: string
  initialCase: BuyerMoveCase | null
  /** True for a buyer-side deal at/after CLOSING_PREP with no case yet — shows the bootstrap button. */
  canBootstrap: boolean
  utilityConnectEnabled: boolean
}) {
  const { toast } = useToast()
  const [moveCase, setMoveCase] = useState<BuyerMoveCase | null>(initialCase)
  const [pending, startTransition] = useTransition()
  const [busyTask, setBusyTask] = useState<MoveTaskType | null>(null)
  /**
   * The LIVE service-mode recommendation from
   * `app/actions/buyer-move.ts:getBuyerMoveCaseAction`, which had no caller.
   *
   * The banner below used the STORED `moveCase.recommended_mode`, which is only
   * recomputed when someone toggles a task. `decideBuyerMode` also weighs
   * `daysToClose`, and that changes every day with no user action — so a deal
   * drifting into "essential utilities still unset with closing approaching" never
   * raised the banner unless the agent happened to tick something off. The action
   * recomputes it server-side on load; the stored value remains the fallback.
   */
  const [liveRecommendedMode, setLiveRecommendedMode] = useState<string | null>(null)

  useEffect(() => {
    if (!moveCase) return
    let cancelled = false
    void getBuyerMoveCaseAction({ transactionId, brokerageId }).then((r) => {
      if (cancelled) return
      if (r.success && r.case) {
        setMoveCase(r.case)
        setLiveRecommendedMode(r.recommendation?.recommended_mode ?? null)
      }
    })
    return () => {
      cancelled = true
    }
    // Deliberately keyed on the identifiers only — this is a load-time refresh, not
    // a loop that re-fires on every local case update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId, brokerageId])

  if (!moveCase && !canBootstrap) return null

  function bootstrap() {
    startTransition(async () => {
      const r = await ensureBuyerMoveCaseAction({ transactionId, brokerageId })
      if (r.success && r.case) { setMoveCase(r.case); toast({ title: "Move-in concierge ready", description: "The buyer's move-in checklist is set up." }) }
      else toast({ title: "Couldn't set up the move case", description: r.error, variant: "destructive" })
    })
  }

  function toggleTask(t: MoveTask) {
    const nextStatus = t.status === "done" ? "pending" : "done"
    setBusyTask(t.type)
    startTransition(async () => {
      const r = await updateMoveTaskAction({ transactionId, brokerageId, taskType: t.type, status: nextStatus })
      setBusyTask(null)
      if (r.success && r.case) setMoveCase(r.case)
      else toast({ title: "Couldn't update the task", description: r.error, variant: "destructive" })
    })
  }

  function chooseHandoff() {
    startTransition(async () => {
      const r = await setServiceModeAction({ transactionId, brokerageId, mode: "handoff" })
      if (r.success && r.case) {
        setMoveCase(r.case)
        toast({
          title: r.handoffPending ? "Handoff preference saved" : "Handoff started",
          description: r.handoffPending
            ? "Utility Connect isn't live yet — coordinate the setup with the buyer; we'll push it automatically once the partner is connected."
            : "The utility setup is being handed to our concierge partner.",
        })
      } else toast({ title: "Couldn't switch modes", description: r.error, variant: "destructive" })
    })
  }

  if (!moveCase) {
    return (
      <section className="border-b bg-background px-4 py-3 sm:px-6" data-testid="buyer-move">
        <div className="flex flex-wrap items-center gap-2">
          <Truck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Buyer Move Services</h2>
          <Button size="sm" variant="outline" className="ml-auto" onClick={bootstrap} disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Set up move-in concierge
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Stand up the buyer's move-in checklist — utilities, address change, movers — with in-app guidance.</p>
      </section>
    )
  }

  const badge = frictionBadge(moveCase.friction_score)
  const openEssentials = moveCase.tasks.filter((t) => t.group === "essential" && t.status !== "done" && t.status !== "skipped").length
  // Live recommendation wins when we have one; the stored column is the fallback.
  const recommendHandoff = (liveRecommendedMode ?? moveCase.recommended_mode) === "handoff"

  return (
    <section className="border-b bg-background px-4 py-3 sm:px-6" data-testid="buyer-move">
      <div className="flex flex-wrap items-center gap-2">
        <Truck className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Buyer Move Services</h2>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
        {moveCase.case_status === "completed" && (
          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 border-emerald-200">Move-in ready</span>
        )}
      </div>

      {recommendHandoff && moveCase.case_status !== "completed" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <Sparkles className="h-3.5 w-3.5" />
          <span>
            {openEssentials > 0
              ? `${openEssentials} essential utilit${openEssentials === 1 ? "y is" : "ies are"} still unset with closing approaching.`
              : "Move-in friction is high."}{" "}
            Offer to hand the setup to our concierge partner.
          </span>
          {moveCase.service_mode !== "handoff" && (
            <Button size="sm" variant="outline" className="ml-auto h-7" onClick={chooseHandoff} disabled={pending}>
              {pending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Handle it for the buyer
            </Button>
          )}
        </div>
      )}
      {moveCase.service_mode === "handoff" && !utilityConnectEnabled && (
        <p className="mt-2 text-xs text-muted-foreground">Handoff preferred — Utility Connect isn't connected yet, so coordinate the setup manually for now.</p>
      )}

      <div className="mt-3 space-y-3">
        {GROUP_ORDER.map((group) => {
          const groupTasks = moveCase.tasks.filter((t) => t.group === group)
          if (groupTasks.length === 0) return null
          return (
            <div key={group}>
              <div className="text-xs font-medium text-muted-foreground">{GROUP_LABEL[group]}</div>
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                {groupTasks.map((t) => {
                  const done = t.status === "done"
                  return (
                    <label key={t.type} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50 cursor-pointer">
                      <Checkbox checked={done} disabled={pending && busyTask === t.type} onCheckedChange={() => toggleTask(t)} className="mt-0.5" />
                      <span className="min-w-0">
                        <span className={`font-medium ${done ? "line-through text-muted-foreground" : ""}`}>{t.label}</span>
                        {t.dueDate && <span className="ml-1 text-xs text-muted-foreground">· by {t.dueDate}</span>}
                        <span className="block text-xs text-muted-foreground">{t.description}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
