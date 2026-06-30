// ─── VOICE TASK COMMAND (the broken "create a task / remind me" intents) ───────
// The voice admin classified create_task / schedule_followup but had NO handler —
// the broker spoke "create a task to call the lender Friday" and got a vague
// deflection, no task. This module is the pure, testable core that turns a spoken
// task command into the canonical `tasks` insert (same shape the ElevenLabs
// create_task tool writes), with deterministic relative-date resolution so "Friday"
// / "tomorrow" / "in 3 days" become a real due date without an LLM round-trip.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function addDays(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return toIso(d)
}

/**
 * Resolve a spoken relative due-date phrase to an ISO date (YYYY-MM-DD), given today.
 * Deterministic — no LLM, no Date.now (today is passed in). Returns null when there's
 * no recognizable date (an undated task is valid). Pure.
 */
export function parseRelativeDueDate(phrase: string | null | undefined, today: string): string | null {
  const p = String(phrase ?? "").trim().toLowerCase()
  if (!p || p === "none" || p === "no" || p === "n/a") return null

  // Already an ISO date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p

  if (p === "today" || p === "tonight" || p === "this evening") return today
  if (p === "tomorrow") return addDays(today, 1)
  if (p === "day after tomorrow") return addDays(today, 2)

  const inN = p.match(/in (\d+) days?/)
  if (inN) return addDays(today, Math.max(1, parseInt(inN[1], 10)))

  if (p === "next week") return addDays(today, 7)
  if (p === "end of week" || p === "eow" || p === "end of the week") {
    // Upcoming Friday (or today if today is Friday).
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay()
    const delta = (5 - dow + 7) % 7
    return addDays(today, delta)
  }

  // A weekday name → its next occurrence (strictly after today; +7 if today is that day).
  const wd = WEEKDAYS.findIndex((d) => p === d || p === `next ${d}` || p === `this ${d}`)
  if (wd >= 0) {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay()
    let delta = (wd - dow + 7) % 7
    if (delta === 0 || p.startsWith("next ")) delta = delta === 0 ? 7 : delta
    return addDays(today, delta)
  }

  return null
}

export interface VoiceTaskInput {
  title: string
  dueDate: string | null
  contactId: string | null
  brokerageId: string
  /** agents.id (NOT users.id) — tasks.assigned_to_agent_id/created_by_agent_id FK → agents.id. */
  agentId: string
  /** schedule_followup vs create_task — both create a task; this tags the title default. */
  isFollowUp?: boolean
}

export interface VoiceTaskRow {
  brokerage_id: string
  assigned_to_agent_id: string
  created_by_agent_id: string
  title: string
  priority: string
  status: string
  due_date?: string
  contact_id?: string
}

/**
 * Build the canonical `tasks` insert row (mirrors the ElevenLabs create_task tool:
 * brokerage_id / assigned_to_agent_id / created_by_agent_id / title / priority /
 * status / due_date? / contact_id?). Pure. Empty/whitespace titles fall back to a
 * sensible default so a recognized command never inserts a blank task.
 */
export function buildVoiceTaskRow(input: VoiceTaskInput): VoiceTaskRow {
  const title = input.title?.trim() || (input.isFollowUp ? "Follow up" : "New task")
  const row: VoiceTaskRow = {
    brokerage_id: input.brokerageId,
    assigned_to_agent_id: input.agentId,
    created_by_agent_id: input.agentId,
    title,
    priority: "normal",
    status: "pending",
  }
  if (input.dueDate) row.due_date = input.dueDate
  if (input.contactId) row.contact_id = input.contactId
  return row
}

/** Spoken confirmation for a created task. Pure. */
export function spokenTaskConfirmation(title: string, dueDate: string | null, contactName: string | null): string {
  const who = contactName ? ` for ${contactName}` : ""
  if (dueDate) {
    const d = new Date(`${dueDate}T00:00:00Z`)
    const pretty = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })
    return `Done — I added the task "${title}"${who}, due ${pretty}.`
  }
  return `Done — I added the task "${title}"${who}.`
}
