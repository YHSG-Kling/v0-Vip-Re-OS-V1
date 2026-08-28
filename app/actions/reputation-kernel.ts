"use server"

// app/actions/reputation-kernel.ts
//
// Thin "use server" wrapper around lib/kernel/reputation.ts.
// Resolves actor context (agentId + brokerageId) from the current session,
// then delegates every mutation to the kernel — NO DB logic here.
// UI components import from this file; they never call the kernel directly.

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@supabase/supabase-js"
import { cookies } from "next/headers"
import {
  createReviewRequest,
  recordReview,
  respondToReview,
  createReferralRequest,
  advanceReferralStatus,
  loadReputationWorkspace,
  loadReferralPipeline,
  loadReviewPerformance,
} from "@/lib/kernel/reputation"
import type {
  CreateReviewRequestInput,
  RecordReviewInput,
  RespondToReviewInput,
  CreateReferralInput,
  AdvanceReferralStatusInput,
} from "@/lib/kernel/reputation"

// ─── ACTOR CONTEXT RESOLVER ───────────────────────────────────────────────────

async function resolveActor(): Promise<{ agentId: string; brokerageId: string; userId: string } | null> {
  const cookieStore = await cookies()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      headers: { Cookie: cookieStore.toString() },
    },
  })

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const service = createServiceClient()
  // Destructured: a refused agents read used to resolve to null and this
  // function returned null, which every caller reports as "Not authenticated."
  // — sending the agent to re-login for a problem that is not their session.
  const { data: profile, error: profileErr } = await service
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (profileErr) {
    console.error("[reputation-kernel] agents lookup refused:", profileErr.message)
    return null
  }
  if (!profile?.id || !profile?.brokerage_id) return null
  // userId travels too: the dispatchers take the ACTING USER (for the autonomy
  // gate and per-actor provider credentials), which is a users.id — not the
  // agents.id that agentId carries.
  return { agentId: profile.id, brokerageId: profile.brokerage_id, userId: user.id }
}

// ─── EXPORTED SERVER ACTIONS ──────────────────────────────────────────────────

export async function createReviewRequestAction(
  input: Omit<CreateReviewRequestInput, "agentId" | "brokerageId">,
) {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }
  return createReviewRequest({ ...input, ...actor })
}

export async function recordReviewAction(
  input: Omit<RecordReviewInput, "agentId" | "brokerageId">,
) {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }
  return recordReview({ ...input, ...actor })
}

export async function respondToReviewAction(
  input: Omit<RespondToReviewInput, "agentId" | "brokerageId">,
) {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }
  return respondToReview({ ...input, ...actor })
}

export async function createReferralRequestAction(
  input: Omit<CreateReferralInput, "agentId" | "brokerageId">,
) {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }
  return createReferralRequest({ ...input, ...actor })
}

export async function advanceReferralStatusAction(
  input: Omit<AdvanceReferralStatusInput, "agentId" | "brokerageId">,
) {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }
  return advanceReferralStatus({ ...input, ...actor })
}

export async function loadReputationWorkspaceAction() {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }
  return loadReputationWorkspace(actor)
}

export async function loadReferralPipelineAction(status?: string) {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }
  return loadReferralPipeline({ ...actor, status })
}

export async function loadReviewPerformanceAction() {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }
  return loadReviewPerformance(actor)
}

// ─── THANK YOU NOTE SEND ──────────────────────────────────────────────────────

