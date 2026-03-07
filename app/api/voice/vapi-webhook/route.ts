/**
 * app/api/voice/vapi-webhook/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VAPI event webhook handler.
 * Processes: call-started, transcript, call-ended.
 * Enforces authority check (evaluateOutbound) for inbound AI ISA calls.
 *
 * Auth: x-vapi-secret header verified against VAPI_WEBHOOK_SECRET env var.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
// NOTE: evaluateOutbound uses createClient() internally (session-based).
// Webhooks from VAPI carry no user session, so we perform the authority check
// directly here using the service client rather than calling evaluateOutbound.
// The compliance_events write is also done manually via service client.

// Normalize a phone number to digits only (last 10 for US)
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Verify secret ──────────────────────────────────────────────────────
  const secret = req.headers.get("x-vapi-secret")
  if (!process.env.VAPI_WEBHOOK_SECRET || secret !== process.env.VAPI_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const eventType = body.type as string | undefined
  const callId = body.callId as string | undefined
  const supabase = createServiceClient()

  // Derive brokerage_id from query params (set when registering the webhook URL)
  const { searchParams } = new URL(req.url)
  const brokerageId = searchParams.get("brokerage_id") ?? null

  // ── 2. Handle events ──────────────────────────────────────────────────────

  if (eventType === "call-started") {
    const direction = (body.direction as string | undefined) ?? "inbound"
    const phoneFrom = (body.customer as any)?.number ?? null
    const phoneTo = (body.phoneNumber as any)?.number ?? null

    await supabase.from("voice_calls").insert({
      brokerage_id: brokerageId,
      vapi_call_id: callId,
      direction,
      call_type: "vapi_inbound",
      phone_from: phoneFrom,
      phone_to: phoneTo,
      status: "in_progress",
      started_at: new Date().toISOString(),
    })

    // ── Authority check for inbound AI ISA calls ────────────────────────────
    if (direction === "inbound") {
      const callTypeCheck = "vapi_inbound"
      const isAiIsaCall = ["vapi_inbound", "ai_isa_call"].includes(callTypeCheck)

      if (isAiIsaCall && phoneFrom && brokerageId) {
        const normalizedDigits = normalizePhone(phoneFrom)

        // Look up contact
        const { data: contact } = await supabase
          .from("contacts")
          .select(
            "id, first_name, last_name, email, phone, contact_type, tcpa_consent, tcpa_consent_date, isa_reengage_allowed, dnc_status, status, brokerage_id"
          )
          .eq("phone_digits", normalizedDigits)
          .maybeSingle()

        if (contact) {
          // Authority check: kernel RESTRICTED_STATES (matches lib/kernel/compliance.ts logic)
          // Done via service client since webhooks carry no user auth session.
          const RESTRICTED = new Set(["representation", "active_transaction", "under_contract", "REPRESENTATION", "ACTIVE_TRANSACTION", "UNDER_CONTRACT"])
          const tcpaConsent  = contact.tcpa_consent ?? false
          const dncStatus    = contact.dnc_status ?? false
          const inRestricted = RESTRICTED.has(contact.status ?? "")
          const isaReengage  = contact.isa_reengage_allowed === true

          const blocked =
            dncStatus ||
            !tcpaConsent ||
            (inRestricted && !isaReengage)

          // Always write compliance_events — mirrors evaluateOutbound contract
          const violations: string[] = []
          if (dncStatus) violations.push("TCPA: Contact on Do Not Contact list")
          if (!tcpaConsent) violations.push("TCPA: No phone consent")
          if (inRestricted && !isaReengage) violations.push("Authority: Contact in restricted state")

          await supabase
            .from("compliance_events")
            .insert({
              brokerage_id: brokerageId,
              gate_name: "vapi_inbound_gate",
              allowed: !blocked,
              violations,
              blocked_reason: violations[0] ?? null,
              actor_role: "isa",
              actor_user_id: "system",
              entity_type: "contact",
              entity_id: contact.id,
              message_type: "phone",
            })

          if (blocked) {
            // Update voice_calls record
            await supabase
              .from("voice_calls")
              .update({
                outcome: "authority_blocked",
                compliance_passed: false,
                compliance_flags: violations,
              })
              .eq("vapi_call_id", callId)

            return NextResponse.json(
              {
                response:
                  "This line is managed by your agent. Please contact your agent directly for assistance.",
              },
              { status: 200 }
            )
          }
        }
      }
    }
  } else if (eventType === "transcript") {
    const transcript = (body.transcript as string | undefined) ?? null
    if (callId && transcript) {
      await supabase
        .from("voice_calls")
        .update({ transcription: transcript })
        .eq("vapi_call_id", callId)
    }
  } else if (eventType === "call-ended") {
    const durationSeconds = (body.durationSeconds as number | undefined) ?? null
    const recordingUrl = (body.recordingUrl as string | undefined) ?? null
    const analysis = body.analysis as Record<string, unknown> | undefined
    const successEval = analysis?.successEvaluation
    const outcome = successEval ? "completed" : "no_answer"

    if (callId) {
      await supabase
        .from("voice_calls")
        .update({
          status: "completed",
          duration_seconds: durationSeconds,
          recording_url: recordingUrl,
          outcome,
          ended_at: new Date().toISOString(),
        })
        .eq("vapi_call_id", callId)
    }
  }

  return NextResponse.json({ received: true }, { status: 200 })
}
