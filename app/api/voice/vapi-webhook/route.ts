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
import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { KernelContact } from "@/lib/kernel/types"

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
          const kernelContact: KernelContact = {
            id: contact.id,
            first_name: contact.first_name ?? "",
            last_name: contact.last_name ?? "",
            email: contact.email ?? undefined,
            phone: contact.phone ?? undefined,
            contact_type: contact.contact_type ?? "buyer",
            tcpa_consent: contact.tcpa_consent ?? false,
            tcpa_consent_date: contact.tcpa_consent_date ?? undefined,
            isa_reengage_allowed: contact.isa_reengage_allowed ?? false,
            dnc_status: contact.dnc_status ?? false,
            status: contact.status ?? undefined,
            brokerage_id: contact.brokerage_id ?? undefined,
          }

          const complianceResult = await evaluateOutbound({
            actorContext: {
              userId: "system",
              role: "isa",
              brokerageId: brokerageId,
            },
            journeyType: "buyer",
            persona: "other",
            messageType: "phone",
            content: "",
            contact: kernelContact,
          })

          if (!complianceResult.allowed) {
            // Block the call — update the record and tell VAPI to play a message
            await supabase
              .from("voice_calls")
              .update({
                outcome: "authority_blocked",
                compliance_passed: false,
                compliance_flags: ["authority_block"],
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
