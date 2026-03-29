import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateText } from "ai"
import { openai } from "@ai-sdk/openai"
import { NextRequest, NextResponse } from "next/server"

const NOTE_TYPE_TITLE: Record<string, string> = {
  general: "Note",
  call_outcome: "Call Outcome",
  meeting_outcome: "Meeting Outcome",
  follow_up: "Follow-Up Note",
  decision: "Decision Recorded",
  action_item: "Action Item",
  loan_update: "Loan Update",
  vendor_update: "Vendor Update",
  observation: "Observation",
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Resolve role, brokerage, vendor_id
  const { data: roleRow } = await supabase
    .from("user_role_assignments")
    .select("role, brokerage_id, vendor_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle()
  const { data: userData } = await supabase
    .from("users")
    .select("role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const role = (roleRow?.role ?? userData?.role ?? "agent").toLowerCase()
  const brokerageId = (roleRow?.brokerage_id ?? userData?.brokerage_id) as string
  const vendorId = (roleRow?.vendor_id ?? null) as string | null

  const body = await req.json()
  const { action } = body as { action: string }
  const service = createServiceClient()

  // ── ACTION: prepare_note ───────────────────────────────────────────────────
  if (action === "prepare_note") {
    const { rawText, conversationContext } = body as {
      rawText: string
      conversationContext: string
    }

    const extraTypes =
      role === "lender"
        ? "loan_update"
        : role === "vendor"
        ? "vendor_update"
        : "observation"

    const systemPrompt = `You are a note preparation assistant for a real estate professional (role: ${role}).
Given raw note text and conversation context, return ONLY a valid JSON object (no markdown, no extra text):
{
  "noteText": "polished, clear version of the note (max 500 chars, present tense, professional)",
  "noteType": "one of: general|call_outcome|meeting_outcome|follow_up|decision|action_item|${extraTypes}",
  "entityType": "one of: contact|lead|transaction|general",
  "entityId": "uuid extracted from context, or null",
  "entityLabel": "human-readable name e.g. 'John Smith' or '123 Main St deal', or null",
  "confidence": "high if entity confidently identified from context, low otherwise",
  "hasActionItem": true or false,
  "suggestedTaskTitle": "short imperative task title if hasActionItem is true, else null"
}

Rules:
- Prefer 'contact' entityType when the note is about a specific person in the CRM
- Prefer 'lead' entityType when the note is about an unqualified incoming lead
- Use 'loan_update' only for lender role, 'vendor_update' only for vendor role
- If entity cannot be confidently resolved, use entityType='general', entityId=null, confidence='low'
- hasActionItem=true when note contains a follow-up promise or action to complete`

    try {
      const { text } = await generateText({
        model: openai("gpt-4o-mini"),
        system: systemPrompt,
        prompt: `Raw note: "${rawText}"\n\nConversation context:\n${conversationContext}`,
        maxOutputTokens: 512,
      })

      const result = JSON.parse(text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, ""))
      return NextResponse.json({
        noteText: result.noteText ?? rawText,
        noteType: result.noteType ?? "general",
        entityType: result.entityType ?? "general",
        entityId: result.entityId ?? null,
        entityLabel: result.entityLabel ?? null,
        confidence: result.confidence ?? "low",
        hasActionItem: result.hasActionItem ?? false,
        suggestedTaskTitle: result.suggestedTaskTitle ?? null,
      })
    } catch {
      return NextResponse.json({
        noteText: rawText,
        noteType: "general",
        entityType: "general",
        entityId: null,
        entityLabel: null,
        confidence: "low",
        hasActionItem: false,
        suggestedTaskTitle: null,
      })
    }
  }

  // ── ACTION: save_note ──────────────────────────────────────────────────────
  if (action === "save_note") {
    const {
      noteText,
      noteType,
      entityType,
      entityId,
      sessionId,
      contentHash,
      createTask,
      taskTitle,
    } = body as {
      noteText: string
      noteType: string
      entityType: string
      entityId: string | null
      sessionId: string | null
      contentHash: string
      createTask: boolean
      taskTitle?: string
    }

    // ── Dedupe check ─────────────────────────────────────────────────────────
    if (contentHash) {
      const windowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      const { data: existing } = await service
        .from("ai_assistant_notes")
        .select("id")
        .eq("created_by", user.id)
        .eq("content_hash", contentHash)
        .gte("created_at", windowStart)
        .limit(1)
        .maybeSingle()

      if (existing) {
        return NextResponse.json({ success: true, duplicate: true, noteId: existing.id })
      }
    }

    // Resolve entity FK columns
    const contactId = entityType === "contact" ? entityId : null
    const transactionId = entityType === "transaction" ? entityId : null
    const leadId = entityType === "lead" ? entityId : null

    // ── 1. ai_assistant_notes (always) ────────────────────────────────────────
    const { data: noteRow, error: noteErr } = await service
      .from("ai_assistant_notes")
      .insert({
        note_text: noteText,
        note_type: noteType,
        brokerage_id: brokerageId,
        created_by: user.id,
        contact_id: contactId,
        transaction_id: transactionId,
        lead_id: leadId,
        source: "internal_ai_assistant",
        content_hash: contentHash || null,
        ai_draft_prompt: sessionId || null,
      })
      .select("id")
      .maybeSingle()

    if (noteErr || !noteRow) {
      return NextResponse.json({ error: "Failed to save note" }, { status: 500 })
    }

    const noteId = noteRow.id

    // ── 2. activities (always) ────────────────────────────────────────────────
    const { data: activityRow } = await service
      .from("activities")
      .insert({
        brokerage_id: brokerageId,
        agent_id: user.id,
        contact_id: contactId,
        transaction_id: transactionId,
        activity_type: "ai_assistant_note",
        entity_type: entityType !== "general" ? entityType : null,
        title: NOTE_TYPE_TITLE[noteType] ?? "Note",
        notes: noteText,
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle()

    const activityId = activityRow?.id ?? null

    // ── 3. contacts.notes append (when entity is contact) ─────────────────────
    if (contactId) {
      const ts = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      const { data: contact } = await service
        .from("contacts")
        .select("notes")
        .eq("id", contactId)
        .maybeSingle()
      const appended = contact?.notes
        ? `${contact.notes}\n\n[AI Note - ${ts}]\n${noteText}`
        : `[AI Note - ${ts}]\n${noteText}`
      await service.from("contacts").update({ notes: appended }).eq("id", contactId)
    }

    // ── 4. leads.notes append (when entity is lead) ────────────────────────────
    if (leadId) {
      const ts = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      const { data: lead } = await service
        .from("leads")
        .select("notes")
        .eq("id", leadId)
        .maybeSingle()
      const appended = lead?.notes
        ? `${lead.notes}\n\n[AI Note - ${ts}]\n${noteText}`
        : `[AI Note - ${ts}]\n${noteText}`
      await service.from("leads").update({ notes: appended }).eq("id", leadId)
    }

    // ── 5. transaction_lenders.notes (role=lender + entity=transaction) ───────
    if (role === "lender" && transactionId) {
      const { data: tl } = await service
        .from("transaction_lenders")
        .select("id, notes")
        .eq("transaction_id", transactionId)
        .limit(1)
        .maybeSingle()
      if (tl) {
        const ts = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        const appended = tl.notes
          ? `${tl.notes}\n\n[Lender Note - ${ts}]\n${noteText}`
          : `[Lender Note - ${ts}]\n${noteText}`
        await service.from("transaction_lenders").update({ notes: appended }).eq("id", tl.id)
      }
    }

    // ── 6. vendor_bookings.notes (role=vendor, most recent active booking) ────
    if (role === "vendor" && vendorId) {
      const { data: booking } = await service
        .from("vendor_bookings")
        .select("id, notes")
        .eq("vendor_id", vendorId)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (booking) {
        const ts = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        const appended = booking.notes
          ? `${booking.notes}\n\n[Vendor Note - ${ts}]\n${noteText}`
          : `[Vendor Note - ${ts}]\n${noteText}`
        await service.from("vendor_bookings").update({ notes: appended }).eq("id", booking.id)
      }
    }

    // ── 7. tasks (human-confirmed, optional) ──────────────────────────────────
    let taskId: string | null = null
    if (createTask && taskTitle?.trim()) {
      const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0]
      const { data: task } = await service
        .from("tasks")
        .insert({
          brokerage_id: brokerageId,
          assigned_to_agent_id: user.id,
          contact_id: contactId,
          transaction_id: transactionId,
          title: taskTitle.trim(),
          description: `Created from AI assistant note: ${noteText.substring(0, 200)}`,
          status: "pending",
          priority: "normal",
          due_date: dueDate,
        })
        .select("id")
        .maybeSingle()
      taskId = task?.id ?? null
    }

    return NextResponse.json({ success: true, duplicate: false, noteId, activityId, taskId })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