export async function sendThankYouNoteAction(input: {
  contactId: string
  contactEmail?: string
  contactName: string
  noteText: string
  subject?: string
  occasion?: string
  channel?: string
  transactionId?: string
  templateId?: string
}): Promise<{ success: boolean; noteId?: string; error?: string }> {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }

  const { isValidUUID } = await import("@/lib/validations")
  if (!isValidUUID(input.contactId)) return { success: false, error: "Invalid contact ID." }

  const service = createServiceClient()
  const channel  = input.channel ?? "email"
  const occasion = input.occasion ?? "general"
  const subject  = input.subject ?? "A personal note from your agent"

  // Insert into thank_you_notes for tracking
  const { data: noteRow, error: noteErr } = await service.from("thank_you_notes").insert({
    brokerage_id:   actor.brokerageId,
    agent_id:       actor.agentId,
    contact_id:     input.contactId,
    transaction_id: input.transactionId ?? null,
    template_id:    input.templateId    ?? null,
    occasion,
    channel,
    subject:        channel === "email" ? subject : null,
    body:           input.noteText,
    status:         "pending",
    ai_generated:   true,
    source:         "reputation_panel",
    created_at:     new Date().toISOString(),
  }).select("id").single()

  if (noteErr) return { success: false, error: noteErr.message }

  // ── THE TEMPLATE'S USE COUNTER ───────────────────────────────────────────
  // `thank_you_note_templates.use_count` is what loadThankYouTemplatesAction
  // ORDERS BY (this file, `.order("use_count", { ascending: false })`) — the
  // "your most-used templates first" ordering an agent sees. It carries
  // `NOT NULL DEFAULT 0` (scripts/create-gifting-notes-tables.sql:58) and had no
  // incrementer anywhere, so every template sat at 0 and the ordering was
  // arbitrary for ever. Sending a note IS the use.
  //
  // Read-then-write, not an atomic bump: PostgREST has no `col = col + 1` and
  // this repo has no increment RPC for the table. Two notes sent in the same
  // instant can therefore cost one tick — acceptable for a POPULARITY ordering,
  // and stated rather than hidden. It is not acceptable for money, which is why
  // no ledger in this lane is written this way.
  if (input.templateId) {
    const { data: tpl, error: tplErr } = await service
      .from("thank_you_note_templates")
      .select("id, use_count")
      .eq("id", input.templateId)
      .maybeSingle()
    if (tplErr) {
      console.error("[reputation-kernel] template use_count not read:", tplErr.message)
    } else if (tpl) {
      const { data: bumped, error: bumpErr } = await service
        .from("thank_you_note_templates")
        .update({ use_count: Number((tpl as { use_count: number | null }).use_count ?? 0) + 1 })
        .eq("id", input.templateId)
        .select("id")
      // COUNTED (§3): a zero-row update resolves exactly like one that landed.
      // The note itself is already filed, so this is reported, never thrown.
      if (bumpErr) console.error("[reputation-kernel] template use_count not bumped:", bumpErr.message)
      else if ((bumped ?? []).length === 0) {
        console.error(`[reputation-kernel] template ${input.templateId} matched no row when bumping use_count`)
      }
    }
  }

  if (channel === "email") {
    if (!input.contactEmail) return { success: false, error: "Contact has no email address." }

    const { data: eqRow, error: eqErr } = await service.from("email_queue").insert({
      brokerage_id: actor.brokerageId,
      to_email:     input.contactEmail,
      to_name:      input.contactName,
      subject,
      body:         input.noteText,
      template:     "thank_you_note",
      metadata:     { contact_id: input.contactId, agent_id: actor.agentId, note_id: noteRow?.id },
      status:       "pending",
      attempts:     0,
      created_at:   new Date().toISOString(),
    }).select("id").single()

    if (!eqErr && eqRow?.id && noteRow?.id) {
      // Link email_queue row to the note row
      await service.from("thank_you_notes").update({
        email_queue_id: eqRow.id,
        status:         "sent",
        sent_at:        new Date().toISOString(),
      }).eq("id", noteRow.id)
    }
  } else if (channel === "sms") {
    // ── SMS RUNS THE SMS LANE ─────────────────────────────────────────────
    // OWNER RULING: "route sms through dispatchsms." This branch used to stamp
    // the note 'sent' and stop — an sms is a machine channel, so nothing about
    // that was honest. dispatchSms carries the suppression list, DNC, quiet
    // hours, opt-out, de-conflict and content-safety gates; a refusal leaves
    // the note 'failed' with the provider's reason rather than a false 'sent'.
    const { data: c } = await service
      .from("contacts").select("phone").eq("id", input.contactId).maybeSingle()
    const phone = ((c as any)?.phone as string | null) ?? null
    if (!phone) {
      await service.from("thank_you_notes")
        .update({ status: "failed" }).eq("id", noteRow?.id)
      return { success: false, error: "Contact has no phone number for an SMS note." }
    }
    const { dispatchSms } = await import("@/lib/providers/dispatch")
    const sms = await dispatchSms({
      brokerageId: actor.brokerageId,
      userId:      actor.userId,
      agentId:     actor.agentId,
      to:          phone,
      message:     input.noteText,
      contactId:   input.contactId,
      systemSource: "thank_you_note",
      metadata:    { note_id: noteRow?.id, occasion },
    })
    await service.from("thank_you_notes").update({
      status:  sms.success ? "sent" : "failed",
      sent_at: sms.success ? new Date().toISOString() : null,
    }).eq("id", noteRow?.id)
    if (!sms.success) {
      return { success: false, noteId: noteRow?.id, error: sms.error ?? "SMS note could not be sent." }
    }
  } else {
    // ── HANDWRITTEN RUNS THE SAME LINE AS A POSTCARD OR CARD ──────────────
    // OWNER RULING: "handwritten notes run the same line as a postcard or card."
    // So this is the DIRECT MAIL lane — dispatchDirectMail → Lob — not a human
    // errand. It used to mark the note sent with nothing behind it.
    //
    // Piece type is the card: Lob's postcard product is the printed-card lane
    // (LOB_NOTECARD_ID overrides the postcard template when a brokerage has a
    // notecard design on file). Every direct-mail gate still applies upstream:
    // the CASS deliverability check, the per-contact physical-touch cap, budget.
    const { data: c } = await service
      .from("contacts")
      .select("first_name, last_name, mailing_address, mailing_city, mailing_state, mailing_zip, city, state, zip_code")
      .eq("id", input.contactId).maybeSingle()
    const row = c as any
    const street = (row?.mailing_address as string | null) ?? null
    const city   = (row?.mailing_city as string | null) ?? (row?.city as string | null) ?? null
    const state  = (row?.mailing_state as string | null) ?? (row?.state as string | null) ?? null
    const zip    = (row?.mailing_zip as string | null) ?? (row?.zip_code as string | null) ?? null
    if (!street || !city || !state || !zip) {
      // No mailing address = no card. Held honestly so the agent can add one,
      // rather than a note that claims to have been posted.
      await service.from("thank_you_notes")
        .update({ status: "failed" }).eq("id", noteRow?.id)
      return {
        success: false,
        noteId: noteRow?.id,
        error: "No complete mailing address on this contact — a handwritten card needs street, city, state and ZIP.",
      }
    }
    const templateId = process.env.LOB_NOTECARD_ID || process.env.LOB_POSTCARD_FRONT_ID || ""
    if (!templateId) {
      await service.from("thank_you_notes")
        .update({ status: "failed" }).eq("id", noteRow?.id)
      return {
        success: false,
        noteId: noteRow?.id,
        error: "No notecard template configured (LOB_NOTECARD_ID) — the platform must add one before cards can be mailed.",
      }
    }
    const { dispatchDirectMail } = await import("@/lib/providers/dispatch")
    const mail = await dispatchDirectMail({
      brokerageId:   actor.brokerageId,
      userId:        actor.userId,
      agentId:       actor.agentId,
      contactId:     input.contactId,
      recipientName: input.contactName,
      mailingAddress: street,
      city, state, zip,
      templateId,
      pieceType:     "postcard",
      color:         true,
      mergeVars:     { note_body: input.noteText, recipient_name: input.contactName },
      systemSource:  "thank_you_note",
      metadata:      { note_id: noteRow?.id, occasion },
    })
    await service.from("thank_you_notes").update({
      status:  mail.success ? "sent" : "failed",
      sent_at: mail.success ? new Date().toISOString() : null,
    }).eq("id", noteRow?.id)
    if (!mail.success) {
      return { success: false, noteId: noteRow?.id, error: mail.error ?? "Card could not be mailed." }
    }
  }

  return { success: true, noteId: noteRow?.id }
}

