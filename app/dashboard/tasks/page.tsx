import Link from "next/link"
import { redirect } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Calendar, CheckCircle2, Clock, Sparkles, Sun } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getTasks, type TaskWithAssignee } from "@/app/actions/tasks"
import { TaskRowActions } from "@/app/dashboard/admin/tasks/task-row-actions"
import { groupTasksByDue, getPriorityColor } from "@/lib/tasks/task-presentation"

/**
 * THE AGENT-FACING TASK LIST.
 *
 * BUILT (orphan doctrine §1.2, lane G3 2026-09-03). Before this page the only
 * surface over the `tasks` table was app/dashboard/admin/tasks — admin/broker
 * only — and /tasks was an alias that redirected to /dashboard, so an agent
 * with forty machine-minted tasks had nowhere to see them. The reader
 * (getTasks) and the three row controls (TaskRowActions → updateTask /
 * completeTask / deleteTask) already existed; this is the door.
 *
 * SCOPE IS THE READER'S, NOT THIS PAGE'S: getTasks() with no params pins the
 * tenant from the session and, for a non-admin seat, the assignee to the
 * session's own agents.id. A tenant admin (isAdminOrBroker — team_lead is in
 * that roster) sees the whole brokerage, which is the same rule the admin
 * board applies. No second scoping rule here.
 *
 * `source` and `auto_generated` are rendered so an agent can tell a task a
 * person wrote from one the kernel / AI minted.
 */

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Tasks | Dashboard",
  description: "Your open tasks — overdue, due today, upcoming, and done",
}

// getTasks has no declared return type, so its `success: true` widens to
// boolean and an Extract<> on it collapses to never; the row shape it returns
// is the one getTaskById declares.
type TaskRow = TaskWithAssignee

function assigneeName(t: TaskRow): string | null {
  const a = t.assigned_agent
  if (!a) return null
  const name = [a.first_name, a.last_name].filter(Boolean).join(" ").trim()
  return name || null
}

function DueLine({ task, overdue }: { task: TaskRow; overdue: boolean }) {
  if (!task.due_date) return null
  const d = new Date(task.due_date)
  if (Number.isNaN(d.getTime())) return null
  return (
    <div
      className={`flex items-center gap-2 text-xs ${overdue ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
    >
      <Calendar className="h-3 w-3" />
      {overdue
        ? `Overdue by ${formatDistanceToNow(d)}`
        : `Due ${formatDistanceToNow(d, { addSuffix: true })}`}
    </div>
  )
}

function TaskRowCard({
  task,
  tone,
  showAssignee,
}: {
  task: TaskRow
  tone: "overdue" | "today" | "upcoming" | "done"
  showAssignee: boolean
}) {
  const rowClass =
    tone === "overdue"
      ? "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
      : tone === "today"
        ? "bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800"
        : tone === "done"
          ? "bg-muted/30 border opacity-75"
          : "bg-muted/50 border"
  const name = showAssignee ? assigneeName(task) : null
  return (
    <div className={`flex items-center justify-between gap-4 p-4 rounded-lg ${rowClass}`}>
      <div className="min-w-0 space-y-1">
        <Link
          href={`/dashboard/tasks/${task.id}`}
          className="font-medium hover:underline underline-offset-4 block truncate"
        >
          {task.title}
        </Link>
        {task.description && (
          <p className="text-sm text-muted-foreground line-clamp-1">{task.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <DueLine task={task} overdue={tone === "overdue"} />
          {task.status === "in_progress" && (
            <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
              <Clock className="h-3 w-3" /> In progress
            </span>
          )}
          {task.auto_generated && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              {task.source ? `Auto · ${task.source}` : "Auto-generated"}
            </span>
          )}
          {!task.auto_generated && task.source && (
            <span className="text-xs text-muted-foreground">{task.source}</span>
          )}
          {name && <span className="text-xs text-muted-foreground">Assigned to {name}</span>}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <Badge className={getPriorityColor(task.priority)}>{task.priority || "normal"}</Badge>
        <TaskRowActions taskId={task.id} status={task.status} />
      </div>
    </div>
  )
}

function Bucket({
  title,
  description,
  icon,
  tasks,
  tone,
  showAssignee,
  cardClass,
  titleClass,
}: {
  title: string
  description: string
  icon: React.ReactNode
  tasks: TaskRow[]
  tone: "overdue" | "today" | "upcoming" | "done"
  showAssignee: boolean
  cardClass?: string
  titleClass?: string
}) {
  if (tasks.length === 0) return null
  return (
    <Card className={cardClass}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className={titleClass}>
            {title} ({tasks.length})
          </CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {tasks.map((task) => (
            <TaskRowCard key={task.id} task={task} tone={tone} showAssignee={showAssignee} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default async function TasksPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")

  const result = await getTasks()

  if (!result.success) {
    // A refusal renders as a refusal — never as "no tasks" (§4 fail closed).
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-4">Tasks</h1>
        <Card className="border-destructive/40">
          <CardContent className="py-8 text-center text-sm text-destructive">
            {result.error ?? "Your tasks could not be loaded."}
          </CardContent>
        </Card>
      </div>
    )
  }

  const tasks = result.tasks as TaskRow[]
  const { overdue, today, upcoming, done } = groupTasksByDue(tasks)
  // A tenant admin sees the whole brokerage (getTasks' rule), so the assignee
  // column matters there; on an agent's own list it is always themselves.
  const showAssignee = tasks.some((t) => t.assigned_to_agent_id !== ctx.agentId)
  const openCount = overdue.length + today.length + upcoming.length

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <h1 className="text-2xl font-bold">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            {openCount} open · {done.length} done
          </p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <Bucket
          title="Overdue"
          description="Past their due date"
          icon={<AlertTriangle className="h-5 w-5 text-red-500" />}
          tasks={overdue}
          tone="overdue"
          showAssignee={showAssignee}
          cardClass="border-red-200 dark:border-red-900/50"
          titleClass="text-red-600 dark:text-red-400"
        />
        <Bucket
          title="Due today"
          description="Due before the day is out"
          icon={<Sun className="h-5 w-5 text-amber-500" />}
          tasks={today}
          tone="today"
          showAssignee={showAssignee}
        />
        <Bucket
          title="Upcoming"
          description="Due later, or with no due date yet"
          icon={<Clock className="h-5 w-5 text-slate-500" />}
          tasks={upcoming}
          tone="upcoming"
          showAssignee={showAssignee}
        />
        <Bucket
          title="Done"
          description="Completed or cancelled"
          icon={<CheckCircle2 className="h-5 w-5 text-green-500" />}
          tasks={done}
          tone="done"
          showAssignee={showAssignee}
        />

        {tasks.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
              <h3 className="text-lg font-semibold">All Caught Up</h3>
              <p className="text-muted-foreground">No tasks on your list right now.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
