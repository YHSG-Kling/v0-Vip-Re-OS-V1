"use client"

// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT'S OWN CHECKLIST — the missing middle on the journey rail.
//
// Everything this renders already existed and none of it was reachable:
//   · lib/portal/persona-config.ts   PERSONA_CONFIGS[persona].journeyStages —
//     a full per-persona task list, never rendered as a task list anywhere.
//   · lib/portal/journey-utils.ts    calculateJourneyProgress — the pure combiner,
//     zero callers. It takes exactly (stages, taskCompletions, stageProgress).
//   · app/actions/journey-tasks.ts   getTaskCompletions / getStageProgress supply
//     those two inputs; getTaskFormFields / submitTaskForm are the write side.
//
// The milestone timeline above this is the AGENT's view of the deal. This is the
// client's own to-do list, and it is the only thing on the portal a client can
// actually complete.
//
// THE VERDICT IS THE SERVER'S. submitTaskForm returns { success:false, error } for
// a refusal — an authorization failure, a rejected document attach, a stage-cursor
// write that did not land. Every one of those is rendered as the failure it is.
// Nothing here shows "Saved" until the server said so.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { CheckCircle2, Circle, Loader2, AlertCircle, ListChecks, ChevronDown, ChevronRight } from "lucide-react"
import { getTaskFormFields, submitTaskForm } from "@/app/actions/journey-tasks"

export interface ChecklistTask {
  id: string
  title: string
  description?: string
  required?: boolean
  /** Resolved server-side so the form shape is decided once, not guessed twice. */
  taskType: string
  completed: boolean
  completedAt: string | null
}

export interface ChecklistStage {
  id: string
  name: string
  description?: string
  estimatedDays?: number
  tasks: ChecklistTask[]
}

interface FormField {
  name: string
  label: string
  type: string
  required: boolean
  options?: string[]
}

interface Props {
  contactId: string
  transactionId: string | null
  persona: string
  stages: ChecklistStage[]
  currentStageIndex: number
  progressPercent: number
  completedTasks: number
  totalTasks: number
  /** Current stage cursor as journey_stage_progress has it, or null if never set. */
  stageCursor: { stage_name: string; progress_pct: number; current_task: string | null } | null
}

