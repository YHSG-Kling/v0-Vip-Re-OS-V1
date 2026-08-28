import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { parseVoiceNote } from "@/lib/contacts/voice-note-parser"
import { bestEffort } from "@/lib/db/best-effort"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/contacts/[contactId]/voice-note
 *
 * Body: { transcript: string }
 *
 * Parses the agent's dictation, appends a structured note to the contact,
 * creates any explicit follow-up tasks, and returns a summary so the UI can
 * confirm what was captured before the agent moves on.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const { contactId } = await params
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const body = await req.json().catch(() => ({}))
  const transcript = String(body?.transcript ?? "").trim()
  if (!transcript) {
    return NextResponse.json({ error: "transcript required" }, { status: 400 })
  }

  // Brokerage scope check.
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id, first_name, last_name, contact_type, notes")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact || contact.brokerage_id !== auth.brokerageId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const parsed = await parseVoiceNote(transcript, {
    contactName: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || undefined,
    contactType: contact.contact_type ?? null,
    // §4 — from requireAuth, and the contact above was checked against it.
    brokerageId: auth.brokerageId,
    userId: auth.userId,
  })

  const stamp = new Date().toISOString()
  const appendedNote = `[${stamp.slice(0, 10)}] ${parsed.noteBody}`
  const newNotes = contact.notes ? `${contact.notes}\n\n${appendedNote}` : appendedNote

  await bestEffort(
    supabase
      .from("contacts")
      .update({ notes: newNotes, last_contacted_at: stamp })
      .eq("id", contactId),
    "one-line notes stamp + recency; the dictated note's real home is the activities row inserted below, whose error IS checked, so a refused stamp does not lose the agent's words",
  )

  // The transcript summary lives ONLY here — the contacts.notes append above is
  // a one-line stamp. A lost row loses the note the agent just dictated.
  const { error: voiceNoteActivityError } = await supabase.from("activities").insert({
    contact_id: contactId,
    brokerage_id: auth.brokerageId,
    agent_id: auth.agentId,
    activity_type: "voice_note",
    title: "Voice note captured",
    description: parsed.noteBody.slice(0, 500),
    notes: JSON.stringify({
      sentiment: parsed.sentiment,
      nextStep: parsed.nextStep,
      transcriptLength: transcript.length,
    }),
    completed_at: stamp,
    status: "completed",
    channel: "voice",
    entity_type: "contact",
  })
  if (voiceNoteActivityError) {
    console.error("[voice-note] voice_note activity REJECTED — the dictated note was NOT saved:", voiceNoteActivityError.message)
  }
  // …AND THE CALLER IS TOLD. The console line above is the only place that
  // refusal used to go: the response was `{ success: true }` either way, so the
  // agent who just dictated a note would be told it was captured while the only
  // row that carries their words had been refused. Nothing in the tree addressed
  // this route until now, so no caller regresses — but a door was being built
  // onto it, and a door that reports success over an unread refusal is the
  // defect this repo has shipped before. The transcript summary still rides the
  // note append above, hence "partially" rather than an outright failure.
  const noteRecorded = !voiceNoteActivityError

  const createdTasks: Array<{ id: string; title: string; due_date: string | null }> = []
  for (const t of parsed.tasks) {
    const due = t.dueInDays != null
      ? new Date(Date.now() + t.dueInDays * 86_400_000).toISOString().slice(0, 10)
      : null
    // §3 — supabase-js RESOLVES refusals. This insert used to destructure only
    // `data`, so a refused task (a CHECK on priority/status, a missing agents
    // row behind either agent_id FK, RLS) silently produced a shorter list and
    // the caller could not tell "the agent mentioned no follow-up" from "the
    // follow-up they DID mention was refused".
    const { data: row, error: taskError } = await supabase
      .from("tasks")
      .insert({
        contact_id: contactId,
        brokerage_id: auth.brokerageId,
        created_by_agent_id: auth.agentId,
        assigned_to_agent_id: auth.agentId,
        title: t.title,
        priority: t.priority,
        status: "open",
        due_date: due,
        auto_generated: true,
      })
      .select("id, title, due_date")
      .single()
    if (taskError) {
      console.error(`[voice-note] follow-up task REJECTED (“${t.title}”):`, taskError.message)
    }
    if (row) createdTasks.push(row as any)
  }

  return NextResponse.json({
    success: true,
    note: parsed.noteBody,
    sentiment: parsed.sentiment,
    nextStep: parsed.nextStep,
    tasks: createdTasks,
    /** false ⇒ the `voice_note` activities row was refused; the note survives
     *  only as the one-line stamp on contacts.notes. */
    noteRecorded,
    /** How many follow-up tasks the parser ASKED for, so a caller can see that
     *  a requested task did not come back as a created row rather than reading
     *  an empty list as "the agent mentioned no follow-up". */
    tasksRequested: parsed.tasks.length,
  })
}
