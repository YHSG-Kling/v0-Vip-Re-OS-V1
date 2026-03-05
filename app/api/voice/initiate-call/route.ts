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
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { KernelContact } from "@/lib/kernel/types"

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: {
    phoneNumber: string
    contactId?: string
    scriptId?: string
    agentId: string
    brokerageId: string
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { phoneNumber, contactId, scriptId, agentId, brokerageId } = body

  if (!phoneNumber || !agentId || !brokerageId) {
    return NextResponse.json({ error: "phoneNumber, agentId, and brokerageId are required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  // ── 1. Optional compliance check when contactId is provided ───────────────
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

  // ── 2. Fetch assistant_wake_name for the agent ─────────────────────────────
  const { data: agentUser } = await supabase
    .from("users")
    .select("assistant_wake_name")
    .eq("id", agentId)
    .maybeSingle()

  const wakeName = agentUser?.assistant_wake_name ?? "VIP"

  // ── 3. POST to VAPI API ────────────────────────────────────────────────────
  const vapiKey = process.env.VAPI_API_KEY
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID

  if (!vapiKey || !phoneNumberId) {
    return NextResponse.json({ error: "VAPI environment variables not configured" }, { status: 500 })
  }

  let vapiResponse: { id: string; status: string; createdAt?: string }
  try {
    const vapiRes = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vapiKey}`,
      },
      body: JSON.stringify({
        phoneNumberId,
        customer: { number: phoneNumber },
        assistant: {
          firstMessage: `Hi, this is ${wakeName} calling on behalf of your agent. How can I help you today?`,
          transcriber: { provider: "deepgram" },
          model: { provider: "anthropic", model: "claude-haiku-4-5" },
        },
      }),
    })

    if (!vapiRes.ok) {
      const errText = await vapiRes.text()
      return NextResponse.json({ error: `VAPI error: ${errText}` }, { status: 502 })
    }

    vapiResponse = await vapiRes.json()
  } catch (err) {
    return NextResponse.json({ error: "Failed to reach VAPI" }, { status: 502 })
  }

  // ── 4. INSERT voice_calls ──────────────────────────────────────────────────
  await supabase.from("voice_calls").insert({
    brokerage_id: brokerageId,
    agent_id: agentId,
    contact_id: contactId ?? null,
    direction: "outbound",
    status: "initiated",
    call_type: "agent_call",
    phone_to: phoneNumber,
    vapi_call_id: vapiResponse.id,
  })

  return NextResponse.json({ callId: vapiResponse.id, status: "initiated" }, { status: 200 })
}
