"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, GraduationCap, Play, Pause } from "lucide-react"
import {
  assignAcademyModuleAction,
  setAgentOnboardingStatusAction,
} from "@/app/actions/admin/agent-360"

/** Assign a published academy module to this agent. */
export function AssignAcademyControl({
  targetUserId,
  availableModules,
  assignedModuleIds,
}: {
  targetUserId: string
  availableModules: Array<{ id: string; title: string }>
  assignedModuleIds: string[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [moduleId, setModuleId] = useState("")
  const [msg, setMsg] = useState<string | null>(null)

  const unassigned = availableModules.filter(m => !assignedModuleIds.includes(m.id))

  if (availableModules.length === 0) {
    return <p className="text-xs text-muted-foreground">No published academy modules yet — author them in the Academy admin.</p>
  }

  function assign() {
    if (!moduleId) return
    setMsg(null)
    start(async () => {
      const r = await assignAcademyModuleAction({ targetUserId, moduleId })
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
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <GraduationCap className="h-3 w-3" />}
          Assign
        </Button>
      </div>
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  )
}

/** Apply / pause / resume the agent's onboarding (walkthrough [47]). */
export function OnboardingControl({
  targetUserId,
  status,
}: {
  targetUserId: string
  /** null = never started */
  status: string | null
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  function set(next: "in_progress" | "paused") {
    setMsg(null)
    start(async () => {
      const r = await setAgentOnboardingStatusAction({ targetUserId, status: next })
      if (r.ok) router.refresh()
      else setMsg(`Failed: ${r.error}`)
    })
  }

  if (status === "completed") return null

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {status === null && (
          <Button size="sm" variant="outline" className="text-xs gap-1" onClick={() => set("in_progress")} disabled={pending}>
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Apply onboarding
          </Button>
        )}
        {status === "in_progress" && (
          <Button size="sm" variant="outline" className="text-xs gap-1" onClick={() => set("paused")} disabled={pending}>
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
            Pause onboarding
          </Button>
        )}
        {status === "paused" && (
          <Button size="sm" variant="outline" className="text-xs gap-1" onClick={() => set("in_progress")} disabled={pending}>
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Resume onboarding
          </Button>
        )}
      </div>
      {msg && <p className="text-xs text-destructive">{msg}</p>}
    </div>
  )
}
