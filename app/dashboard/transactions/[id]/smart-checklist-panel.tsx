"use client"

/**
 * SMART CHECKLIST — the surface for smart_checklists / task_items.
 *
 * The AI wrote per-deal compliance checklists (generateSmartChecklist,
 * lib/application/transactions.ts) with owners, priorities and deadlines — and
 * NO human could see any of it. The only reader tree-wide was the health
 * counter's `select("completed, due_date")`, and the GENERATOR itself had zero
 * .tsx callers, so the capability was unreachable from both ends: nothing could
 * make a checklist and nothing could show one.
 *
 * This card is both halves:
 *   · the reader — every checklist + task on this deal (title, description,
 *     owner, priority, due date, done);
 *   · the completion writer task_items never had — a checkbox per task, landing
 *     on a COUNTED tenant-scoped update (an UPDATE that matches nothing resolves
 *     identically to one that worked, so the action counts what came back);
 *   · the "Generate checklist" control, wired to the existing generator.
 *
 * HONESTY CONTRACT (copied from ai-coordinator-panel.tsx): every control
 * reports the server's verdict — proposed vs created vs skipped — and a refused
 * read renders as a refusal, never as an empty checklist.
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertTriangle, ClipboardCheck, Loader2 } from "lucide-react"
import { format } from "date-fns"
import {
  generateSmartChecklist,
  getSmartChecklists,
  setTaskItemCompleted,
} from "@/app/actions/transactions"

interface ChecklistRow {
  id: string
  checklist_type: string | null
  total_items: number | null
  completed_items: number | null
  percent_complete: number | null
  auto_generated: boolean | null
  created_at: string | null
}

interface TaskRow {
  id: string
  checklist_id: string
  title: string | null
  description: string | null
  assigned_to: string | null
  priority: string | null
  due_date: string | null
  completed: boolean | null
  completed_at: string | null
  created_at: string | null
}

/** What the server said. Never a hard-coded "Success!". */
interface Verdict {
  ok: boolean
  headline: string
  skipped?: string[]
}

const PRIORITY_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-700",
  high: "bg-amber-100 text-amber-700",
  medium: "bg-blue-100 text-blue-700",
  low: "bg-gray-100 text-gray-600",
}

