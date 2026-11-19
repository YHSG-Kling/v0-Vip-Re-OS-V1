"use client"

/**
 * OPEN CLIENT QUESTIONS — the staff view on the client's portal Help page (wave 155, lane 155F; directive F1.6 / F1.7).
 *
 * When the assistant could not confirm a deal fact (clear to close, title, insurance, the closing date…) it opened ONE task for
 * the assigned agent: "Ask <lender / title> (not on the platform) and record the reply". This panel is where that reply is
 * recorded: the agent / TC / an admin picks what the outside party said; recordPortalQuestionReplyAction checks the seat, records
 * it as a sourced fact, re-answers the client on the portal (once) and closes the task with evidence. Rendered only for staff —
 * a client never sees it (app/portal/[contactId]/help/page.tsx decides).
 */
import { useState, useTransition } from "react"
import { recordPortalQuestionReplyAction } from "@/app/actions/education-tutor"

export interface OpenQuestionTask { id: string; title: string; question: string | null }

export function QuestionReplies({ tasks }: { tasks: OpenQuestionTask[] }) {
  const [done, setDone] = useState<Record<string, string>>({})
  const [pending, start] = useTransition()
  if (tasks.length === 0) return null
  return (
    <section className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/40" aria-label="Open client questions">
      <h2 className="mb-1 font-semibold">Open client questions (staff only)</h2>
      <p className="mb-3 text-sm text-muted-foreground">Record what the lender, title company or insurer told you. Their silence is not confirmation — record only what they actually said.</p>
      <ul className="space-y-3">
        {tasks.map((t) => (
          <li key={t.id} className="rounded-md border bg-background p-3">
            <p className="font-medium">{t.title}</p>
            {t.question && <p className="mt-1 text-sm text-muted-foreground">“{t.question}”</p>}
            {done[t.id] ? (
              <p className="mt-2 text-sm" role="status">{done[t.id]}</p>
            ) : (
              <form
                className="mt-2 flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const f = new FormData(e.currentTarget)
                  const status = String(f.get("status")) as "confirmed" | "not_yet" | "date"
                  start(async () => {
                    const r = await recordPortalQuestionReplyAction({ taskId: t.id, status, date: (f.get("date") as string) || null, note: (f.get("note") as string) || null })
                    setDone((d) => ({ ...d, [t.id]: r.ok ? (r.status === "closed" ? "Recorded — your client has been answered and the task is closed." : "Recorded — still not confirmed, the task stays open.") : `Not recorded: ${r.error ?? "please try again"}` }))
                  })
                }}
              >
                <label className="text-sm">They said
                  <select name="status" className="ml-1 rounded border px-2 py-1 text-sm" defaultValue="confirmed">
                    <option value="confirmed">Confirmed</option>
                    <option value="not_yet">Not confirmed yet</option>
                    <option value="date">Gave a date</option>
                  </select>
                </label>
                <label className="text-sm">Date <input type="date" name="date" className="ml-1 rounded border px-2 py-1 text-sm" /></label>
                <label className="text-sm">Private note <input name="note" maxLength={400} className="ml-1 rounded border px-2 py-1 text-sm" placeholder="not shown to the client" /></label>
                <button type="submit" disabled={pending} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50">Record reply</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
