"use client"

/**
 * WORKFLOW RUNS PANEL — the contact-card surface app/actions/workflow-orchestrator.ts
 * was written for ("Read APIs for UI surfaces (workflow status panel on contact card)")
 * and that never existed. Every chain run against this contact was invisible: a run
 * paused on `needs_approval` sat there forever because nothing in the product could
 * approve it, and a failed run could not be resumed or cancelled from anywhere.
 *
 * Wires the orchestrator's whole public surface:
 *   getRunsForContact → the list · getRunDetail → the steps ·
 *   approveChainStep  → the gated step · advanceChainRun → resume ·
 *   cancelChainRun    → stop · startChainRun → launch listing-appointment prep
 *
 * Every call READS its outcome; a refusal from the action (Unauthorized / Forbidden /
 * "Step is done, cannot approve") is shown verbatim rather than swallowed.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Workflow,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Play,
  Ban,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import {
  getRunsForContact,
  getRunDetail,
  approveChainStep,
  advanceChainRun,
  cancelChainRun,
  startChainRun,
} from "@/app/actions/workflow-orchestrator"

/** The chain an agent can launch by hand for a contact (the rest are event-triggered). */
const MANUAL_CHAIN_KEY = "listing-appt-prep"
const MANUAL_CHAIN_LABEL = "Listing appointment prep"

interface RunRow {
  id: string
  chain_key: string
  status: string
  current_step_index: number | null
  started_at: string | null
  completed_at: string | null
  error_message: string | null
}

interface StepRow {
  id: string
  step_index: number
  step_key: string
  step_label: string | null
  status: string
  error_message: string | null
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled"])

function statusBadge(status: string) {
  if (status === "completed" || status === "done") {
    return <Badge className="bg-green-100 text-green-800 border-green-200 text-xs"><CheckCircle2 className="h-3 w-3 mr-1" />{status}</Badge>
  }
  if (status === "failed") {
    return <Badge variant="destructive" className="text-xs"><XCircle className="h-3 w-3 mr-1" />failed</Badge>
  }
  if (status === "needs_approval" || status === "paused") {
    return <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs"><Clock className="h-3 w-3 mr-1" />{status.replace(/_/g, " ")}</Badge>
  }
  return <Badge variant="secondary" className="text-xs">{status.replace(/_/g, " ")}</Badge>
}

export function WorkflowRunsPanel({ contactId }: { contactId: string }) {
  const [runs, setRuns] = useState<RunRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [steps, setSteps] = useState<StepRow[]>([])
  const [stepsLoading, setStepsLoading] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, startBusy] = useTransition()

  const loadRuns = useCallback(async () => {
    setLoading(true)
    const rows = await getRunsForContact(contactId)
    setRuns(rows as RunRow[])
    setLoading(false)
  }, [contactId])

  useEffect(() => { void loadRuns() }, [loadRuns])

  async function openRun(runId: string) {
    if (expanded === runId) { setExpanded(null); setSteps([]); return }
    setExpanded(runId)
    setStepsLoading(true)
    const detail = await getRunDetail(runId)
    // getRunDetail returns { run: null, steps: [] } when the caller is not entitled
    // to this run — say so rather than rendering an empty step list as "no steps".
    if (!detail.run) setRefusal("That run could not be opened for this account.")
    setSteps((detail.steps ?? []) as StepRow[])
    setStepsLoading(false)
  }

  function handleApprove(runId: string, stepKey: string) {
    setRefusal(null)
    startBusy(async () => {
      const res = await approveChainStep({ runId, stepKey })
      if (!res.success) { setRefusal(res.error ?? "Approval was refused."); return }
      await loadRuns()
      const detail = await getRunDetail(runId)
      setSteps((detail.steps ?? []) as StepRow[])
    })
  }

  function handleResume(runId: string) {
    setRefusal(null)
    startBusy(async () => {
      const res = await advanceChainRun(runId)
      if (!res.success) { setRefusal(res.error ?? "The run could not be advanced."); return }
      await loadRuns()
    })
  }

  function handleCancel(runId: string) {
    setRefusal(null)
    startBusy(async () => {
      const res = await cancelChainRun({ runId, reason: "Cancelled from the contact record" })
      if (!res.success) { setRefusal(res.error ?? "The run could not be cancelled."); return }
      await loadRuns()
    })
  }

  function handleStart() {
    setRefusal(null)
    startBusy(async () => {
      const res = await startChainRun({ chainKey: MANUAL_CHAIN_KEY, contactId })
      if (!res.success) { setRefusal(res.error ?? "The workflow could not be started."); return }
      await loadRuns()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <Workflow className="h-4 w-4 text-primary" />
              Automations
              {runs.length > 0 && <Badge variant="outline" className="text-xs">{runs.length}</Badge>}
            </CardTitle>
            <CardDescription className="text-xs">
              Chain runs for this contact — approve a gated step, resume, or stop one.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" className="text-xs shrink-0" disabled={busy} onClick={handleStart}>
            {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
            {MANUAL_CHAIN_LABEL}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {refusal && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {refusal}
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading automations…
          </div>
        ) : runs.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground">
            No automation has run for this contact yet.
          </p>
        ) : (
          runs.map((run) => {
            const isOpen = expanded === run.id
            const live = !TERMINAL.has(run.status)
            return (
              <div key={run.id} className="rounded-md border p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => openRun(run.id)}
                    className="flex min-w-0 items-center gap-2 text-left"
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                    <span className="truncate text-sm font-medium">{run.chain_key}</span>
                    {statusBadge(run.status)}
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {live && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => handleResume(run.id)}>
                        <RefreshCw className="h-3 w-3 mr-1" />Resume
                      </Button>
                    )}
                    {live && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" disabled={busy} onClick={() => handleCancel(run.id)}>
                        <Ban className="h-3 w-3 mr-1" />Cancel
                      </Button>
                    )}
                  </div>
                </div>

                {run.error_message && (
                  <p className="mt-1 pl-5 text-xs text-destructive">{run.error_message}</p>
                )}
                <p className="mt-1 pl-5 text-[11px] text-muted-foreground">
                  {run.started_at ? `Started ${new Date(run.started_at).toLocaleString()}` : "Not started"}
                  {run.completed_at ? ` · Finished ${new Date(run.completed_at).toLocaleString()}` : ""}
                </p>

                {isOpen && (
                  <div className="mt-2 space-y-1.5 border-t pt-2 pl-5">
                    {stepsLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Loading steps…
                      </div>
                    ) : steps.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No steps recorded for this run.</p>
                    ) : (
                      steps.map((step) => (
                        <div key={step.id} className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="text-xs tabular-nums text-muted-foreground">{step.step_index + 1}.</span>
                            <span className="truncate text-xs">{step.step_label ?? step.step_key}</span>
                            {statusBadge(step.status)}
                          </div>
                          {step.status === "needs_approval" && (
                            <Button
                              size="sm"
                              className="h-7 shrink-0 bg-amber-600 text-xs hover:bg-amber-700"
                              disabled={busy}
                              onClick={() => handleApprove(run.id, step.step_key)}
                            >
                              <CheckCircle2 className="h-3 w-3 mr-1" />Approve
                            </Button>
                          )}
                        </div>
                      ))
                    )}
                    {steps.some((s) => s.error_message) && (
                      <ul className="list-disc pl-4 text-[11px] text-destructive">
                        {steps.filter((s) => s.error_message).map((s) => (
                          <li key={`err-${s.id}`}>{s.step_label ?? s.step_key}: {s.error_message}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
