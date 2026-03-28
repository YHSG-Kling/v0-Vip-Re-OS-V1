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

  // ── 0. Resolve contactId only when the lead already has a linked contact ──
  // Architecture rules:
  //   - contactId provided directly → call operates from contact
  //   - leadId provided + lead has contact_id → resolve and operate from contact
  //   - leadId provided + lead has NO contact_id → call operates from lead directly;
  //     do NOT create a contact — conversion only happens on positive call outcome
  let resolvedLeadId: string | null = leadId ?? null
  if (!contactId && leadId) {
    const { data: leadRow } = await supabase
      .from("leads")
      .select("contact_id")
      .eq("id", leadId)
      .maybeSingle()
    if (leadRow?.contact_id) {
      // Lead already has a contact — operate from the contact
      contactId = leadRow.contact_id
      resolvedLeadId = null // contact takes precedence; no need to track lead separately
    }
    // If leadRow?.contact_id is null — leave contactId as null, call from lead
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
    return NextResponse.json(
      {
        error: "VAPI not configured",
        vapiNotConfigured: true,
        ctaMessage: "Configure VAPI to enable AI calling",
        ctaLink: "/admin/integrations",
      },
      { status: 503 }
    )
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

  // ── 4. INSERT voice_calls ─────────────────────────────────────────���────────
  // contact_id and lead_id are mutually exclusive per call origin:
  //   contact_id set → call from a contact record
  //   lead_id set    → call from a lead with no contact yet
  const { data: voiceCallRow, error: vcInsertError } = await supabase
    .from("voice_calls")
    .insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      contact_id: contactId ?? null,
      lead_id: resolvedLeadId ?? null,
      direction: "outbound",
      status: "initiated",
      call_type: "isa_ai",
      phone_to: phoneNumber,
      vapi_call_id: vapiResponse.id,
    })
    .select("id")
    .single()

  if (vcInsertError) {
    console.error("[initiate-call] voice_calls insert error:", vcInsertError.message)
  }

  // ── 5. INSERT ai_isa_calls row — schema: brokerage_id, contact_id, lead_id, voice_call_id, script_used, appointment_set
  const { error: isaInsertError } = await supabase.from("ai_isa_calls").insert({
    brokerage_id: brokerageId,
    contact_id: contactId ?? null,
    lead_id: resolvedLeadId ?? null,
    voice_call_id: voiceCallRow?.id ?? null,
    script_used: callPurpose,
    appointment_set: false,
  })

  if (isaInsertError) {
    // Non-fatal: the VAPI call is already live; log but do not abort
    console.error("[initiate-call] ai_isa_calls insert error:", isaInsertError.message)
  }

  return NextResponse.json({ callId: vapiResponse.id, status: "initiated" }, { status: 200 })
}
