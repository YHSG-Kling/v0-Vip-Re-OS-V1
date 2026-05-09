/**
 * POST /api/workflow/intake/offer
 *
 * Conversational + form-based offer intake. Two modes:
 *
 *   action: 'extract' — Send raw text (voice transcript / typed summary /
 *                       pasted email). Returns structured OfferIntake +
 *                       follow-up questions for whatever's missing.
 *                       Idempotent — call repeatedly with accumulated
 *                       conversation; the engine refines + fills gaps.
 *
 *   action: 'finalize' — Caller declares intake complete. Server:
 *                       1. fillOfferPacket(intake) — runs the AI form-fill engine
 *                       2. Creates a documents row (status='needs_agent_input')
 *                       3. Calls generateOfferDraft to stage the packet
 *                       4. Notifies the agent in-app
 *                       Returns documentId + FormWizard URL for the agent
 *                       to review/finalize before sending for eSign.
 *
 * Auth: requires authenticated user (agent). Brokerage scope is derived
 * from the agent's record.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { extractOfferIntake, intakeToOfferDraftParams, type OfferIntake } from "@/lib/workflow/intake/voice-to-offer"
import { fillOfferPacket } from "@/lib/workflow/intake/form-fill-engine"

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: {
    action:        "extract" | "finalize"
    sessionId?:    string
    text?:         string                  // for extract
    contactId?:   string
    intake?:       OfferIntake             // for finalize, if caller passes finalized intake
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // Resolve agent + brokerage scope
  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return NextResponse.json({ error: "No brokerage on user" }, { status: 422 })

  // ── ACTION: extract ─────────────────────────────────────────────────────
  if (body.action === "extract") {
    if (!body.text) return NextResponse.json({ error: "text required for extract" }, { status: 400 })

    // Load existing session if continuing a conversation
    let priorIntake: OfferIntake | undefined
    let priorConversation: Array<{ role: string; content: string; ts: string }> = []
    if (body.sessionId) {
      const { data: session } = await supabase
        .from("workflow_intake_sessions").select("current_intake, conversation")
        .eq("id", body.sessionId).maybeSingle()
      if (session) {
        priorIntake = (session.current_intake as OfferIntake) || undefined
        priorConversation = (session.conversation as any[]) || []
      }
    }

    const result = await extractOfferIntake({
      text:  body.text,
      prior: priorIntake,
    })

    // Persist session
    const newConversation = [
      ...priorConversation,
      { role: "agent",     content: body.text, ts: new Date().toISOString() },
      { role: "assistant", content: result.followUpQuestions.length > 0
          ? result.followUpQuestions.map(q => q.question).join(" ")
          : "Got it — ready to draft when you are.",
        ts: new Date().toISOString() },
    ]

    let sessionId = body.sessionId
    if (sessionId) {
      await supabase.from("workflow_intake_sessions")
        .update({
          current_intake: result.intake,
          conversation: newConversation,
          status: result.readyToDraft ? "ready_to_draft" : "in_progress",
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId)
    } else {
      const { data: newSession } = await supabase
        .from("workflow_intake_sessions").insert({
          brokerage_id: brokerageId,
          agent_user_id: user.id,
          contact_id: body.contactId ?? null,
          intake_type: "offer",
          conversation: newConversation,
          current_intake: result.intake,
          status: result.readyToDraft ? "ready_to_draft" : "in_progress",
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

  // ── ACTION: finalize ────────────────────────────────────────────────────
  if (body.action === "finalize") {
    let intake: OfferIntake | undefined = body.intake

    if (!intake && body.sessionId) {
      const { data: session } = await supabase
        .from("workflow_intake_sessions").select("current_intake, contact_id").eq("id", body.sessionId).maybeSingle()
      if (session) {
        intake = session.current_intake as OfferIntake
        if (!body.contactId && session.contact_id) body.contactId = session.contact_id
      }
    }

    if (!intake) return NextResponse.json({ error: "intake or sessionId required" }, { status: 400 })

    // 1. Run proactive intelligence checks BEFORE filling (so blockers stop the
    //    flow and the agent fixes the issue first — saves a wasted pass).
    let proactiveResult: Awaited<ReturnType<typeof import("@/lib/workflow/intelligence/proactive-checks").runAllOfferChecks>> | null = null
    try {
      const { runAllOfferChecks } = await import("@/lib/workflow/intelligence/proactive-checks")
      proactiveResult = await runAllOfferChecks({
        intake,
        contactId:  body.contactId ?? null,
        agentUserId: user.id,
        brokerageId,
        listingId:  intake.listingId.value,
      })

      if (!proactiveResult.passed) {
        // Hard blockers — return them; agent must resolve before drafting.
        return NextResponse.json({
          error:    "Proactive checks blocked the offer",
          findings: proactiveResult.findings,
          blockers: proactiveResult.blockers,
          addenda:  proactiveResult.addenda,
        }, { status: 422 })
      }
    } catch { /* checks are best-effort — proceed if they crash */ }

    // 2. AI form-fill engine
    let filledPacket
    try {
      filledPacket = await fillOfferPacket({ intake, brokerageId })
    } catch (err: any) {
      return NextResponse.json({ error: err.message ?? "Fill engine failed" }, { status: 422 })
    }

    // 2. Create the documents row
    const { data: doc, error: docErr } = await supabase.from("documents").insert({
      brokerage_id: brokerageId,
      contact_id:   body.contactId ?? null,
      document_type: "offer",
      status:       "needs_agent_input",
      state_code:   intake.propertyState.value,
      metadata:     {
        packet_type: "offer",
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

    // 3. Stage the packet via generateOfferDraft (sets needs_agent_input + notifies agent)
    try {
      const draftMod = await import("@/app/actions/ai-offer-creation")
      const draftParams = intakeToOfferDraftParams({
        intake,
        brokerageId,
        contactId: body.contactId ?? null,
        agentUserId: user.id,
        documentId: doc.id,
      })
      await (draftMod as any).generateOfferDraft(draftParams)
    } catch { /* generator optional — packet still exists on documents row */ }

    // 4. Update session state
    if (body.sessionId) {
      await supabase.from("workflow_intake_sessions").update({
        status: "drafted",
        document_id: doc.id,
        updated_at: new Date().toISOString(),
      }).eq("id", body.sessionId)
    }

    return NextResponse.json({
      documentId: doc.id,
      formwizardUrl: body.contactId
        ? `/dashboard/buyers/${body.contactId}/offers/new?documentId=${doc.id}`
        : `/dashboard/documents/${doc.id}`,
      filledPacket,
      // Surface non-blocking findings (warnings + info) so the FormWizard can
      // show a "review these" panel alongside the prefilled fields.
      findings: proactiveResult?.findings ?? [],
      addenda:  proactiveResult?.addenda  ?? [],
    })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
