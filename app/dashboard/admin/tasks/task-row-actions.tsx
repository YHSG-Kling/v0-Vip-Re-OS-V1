"use client"

/**
 * THE ADMIN TASK QUEUE'S MISSING HALF.
 *
 * app/dashboard/admin/tasks/page.tsx renders every open task in the brokerage —
 * overdue, in progress, pending — and offered NOTHING to do about any of them.
 * It was a board you could read and not touch: no start, no complete, no
 * remove. The capabilities it needed already existed and had no caller
 * (app/actions/tasks.ts:updateTask and :deleteTask), which is the orphan
 * doctrine's second case exactly — the capability is built, the door is not.
 *
 * WHY THESE THREE CONTROLS AND NOT MORE:
 *
 *   Start     → updateTask({ status: "in_progress" }). The one transition the
 *               board itself already renders a column for.
 *   Complete  → completeTask(). NOT updateTask({ status: "completed" }), even
 *               though updateTask would accept it: completeTask is the writer
 *               that also stamps `completed_at`, and a second path that sets the
 *               status without the timestamp would be a second writer that
 *               disagrees with the first about what "done" records.
 *   Remove    → deleteTask(). Counted, not assumed: the action `.select()`s the
 *               delete and refuses on zero rows, so a task belonging to another
 *               tenant cannot report success (CLAUDE.md §3 — a DELETE that
 *               matches nothing resolves exactly like one that worked).
 *
 * REASSIGNMENT IS DELIBERATELY NOT HERE. updateTask supports it and gates it
 * (current assignee, creator, or broker/admin), but it needs an agent roster
 * this page does not load, and half a picker is worse than none.
 *
 * Every outcome is READ. A refusal renders as a refusal — `updateTask` and
 * `deleteTask` both return `{ success: false, error }` rather than throwing for
 * the ordinary refusals ("Task not found in your brokerage", the act-as
 * read-only refusal), so a component that ignored the return value would show a
 * silent no-op as a success.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, Play, Check, Trash2 } from "lucide-react"
import { updateTask, deleteTask, completeTask } from "@/app/actions/tasks"

type Busy = "start" | "complete" | "delete" | null

export function TaskRowActions({
  taskId,
  status,
}: {
  taskId: string
  status: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [isPending, startTransition] = useTransition()

  function run(which: Exclude<Busy, null>, fn: () => Promise<{ success: boolean; error?: string }>) {
    setError(null)
    setBusy(which)
    startTransition(async () => {
      try {
        const res = await fn()
        if (!res?.success) {
          // A refusal is not a completed action. The row stays where it is and
          // says why.
          setError(res?.error ?? "That did not go through.")
          return
        }
        setConfirmingDelete(false)
        router.refresh()
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "That did not go through.")
      } finally {
        setBusy(null)
      }
    })
  }

  const disabled = isPending || busy !== null

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        {status !== "in_progress" && status !== "completed" && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => run("start", () => updateTask({ taskId, status: "in_progress" }))}
          >
            {busy === "start" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">Start</span>
          </Button>
        )}

        {status !== "completed" && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => run("complete", () => completeTask(taskId))}
          >
            {busy === "complete" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">Complete</span>
          </Button>
        )}

        {confirmingDelete ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={disabled}
              onClick={() => run("delete", () => deleteTask(taskId))}
            >
              {busy === "delete" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5">Confirm</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              setError(null)
              setConfirmingDelete(true)
            }}
            aria-label="Remove this task"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive max-w-[16rem] text-right">{error}</p>
      )}
    </div>
  )
}