// ─── THANK YOU NOTE TEMPLATES ─────────────────────────────────────────────────

export async function loadThankYouTemplatesAction(occasion?: string): Promise<{
  success: boolean
  templates?: any[]
  error?: string
}> {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }

  const service = createServiceClient()
  let query = service
    .from("thank_you_note_templates")
    .select("*")
    .eq("is_active", true)
    .or(`brokerage_id.eq.${actor.brokerageId},is_global.eq.true`)
    .order("use_count", { ascending: false })

  if (occasion) query = query.eq("occasion", occasion)

  const { data, error } = await query
  if (error) return { success: false, error: error.message }
  return { success: true, templates: data ?? [] }
}

export async function saveThankYouTemplateAction(input: {
  name: string
  occasion: string
  channel: string
  subject?: string
  body: string
  isGlobal?: boolean
}): Promise<{ success: boolean; templateId?: string; error?: string }> {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }

  const service = createServiceClient()
  const { data, error } = await service.from("thank_you_note_templates").insert({
    brokerage_id: actor.brokerageId,
    agent_id:     actor.agentId,
    name:         input.name,
    occasion:     input.occasion,
    channel:      input.channel,
    subject:      input.subject ?? null,
    body:         input.body,
    is_global:    input.isGlobal ?? false,
    created_at:   new Date().toISOString(),
  }).select("id").single()

  if (error) return { success: false, error: error.message }
  return { success: true, templateId: data?.id }
}

export async function loadNoteHistoryAction(contactId: string): Promise<{
  success: boolean
  notes?: any[]
  error?: string
}> {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }

  const service = createServiceClient()
  const { data, error } = await service
    .from("thank_you_notes")
    .select("id, occasion, channel, subject, status, sent_at, created_at")
    .eq("contact_id", contactId)
    .eq("agent_id",   actor.agentId)
    .order("created_at", { ascending: false })
    .limit(10)

  if (error) return { success: false, error: error.message }
  return { success: true, notes: data ?? [] }
}

