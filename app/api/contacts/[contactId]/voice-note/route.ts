import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { parseVoiceNote } from "@/lib/contacts/voice-note-parser"

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
  })

  const stamp = new Date().toISOString()
  const appendedNote = `[${stamp.slice(0, 10)}] ${parsed.noteBody}`
  const newNotes = contact.notes ? `${contact.notes}\n\n${appendedNote}` : appendedNote

  await supabase
    .from("contacts")
    .update({ notes: newNotes, last_contacted_at: stamp })
    .eq("id", contactId)

  await supabase.from("activities").insert({
    contact_id: contactId,
    brokerage_id: auth.brokerageId,
    agent_id: auth.agentId,
    activity_type: "voice_note",
    description: parsed.noteBody.slice(0, 500),
    metadata: { sentiment: parsed.sentiment, nextStep: parsed.nextStep, transcriptHash: transcript.length },
    occurred_at: stamp,
  })

  const createdTasks: Array<{ id: string; title: string; due_date: string | null }> = []
  for (const t of parsed.tasks) {
    const due = t.dueInDays != null
      ? new Date(Date.now() + t.dueInDays * 86_400_000).toISOString().slice(0, 10)
      : null
    const { data: row } = await supabase
      .from("tasks")
      .insert({
        contact_id: contactId,
        brokerage_id: auth.brokerageId,
        agent_id: auth.agentId,
        assigned_to: auth.userId,
        title: t.title,
        priority: t.priority,
        status: "open",
        due_date: due,
        source: "voice_note",
      })
      .select("id, title, due_date")
      .single()
    if (row) createdTasks.push(row as any)
  }

  return NextResponse.json({
    success: true,
    note: parsed.noteBody,
    sentiment: parsed.sentiment,
    nextStep: parsed.nextStep,
    tasks: createdTasks,
  })
}
