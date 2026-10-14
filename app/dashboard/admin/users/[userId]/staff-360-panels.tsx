"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2, GraduationCap, ClipboardList, ShieldCheck, Activity, AlertTriangle } from "lucide-react"
import type { Staff360 } from "@/app/actions/admin/staff-360"
import { assignAcademyModuleToStaffAction } from "@/app/actions/admin/staff-360"

/**
 * Staff 360 — the same depth the agent card got, for TC / ISA / Compliance /
 * Admin / Broker users: their real queue, their work trail, and their academy
 * assignments (the staff_user_id lane).
 */

const ROLE_LABELS: Record<string, string> = {
  tc: "Transaction Coordinator", isa: "ISA", compliance_officer: "Compliance Officer",
  compliance_manager: "Compliance Manager", admin: "Admin", broker: "Broker",
  broker_admin: "Broker Admin", team_lead: "Team Lead",
}

export function Staff360Panels({ data, targetUserId }: { data: Staff360; targetUserId: string }) {
  return (
    <div className="space-y-6">
      {/* Workload — the queue this person is actually on the hook for */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-blue-600" />
            Workload
            <Badge variant="outline" className="ml-auto text-xs">
              {ROLE_LABELS[data.role] ?? data.role.replace(/_/g, " ")}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.tc ? (
            <div className="grid grid-cols-2 gap-3">
              <Tile label="Open tasks" value={String(data.tc.tasksOpen)} />
              <Tile
                label="Overdue"
                value={String(data.tc.tasksOverdue)}
                urgent={data.tc.tasksOverdue > 0}
              />
              <Tile label="Completed (30d)" value={String(data.tc.tasksCompleted30d)} />
              <Tile label="Files carried" value={String(data.tc.filesCarried)} sub="open transactions" />
            </div>
          ) : data.review ? (
            <div className="grid grid-cols-2 gap-3">
              <Tile label="Items reviewed" value={String(data.review.itemsReviewed)} sub="all time" />
              <Tile
                label="Queue pending"
                value={String(data.review.queuePending)}
                sub="brokerage-wide"
                urgent={data.review.queuePending > 10}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              This role has no dedicated queue — their work shows in the activity trail below.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Work trail — the universal activity log */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-slate-600" />
            Recent activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No logged activity yet.</p>
          ) : (
            <div className="divide-y">
              {data.recentActivity.map((a, i) => (
                <div key={i} className="py-1.5 flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{a.title}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(a.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
          {data.memberSince && (
            <p className="text-xs text-muted-foreground mt-3 pt-2 border-t">
              Member since {new Date(data.memberSince).toLocaleDateString()}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Academy — staff get assigned classes too (staff_user_id lane) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-purple-600" />
            Academy
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.academy.assignments.length > 0 ? (
            <div className="divide-y">
              {data.academy.assignments.map(a => (
                <div key={a.moduleId} className="py-1.5 flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{a.title}</span>
                  <Badge
                    variant="outline"
                    className={`text-xs capitalize shrink-0 ${a.status === "completed" ? "bg-emerald-100 text-emerald-800" : ""}`}
                  >
                    {a.status}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No classes assigned yet.</p>
          )}
          <StaffAcademyControl
            targetUserId={targetUserId}
            availableModules={data.academy.availableModules}
            assignedModuleIds={data.academy.assignments.map(a => a.moduleId)}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function Tile({ label, value, sub, urgent }: { label: string; value: string; sub?: string; urgent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${urgent ? "border-red-200 bg-red-50/60" : ""}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {urgent && <AlertTriangle className="h-3 w-3 text-red-600" />}
        {label}
      </div>
      <p className={`text-xl font-bold mt-1 ${urgent ? "text-red-700" : ""}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

function StaffAcademyControl({
  targetUserId, availableModules, assignedModuleIds,
}: {
  targetUserId: string
  availableModules: Array<{ id: string; title: string }>
  assignedModuleIds: string[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [moduleId, setModuleId] = useState("")
  const [msg, setMsg] = useState<string | null>(null)

  if (availableModules.length === 0) {
    return <p className="text-xs text-muted-foreground">No published academy modules yet.</p>
  }
  const unassigned = availableModules.filter(m => !assignedModuleIds.includes(m.id))

  function assign() {
    if (!moduleId) return
    setMsg(null)
    start(async () => {
      const r = await assignAcademyModuleToStaffAction({ targetUserId, moduleId })
      if (r.ok) {
        setMsg(r.duplicate ? "Already assigned." : "Assigned.")
        setModuleId("")
        router.refresh()
      } else {
        setMsg(`Failed: ${r.error}`)
      }
    })
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <select
          className="flex-1 border rounded px-2 py-1.5 text-xs"
          value={moduleId}
          onChange={e => setModuleId(e.target.value)}
          disabled={pending}
        >
          <option value="">Assign a class…</option>
          {unassigned.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
        <Button size="sm" className="text-xs gap-1" onClick={assign} disabled={pending || !moduleId}>
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
          Assign
        </Button>
      </div>
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  )
}