// ─── GIFT ACTIONS ─────────────────────────────────────────────────────────────

export async function assignGiftAction(input: {
  contactId: string
  contactName: string
  giftName: string
  giftDescription: string
  giftType?: string
  vendorName?: string
  vendorUrl?: string
  budget: number
  budgetMin?: number
  budgetMax?: number
  occasion: string
  personalizationNote?: string
  aiReasoning?: string
  transactionId?: string
}): Promise<{ success: boolean; giftId?: string; error?: string }> {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }

  const { isValidUUID } = await import("@/lib/validations")
  if (!isValidUUID(input.contactId)) return { success: false, error: "Invalid contact ID." }

  const service = createServiceClient()
  const { data, error } = await service.from("client_gifts").insert({
    brokerage_id:         actor.brokerageId,
    agent_id:             actor.agentId,
    contact_id:           input.contactId,
    transaction_id:       input.transactionId ?? null,
    occasion:             input.occasion,
    gift_type:            input.giftType ?? "physical",
    gift_name:            input.giftName,
    gift_description:     input.giftDescription,
    vendor_name:          input.vendorName ?? null,
    vendor_url:           input.vendorUrl  ?? null,
    estimated_cost:       input.budget,
    budget_min:           input.budgetMin  ?? null,
    budget_max:           input.budgetMax  ?? null,
    personalization_note: input.personalizationNote ?? null,
    ai_reasoning:         input.aiReasoning         ?? null,
    status:               "recommended",
    source:               "ai",
    created_at:           new Date().toISOString(),
  }).select("id").single()

  if (error) return { success: false, error: error.message }
  return { success: true, giftId: data?.id }
}

/**
 * MARK SENT is where the gift's MONEY becomes true.
 *
 * `client_gifts.estimated_cost` is the budget the recommendation was made
 * against; `client_gifts.actual_cost` is what was really paid, and it is the
 * FIRST value the spend read prefers — app/actions/ai-client-gifting.ts:511
 * computes `Number(g.actual_cost ?? g.estimated_cost ?? 0)`. Nothing in the tree
 * wrote `actual_cost`, so that coalesce could only ever fall through to the
 * budget: every gift dashboard reported the QUOTE as the spend, and an agent who
 * bought a $40 gift on a $120 budget was billed against the wrong number for the
 * whole year. There is no second writer to merge onto — the missing half is the
 * write, and this is the one moment in the process where the amount is known:
 * the agent has bought the thing and is recording that they sent it.
 *
 * `actualCost` is OPTIONAL: an agent who does not know or does not care still
 * gets the status transition, and the column stays NULL so the coalesce above
 * falls back to the budget exactly as before. Only a supplied, finite,
 * non-negative number is stamped.
 */
export async function markGiftSentAction(
  giftId: string,
  actualCost?: number | null,
): Promise<{ success: boolean; error?: string }> {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }

  const patch: Record<string, unknown> = { status: "sent", sent_at: new Date().toISOString() }
  if (actualCost !== undefined && actualCost !== null) {
    const paid = Number(actualCost)
    if (!Number.isFinite(paid) || paid < 0) {
      return { success: false, error: "Amount paid must be a non-negative number." }
    }
    patch.actual_cost = paid
  }

  const service = createServiceClient()
  // COUNTED. An update whose tenant/agent predicate matched nothing resolves with
  // error === null and data === [] — byte-identical to a write that landed
  // (CLAUDE.md §3) — so "gift marked sent" would be reported for another agent's
  // row. `.select("id")` makes the zero case visible.
  const { data, error } = await service
    .from("client_gifts")
    .update(patch)
    .eq("id",       giftId)
    .eq("agent_id", actor.agentId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if ((data ?? []).length === 0) return { success: false, error: "That gift is not yours to update." }
  return { success: true }
}

export async function loadGiftHistoryAction(contactId: string): Promise<{
  success: boolean
  gifts?: any[]
  error?: string
}> {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }

  const service = createServiceClient()
  const { data, error } = await service
    .from("client_gifts")
    .select("id, gift_name, gift_type, occasion, status, estimated_cost, actual_cost, sent_at, created_at")
    .eq("contact_id", contactId)
    .eq("agent_id",   actor.agentId)
    .order("created_at", { ascending: false })
    .limit(10)

  if (error) return { success: false, error: error.message }
  return { success: true, gifts: data ?? [] }
}
