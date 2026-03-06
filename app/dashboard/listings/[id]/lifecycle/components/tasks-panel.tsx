"use client"

import { useState, useTransition } from "react"
import { CheckCircle2, Circle, Clock, AlertCircle, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { completeListingTask } from "@/app/actions/listing-lifecycle"

interface Task {
  id: string
  title: string
  description: string | null
  status: string
  priority: string | null
  due_date: string | null
  owner_role: string | null
  auto_generated: boolean
  completed_at: string | null
}

interface Props {
  tasks: Task[]
  listingId: string
}

const PRIORITY_COLORS: Record<string, string> = {
  high:   "text-destructive bg-destructive/10 border-destructive/20",
  medium: "text-amber-700 bg-amber-50 border-amber-200",
  low:    "text-muted-foreground bg-muted border-border",
}

const ROLE_COLORS: Record<string, string> = {
  agent:      "bg-blue-50 text-blue-800 border-blue-200",
  TC:         "bg-purple-50 text-purple-800 border-purple-200",
  broker:     "bg-slate-100 text-slate-700 border-slate-200",
  admin:      "bg-slate-100 text-slate-700 border-slate-200",
  team_lead:  "bg-indigo-50 text-indigo-800 border-indigo-200",
}

export function TasksPanel({ tasks, listingId }: Props) {
  const [optimisticDone, setOptimisticDone] = useState<Set<string>>(new Set())
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const now = new Date()

  function isOverdue(task: Task) {
    return task.due_date && new Date(task.due_date) < now && task.status !== "completed"
  }

  function handleComplete(taskId: string) {
    setError(null)
    setOptimisticDone(prev => new Set([...prev, taskId]))
    startTransition(async () => {
      try {
        await completeListingTask(taskId)
      } catch (e: any) {
        setOptimisticDone(prev => { const n = new Set(prev); n.delete(taskId); return n })
        setError(e?.message ?? "Failed to complete task")
      }
    })
  }

  const overdueTasks = tasks.filter(t => isOverdue(t) && !optimisticDone.has(t.id))
  const activeTasks  = tasks.filter(t => !isOverdue(t) && t.status !== "completed" && !optimisticDone.has(t.id))
  const doneTasks    = tasks.filter(t => t.status === "completed" || optimisticDone.has(t.id))

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <CheckCircle2 className="w-10 h-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No auto-generated tasks</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Tasks will appear when stages advance</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Overdue */}
      {overdueTasks.length > 0 && (
        <section>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-destructive uppercase tracking-wide mb-3">
            <AlertCircle className="w-3.5 h-3.5" />
            Overdue ({overdueTasks.length})
          </h3>
          <div className="space-y-2">
            {overdueTasks.map(task => <TaskRow key={task.id} task={task} onComplete={handleComplete} isPending={isPending} optimisticDone={optimisticDone} />)}
          </div>
        </section>
      )}

      {/* Active */}
      {activeTasks.length > 0 && (
        <section>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            <Clock className="w-3.5 h-3.5" />
            Active ({activeTasks.length})
          </h3>
          <div className="space-y-2">
            {activeTasks.map(task => <TaskRow key={task.id} task={task} onComplete={handleComplete} isPending={isPending} optimisticDone={optimisticDone} />)}
          </div>
        </section>
      )}

      {/* Completed */}
      {doneTasks.length > 0 && (
        <section>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Completed ({doneTasks.length})
          </h3>
          <div className="space-y-2 opacity-60">
            {doneTasks.map(task => <TaskRow key={task.id} task={task} onComplete={handleComplete} isPending={isPending} optimisticDone={optimisticDone} />)}
          </div>
        </section>
      )}
    </div>
  )
}

function TaskRow({
  task,
  onComplete,
  isPending,
  optimisticDone,
}: {
  task: Task
  onComplete: (id: string) => void
  isPending: boolean
  optimisticDone: Set<string>
}) {
  const isDone = task.status === "completed" || optimisticDone.has(task.id)
  const now = new Date()
  const isOverdue = task.due_date && new Date(task.due_date) < now && !isDone

  return (
    <div className={cn(
      "rounded-lg border bg-card p-3",
      isOverdue ? "border-destructive/30" : "border-border",
    )}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          disabled={isDone || isPending}
          onClick={() => onComplete(task.id)}
          className="mt-0.5 flex-shrink-0 text-muted-foreground hover:text-emerald-600 transition-colors disabled:cursor-default"
          aria-label={isDone ? "Completed" : "Mark complete"}
        >
          {isPending && optimisticDone.has(task.id) ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isDone ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          ) : (
            <Circle className="w-4 h-4" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <p className={cn("text-sm font-medium", isDone && "line-through text-muted-foreground")}>
            {task.title}
          </p>
          {task.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{task.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {/* Owner role */}
            {task.owner_role && (
              <span className={cn(
                "px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase",
                ROLE_COLORS[task.owner_role] ?? "bg-muted text-muted-foreground border-border"
              )}>
                {task.owner_role}
              </span>
            )}

            {/* Priority */}
            {task.priority && (
              <span className={cn(
                "px-1.5 py-0.5 rounded border text-[10px] font-medium",
                PRIORITY_COLORS[task.priority] ?? "bg-muted text-muted-foreground border-border"
              )}>
                {task.priority}
              </span>
            )}

            {/* Due date */}
            {task.due_date && (
              <span className={cn(
                "text-[10px] font-medium",
                isOverdue ? "text-destructive" : "text-muted-foreground"
              )}>
                {isOverdue ? "Due " : ""}
                {new Date(task.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