export default function JourneyChecklist({
  contactId,
  transactionId,
  persona,
  stages,
  currentStageIndex,
  progressPercent,
  completedTasks,
  totalTasks,
  stageCursor,
}: Props) {
  const router = useRouter()
  const [openStages, setOpenStages] = useState<Set<string>>(
    () => new Set(stages[currentStageIndex] ? [stages[currentStageIndex].id] : [])
  )
  const [activeTask, setActiveTask] = useState<{ stage: ChecklistStage; task: ChecklistTask } | null>(null)
  const [fields, setFields] = useState<FormField[] | null>(null)
  const [formDescription, setFormDescription] = useState<string>("")
  const [values, setValues] = useState<Record<string, string>>({})
  const [loadingFields, setLoadingFields] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function toggleStage(id: string) {
    setOpenStages((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function openTask(stage: ChecklistStage, task: ChecklistTask) {
    setActiveTask({ stage, task })
    setFields(null)
    setValues({})
    setError(null)
    setSaved(null)
    setLoadingFields(true)
    try {
      const spec = await getTaskFormFields(task.taskType)
      setFields(spec.fields as FormField[])
      setFormDescription(spec.description)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this task's form")
    } finally {
      setLoadingFields(false)
    }
  }

  function submit() {
    if (!activeTask || !fields) return
    const missing = fields.filter((f) => f.required && !values[f.name]?.trim())
    if (missing.length > 0) {
      setError(`Please fill in: ${missing.map((f) => f.label).join(", ")}`)
      return
    }
    setError(null)
    setSaved(null)

    const { stage, task } = activeTask
    const stageIndex = stages.findIndex((s) => s.id === stage.id)

    startTransition(async () => {
      const result = await submitTaskForm({
        contactId,
        transactionId: transactionId ?? undefined,
        taskId: `${stage.id}:${task.id}`,
        taskName: task.title,
        taskType: task.taskType,
        stageId: stage.id,
        stageName: stage.name,
        stageIndex,
        totalStages: stages.length,
        persona,
        formData: values,
      })

      // THE SERVER'S VERDICT, not an optimistic one.
      if (!result.success) {
        setError(result.error)
        return
      }
      setSaved(task.title)
      setActiveTask(null)
      setFields(null)
      router.refresh()
    })
  }

  if (stages.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-primary" />
            Your Checklist
          </CardTitle>
          <Badge variant="secondary">
            {completedTasks} of {totalTasks} done
          </Badge>
        </div>
        <CardDescription>
          These are the steps you can take yourself. Your agent sees each one the moment you complete it.
          {stageCursor && (
            <span className="block mt-1 text-xs">
              Currently on <span className="font-medium">{stageCursor.stage_name}</span> ({stageCursor.progress_pct}%)
              {stageCursor.current_task ? ` — last: ${stageCursor.current_task}` : ""}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Checklist progress</span>
            <span className="font-medium">{progressPercent}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>

        {saved && (
          <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Recorded: {saved}. Your agent has been notified.</span>
          </div>
        )}
        {error && !activeTask && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {stages.map((stage, idx) => {
          const open = openStages.has(stage.id)
          const done = stage.tasks.filter((t) => t.completed).length
          const isCurrent = idx === currentStageIndex
          return (
            <div
              key={stage.id}
              className={`rounded-lg border ${isCurrent ? "border-primary bg-primary/5" : "border-muted"}`}
            >
              <button
                type="button"
                onClick={() => toggleStage(stage.id)}
                className="flex w-full items-center justify-between gap-3 p-3 text-left"
              >
                <span className="flex items-center gap-2 min-w-0">
                  {open ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-medium truncate">{stage.name}</span>
                </span>
                <Badge variant={done === stage.tasks.length ? "default" : "outline"} className="shrink-0">
                  {done}/{stage.tasks.length}
                </Badge>
              </button>

              {open && (
                <div className="space-y-2 border-t px-3 py-3">
                  {stage.description && (
                    <p className="text-sm text-muted-foreground">{stage.description}</p>
                  )}
                  {stage.tasks.map((task) => {
                    const isActive = activeTask?.task.id === task.id && activeTask?.stage.id === stage.id
                    return (
                      <div key={task.id} className="rounded-md border bg-background p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2 min-w-0">
                            {task.completed ? (
                              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-green-600" />
                            ) : (
                              <Circle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/50" />
                            )}
                            <div className="min-w-0">
                              <p className={`text-sm ${task.completed ? "text-muted-foreground line-through" : ""}`}>
                                {task.title}
                                {task.required && !task.completed && (
                                  <span className="ml-2 text-xs text-amber-700">Required</span>
                                )}
                              </p>
                              {task.completed && task.completedAt && (
                                <p className="text-xs text-muted-foreground">
                                  Completed {new Date(task.completedAt).toLocaleDateString()}
                                </p>
                              )}
                            </div>
                          </div>
                          {!task.completed && !isActive && (
                            <Button size="sm" variant="outline" onClick={() => openTask(stage, task)}>
                              Complete
                            </Button>
                          )}
                        </div>

                        {isActive && (
                          <div className="mt-3 space-y-3 border-t pt-3">
                            {loadingFields && (
                              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                              </p>
                            )}
                            {fields && (
                              <>
                                <p className="text-sm text-muted-foreground">{formDescription}</p>
                                {fields.map((f) => (
                                  <div key={f.name} className="space-y-1">
                                    <label className="text-xs font-medium" htmlFor={`${task.id}-${f.name}`}>
                                      {f.label}
                                      {f.required && <span className="text-red-600"> *</span>}
                                    </label>
                                    {f.type === "select" || f.type === "multiselect" ? (
                                      <select
                                        id={`${task.id}-${f.name}`}
                                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                                        value={values[f.name] ?? ""}
                                        onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                                      >
                                        <option value="">Select…</option>
                                        {(f.options ?? []).map((o) => (
                                          <option key={o} value={o}>
                                            {o}
                                          </option>
                                        ))}
                                      </select>
                                    ) : f.type === "textarea" ? (
                                      <textarea
                                        id={`${task.id}-${f.name}`}
                                        rows={3}
                                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                                        value={values[f.name] ?? ""}
                                        onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                                      />
                                    ) : f.type === "checkbox" ? (
                                      <input
                                        id={`${task.id}-${f.name}`}
                                        type="checkbox"
                                        className="h-4 w-4"
                                        checked={values[f.name] === "yes"}
                                        onChange={(e) =>
                                          setValues((v) => ({ ...v, [f.name]: e.target.checked ? "yes" : "" }))
                                        }
                                      />
                                    ) : (
                                      <input
                                        id={`${task.id}-${f.name}`}
                                        type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                                        value={values[f.name] ?? ""}
                                        onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                                      />
                                    )}
                                  </div>
                                ))}

                                {error && (
                                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                    <span>{error}</span>
                                  </div>
                                )}

                                <div className="flex gap-2">
                                  <Button size="sm" onClick={submit} disabled={pending}>
                                    {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Submit
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={pending}
                                    onClick={() => {
                                      setActiveTask(null)
                                      setFields(null)
                                      setError(null)
                                    }}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
