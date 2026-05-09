/**
 * POST /api/workflow/intake/listing
 *
 * Conversational + form-based LISTING AGREEMENT intake. Mirror of the offer
 * intake route at /api/workflow/intake/offer.
 *
 *   action: 'extract'  → structure voice/text into ListingIntake + follow-ups
 *   action: 'finalize' → fillListingPacket → create documents row → stage via
 *                        generateListingAgreement → return FormWizard URL
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { extractListingIntake, intakeToListingDraftParams, type ListingIntake } from "@/lib/workflow/intake/voice-to-listing"
import { fillListingPacket } from "@/lib/workflow/intake/form-fill-engine"

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: {
    action:     "extract" | "finalize"
    sessionId?: string
    text?:      string
    contactId?: string
    intake?:    ListingIntake
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return NextResponse.json({ error: "No brokerage on user" }, { status: 422 })

  if (body.action === "extract") {
    if (!body.text) return NextResponse.json({ error: "text required for extract" }, { status: 400 })

    let priorIntake: ListingIntake | undefined
    let priorConversation: Array<{ role: string; content: string; ts: string }> = []
    if (body.sessionId) {
      const { data: session } = await supabase
        .from("workflow_intake_sessions").select("current_intake, conversation")
        .eq("id", body.sessionId).maybeSingle()
      if (session) {
        priorIntake = (session.current_intake as ListingIntake) || undefined
        priorConversation = (session.conversation as any[]) || []
      }
    }

    const result = await extractListingIntake({ text: body.text, prior: priorIntake })

    const newConversation = [
      ...priorConversation,
      { role: "agent",     content: body.text, ts: new Date().toISOString() },
      { role: "assistant", content: result.followUpQuestions.length > 0
          ? result.followUpQuestions.map(q => q.question).join(" ")
          : "Got it — ready to draft the listing agreement.",
        ts: new Date().toISOString() },
    ]

    let sessionId = body.sessionId
    if (sessionId) {
      await supabase.from("workflow_intake_sessions").update({
        current_intake: result.intake,
        conversation:   newConversation,
        status:         result.readyToDraft ? "ready_to_draft" : "in_progress",
        updated_at:     new Date().toISOString(),
      }).eq("id", sessionId)
    } else {
      const { data: newSession } = await supabase.from("workflow_intake_sessions").insert({
        brokerage_id:   brokerageId,
        agent_user_id:  user.id,
        contact_id:     body.contactId ?? null,
        intake_type:    "listing",
        conversation:   newConversation,
        current_intake: result.intake,
        status:         result.readyToDraft ? "ready_to_draft" : "in_progress",
      }).select("id").single()
      sessionId = newSession?.id
    }

    return NextResponse.json({
      sessionId,
      intake: result.intake,
      followUpQuestions: result.followUpQuestions,
      readyToDraft: result.readyToDraft,
    })
  }

  if (body.action === "finalize") {
    let intake: ListingIntake | undefined = body.intake

    if (!intake && body.sessionId) {
      const { data: session } = await supabase
        .from("workflow_intake_sessions").select("current_intake, contact_id").eq("id", body.sessionId).maybeSingle()
      if (session) {
        intake = session.current_intake as ListingIntake
        if (!body.contactId && session.contact_id) body.contactId = session.contact_id
      }
    }

    if (!intake) return NextResponse.json({ error: "intake or sessionId required" }, { status: 400 })

    let filledPacket
    try {
      filledPacket = await fillListingPacket({ intake, brokerageId })
    } catch (err: any) {
      return NextResponse.json({ error: err.message ?? "Fill engine failed" }, { status: 422 })
    }

    const { data: doc, error: docErr } = await supabase.from("documents").insert({
      brokerage_id:  brokerageId,
      contact_id:    body.contactId ?? null,
      document_type: "listing_agreement",
      status:        "needs_agent_input",
      state_code:    intake.propertyState.value,
      metadata: {
        packet_type: "listing",
        state: intake.propertyState.value,
        forms_count: filledPacket.forms.length,
        brokerage_forms_count: filledPacket.brokerageForms.length,
        agent_must_complete: filledPacket.agentMustComplete,
        audit: filledPacket.audit,
      },
      content: JSON.stringify({ filledPacket, intake }, null, 2),
      created_at: new Date().toISOString(),
    }).select("id").single()

    if (docErr || !doc) return NextResponse.json({ error: docErr?.message ?? "Could not create document" }, { status: 500 })

    try {
      const intakeMod = await import("@/app/actions/ai-listing-intake")
      const draftParams = intakeToListingDraftParams({
        intake,
        brokerageId,
        contactId: body.contactId ?? null,
        agentUserId: user.id,
        documentId: doc.id,
      })
      await (intakeMod as any).generateListingAgreement(draftParams)
    } catch { /* generator optional */ }

    if (body.sessionId) {
      await supabase.from("workflow_intake_sessions").update({
        status: "drafted",
        document_id: doc.id,
        updated_at: new Date().toISOString(),
      }).eq("id", body.sessionId)
    }

    return NextResponse.json({
      documentId: doc.id,
      formwizardUrl: `/dashboard/listings/new?documentId=${doc.id}`,
      filledPacket,
    })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
