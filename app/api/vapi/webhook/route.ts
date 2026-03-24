"use server"
/**
 * app/api/vapi/webhook/route.ts
 *
 * VAPI sends POST events here for call lifecycle events.
 * We ingest call-ended payloads to:
 *   - Update voice_calls with duration, status, summary, sentiment
 *   - Write call_transcriptions with full_text + speaker_turns
 *   - Write call_analyses with intent, objections, next_steps, urgency
 *   - Update vapi_voice_calls with cost, duration, minutes_billed
 *   - Log usage_logs for billing roll-up
 *
 * Webhook secret is validated via VAPI_WEBHOOK_SECRET env var.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Validate VAPI webhook secret if configured
  const secret = process.env.VAPI_WEBHOOK_SECRET
  if (secret) {
    const incoming = req.headers.get("x-vapi-secret")
    if (incoming !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  let payload: any
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const eventType: string = payload?.message?.type ?? payload?.type ?? ""
  const call = payload?.message?.call ?? payload?.call ?? null

  // Only process call-ended events
  if (eventType !== "end-of-call-report" && eventType !== "call-ended") {
    return NextResponse.json({ received: true, processed: false })
  }

  if (!call?.id) {
    return NextResponse.json({ error: "Missing call ID" }, { status: 400 })
  }

  const supabase = createServiceClient()
  const vapiCallId: string = call.id
  const durationSeconds: number = Math.round(call.duration ?? 0)
  const minutesBilled: number = Math.ceil(durationSeconds / 60)
  const costCents: number = Math.round((call.cost ?? 0) * 100)
  const endedReason: string = call.endedReason ?? "unknown"
  const summary: string = payload?.message?.summary ?? call?.analysis?.summary ?? ""
  const transcript: string = payload?.message?.transcript ?? call?.transcript ?? ""
  const stereoRecordingUrl: string = call?.recordingUrl ?? call?.stereoRecordingUrl ?? ""

  // Speaker turns — VAPI sends these as an array of { role, message } objects
  const artifactMessages: any[] = payload?.message?.artifact?.messages ?? []
  const speakerTurns = artifactMessages.map((m: any) => ({
    role: m.role ?? "unknown",
    text: m.message ?? "",
    time: m.time ?? null,
  }))

  // Sentiment from VAPI analysis
  const vapiAnalysis = payload?.message?.analysis ?? {}
  const sentiment: string = vapiAnalysis?.sentiment ?? "neutral"
  const structuredData: Record<string, any> = vapiAnalysis?.structuredData ?? {}

  // Intent extraction from structured data or summary keywords
  const intentPrimary: string =
    structuredData?.intent_primary ??
    (summary.toLowerCase().includes("ready to buy") ? "ready_to_buy" :
     summary.toLowerCase().includes("just looking") ? "browsing" :
     summary.toLowerCase().includes("appointment") ? "appointment_requested" :
     "unknown")

  const urgencyScore: number = structuredData?.urgency_score ??
    (summary.toLowerCase().includes("asap") || summary.toLowerCase().includes("immediately") ? 80 :
     summary.toLowerCase().includes("few months") ? 40 : 50)

  const objections: string[] = structuredData?.objections ?? []
  const nextSteps: string[] = structuredData?.next_steps ?? []
  const suggestedNextAction: string =
    structuredData?.suggested_next_action ??
    (vapiAnalysis?.successEvaluation === "true" ? "schedule_agent_handoff" : "continue_nurturing")

  // 1. Look up our voice_calls row by vapi_call_id
  const { data: voiceCall } = await supabase
    .from("voice_calls")
    .select("id, brokerage_id, agent_id, contact_id")
    .eq("vapi_call_id", vapiCallId)
    .maybeSingle()

  if (voiceCall) {
    // 2. Update voice_calls row
    await supabase
      .from("voice_calls")
      .update({
        status: "completed",
        ended_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        transcription: transcript,
        summary,
        sentiment,
        outcome: suggestedNextAction,
        recording_url: stereoRecordingUrl || null,
        ai_notes: JSON.stringify({
          intent_primary: intentPrimary,
          urgency_score: urgencyScore,
          success_evaluation: vapiAnalysis?.successEvaluation,
        }),
      })
      .eq("id", voiceCall.id)

    // 3. Write call_transcriptions
    if (transcript || speakerTurns.length > 0) {
      await supabase.from("call_transcriptions").upsert(
        {
          voice_call_id: voiceCall.id,
          brokerage_id: voiceCall.brokerage_id,
          full_text: transcript,
          speaker_turns: speakerTurns,
          word_count: transcript.split(/\s+/).filter(Boolean).length,
          language: "en",
          transcribed_at: new Date().toISOString(),
        },
        { onConflict: "voice_call_id" }
      )
    }

    // 4. Write call_analyses
    await supabase.from("call_analyses").upsert(
      {
        voice_call_id: voiceCall.id,
        brokerage_id: voiceCall.brokerage_id,
        agent_id: voiceCall.agent_id,
        contact_id: voiceCall.contact_id,
        sentiment,
        objections,
        next_steps: nextSteps,
        coaching_score: urgencyScore,
        intent_primary: intentPrimary,
        intent_secondary: structuredData?.intent_secondary ?? null,
        intent_signals: structuredData?.intent_signals ?? [],
        urgency_score: urgencyScore,
        suggested_next_action: suggestedNextAction,
      },
      { onConflict: "voice_call_id" }
    )

    // 5. Update vapi_voice_calls billing row
    await supabase
      .from("vapi_voice_calls")
      .update({
        cost_cents: costCents,
        duration_seconds: durationSeconds,
        minutes_billed: minutesBilled,
        ended_reason: endedReason,
        raw_payload: payload,
      })
      .eq("vapi_call_id", vapiCallId)

    // 6. Log to usage_logs for billing roll-up
    if (voiceCall.brokerage_id) {
      await supabase.from("usage_logs").insert({
        brokerage_id: voiceCall.brokerage_id,
        agent_id: voiceCall.agent_id,
        usage_type: "voice_call",
        units_used: minutesBilled,
        cost_cents: costCents,
        recorded_at: new Date().toISOString(),
        metadata: {
          vapi_call_id: vapiCallId,
          duration_seconds: durationSeconds,
          ended_reason: endedReason,
        },
      })
    }
  }

  return NextResponse.json({ received: true, processed: !!voiceCall })
}
