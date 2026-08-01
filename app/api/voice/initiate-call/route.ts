/**
 * app/api/voice/initiate-call/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * POST — Initiate an outbound AI call on behalf of an agent (Twilio-native lane).
 *
 * Body: { phoneNumber, contactId?, leadId?, scriptId?, callPurpose? }
 *
 * Compliance: evaluateOutbound() is called when contactId is supplied, plus a
 * TCPA quiet-hours gate; placeOutboundAiCall re-runs the TCPA chokepoint and the
 * vendor budget gate before any dial. If blocked → 403 { blocked: true, reason }.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { buildCallContext } from "@/lib/ai-isa/build-call-context"
import { checkQuietHours } from "@/lib/communication/call-compliance"
import type { KernelContact } from "@/lib/kernel/types"

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth guard — agentId and brokerageId always from session, never from body
  const authSupabase = await createClient()
  const auth = await requireAuth(authSupabase)
  if (!auth.ok) return auth.response

  let body: {
    phoneNumber: string
    contactId?: string
    leadId?: string
    scriptId?: string
    callPurpose?: 'isa_qualification' | 'isa_followup' | 'ghost_recovery' | 'appointment_confirm' | 'post_close'
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // agentId and brokerageId always from session — never from body.
  //
  // IDENTITY CLASS (m358). This was `auth.agentId ?? auth.userId`, which made
  // agentId an AGENTS id normally and a USERS id when the caller had no agents
  // row — and the file then used it as BOTH: voice_calls.agent_id (FKs agents)
  // AND an agents.user_id lookup. No fallback: an outbound AI call is
  // agent-scoped, and a users id in either place is wrong rather than degraded.
  const agentId = auth.agentId
  if (!agentId) {
    return NextResponse.json({ error: "No agent profile for this user — an outbound AI call is agent-scoped." }, { status: 409 })
  }
  const brokerageId = auth.brokerageId
  const { phoneNumber, leadId, callPurpose = 'isa_qualification' } = body
  // contactId may be provided directly OR resolved from the lead record below
  let contactId = body.contactId ?? null

  if (!phoneNumber) {
    return NextResponse.json({ error: "phoneNumber is required" }, { status: 400 })
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

  // ── 1b. TCPA quiet-hours: outbound auto-dial calls must be 8am-9pm in
  // the recipient's local time. Resolves area code → state → timezone.
  const quietHoursCheck = checkQuietHours(phoneNumber)
  if (!quietHoursCheck.allowed) {
    return NextResponse.json(
      {
        blocked: true,
        reason: quietHoursCheck.reason ?? "Outside TCPA-allowed calling hours",
        recipientLocalHour: quietHoursCheck.recipientLocalHour,
        recipientTimezone: quietHoursCheck.recipientTimezone,
      },
      { status: 403 }
    )
  }

  // ── 2. Build brokerage-branded call context via buildCallContext() ───────────
  // This returns the assistant name, system prompt, and first message derived
  // from ai_identity_profiles (brokerage → team → agent hierarchy).
  // agentId IS the agents id (auth.agentId — see lib/kernel/api-auth), so the
  // lookup that used to sit here asked agents.user_id for an agents id, matched
  // nothing, and handed buildCallContext a null agent — every AI call fell back
  // to the brokerage/team identity profile instead of the agent's own.
  const callCtx = await buildCallContext({
    brokerageId,
    agentId,
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

  // ── 3. Place the call on the Twilio-native lane ─────────────────────────────
  // placeOutboundAiCall re-runs the TCPA chokepoint + vendor budget gate, dials
  // from the tenant's own number, and writes the voice_calls ledger row (the row
  // IS the serverless turn session; the answer/turn webhooks rebuild the ISA
  // brain from ai_notes). The persona (systemPrompt/firstMessage) travels with
  // it; AI + recording disclosures are applied inside the turn engine.
  const { placeOutboundAiCall } = await import("@/lib/voice/twilio-outbound")
  const placed = await placeOutboundAiCall(supabase, {
    toNumber: phoneNumber,
    contactId: contactId ?? null,
    brokerageId,
    agentUserId: agentId,
    initiatedBy: agentId,
    objective:
      callPurpose === "ghost_recovery"
        ? "Re-engage a contact who went quiet: reconnect warmly, learn what changed, and offer to book time with the agent."
        : "AI ISA outreach: understand where this person is in their journey (timeline, motivation) and offer to book time with the agent.",
    firstMessage: callCtx.firstMessage ?? null,
    systemPrompt: callCtx.systemPrompt ?? null,
  })
  if (!placed.ok) {
    // Honest failure — blocked (TCPA/budget) or no tenant number/creds.
    const status = placed.blocked ? 403 : 503
    return NextResponse.json(
      { error: placed.error, ...(placed.blocked ? { blocked: true, reason: placed.blockReason } : {}) },
      { status }
    )
  }

  // Attach the lead origin to the ledger row placeOutboundAiCall wrote (it does
  // not know about lead_id / agent_id — set them here for lead-based routing).
  if (placed.voiceCallId) {
    await supabase
      .from("voice_calls")
      .update({ agent_id: agentId, lead_id: resolvedLeadId ?? null })
      .eq("id", placed.voiceCallId)
  }

  // ── 4. INSERT ai_isa_calls row (placeOutboundAiCall already wrote voice_calls) ─
  const { error: isaInsertError } = await supabase.from("ai_isa_calls").insert({
    brokerage_id: brokerageId,
    contact_id: contactId ?? null,
    lead_id: resolvedLeadId ?? null,
    voice_call_id: placed.voiceCallId,
    script_used: callPurpose,
    appointment_set: false,
  })

  if (isaInsertError) {
    // Non-fatal: the call is already live; log but do not abort
    console.error("[initiate-call] ai_isa_calls insert error:", isaInsertError.message)
  }

  return NextResponse.json({ callId: placed.callSid, status: "initiated" }, { status: 200 })
}
