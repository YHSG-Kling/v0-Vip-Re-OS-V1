"use client"

// The Actions tab, made real. The version this replaces rendered a permanent
// empty state ("Select agents from the overview to perform batch actions") over
// a `selectedAgents` array nothing ever wrote to, so both of its buttons were
// disabled forever — and its `onBatchAction` callback led to a handler whose
// body was a comment saying this panel handled it. Nothing did anything.
//
// The selection list now comes from the real onboarding roster, and the nudge
// writes real in-app notifications. "Enroll in Training" is deliberately NOT
// carried over: there was no enrolment backend behind it, and a button that
// pretends to assign coursework is worse than no button.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { toast } from "sonner"
import { AlertTriangle, Bell, Loader2, Users } from "lucide-react"
import {
  listOnboardingAgentsAction,
  nudgeOnboardingAgentsAction,
} from "@/app/actions/onboarding/onboarding-ops"
import type { OnboardingRosterRow } from "@/lib/onboarding/onboarding-roster"

interface OnboardingBatchActionsPanelProps {
  /** Preselect these agent ids on mount (the Quick Actions "stalled" jump). */
  preselectAgentIds?: string[]
}

export function OnboardingBatchActionsPanel({ preselectAgentIds }: OnboardingBatchActionsPanelProps) {
  const [agents, setAgents] = useState<OnboardingRosterRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    listOnboardingAgentsAction().then((res) => {
      if (cancelled) return
      if (res.success) {
        setAgents(res.agents)
        setError(null)
      } else {
        setError(res.error)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // Applied once the roster is in — the ids come from the same load.
  useEffect(() => {
    if (!preselectAgentIds?.length || agents.length === 0) return
    const known = new Set(agents.map((a) => a.agentId))
    setSelected(preselectAgentIds.filter((id) => known.has(id)))
  }, [preselectAgentIds, agents])

  function toggle(agentId: string) {
    setSelected((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    )
  }

  const unfinished = agents.filter((a) => a.status !== "completed")
  const allSelected = unfinished.length > 0 && selected.length === unfinished.length

  function handleNudge() {
    startTransition(async () => {
      const res = await nudgeOnboardingAgentsAction(selected)
      if (!res.success) {
        toast.error(res.error)
        return
      }
      toast.success(
        res.skipped > 0
          ? `Nudged ${res.notified} agent${res.notified === 1 ? "" : "s"} · ${res.skipped} skipped (no linked user account)`
          : `Nudged ${res.notified} agent${res.notified === 1 ? "" : "s"}`,
      )
      setSelected([])
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Batch Actions</CardTitle>
        <CardDescription>Nudge agents whose onboarding is unfinished</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground text-center py-8">Loading agents…</p>
        ) : error ? (
          <p className="text-sm text-destructive text-center py-8">{error}</p>
        ) : unfinished.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>{agents.length === 0 ? "No agents are onboarding yet." : "Every agent has finished onboarding."}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() =>
                    setSelected(allSelected ? [] : unfinished.map((a) => a.agentId))
                  }
                  aria-label="Select all unfinished agents"
                />
                Select all ({unfinished.length})
              </label>
              <span className="text-xs text-muted-foreground">{selected.length} selected</span>
            </div>

            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {unfinished.map((a) => (
                <label
                  key={a.agentId}
                  className="flex items-center gap-3 p-2 rounded-lg border bg-card cursor-pointer hover:bg-muted/40"
                >
                  <Checkbox
                    checked={selected.includes(a.agentId)}
                    onCheckedChange={() => toggle(a.agentId)}
                    aria-label={`Select ${a.agentName}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{a.agentName}</span>
                      {a.isStalled && (
                        <Badge variant="destructive" className="text-[10px] gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Stalled
                        </Badge>
                      )}
                      {!a.userId && (
                        <Badge variant="outline" className="text-[10px]">No user account</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{a.email || "—"}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <Progress value={a.percentComplete} className="h-1 flex-1" />
                      <span className="text-xs text-muted-foreground shrink-0">{a.percentComplete}%</span>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {a.daysSinceLastActivity === null ? "no activity" : `${a.daysSinceLastActivity}d idle`}
                  </span>
                </label>
              ))}
            </div>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={selected.length === 0 || isPending} className="gap-2">
                  {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
                  Send Reminders
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Nudge {selected.length} agent{selected.length === 1 ? "" : "s"}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Each selected agent gets an in-app notification linking to their onboarding.
                    They can dismiss it.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleNudge}>Send</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </CardContent>
    </Card>
  )
}
