/**
 * app/api/voice/vapi-webhook/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single authoritative VAPI webhook handler.
 *
 * Handles all VAPI event types:
 *   call-started   — writes voice_calls row (inbound OR outbound), runs TCPA/authority gate for inbound
 *   transcript     — streams live transcript into voice_calls.transcription
 *   end-of-call-report / call-ended — persists transcript, call_analyses,
 *                   vapi_voice_calls billing, usage_logs, and fires AI SDK
 *                   post-call follow-up (SMS if phone exists, email if email exists)
 *
 * Auth: x-vapi-secret header validated against VAPI_WEBHOOK_SECRET env var.
 * Brokerage resolved from ?brokerage_id query param set when registering the
 * webhook URL in VAPI dashboard.
 *
 * NOTE: runtime must stay "nodejs" — AI SDK generateText is NOT edge-compatible.
 */
import { evaluateKernelOutbound } from "@/lib/kernel/adapters/compliance"
import { NextRequest, NextResponse } from "next/server"
import { generateText } from "ai"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { openai } from "@ai-sdk/openai"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchSms } from "@/lib/providers/dispatch"
import { dispatchEmail } from "@/lib/providers/dispatch"

export const runtime = "nodejs"

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10)
}

const RESTRICTED_STATES = new Set([
  "representation",
  "active_transaction",
  "under_contract",
  "REPRESENTATION",
  "ACTIVE_TRANSACTION",
  "UNDER_CONTRACT",
])

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Validate webhook secret
  const secret = process.env.VAPI_WEBHOOK_SECRET
  if (secret) {
    const incoming = req.headers.get("x-vapi-secret")
    if (incoming !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  let payload: Record<string, any>
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Normalize event type — VAPI sends either top-level `type` or `message.type`
  const eventType: string = payload?.message?.type ?? payload?.type ?? ""
  const call: Record<string, any> = payload?.message?.call ?? payload?.call ?? {}
  const callId: string | null = call?.id ?? null

  const { searchParams } = new URL(req.url)
  const brokerageId: string | null = searchParams.get("brokerage_id") ?? null

  const supabase = createServiceClient()

  // ── EVENT: call-started ───────────────────────────────────────────────────
  if (eventType === "call-started") {
    const direction: string = call.direction ?? "outbound"
    const phoneFrom: string | null = call.customer?.number ?? null
    const phoneTo: string | null = call.phoneNumber?.number ?? null
    const callerPhone = direction === "inbound" ? phoneFrom : null

    // ── Inbound: resolve or create record BEFORE writing voice_calls ─────────
    let resolvedContactId: string | null = null
    let resolvedLeadId: string | null = null

    if (direction === "inbound" && callerPhone && brokerageId) {
      const digits = normalizePhone(callerPhone)

      // 1. Check contacts first
      const { data: existingContact } = await supabase
        .from("contacts")
        .select("id, tcpa_consent, dnc_status, status, isa_reengage_allowed, call_stop_flag")
        .eq("phone_digits", digits)
        .eq("brokerage_id", brokerageId)
        .maybeSingle()

      if (existingContact) {
        // Known contact — update record to reflect inbound call, stamp TCPA consent
        // (the act of calling in IS consent for that communication)
        await supabase
          .from("contacts")
          .update({
            tcpa_consent: true,
            tcpa_consent_date: existingContact.tcpa_consent ? existingContact.tcpa_consent : new Date().toISOString(),
            last_contacted_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingContact.id)

        // Block if DNC / call_stop_flag / restricted state that has opted out
        const complianceResult = await evaluateKernelOutbound({
  actorContext: {
    userId: "system",
    brokerageId,
    role: "isa",
  },
  journeyType: "buyer",
  persona: "other",
  messageType: "phone",
  content: "",
  contact: {
    id: existingContact.id,
    status: existingContact.status,
    dnc_status: existingContact.dnc_status ?? false,
    tcpa_consent: existingContact.tcpa_consent ?? false,
    isa_reengage_allowed: existingContact.isa_reengage_allowed ?? false,
  },
})
        const blocked = !complianceResult.allowed
        const violations = complianceResult.violations ?? []

        await supabase.from("compliance_events").insert({
          brokerage_id: brokerageId,
          gate_name: "vapi_inbound_gate",
          allowed: !blocked,
          violations,
          blocked_reason: violations[0] ?? null,
          actor_role: "isa",
          actor_user_id: "system",
          entity_type: "contact",
          entity_id: existingContact.id,
          message_type: "phone",
        })

        if (blocked) {
          await supabase.from("voice_calls").insert({
            brokerage_id: brokerageId,
            vapi_call_id: callId,
            direction,
            call_type: "isa_ai",
            contact_id: existingContact.id,
            phone_from: callerPhone,
            phone_to: phoneTo,
            status: "blocked",
            outcome: "authority_blocked",
            compliance_passed: false,
            compliance_flags: violations,
            started_at: new Date().toISOString(),
          })
          return NextResponse.json(
            { response: "This line is managed by your real estate agent. Please contact your agent directly." },
            { status: 200 }
          )
        }

        resolvedContactId = existingContact.id

      } else {
        // 2. Check leads
        const { data: existingLead } = await supabase
          .from("leads")
          .select("id, contact_id, call_stop_flag, dnc_status")
          .eq("phone_digits", digits)
          .eq("brokerage_id", brokerageId)
          .maybeSingle()

        if (existingLead) {
          // Lead exists — if it has a linked contact use that, otherwise track on lead
          if (existingLead.contact_id) {
            resolvedContactId = existingLead.contact_id
          } else {
            resolvedLeadId = existingLead.id
          }

          // Block if lead has DNC / call_stop_flag
          if (existingLead.call_stop_flag || existingLead.dnc_status) {
            await supabase.from("voice_calls").insert({
              brokerage_id: brokerageId,
              vapi_call_id: callId,
              direction,
              call_type: "isa_ai",
              lead_id: resolvedLeadId,
              contact_id: resolvedContactId,
              phone_from: callerPhone,
              phone_to: phoneTo,
              status: "blocked",
              outcome: "authority_blocked",
              compliance_passed: false,
              compliance_flags: ["CallStop: Lead has requested no contact"],
              started_at: new Date().toISOString(),
            })
            return NextResponse.json(
              { response: "This line is managed by your real estate agent. Please contact your agent directly." },
              { status: 200 }
            )
          }

        } else {
          // 3. Unknown caller — calling is consent; create a contact record immediately
          const { data: newContact } = await supabase
            .from("contacts")
            .insert({
              brokerage_id: brokerageId,
              phone: callerPhone,
              phone_digits: digits,
              source: "inbound_call",
              tcpa_consent: true,
              tcpa_consent_date: new Date().toISOString(),
              preferred_channel: "phone",
              last_contacted_at: new Date().toISOString(),
              isa_reengage_allowed: true,
              dnc_status: false,
            })
            .select("id")
            .single()

          if (newContact?.id) {
            resolvedContactId = newContact.id
            // Queue enrichment for the new contact
            await supabase.from("contact_enrichment_queue").insert({
              contact_id: newContact.id,
              brokerage_id: brokerageId,
              status: "pending",
              source: "inbound_call",
            })
          }
        }
      }
    }

    // Write voice_calls row with resolved IDs
    await supabase.from("voice_calls").insert({
      brokerage_id: brokerageId,
      vapi_call_id: callId,
      direction,
      call_type: "isa_ai",
      contact_id: resolvedContactId,
      lead_id: resolvedLeadId ?? null,
      phone_from: direction === "inbound" ? callerPhone : phoneTo,
      phone_to: direction === "inbound" ? phoneTo : callerPhone,
      status: "in_progress",
      started_at: new Date().toISOString(),
    })

    // Insert ai_isa_calls row so call-ended can update appointment_set / quality score.
    // outbound calls get this row from initiate-call/route.ts; inbound calls need it here.
    if (direction === "inbound") {
      const { data: voiceCallRow } = await supabase
        .from("voice_calls")
        .select("id")
        .eq("vapi_call_id", callId)
        .maybeSingle()

      if (voiceCallRow?.id) {
        await supabase.from("ai_isa_calls").insert({
          brokerage_id: brokerageId,
          contact_id: resolvedContactId ?? null,
          lead_id: resolvedLeadId ?? null,
          voice_call_id: voiceCallRow.id,
          script_used: "inbound",
          appointment_set: false,
        }).catch(() => {})
      }
    }

    return NextResponse.json({ received: true, event: "call-started" })
  }

  // ── EVENT: transcript (live streaming) ────────────────────────────────────
  if (eventType === "transcript") {
    const transcript: string = payload.transcript ?? ""
    if (callId && transcript) {
      await supabase
        .from("voice_calls")
        .update({ transcription: transcript })
        .eq("vapi_call_id", callId)
    }
    return NextResponse.json({ received: true, event: "transcript" })
  }

  // ── EVENT: end-of-call-report / call-ended ────────────────────────────────
  if (eventType === "end-of-call-report" || eventType === "call-ended") {
    if (!callId) {
      return NextResponse.json({ error: "Missing call ID" }, { status: 400 })
    }

    // Extract call payload fields
    const durationSeconds = Math.round(call.duration ?? 0)
    const minutesBilled = Math.ceil(durationSeconds / 60)
    const costCents = Math.round((call.cost ?? 0) * 100)
    const endedReason: string = call.endedReason ?? "unknown"
    const recordingUrl: string = call.recordingUrl ?? call.stereoRecordingUrl ?? ""
    const transcript: string = payload?.message?.transcript ?? call.transcript ?? ""
    const summary: string = payload?.message?.summary ?? call.analysis?.summary ?? ""

    // Speaker turns from artifact messages
    const artifactMessages: any[] = payload?.message?.artifact?.messages ?? []
    const speakerTurns = artifactMessages.map((m: any) => ({
      role: m.role ?? "unknown",
      text: m.message ?? "",
      time: m.time ?? null,
    }))

    // VAPI analysis object
    const vapiAnalysis: Record<string, any> = payload?.message?.analysis ?? {}
    const structuredData: Record<string, any> = vapiAnalysis?.structuredData ?? {}

    const sentiment: string = vapiAnalysis?.sentiment ?? structuredData?.sentiment ?? "neutral"
    const intentPrimary: string =
      structuredData?.intent_primary ??
      (summary.toLowerCase().includes("appointment") ? "appointment_requested" :
       summary.toLowerCase().includes("ready to buy") ? "ready_to_buy" :
       summary.toLowerCase().includes("just looking") ? "browsing" : "unknown")

    const intentSecondary: string | null = structuredData?.intent_secondary ?? null
    const urgencyScore: number = structuredData?.urgency_score ??
      (summary.toLowerCase().includes("asap") || summary.toLowerCase().includes("immediately") ? 80 :
       summary.toLowerCase().includes("few months") ? 40 : 50)

    const objections: string[] = structuredData?.objections ?? []
    const nextSteps: string[] = structuredData?.next_steps ?? []
    const suggestedNextAction: string =
      structuredData?.suggested_next_action ??
      (vapiAnalysis?.successEvaluation === "true" ? "schedule_agent_handoff" : "continue_nurturing")

    // Look up our voice_calls row — include lead_id for lead-based routing
    const { data: voiceCall } = await supabase
      .from("voice_calls")
      .select("id, brokerage_id, agent_id, contact_id, lead_id, direction")
      .eq("vapi_call_id", callId)
      .maybeSingle()

    if (voiceCall) {
      // 2. Update voice_calls
      await supabase.from("voice_calls").update({
        status: "completed",
        ended_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        transcription: transcript,
        summary,
        sentiment,
        outcome: suggestedNextAction,
        recording_url: recordingUrl || null,
        ai_notes: JSON.stringify({ intent_primary: intentPrimary, urgency_score: urgencyScore }),
      }).eq("id", voiceCall.id)

      // 3. call_transcriptions
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

      // 4. call_analyses
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
          intent_secondary: intentSecondary,
          intent_signals: structuredData?.intent_signals ?? [],
          urgency_score: urgencyScore,
          suggested_next_action: suggestedNextAction,
        },
        { onConflict: "voice_call_id" }
      )

      // 5. Update vapi_voice_calls billing row
      await supabase.from("vapi_voice_calls").update({
        cost_cents: costCents,
        duration_seconds: durationSeconds,
        minutes_billed: minutesBilled,
        ended_reason: endedReason,
        raw_payload: payload,
      }).eq("vapi_call_id", callId)

      // 6. usage_logs for billing roll-up
      if (voiceCall.brokerage_id) {
        await supabase.from("usage_logs").insert({
          brokerage_id: voiceCall.brokerage_id,
          agent_id: voiceCall.agent_id,
          usage_type: "voice_call",
          units_used: minutesBilled,
          cost_cents: costCents,
          recorded_at: new Date().toISOString(),
          metadata: { vapi_call_id: callId, duration_seconds: durationSeconds, ended_reason: endedReason },
        })
      }

      // 7. Update ai_isa_calls with outcome scoring
      const { data: isaCall } = await supabase
        .from("ai_isa_calls")
        .select("id")
        .eq("voice_call_id", voiceCall.id)
        .maybeSingle()

      if (isaCall) {
        const appointmentSet =
          suggestedNextAction === "schedule_agent_handoff" ||
          intentPrimary === "appointment_requested" ||
          (summary ?? "").toLowerCase().includes("appointment")

        const qualScore = Math.min(
          100,
          Math.max(
            0,
            urgencyScore +
              (["ready_to_buy", "ready_to_list"].includes(intentPrimary) ? 20 : 0) +
              (intentPrimary === "appointment_requested" ? 30 : 0) +
              (appointmentSet ? 20 : 0)
          )
        )

        await supabase
          .from("ai_isa_calls")
          .update({
            appointment_set:    appointmentSet,
            lead_quality_score: qualScore,
            ai_response_summary: (summary ?? "").substring(0, 500) || null,
            ...(appointmentSet ? { appointment_datetime: new Date().toISOString() } : {}),
          })
          .eq("id", isaCall.id)
          .catch(() => {})

        // Notify agent when lead is highly qualified but appointment not yet set
        if (!appointmentSet && qualScore >= 60 && voiceCall.contact_id && voiceCall.agent_id) {
          await supabase.from("notifications").insert({
            user_id:      voiceCall.agent_id,
            brokerage_id: brokerageId,
            type:         "isa_qualified_lead",
            title:        "AI-ISA qualified a contact for you",
            body:         `Score: ${qualScore}/100. Intent: ${intentPrimary?.replace(/_/g, " ")}.`,
            entity_type:  "contact",
            entity_id:    voiceCall.contact_id,
          }).catch(() => {})
        }
      }

      // 8. Post-call lead / contact routing
      //
      // Architecture rules:
      //   Contact record → update contact with call notes; positive = notify agent
      //   Lead with contact_id → calls already operated from contact; same as above
      //   Lead (no contact_id) + POSITIVE → assign agent + convert to contact
      //   Lead (no contact_id) + NEGATIVE → notes only, block phone/SMS, do NOT convert

      const isPositiveOutcome =
        sentiment === "positive" ||
        suggestedNextAction === "schedule_agent_handoff" ||
        intentPrimary === "appointment_requested" ||
        intentPrimary === "ready_to_buy" ||
        intentPrimary === "ready_to_list"

      const isNegativeOutcome =
        sentiment === "negative" ||
        suggestedNextAction === "do_not_contact" ||
        objections.some((o: string) =>
          ["not interested", "stop calling", "remove me", "do not call", "take me off"].some(
            (phrase) => o.toLowerCase().includes(phrase)
          )
        )

      const callNoteSummary = `[AI Call ${new Date().toLocaleDateString()}] ${summary || `Intent: ${intentPrimary}. Urgency: ${urgencyScore}/100.`}`

      if (voiceCall.lead_id && !voiceCall.contact_id) {
        // ── Call operated from a LEAD (no contact yet) ──────────────────────
        if (isPositiveOutcome) {
          // Positive: assign agent + convert lead to contact for further follow-up
          const { acceptAIISAHandoff } = await import("@/app/actions/ai-isa/accept-handoff")
          await acceptAIISAHandoff({
            leadId: voiceCall.lead_id,
            brokerageId: voiceCall.brokerage_id ?? "",
            actorUserId: "system",
          }).catch(() => {})
        } else if (isNegativeOutcome) {
          // Negative: notes only, block phone + SMS, do NOT convert to contact
          await supabase
            .from("leads")
            .update({
              call_stop_flag: true,
              ai_isa_owner: false,
              notes: callNoteSummary,
              updated_at: new Date().toISOString(),
            })
            .eq("id", voiceCall.lead_id)
            .catch(() => {})

          await supabase.from("activities").insert({
            brokerage_id: voiceCall.brokerage_id,
            contact_id: voiceCall.lead_id,
            activity_type: "call_negative_outcome",
            title: "Lead requested no further contact via phone",
            description: callNoteSummary,
            status: "completed",
          }).catch(() => {})
        } else {
          // Neutral: add notes, keep lead in AI queue
          await supabase
            .from("leads")
            .update({ notes: callNoteSummary, updated_at: new Date().toISOString() })
            .eq("id", voiceCall.lead_id)
            .catch(() => {})
        }

      } else if (voiceCall.contact_id) {
        // ── Call operated from a CONTACT ────────────────────────────────────
        if (isNegativeOutcome) {
          // Negative: block phone + SMS channels on the contact, no channel removal
          await supabase
            .from("contacts")
            .update({
              call_stop_flag: true,
              dnc_status: true,
              isa_reengage_allowed: false,
              notes: callNoteSummary,
              updated_at: new Date().toISOString(),
            })
            .eq("id", voiceCall.contact_id)
            .catch(() => {})

          await supabase.from("activities").insert({
            brokerage_id: voiceCall.brokerage_id,
            contact_id: voiceCall.contact_id,
            activity_type: "call_negative_outcome",
            title: "Contact requested no further phone/SMS contact",
            description: callNoteSummary,
            status: "completed",
          }).catch(() => {})

        } else {
          // Positive or neutral: update contact with call notes
          await supabase
            .from("contacts")
            .update({
              last_contacted_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", voiceCall.contact_id)
            .catch(() => {})

          // Notify assigned agent on strong positive signal
          if (isPositiveOutcome && voiceCall.agent_id) {
            await supabase.from("notifications").insert({
              user_id: voiceCall.agent_id,
              brokerage_id: voiceCall.brokerage_id,
              type: "isa_qualified_lead",
              title: "AI-ISA: Contact ready for agent follow-up",
              body: callNoteSummary,
              entity_type: "contact",
              entity_id: voiceCall.contact_id,
            }).catch(() => {})
          }
        }
      }

      // 9. Post-call AI SDK follow-up (non-blocking — intentional fire-and-forget)
      // Only trigger if call had meaningful duration (> 15s) and outcome warrants follow-up
      const shouldFollowUp =
        durationSeconds > 15 &&
        suggestedNextAction !== "do_not_contact" &&
        endedReason !== "assistant-error"

      if (shouldFollowUp && voiceCall.contact_id) {
        schedulePostCallFollowUp({
          supabase,
          voiceCallId: voiceCall.id,
          contactId: voiceCall.contact_id,
          brokerageId: voiceCall.brokerage_id,
          agentId: voiceCall.agent_id,
          transcript,
          summary,
          intentPrimary,
          suggestedNextAction,
          urgencyScore,
        }).catch((err) => {
          console.error("[VAPI webhook] Post-call follow-up failed (non-blocking):", err)
        })
      }
    }

    return NextResponse.json({ received: true, processed: !!voiceCall, event: "call-ended" })
  }

  // Unknown event — ack without processing
  return NextResponse.json({ received: true, processed: false, event: eventType })
}

// ─── POST-CALL AI FOLLOW-UP ───────────────────────────────────────────────────

async function schedulePostCallFollowUp(params: {
  supabase: ReturnType<typeof createServiceClient>
  voiceCallId: string
  contactId: string
  brokerageId: string | null
  agentId: string | null
  transcript: string
  summary: string
  intentPrimary: string
  suggestedNextAction: string
  urgencyScore: number
}) {
  const { supabase, contactId, brokerageId, agentId, transcript, summary, intentPrimary, suggestedNextAction, urgencyScore } = params

  // Look up contact details for follow-up
  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, phone, tcpa_consent, dnc_status")
    .eq("id", contactId)
    .single()

  if (!contact) return

  // Hard stops — respect TCPA and DNC
  if (contact.dnc_status) return

  // brokerageId is required by dispatch — skip follow-up if not available
  if (!brokerageId) return

  // Build context for the AI to generate the follow-up
  const callContext = summary
    || (transcript.length > 0 ? `Call transcript excerpt: "${transcript.slice(0, 600)}"` : "A brief AI call")

  // Generate follow-up message using AI SDK
  const { text: followUpMessage } = await generateText({
    model: openai('gpt-4o-mini'),
    system: [
      "You are a real estate ISA (Inside Sales Agent) AI assistant.",
      "Write a short, warm, personalized follow-up message to send after a voice call.",
      "Keep it under 160 characters for SMS or 3–4 sentences for email.",
      "Do NOT mention you are an AI unless the contact directly asked.",
      "Match the tone to the call outcome and urgency.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          `Contact: ${contact.first_name ?? "there"} ${contact.last_name ?? ""}`.trim(),
          `Call intent: ${intentPrimary.replace(/_/g, " ")}`,
          `Urgency score: ${urgencyScore}/100`,
          `Suggested next action: ${suggestedNextAction.replace(/_/g, " ")}`,
          `Call summary: ${callContext}`,
          `Write a follow-up message appropriate for the channel.`,
        ].join("\n"),
      },
    ],
  })

  // Determine channel: SMS first (instant), then email
  const smsSent =
    contact.phone && contact.tcpa_consent
      ? await dispatchSms({
          to: contact.phone,
          message: followUpMessage.slice(0, 320), // allow MMS length
          brokerageId,
          agentId: agentId ?? undefined,
          systemSource: "vapi_post_call_followup",
          contactId,
          metadata: { voice_call_intent: intentPrimary, urgency_score: urgencyScore },
        }).then((r) => r.success).catch(() => false)
      : false

  const emailSent =
    !smsSent && contact.email
      ? await dispatchEmail({
          to: contact.email,
          from: "",
          subject: "Quick follow-up from your call",
          html: `<p>${followUpMessage.replace(/\n/g, "<br>")}</p>`,
          text: followUpMessage,
          brokerageId,
          agentId: agentId ?? undefined,
          systemSource: "vapi_post_call_followup",
          contactId,
          channelPurpose: "conversation",
        }).then((r) => r.success).catch(() => false)
      : false

  // Log the follow-up activity
  if (smsSent || emailSent) {
    await supabase.from("activities").insert({
      contact_id:    contactId,
      brokerage_id:  brokerageId,
      agent_id:      agentId,
      activity_type: smsSent ? "sms_sent" : "email_sent",
      title:         "AI post-call follow-up",
      description:   `Post-call AI follow-up: ${followUpMessage.slice(0, 100)}`,
      status:        "completed",
      notes: JSON.stringify({
        source:         "vapi_post_call_followup",
        voice_call_id:  params.voiceCallId,
        intent_primary: intentPrimary,
        urgency_score:  urgencyScore,
        channel:        smsSent ? "sms" : "email",
      }),
    })
  }
}
