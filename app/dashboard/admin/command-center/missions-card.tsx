"use client"

/**
 * MISSIONS card (wave 104, lane 104F) — the human door onto the durable mission runtime, on the
 * admin Command Center. Lists the tenant's non-terminal missions with the ATTENTION set first
 * (BLOCKED / APPROVAL_REQUIRED / ESCALATED), and lets the principal decide (approve → ACTIVE,
 * reject → CANCELLED), block / unblock, and create a mission (objective, type, owner manager from
 * the registry). Every mutation is app/actions/missions.ts (tenant from the SESSION; the kernel
 * service lib/kernel/missions.ts is the only writer — the state machine refuses what it refuses and
 * the refusal reads back here verbatim). Tenant-admin roster only: the page gates the render
 * (isAdminOrBroker), agents never see it.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Target, Loader2 } from "lucide-react"
import { blockMissionAction, createMissionAction, decideMissionAction } from "@/app/actions/missions"
import type { MissionRow, MissionType } from "@/lib/kernel/missions"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

export interface MissionsCardProps {
  active: MissionRow[]
  attention: MissionRow[]
  readRefused: string | null
  /** The manager registry (key + label), handed in by the server page — the owner picker. */
  managers: Array<{ key: ManagerKey; label: string }>
  missionTypes: readonly MissionType[]
}

const STATE_TONE: Record<string, string> = {
  APPROVAL_REQUIRED: "bg-amber-100 text-amber-900 border-amber-200",
  ESCALATED: "bg-red-100 text-red-900 border-red-200",
  BLOCKED: "bg-orange-100 text-orange-900 border-orange-200",
  ACTIVE: "bg-emerald-100 text-emerald-900 border-emerald-200",
  WAITING: "bg-sky-100 text-sky-900 border-sky-200",
  PLANNING: "bg-slate-100 text-slate-900 border-slate-200",
  PROPOSED: "bg-slate-100 text-slate-700 border-slate-200",
}

function MissionLine({ m, label, pending, onDecide, onBlock }: {
  m: MissionRow
  label: (k: string) => string
  pending: boolean
  onDecide: (id: string, decision: "approve" | "cancel") => void
  onBlock: (id: string, clear: boolean) => void
}) {
  const openBlockers = (m.blockers ?? []).filter((b) => !b.cleared_at)
  const needsDecision = m.state === "APPROVAL_REQUIRED" || m.state === "ESCALATED" || m.state === "PROPOSED" || m.state === "PLANNING"
  return (
    <li className="rounded-md border p-2 text-xs space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={STATE_TONE[m.state] ?? ""}>{m.state.toLowerCase().replace("_", " ")}</Badge>
        <span className="font-medium">{m.objective}</span>
        <span className="text-muted-foreground">· {label(m.owner_manager)} · {m.mission_type.replace("_", " ")} · {m.priority}</span>
        {m.deadline && <span className="text-muted-foreground">· due {new Date(m.deadline).toLocaleDateString()}</span>}
      </div>
      {openBlockers.length > 0 && (
        <div className="text-orange-800">Blocked on: {openBlockers.map((b) => `${b.key} (${b.reason})`).join("; ")}</div>
      )}
      {(m.success_criteria ?? []).length > 0 && (
        <div className="text-muted-foreground">
          Criteria: {m.success_criteria.map((c) => `${c.metric} ${c.op} ${c.target}${typeof m.progress?.[c.metric] === "number" ? ` (is ${m.progress[c.metric]})` : ""}`).join(" · ")}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {needsDecision && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => onDecide(m.id, "approve")}>Approve</Button>
        )}
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => onDecide(m.id, "cancel")}>Reject</Button>
        {openBlockers.length > 0
          ? <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => onBlock(m.id, true)}>Unblock</Button>
          : m.state !== "BLOCKED" && <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => onBlock(m.id, false)}>Block</Button>}
      </div>
    </li>
  )
}

export function MissionsCard({ active, attention, readRefused, managers, missionTypes }: MissionsCardProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState<string | null>(null)
  const [objective, setObjective] = useState("")
  const [owner, setOwner] = useState<string>(managers[0]?.key ?? "")
  const [type, setType] = useState<string>("custom")
  const label = (k: string) => managers.find((m) => m.key === k)?.label ?? k
  const attentionIds = new Set(attention.map((m) => m.id))
  const rest = active.filter((m) => !attentionIds.has(m.id))

  const decide = (missionId: string, decision: "approve" | "cancel") => {
    setNote(null)
    startTransition(async () => {
      const reason = window.prompt(decision === "approve" ? "Why approve / resume this mission?" : "Why reject this mission?") ?? ""
      const r = await decideMissionAction({ missionId, decision, reason })
      setNote(r.ok ? `Mission is now ${r.data.state.toLowerCase().replace("_", " ")}.` : r.error)
      if (r.ok) router.refresh()
    })
  }
  const block = (missionId: string, clear: boolean) => {
    setNote(null)
    startTransition(async () => {
      const key = clear ? (active.find((m) => m.id === missionId)?.blockers ?? []).find((b) => !b.cleared_at)?.key ?? "" : (window.prompt("Blocker key (e.g. lender_docs)") ?? "").trim()
      if (!key) { setNote("A blocker needs a key."); return }
      const reason = window.prompt(clear ? "Why is it unblocked?" : "What is it blocked on?") ?? ""
      const r = await blockMissionAction({ missionId, key, reason, clear })
      setNote(r.ok ? (clear ? "Blocker cleared." : "Mission blocked — its owner manager is told.") : r.error)
      if (r.ok) router.refresh()
    })
  }
  const create = () => {
    setNote(null)
    startTransition(async () => {
      const r = await createMissionAction({ objective, ownerManager: owner as ManagerKey, missionType: type as MissionType })
      setNote(r.ok ? `Mission proposed: "${r.data.objective}" (${label(r.data.owner_manager)} owns it).` : r.error)
      if (r.ok) { setObjective(""); router.refresh() }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Target className="h-4 w-4 text-violet-700" /> Missions
          <span className="text-xs font-normal text-muted-foreground">{active.length} active · {attention.length} need a decision</span>
          {pending && <Loader2 className="h-3 w-3 animate-spin" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {readRefused && <p className="text-xs text-red-700">Missions could not be read: {readRefused}. Nothing is shown rather than an empty all-clear.</p>}
        {attention.length > 0 && (
          <ul className="space-y-1">
            {attention.map((m) => <MissionLine key={m.id} m={m} label={label} pending={pending} onDecide={decide} onBlock={block} />)}
          </ul>
        )}
        {rest.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">{rest.length} running on their own</summary>
            <ul className="mt-1 space-y-1">
              {rest.map((m) => <MissionLine key={m.id} m={m} label={label} pending={pending} onDecide={decide} onBlock={block} />)}
            </ul>
          </details>
        )}
        {!readRefused && active.length === 0 && <p className="text-xs text-muted-foreground">No missions yet — give the OS an objective below.</p>}
        <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          <input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Objective — e.g. Close 24 sides this year" className="h-8 min-w-[220px] flex-1 rounded-md border bg-background px-2 text-xs" />
          <select value={type} onChange={(e) => setType(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
            {missionTypes.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
          </select>
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
            {managers.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <Button size="sm" className="h-8 text-xs" disabled={pending || !objective.trim() || !owner} onClick={create}>Propose mission</Button>
        </div>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  )
}