export function SmartChecklistPanel({
  transactionId,
  stage,
}: {
  transactionId: string
  stage: string | null
}) {
  const [pending, startTransition] = useTransition()
  const [generating, setGenerating] = useState(false)

  const [checklists, setChecklists] = useState<ChecklistRow[]>([])
  const [tasks, setTasks] = useState<TaskRow[]>([])
  // Three-state read: null = loaded fine; string = the read was REFUSED and the
  // card says so instead of rendering a reassuring empty list.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const [generateVerdict, setGenerateVerdict] = useState<Verdict | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = async () => {
    const res = await getSmartChecklists(transactionId)
    if (!res.success) {
      setLoadError(res.error ?? "Could not load the checklist.")
      setChecklists([])
      setTasks([])
      setLoaded(true)
      return
    }
    setLoadError(null)
    setChecklists(res.checklists as ChecklistRow[])
    setTasks(res.items as TaskRow[])
    setLoaded(true)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId])

  const runGenerate = () => {
    setGenerating(true)
    setGenerateVerdict(null)
    startTransition(async () => {
      const res: any = await generateSmartChecklist(transactionId, stage ?? "current")
      setGenerating(false)
      if (!res?.success) {
        setGenerateVerdict({
          ok: false,
          headline: res?.error ?? "Checklist generation failed.",
          skipped: res?.skipped,
        })
        await load()
        return
      }
      const created = res.createdCount ?? 0
      const proposed = res.proposedCount ?? 0
      setGenerateVerdict({
        ok: created > 0,
        headline:
          created > 0
            ? `${created} of ${proposed} proposed task${proposed === 1 ? "" : "s"} written to this deal.`
            : `The model proposed ${proposed} task${proposed === 1 ? "" : "s"} and NONE were written.`,
        skipped: res.skipped,
      })
      await load()
    })
  }

  const toggleTask = (task: TaskRow, next: boolean) => {
    setToggleError(null)
    setTogglingId(task.id)
    startTransition(async () => {
      const res: any = await setTaskItemCompleted(task.id, transactionId, next)
      setTogglingId(null)
      if (!res?.success) {
        // The server refused (wrong tenant, gone task, RLS) — the box does NOT
        // flip. A zero-row update is reported as exactly that.
        setToggleError(res?.error ?? "The task was not updated.")
        return
      }
      if (res.rollupError) {
        setToggleError(`Task saved, but the checklist counters were not: ${res.rollupError}`)
      }
      await load()
    })
  }

  const isOverdue = (t: TaskRow) =>
    !t.completed && !!t.due_date && new Date(t.due_date) < new Date()

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-emerald-600" />
              Smart Checklist
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              The AI-generated task list for this deal — owners, priorities and deadlines, with
              the database&apos;s own verdict on every write.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={runGenerate} disabled={pending}>
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            {checklists.length === 0 ? "Generate checklist" : "Generate another"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {generateVerdict ? (
          <Alert variant={generateVerdict.ok ? "default" : "destructive"}>
            <AlertDescription className="text-xs space-y-1">
              <p className="font-medium">{generateVerdict.headline}</p>
              {generateVerdict.skipped && generateVerdict.skipped.length > 0 ? (
                <ul className="list-disc pl-4 space-y-0.5">
                  {generateVerdict.skipped.map((s, i) => (
                    <li key={i} className="text-[11px] break-words">{s}</li>
                  ))}
                </ul>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {toggleError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            <AlertDescription className="text-xs">{toggleError}</AlertDescription>
          </Alert>
        ) : null}

        {/* The read's own verdict — a refusal is a refusal, not an empty list. */}
        {loadError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            <AlertDescription className="text-xs">
              The checklist could not be loaded: {loadError}
            </AlertDescription>
          </Alert>
        ) : !loaded ? (
          <p className="text-xs text-muted-foreground">Loading checklist…</p>
        ) : checklists.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No checklist on this deal yet — generate one for the <b>{stage ?? "current"}</b> stage.
          </p>
        ) : (
          checklists.map((cl) => {
            const clTasks = tasks.filter((t) => t.checklist_id === cl.id)
            const done = clTasks.filter((t) => t.completed).length
            return (
              <div key={cl.id} className="border rounded">
                <div className="flex items-center gap-2 flex-wrap px-2 py-1.5 border-b bg-muted/40">
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {(cl.checklist_type ?? "checklist").replace(/_/g, " ")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {done} of {clTasks.length} done
                  </span>
                  {cl.created_at ? (
                    <span className="text-[11px] text-muted-foreground ml-auto">
                      {format(new Date(cl.created_at), "MMM d, yyyy")}
                    </span>
                  ) : null}
                </div>
                {clTasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-2 py-2">
                    This checklist has no tasks on record.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {clTasks.map((t) => (
                      <li key={t.id} className="px-2 py-1.5 flex items-start gap-2 text-xs">
                        <Checkbox
                          className="mt-0.5"
                          checked={!!t.completed}
                          disabled={pending && togglingId === t.id}
                          onCheckedChange={(v) => toggleTask(t, v === true)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={t.completed ? "line-through text-muted-foreground" : "font-medium"}>
                              {t.title ?? "(untitled task)"}
                            </span>
                            {t.priority ? (
                              <Badge className={`text-[10px] capitalize ${PRIORITY_STYLE[t.priority] ?? "bg-gray-100 text-gray-600"}`}>
                                {t.priority}
                              </Badge>
                            ) : null}
                            {t.assigned_to ? (
                              <Badge variant="outline" className="text-[10px] capitalize">
                                {t.assigned_to}
                              </Badge>
                            ) : null}
                            {t.due_date ? (
                              <span className={isOverdue(t) ? "text-red-600 font-medium" : "text-muted-foreground"}>
                                due {format(new Date(t.due_date), "MMM d")}
                                {isOverdue(t) ? " — overdue" : ""}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">no deadline on record</span>
                            )}
                          </div>
                          {t.description ? (
                            <p className="text-muted-foreground mt-0.5">{t.description}</p>
                          ) : null}
                          {t.completed && t.completed_at ? (
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              completed {format(new Date(t.completed_at), "MMM d, yyyy h:mm a")}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
