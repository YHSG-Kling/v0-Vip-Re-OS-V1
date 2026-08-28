"use client"

import { useState, useEffect } from "react"
import {
  getErrorGroupDetails,
  assignErrorGroup,
  listAssignableTeammates,
} from "@/app/actions/error-handler"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Trash2, CheckCircle, UserPlus, Loader2, RotateCw, AlertTriangle } from "lucide-react"

interface ErrorDetailsPanelProps {
  groupId: string
  onDismiss: (groupId: string) => void
  onResolve: (groupId: string) => void
}

export function ErrorDetailsPanel({
  groupId,
  onDismiss,
  onResolve,
}: ErrorDetailsPanelProps) {
  const [details, setDetails] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)

  // ASSIGN — the triage surface had Resolve and Dismiss and no way to hand an error
  // to the person who can actually fix it, which is why assignErrorGroup had no
  // caller. The list is users.id (what automation_errors.assigned_to FKs to), never
  // agents.id.
  const [teammates, setTeammates] = useState<Array<{ id: string; name: string; email: string | null }>>([])
  const [assigneeId, setAssigneeId] = useState("")
  const [assigning, setAssigning] = useState(false)
  const [assignMsg, setAssignMsg] = useState<string | null>(null)
  const [assignErr, setAssignErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listAssignableTeammates()
      .then((rows) => { if (!cancelled) setTeammates(rows) })
      .catch(() => { if (!cancelled) setTeammates([]) })
    return () => { cancelled = true }
  }, [])

  async function handleAssign() {
    setAssignMsg(null)
    setAssignErr(null)
    if (!assigneeId) { setAssignErr("Pick who should own this error."); return }
    setAssigning(true)
    try {
      await assignErrorGroup(groupId, assigneeId)
      const who = teammates.find((t) => t.id === assigneeId)?.name ?? "that teammate"
      setAssignMsg(`Assigned to ${who}.`)
      // Reflect it immediately — the panel would otherwise keep showing the old owner.
      setDetails((d: any) => (d ? { ...d, assigned_to: assigneeId } : d))
    } catch (e: any) {
      // assignErrorGroup THROWS on refusal (unknown assignee, wrong brokerage,
      // no matching error). Surface the real reason rather than a generic failure.
      setAssignErr(e?.message ?? "Could not assign this error")
    } finally {
      setAssigning(false)
    }
  }

  useEffect(() => {
    const loadDetails = async () => {
      try {
        const data = await getErrorGroupDetails(groupId)
        setDetails(data)
      } catch (error) {
        console.error("Error loading details:", error)
      } finally {
        setIsLoading(false)
      }
    }

    loadDetails()
  }, [groupId])

  // ── RETRY / ESCALATE ────────────────────────────────────────────────────────
  // Lane G5 2026-08-28. This panel RENDERED the auto-retry ledger and the
  // escalation flag (the block below) while neither had an operator-facing
  // writer anywhere in the tree: POST /api/errors/retry is the only manual
  // caller of lib/errors/auto-retry.ts:scheduleRetry outside the cron, and POST
  // /api/errors/escalate is the only writer of error_resolution_log
  // action_type='escalated', of the SYSTEM_HEALTH_ALERT lifecycle event and of
  // the escalation notification — and no string in the tree addressed either
  // route. The ruling that kept them (app/actions/error-handler.ts:4-30) says
  // the missing half must be BUILT rather than the route deleted. This is that
  // half. Both are HTTP doors, not server actions, so they are called with
  // fetch; the routes re-check the admin/broker + platform_role gate server-side
  // and this component's visibility is not the gate.
  const [opBusy, setOpBusy] = useState<"retry" | "escalate" | null>(null)
  const [opMsg, setOpMsg] = useState<string | null>(null)
  const [opErr, setOpErr] = useState<string | null>(null)

  async function refreshDetails() {
    try {
      setDetails(await getErrorGroupDetails(groupId))
    } catch {
      /* the action just taken already reported its own outcome */
    }
  }

  async function handleRetry() {
    setOpMsg(null); setOpErr(null); setOpBusy("retry")
    try {
      const res = await fetch("/api/errors/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ errorId: groupId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Retry refused (${res.status})`)
      // The route reports per-id success; a scheduled retry that the engine
      // refused must not read as "queued".
      const failed = (data?.results ?? []).find((r: any) => !r.success)
      if (failed) throw new Error(failed.error ?? "The retry engine refused this error")
      setOpMsg("Retry scheduled.")
      await refreshDetails()
    } catch (e: any) {
      setOpErr(e?.message ?? "Could not schedule a retry")
    } finally {
      setOpBusy(null)
    }
  }

  async function handleEscalate() {
    setOpMsg(null); setOpErr(null); setOpBusy("escalate")
    try {
      const res = await fetch("/api/errors/escalate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          errorId: groupId,
          escalatedSeverity: "critical",
          notes: "Escalated from the error triage panel",
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Escalation refused (${res.status})`)
      const failed = (data?.results ?? []).find((r: any) => !r.success)
      if (failed) throw new Error(failed.error ?? "The escalation was refused")
      setOpMsg("Escalated to critical — the on-call notification was sent.")
      await refreshDetails()
    } catch (e: any) {
      setOpErr(e?.message ?? "Could not escalate this error")
    } finally {
      setOpBusy(null)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-full mb-2" />
          <Skeleton className="h-4 w-3/4" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </CardContent>
      </Card>
    )
  }

  if (!details) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">Failed to load error details</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{details.workflow_name}</CardTitle>
        <CardDescription>
          {details.severity} · {details.status}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Error detail (single record) */}
        <div>
          <h4 className="font-medium text-sm mb-2">Error</h4>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            <div className="p-2 bg-muted rounded text-xs">
              <p className="font-mono text-red-600 truncate">{details.error_message}</p>
              <p className="text-muted-foreground">
                {details.created_at ? new Date(details.created_at).toLocaleString() : ""}
              </p>
            </div>
          </div>
        </div>

        {/* Auto-retry state — attached by getErrorGroupDetails from the retry
            engine's own ledger (error_resolution_log). Shows what the engine has
            actually done with this error instead of leaving Retry a black box. */}
        {details.retry && (
          <div className="pt-4 space-y-1 border-t">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Auto-retry</p>
            {details.retry.totalAttempts === 0 && !details.retry.isEscalated ? (
              <p className="text-xs text-muted-foreground">No retries scheduled yet.</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {details.retry.totalAttempts} attempt{details.retry.totalAttempts === 1 ? "" : "s"}
                {details.retry.lastResult ? ` · last: ${details.retry.lastResult}` : ""}
                {details.retry.nextRetryAt ? ` · next: ${new Date(details.retry.nextRetryAt).toLocaleString()}` : ""}
                {details.retry.isEscalated ? " · escalated" : ""}
              </p>
            )}
            {opMsg && <p className="text-xs text-green-700">{opMsg}</p>}
            {opErr && <p className="text-xs text-red-600">{opErr}</p>}
            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                variant="secondary"
                className="flex-1"
                onClick={handleRetry}
                disabled={opBusy !== null}
              >
                {opBusy === "retry"
                  ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  : <RotateCw className="h-4 w-4 mr-2" />}
                Retry now
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                onClick={handleEscalate}
                disabled={opBusy !== null || details.retry.isEscalated}
                title={details.retry.isEscalated ? "Already escalated" : "Raise to critical and notify"}
              >
                {opBusy === "escalate"
                  ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  : <AlertTriangle className="h-4 w-4 mr-2" />}
                Escalate
              </Button>
            </div>
          </div>
        )}

        {/* Assign */}
        <div className="pt-4 space-y-2 border-t">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Owner</p>
          {assignMsg && <p className="text-xs text-green-700">{assignMsg}</p>}
          {assignErr && <p className="text-xs text-red-600">{assignErr}</p>}
          {teammates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No teammates available to assign.
            </p>
          ) : (
            <div className="flex gap-2">
              <Select value={assigneeId} onValueChange={setAssigneeId}>
                <SelectTrigger className="h-9 flex-1">
                  <SelectValue placeholder="Assign to…" />
                </SelectTrigger>
                <SelectContent>
                  {teammates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="secondary" onClick={handleAssign} disabled={assigning}>
                {assigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              </Button>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-4">
          <Button
            size="sm"
            onClick={() => onResolve(groupId)}
            className="w-full"
          >
            <CheckCircle className="h-4 w-4 mr-2" />
            Resolve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDismiss(groupId)}
            className="w-full"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
