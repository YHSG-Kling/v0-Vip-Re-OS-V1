import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Verify auth
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get agent context
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("user_id", user.id)
      .single()

    if (agentError || !agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 })
    }

    const body = await request.json()
    const {
      sourceSystem,
      sourceRecordId,
      sourceRecordType,
      aiOutputSnapshot,
      rating,
      feedbackText,
    } = body

    // Validate required fields
    if (!sourceSystem || !sourceRecordId || !sourceRecordType || rating === undefined) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    // Validate rating is 1 or -1
    if (rating !== 1 && rating !== -1) {
      return NextResponse.json(
        { error: "Rating must be 1 or -1" },
        { status: 400 }
      )
    }

    // Insert feedback log
    const { data: feedback, error: feedbackError } = await supabase
      .from("ai_feedback_log")
      .insert({
        brokerage_id: agent.brokerage_id,
        agent_id: agent.id,
        source_system: sourceSystem,
        source_record_id: sourceRecordId,
        source_record_type: sourceRecordType,
        rating,
        feedback_text: feedbackText || null,
        ai_output_snapshot: aiOutputSnapshot?.slice(0, 200) || null,
      })
      .select("id")
      .single()

    if (feedbackError) {
      console.error("[FeedbackAPI] Error inserting feedback:", feedbackError)
      return NextResponse.json(
        { error: "Failed to save feedback" },
        { status: 500 }
      )
    }

    // If source is smart_assistant_suggestions, update the rating there too
    if (sourceRecordType === "smart_assistant_suggestions") {
      await supabase
        .from("smart_assistant_suggestions")
        .update({
          rating,
          rating_at: new Date().toISOString(),
          feedback_text: feedbackText || null,
        })
        .eq("id", sourceRecordId)
    }

    // Emit kernel event — audit row + reactor. The bare insert it replaces carried
    // NO entity_type / entity_id (both NOT NULL live) and wrote `payload` instead of
    // `metadata`, so it was refused on every request and no AI_FEEDBACK_RECEIVED row
    // has ever landed. Entity is the feedback row itself.
    const { error: feedbackEventError } = await emitKernelEvent({
      brokerageId: agent.brokerage_id,
      agentId: agent.id,
      event: KernelEvent.AI_FEEDBACK_RECEIVED,
      entityType: "ai_feedback_log",
      entityId: feedback.id,
      metadata: {
        source_system: sourceSystem,
        source_record_id: sourceRecordId,
        rating,
        feedback_id: feedback.id,
      },
    })
    if (feedbackEventError) {
      console.error("[FeedbackAPI] AI_FEEDBACK_RECEIVED row refused (feedback saved):", feedbackEventError)
    }

    return NextResponse.json({
      ok: true,
      feedbackId: feedback.id,
    })
  } catch (error) {
    console.error("[FeedbackAPI] Unexpected error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
