import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Calendar, CheckCircle2, Sparkles } from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { getTaskById } from "@/app/actions/tasks"
import { TaskRowActions } from "@/app/dashboard/admin/tasks/task-row-actions"
import { getPriorityColor, isTaskOverdue } from "@/lib/tasks/task-presentation"

/**
 * ONE TASK, BY ID — the page the daily brief's "Complete task" CTA and the
 * brief emails already sent point at (lib/intelligence/user-type-briefs/
 * index.ts `complete_task` → /dashboard/tasks/<id>).
 *
 * BUILT (orphan doctrine §1.2, lane G3 2026-09-03). The gate is the reader's
 * (app/actions/tasks.ts getTaskById): tenant from the session, then
 * assignee-or-tenant-admin. A refusal of any kind other than "not signed in"
 * renders as notFound() — the reader deliberately answers a forbidden id with
 * the same string as an absent one, and this page keeps that indistinguishable.
 *
 * The controls are the same TaskRowActions the admin board uses, so "done"
 * is written by ONE writer (completeTask, which stamps completed_at).
 */

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ taskId: string }>
}

function fmtDate(value: string | null, withTime = false): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return format(d, withTime ? "MMM d, yyyy 'at' h:mm a" : "MMM d, yyyy")
}

function statusLabel(status: string | null): string {
  switch (status) {
    case "in_progress":
      return "In progress"
    case "completed":
      return "Completed"
    case "cancelled":
      return "Cancelled"
    case "pending":
      return "Pending"
    default:
      return status || "Pending"
  }
}

export default async function TaskDetailPage({ params }: PageProps) {
  const { taskId } = await params
  const result = await getTaskById(taskId)

  if (!result.success) {
    if (result.error === "Not authenticated") redirect("/login")
    notFound()
  }

  const task = result.task
  const overdue = isTaskOverdue(task)
  const done = task.status === "completed" || task.status === "cancelled"
  const assignee = task.assigned_agent
    ? [task.assigned_agent.first_name, task.assigned_agent.last_name].filter(Boolean).join(" ").trim()
    : ""
  const dueDisplay = fmtDate(task.due_date)

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/tasks">
                <ArrowLeft className="h-4 w-4 mr-2" />
                All tasks
              </Link>
            </Button>
            <div className="h-8 w-px bg-border" />
            <div className="min-w-0">
              <h1 className="text-2xl font-bold truncate">{task.title}</h1>
              <p className="text-sm text-muted-foreground">{statusLabel(task.status)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        <Card className={overdue ? "border-red-200 dark:border-red-900/50" : undefined}>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={getPriorityColor(task.priority)}>{task.priority || "normal"}</Badge>
                <Badge variant="outline">{statusLabel(task.status)}</Badge>
                {task.auto_generated && (
                  <Badge variant="secondary" className="gap-1">
                    <Sparkles className="h-3 w-3" />
                    {task.source ? `Auto · ${task.source}` : "Auto-generated"}
                  </Badge>
                )}
                {!task.auto_generated && task.source && (
                  <Badge variant="secondary">{task.source}</Badge>
                )}
              </div>
              <TaskRowActions taskId={task.id} status={task.status} />
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {task.description ? (
              <p className="text-sm whitespace-pre-wrap">{task.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Due</dt>
                <dd className={`flex items-center gap-2 ${overdue ? "text-red-600 dark:text-red-400" : ""}`}>
                  <Calendar className="h-4 w-4" />
                  {dueDisplay ? (
                    <span>
                      {dueDisplay}
                      {!done && task.due_date && (
                        <span className="text-muted-foreground">
                          {" "}
                          ({overdue
                            ? `overdue by ${formatDistanceToNow(new Date(task.due_date))}`
                            : formatDistanceToNow(new Date(task.due_date), { addSuffix: true })})
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No due date</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Assigned to</dt>
                <dd>{assignee || <span className="text-muted-foreground">Unassigned</span>}</dd>
              </div>
              {task.completed_at && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Completed</dt>
                  <dd className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    {fmtDate(task.completed_at, true)}
                  </dd>
                </div>
              )}
              {task.stage_key && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Stage</dt>
                  <dd>{task.stage_key}</dd>
                </div>
              )}
              {task.created_at && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt>
                  <dd>{fmtDate(task.created_at, true)}</dd>
                </div>
              )}
              {Array.isArray(task.tags) && task.tags.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Tags</dt>
                  <dd className="flex flex-wrap gap-1.5 mt-1">
                    {task.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {(task.contact_id || task.listing_id || task.transaction_id) && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Related</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {task.contact_id && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/crm?contact=${task.contact_id}`}>Open contact</Link>
                </Button>
              )}
              {task.listing_id && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/dashboard/listings/${task.listing_id}`}>Open listing</Link>
                </Button>
              )}
              {task.transaction_id && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/dashboard/transactions/${task.transaction_id}`}>Open transaction</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
