/**
 * ONE due-date bucketing rule and ONE priority colour for every `tasks`
 * surface (§6 — one vocabulary per function).
 *
 * HOISTED (2026-09-03, lane G3) from app/dashboard/admin/tasks/page.tsx:42-59,
 * where the overdue filter and getPriorityColor lived inline, when the
 * agent-facing list at app/dashboard/tasks/page.tsx needed the same two
 * rules. Copying them would have been a second spelling that the two boards
 * could drift apart on; the admin board now imports these.
 *
 * WHY DAY KEYS AND NOT `new Date(due_date) < new Date()`: `tasks.due_date` is
 * written as a plain `YYYY-MM-DD` by some writers (the voice-note follow-up,
 * the AI task minters) and as a full ISO timestamp by others (createTask
 * passes the caller's string through). `new Date("2026-09-03")` is UTC
 * midnight, which in every US timezone is the previous EVENING — so the
 * inline rule read a task due today as overdue for the whole day. Comparing
 * calendar-day keys in the server's local day makes "due today" and "overdue"
 * mean what an agent expects, for both spellings of the column.
 *
 * STATUS VOCABULARY (no CHECK on the column; de facto, see app/actions/tasks.ts
 * updateTask's signature): pending | in_progress | completed | cancelled.
 * A `completed` or `cancelled` task is never overdue.
 */

export interface TaskDueFields {
  due_date: string | null
  status: string | null
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Local calendar-day key (YYYY-MM-DD) for a Date. */
export function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/**
 * Calendar-day key for a due_date value in either spelling, or null when the
 * value is absent or unparseable (an unparseable date is "no due date", never
 * "overdue" — fail toward the quieter bucket).
 */
export function dueDayKey(due: string | null | undefined): string | null {
  if (!due) return null
  if (PLAIN_DATE.test(due)) return due
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return null
  return localDayKey(d)
}

export function isTaskDone(t: Pick<TaskDueFields, "status">): boolean {
  return t.status === "completed" || t.status === "cancelled"
}

export function isTaskOverdue(t: TaskDueFields, now: Date = new Date()): boolean {
  if (isTaskDone(t)) return false
  const key = dueDayKey(t.due_date)
  return key !== null && key < localDayKey(now)
}

export function isTaskDueToday(t: TaskDueFields, now: Date = new Date()): boolean {
  if (isTaskDone(t)) return false
  return dueDayKey(t.due_date) === localDayKey(now)
}

/**
 * The four buckets the agent-facing list renders. Every task lands in exactly
 * one; order inside a bucket is the caller's (getTasks orders by due_date asc).
 */
export function groupTasksByDue<T extends TaskDueFields>(
  tasks: T[],
  now: Date = new Date(),
): { overdue: T[]; today: T[]; upcoming: T[]; done: T[] } {
  const overdue: T[] = []
  const today: T[] = []
  const upcoming: T[] = []
  const done: T[] = []
  for (const t of tasks) {
    if (isTaskDone(t)) done.push(t)
    else if (isTaskOverdue(t, now)) overdue.push(t)
    else if (isTaskDueToday(t, now)) today.push(t)
    else upcoming.push(t)
  }
  return { overdue, today, upcoming, done }
}

/**
 * Badge classes by priority. `urgent` is in the priority vocabulary
 * (app/actions/tasks.ts updateTask/createTask) but the inline admin version
 * had no case for it, so it fell to the neutral colour — the loudest priority
 * rendered the quietest. It now shares high's red.
 */
export function getPriorityColor(priority: string | null | undefined): string {
  switch (priority) {
    case "urgent":
    case "high":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
    case "medium":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
    default:
      return "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-400"
  }
}
