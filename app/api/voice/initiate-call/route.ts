/**
 * app/api/voice/initiate-call/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * POST — Initiate an outbound VAPI AI call on behalf of an agent.
 *
 * Body: { phoneNumber, contactId?, scriptId?, agentId, brokerageId }
 *
 * Compliance: evaluateOutbound() is called when contactId is supplied.
 * If blocked → 403 { blocked: true, reason }.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { buildCallContext } from "@/lib/ai-isa/build-call-context"
import type { KernelContact } from "@/lib/kernel/types"

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth guard — evaluateOutbound uses createClient() internally for TCPA re-check
  const authSupabase = await createClient()
  const {
    data: { user: authUser },
  } = await authSupabase.auth.getUser()

  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: {
    phoneNumber: string
    contactId?: string
    leadId?: string
    scriptId?: string
    agentId: string
    brokerageId: string
    callPurpose?: 'isa_qualification' | 'isa_followup' | 'ghost_recovery' | 'appointment_confirm' | 'post_close'
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { phoneNumber, leadId, scriptId, agentId, brokerageId, callPurpose = 'isa_qualification' } = body
  // contactId may be provided directly OR resolved from the lead record below
  let contactId = body.contactId ?? null

  if (!phoneNumber || !agentId || !brokerageId) {
    return NextResponse.json({ error: "phoneNumber, agentId, and brokerageId are required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  // ── 0. Resolve contactId from lead when not explicitly supplied ───────────
  // A call can be initiated with either a contactId OR a leadId. When only
  // a leadId is given, check whether the lead already has a linked contact
  // and use that for compliance checks and ai_isa_calls attribution.
  if (!contactId && leadId) {
    const { data: leadRow } = await supabase
      .from("leads")
      .select("contact_id")
      .eq("id", leadId)
      .maybeSingle()
    if (leadRow?.contact_id) contactId = leadRow.contact_id
  }

  // ── 1. Optional compliance check when contactId is available ──────────────
  if (contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select(
        "id, first_name, last_name, email, phone, contact_type, tcpa_consent, tcpa_consent_date, isa_reengage_allowed, dnc_status, status, brokerage_id"
      )
      .eq("id", contactId)
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
          userId: agentId,
          role: "agent",
          brokerageId,
        },
        journeyType: "buyer",
        persona: "other",
        messageType: "phone",
        content: "",
        contact: kernelContact,
      })

      if (!complianceResult.allowed) {
        return NextResponse.json(
          { blocked: true, reason: complianceResult.blockedReason ?? "Compliance check failed" },
          { status: 403 }
        )
      }
    }
  }

  // ── 2. Build brokerage-branded call context via buildCallContext() ───────────
  // This returns the assistant name, system prompt, and first message derived
  // from ai_identity_profiles (brokerage → team → agent hierarchy).
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, user_id")
    .eq("user_id", agentId)
    .maybeSingle()

  const callCtx = await buildCallContext({
    brokerageId,
    agentId: agentRow?.id ?? null,
    contactId: contactId ?? null,
    leadId: leadId ?? null,
    callPurpose,
  })

  if (callCtx.blocked) {
    return NextResponse.json(
      { blocked: true, reason: callCtx.blockReason ?? "blocked" },
      { status: 403 }
    )
  }

  // ── 3. POST to VAPI API ────────────────────────────────────────────────────
  const vapiKey = process.env.VAPI_API_KEY
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

  if (!vapiKey || !phoneNumberId) {
    return NextResponse.json({ error: "VAPI environment variables not configured" }, { status: 500 })
  }

  let vapiResponse: { id: string; status: string; createdAt?: string }
  try {
    const vapiBody: Record<string, unknown> = {
      phoneNumberId,
      customer: { number: phoneNumber },
      assistant: {
        firstMessage: callCtx.firstMessage,
        transcriber: { provider: "deepgram" },
        model: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          systemPrompt: callCtx.systemPrompt,
          temperature: callCtx.temperature,
        },
        // Voice config from identity profile when set
        ...(callCtx.voiceConfig
          ? {
              voice: {
                provider: callCtx.voiceConfig.provider,
                voiceId: callCtx.voiceConfig.voiceId,
                stability: callCtx.voiceConfig.stability,
                similarityBoost: callCtx.voiceConfig.similarityBoost,
              },
            }
          : {}),
      },
    }

    const vapiRes = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vapiKey}`,
      },
      body: JSON.stringify(vapiBody),
    })

    if (!vapiRes.ok) {
      const errText = await vapiRes.text()
      return NextResponse.json({ error: `VAPI error: ${errText}` }, { status: 502 })
    }

    vapiResponse = await vapiRes.json()
  } catch {
    return NextResponse.json({ error: "Failed to reach VAPI" }, { status: 502 })
  }

  // ── 4. INSERT voice_calls ──────────────────────────────────────────────────
  const { data: voiceCallRow } = await supabase
    .from("voice_calls")
    .insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      contact_id: contactId ?? null,
      direction: "outbound",
      status: "initiated",
      call_type: "isa_ai",
      phone_to: phoneNumber,
      vapi_call_id: vapiResponse.id,
    })
    .select("id")
    .single()

  // ── 5. INSERT ai_isa_calls row (brokerage_id, contact_id, voice_call_id) ──
  await supabase.from("ai_isa_calls").insert({
    brokerage_id: brokerageId,
    contact_id: contactId ?? null,
    voice_call_id: voiceCallRow?.id ?? null,
    script_used: callPurpose,
    appointment_set: false,
  })

  return NextResponse.json({ callId: vapiResponse.id, status: "initiated" }, { status: 200 })
}
