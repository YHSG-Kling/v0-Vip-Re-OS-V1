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
import { blockMissionAction, controlMissionAction, createMissionAction, decideDelegationAction, decideMissionAction } from "@/app/actions/missions"
import type { MissionRow, MissionType } from "@/lib/kernel/missions"
import type { MissionVerdictLine } from "@/lib/kernel/mission-controller"
import type { DelegationRow } from "@/lib/kernel/manager-delegation"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

export interface MissionsCardProps {
  active: MissionRow[]
  attention: MissionRow[]
  readRefused: string | null
  /** The EXECUTIVE MISSION CONTROLLER's verdict per mission (wave 105, lane 105B — lib/kernel/
   *  mission-controller.ts via listMissionsAction): owner, participants, progress %, blockers,
   *  budget, next action. Absent for a mission = the plan could not be made (shown as such). */
  verdicts?: Record<string, MissionVerdictLine>
  /** WAVE 105A: the PENDING delegations per mission id (what the mission asked other managers for). */
  delegations?: Record<string, DelegationRow[]>
  delegationsRefused?: string | null
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

type DelegationDecision = "accept" | "reject" | "dissent" | "escalate" | "cancel"

/** WAVE 105A — one pending delegation under its mission: who asked whom for which capability, its
 *  status, deadline and budget, with the human's doors (accept / reject / dissent / escalate / cancel). */
function DelegationLine({ d, label, pending, onDecide }: { d: DelegationRow; label: (k: string) => string; pending: boolean; onDecide: (id: string, decision: DelegationDecision) => void }) {
  const attention = d.status === "DISSENTED" || d.status === "ESCALATED"
  const btn = (decision: DelegationDecision, text: string) => (
    <Button size="sm" variant="outline" className="h-5 px-1.5 text-[10px]" disabled={pending} onClick={() => onDecide(d.id, decision)}>{text}</Button>
  )
  return (
    <li className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <Badge variant="outline" className={attention ? STATE_TONE.ESCALATED : STATE_TONE.ACTIVE}>{d.status.toLowerCase()}</Badge>
      <span>{label(d.requesting_manager)} → {label(d.assigned_manager)}</span>
      <span className="font-mono text-muted-foreground">{d.requested_capability}</span>
      {d.deadline && <span className="text-muted-foreground">· due {new Date(d.deadline).toLocaleDateString()}</span>}
      {typeof d.budget?.usd === "number" && <span className="text-muted-foreground">· ${Number(d.spent_usd ?? 0).toFixed(2)} / ${d.budget.usd.toFixed(2)}</span>}
      <span className="flex gap-1">
        {(d.status === "REQUESTED" || attention) && btn("accept", "Accept")}
        {d.status !== "ESCALATED" && btn("escalate", "Escalate")}
        {d.status !== "DISSENTED" && btn("dissent", "Dissent")}
        {btn("reject", "Reject")}
        {btn("cancel", "Cancel")}
      </span>
    </li>
  )
}

function MissionLine({ m, label, pending, onDecide, onBlock, onControl, verdict, delegations, onDelegation }: {
  m: MissionRow
  label: (k: string) => string
  pending: boolean
  onDecide: (id: string, decision: "approve" | "cancel") => void
  onBlock: (id: string, clear: boolean) => void
  onControl: (id: string) => void
  verdict?: MissionVerdictLine
  delegations: DelegationRow[]
  onDelegation: (id: string, decision: DelegationDecision) => void
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
      {/* The controller's verdict (owner · participants · progress % · blockers · budget · next action). */}
      <div className={verdict?.humanNeeded ? "text-amber-900" : "text-muted-foreground"} title={verdict ? verdict.flags.join(", ") : undefined}>
        Controller: {verdict ? verdict.line : "no verdict (the plan could not be made for this mission)"}
      </div>
      {verdict?.ownerExpected && verdict.ownerExpected !== m.owner_manager && (
        <div className="text-amber-800">Registry expects {label(verdict.ownerExpected)} to own this objective; {label(m.owner_manager)} was chosen — the controller reports, it does not reassign.</div>
      )}
      {delegations.length > 0 && (
        <div className="rounded border border-dashed p-1.5">
          <div className="text-muted-foreground">Waiting on {delegations.length} delegation{delegations.length === 1 ? "" : "s"} to other managers:</div>
          <ul className="mt-1 space-y-1">
            {delegations.map((d) => <DelegationLine key={d.id} d={d} label={label} pending={pending} onDecide={onDelegation} />)}
          </ul>
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
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={pending} title="Ask the mission controller to judge this mission now (owner, participants, progress, dependencies, disagreement, budget, authority)" onClick={() => onControl(m.id)}>Re-check</Button>
      </div>
    </li>
  )
}

export function MissionsCard({ active, attention, readRefused, managers, missionTypes, verdicts = {}, delegations = {}, delegationsRefused = null }: MissionsCardProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState<string | null>(null)
  const [objective, setObjective] = useState("")
  const [owner, setOwner] = useState<string>(managers[0]?.key ?? "")
  const [type, setType] = useState<string>("custom")
  const label = (k: string) => managers.find((m) => m.key === k)?.label ?? k
  const attentionIds = new Set(attention.map((m) => m.id))
  const rest = active.filter((m) => !attentionIds.has(m.id))
  const pendingDelegations = Object.values(delegations).reduce((n, list) => n + list.length, 0)

  const decideDelegation = (delegationId: string, decision: DelegationDecision) => {
    setNote(null)
    startTransition(async () => {
      const reason = window.prompt(decision === "dissent" ? "What is the objection?" : `Why ${decision} this delegation?`) ?? ""
      const r = await decideDelegationAction({ delegationId, decision, reason })
      setNote(r.ok ? `Delegation is now ${r.data.status.toLowerCase()}.` : r.error)
      if (r.ok) router.refresh()
    })
  }
  const line = (m: MissionRow) => <MissionLine key={m.id} m={m} label={label} pending={pending} onDecide={decide} onBlock={block} onControl={control} verdict={verdicts[m.id]} delegations={delegations[m.id] ?? []} onDelegation={decideDelegation} />

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
  const control = (missionId: string) => {
    setNote(null)
    startTransition(async () => {
      const r = await controlMissionAction({ missionId })
      setNote(r.ok ? `Controller: ${r.data.line}${r.data.moved ? ` — moved to ${r.data.state.toLowerCase().replace("_", " ")}.` : ""}` : r.error)
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
          <span className="text-xs font-normal text-muted-foreground">{active.length} active · {attention.length} need a decision{pendingDelegations > 0 ? ` · ${pendingDelegations} delegation${pendingDelegations === 1 ? "" : "s"} pending` : ""}</span>
          {pending && <Loader2 className="h-3 w-3 animate-spin" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {readRefused && <p className="text-xs text-red-700">Missions could not be read: {readRefused}. Nothing is shown rather than an empty all-clear.</p>}
        {delegationsRefused && <p className="text-xs text-red-700">Delegations could not be read: {delegationsRefused}. Missions are shown without them rather than as "nothing pending".</p>}
        {attention.length > 0 && (
          <ul className="space-y-1">
            {attention.map(line)}
          </ul>
        )}
        {rest.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">{rest.length} running on their own</summary>
            <ul className="mt-1 space-y-1">
              {rest.map(line)}
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
