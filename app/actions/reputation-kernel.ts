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

async function resolveActor(): Promise<{ agentId: string; brokerageId: string } | null> {
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
  const { data: profile } = await service
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!profile?.id || !profile?.brokerage_id) return null
  return { agentId: profile.id, brokerageId: profile.brokerage_id }
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
// Inserts a row into email_queue so the note is delivered via the existing
// email delivery pipeline. No new table required.

export async function sendThankYouNoteAction(input: {
  contactId: string
  contactEmail: string
  contactName: string
  noteText: string
}): Promise<{ success: boolean; error?: string }> {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }

  const { isValidUUID } = await import("@/lib/validations")
  if (!isValidUUID(input.contactId)) return { success: false, error: "Invalid contact ID." }
  if (!input.contactEmail) return { success: false, error: "Contact has no email address." }

  const service = createServiceClient()

  const { error } = await service.from("email_queue").insert({
    brokerage_id: actor.brokerageId,
    to_email:     input.contactEmail,
    to_name:      input.contactName,
    subject:      "A personal note from your agent",
    body:         input.noteText,
    template:     "thank_you_note",
    metadata:     { contact_id: input.contactId, agent_id: actor.agentId, source: "reputation_panel" },
    status:       "pending",
    attempts:     0,
    created_at:   new Date().toISOString(),
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── GIFT ORDER ASSIGN ────────────────────────────────────────────────────────
// Creates a gift order for a contact using the ai_assistant_notes table
// (client_gifts does not exist in the live schema). The gift details are
// persisted so the agent can action them externally.

export async function assignGiftAction(input: {
  contactId: string
  contactName: string
  giftName: string
  giftDescription: string
  budget: number
  occasion: string
}): Promise<{ success: boolean; error?: string }> {
  const actor = await resolveActor()
  if (!actor) return { success: false, error: "Not authenticated." }

  const { isValidUUID } = await import("@/lib/validations")
  if (!isValidUUID(input.contactId)) return { success: false, error: "Invalid contact ID." }

  const service = createServiceClient()

  const { error } = await service.from("ai_assistant_notes").insert({
    brokerage_id: actor.brokerageId,
    created_by:   actor.agentId,
    contact_id:   input.contactId,
    role:         "agent",
    note_type:    "gift_order",
    note_text:    JSON.stringify({
      contact_name:     input.contactName,
      gift_name:        input.giftName,
      gift_description: input.giftDescription,
      budget:           input.budget,
      occasion:         input.occasion,
      status:           "pending",
    }),
    source:     "reputation_panel",
    created_at: new Date().toISOString(),
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}
