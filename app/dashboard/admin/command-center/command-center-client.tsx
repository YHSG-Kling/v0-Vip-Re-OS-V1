"use client"

import { useState, useTransition } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { approveAgentAction, rejectAgentAction } from "@/app/actions/command-center"
import type { CommandCenterData, CommandCenterAction, CommandCenterSession } from "@/lib/kernel/command-center"

const SESSION_BADGE: Record<string, string> = {
  running:    "bg-green-100 text-green-800",
  idle:       "bg-amber-100 text-amber-800",
  terminated: "bg-slate-100 text-slate-700",
  error:      "bg-red-100 text-red-800",
}
const KIND_LABEL: Record<string, string> = {
  deal_coordinator:      "Deal Coordinator",
  shopping_agent:        "Shopping Agent",
  listing_concierge:     "Listing Concierge",
  sphere_of_influence:   "Sphere of Influence",
  campaign_orchestrator: "Campaign Orchestrator",
  marketing_agent:       "Marketing Agent",
  asset_manager:         "Asset Manager",
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—"
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function CommandCenterClient({ data, scope }: { data: CommandCenterData; scope: "platform" | "brokerage" }) {
  const [actions, setActions] = useState<CommandCenterAction[]>(data.pendingActions)
  const [summary, setSummary] = useState(data.summary)

  function onResolved(actionId: string) {
    setActions((prev) => {
      const next = prev.filter((a) => a.id !== actionId)
      setSummary((s) => ({ ...s, pendingApprovals: next.length }))
      return next
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agent Command Center</h1>
          <p className="text-sm text-muted-foreground">
            {scope === "platform" ? "Platform-wide" : "Your brokerage"} — live manager sessions + action approvals
          </p>
        </div>
      </header>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Stat label="Running" value={summary.activeSessions} accent="text-green-700" />
        <Stat label="Idle" value={summary.idleSessions} accent="text-amber-700" />
        <Stat label="Errored" value={summary.erroredSessions} accent="text-red-700" />
        <Stat label="Pending approvals" value={summary.pendingApprovals} accent="text-blue-700" />
        <Stat label="SLA breached" value={summary.breachedApprovals} accent={summary.breachedApprovals > 0 ? "text-red-700" : "text-slate-500"} />
      </div>

      {/* Approval queue */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Approval queue</h2>
        {actions.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No actions awaiting approval.</Card>
        ) : (
          actions.map((a) => <ActionRow key={a.id} action={a} onResolved={onResolved} />)
        )}
      </section>

      {/* Sessions */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Manager sessions</h2>
        {data.sessions.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No managed-agent sessions yet.</Card>
        ) : (
          <div className="space-y-2">{data.sessions.map((s) => <SessionRow key={s.id} session={s} />)}</div>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <Card className="p-4">
      <div className={`text-3xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground mt-1">{label}</div>
    </Card>
  )
}

function SessionRow({ session }: { session: CommandCenterSession }) {
  return (
    <Card className="p-4 flex items-center justify-between">
      <div>
        <div className="font-medium">{KIND_LABEL[session.agentKind ?? ""] ?? session.agentKind ?? "Unknown agent"}</div>
        <div className="text-xs text-muted-foreground">
          {session.entityType} · {session.entityId.slice(0, 8)}… · last event {timeAgo(session.lastEventAt)}
        </div>
      </div>
      <Badge className={SESSION_BADGE[session.status] ?? "bg-slate-100 text-slate-700"}>{session.status}</Badge>
    </Card>
  )
}

function ActionRow({ action, onResolved }: { action: CommandCenterAction; onResolved: (id: string) => void }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function run(kind: "approve" | "reject") {
    setError(null)
    startTransition(async () => {
      const res = kind === "approve"
        ? await approveAgentAction({ queue: action.queue, actionId: action.id })
        : await rejectAgentAction({ queue: action.queue, actionId: action.id })
      if (res.ok) onResolved(action.id)
      else setError(res.error ?? "Action failed")
    })
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge className={action.queue === "marketing" ? "bg-purple-100 text-purple-800" : "bg-orange-100 text-orange-800"}>
              {action.queue === "marketing" ? "Marketing Agent" : "Asset Manager"}
            </Badge>
            <span className="font-medium">{action.actionType.replace(/_/g, " ")}</span>
            {action.slaLevel === "breached" && (
              <Badge className="bg-red-100 text-red-800">SLA breached · {Math.round(action.ageHours)}h</Badge>
            )}
            {action.slaLevel === "due" && (
              <Badge className="bg-amber-100 text-amber-800">SLA due · {Math.round(action.ageHours)}h</Badge>
            )}
          </div>
          {action.rationale && <p className="text-sm text-muted-foreground mt-1">{action.rationale}</p>}
          <div className="text-xs text-muted-foreground mt-1">proposed {timeAgo(action.proposedAt)}</div>
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run("reject")}>Reject</Button>
          <Button size="sm" disabled={pending} onClick={() => run("approve")}>{pending ? "…" : "Approve"}</Button>
        </div>
      </div>
    </Card>
  )
}
