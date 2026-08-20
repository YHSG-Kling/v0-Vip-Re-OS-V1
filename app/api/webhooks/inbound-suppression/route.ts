// app/api/webhooks/inbound-suppression/route.ts
// WEBHOOK: Capture inbound suppression intents (stop/unsubscribe)
// Detects and applies suppression from SMS, email, phone responses
//
// ── AUTH: SHARED SECRET, UNSET = 404 ────────────────────────────────────────
// This handler had NO caller authentication. It runs on the service client
// (RLS bypassed), and when the payload omits `brokerageId` it matched contacts
// by bare phone/email across EVERY tenant (see the two identity lookups below).
// So an unauthenticated POST of {source:"sms", phoneNumber:"…", message:"stop"}
// set call_stop_flag / sms_opt_out / email_opt_out on somebody else's contact —
// a cross-tenant write and a denial-of-communication vector — while the
// 404 `contact_not_found` vs 200 `success` split answered "is this phone number
// in your CRM?" for anyone who asked.
//
// The gate is the idiom the other provider webhooks in this tree already use
// (app/api/webhooks/sendgrid-events/route.ts:43, app/api/webhooks/lob-events/
// route.ts:41, app/api/webhooks/twilio-sms-status/route.ts:46): the secret is
// read from the env, an UNSET secret is an honest 404 rather than a silently
// open endpoint, and a wrong secret is a 401. Nothing in this repo addresses
// this route and no provider integration in this repo is configured to call it,
// so the closed-by-default posture is the correct production state; set
// INBOUND_SUPPRESSION_WEBHOOK_SECRET and hand the URL its secret to enable it.
//
// The signature-verified path that actually carries real inbound opt-outs today
// is app/api/providers/inbound/route.ts (bound as SmsUrl at
// lib/voice/twilio-voice.ts:151) → lib/ai-isa/opt-out-utils.ts:12
// → app/actions/ai-isa/process-opt-out.ts. Prefer it for anything new.

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateOutboundCompliance } from "@/lib/kernel/communication-compliance"
import { syncSuppressionState, recordSuppressionEvent } from "@/lib/kernel/suppression-sync"

export const runtime = "nodejs"

interface InboundSuppressionPayload {
  source: "sms" | "email" | "phone" | "webhook"
  contactId?: string
  leadId?: string
  /** Tenant hint — callers that know which brokerage's channel received the
   *  message pass it so identity matches never cross tenants. */
  brokerageId?: string
  phoneNumber?: string
  emailAddress?: string
  message: string
  timestamp?: string
  metadata?: Record<string, any>
}

interface DetectIntentOutput {
  hasIntent: boolean
  intentType?: "stop" | "unsubscribe" | "do_not_call" | "do_not_text" | "wrong_number" | "wrong_person"
  confidence: number
  recommendedAction: "apply_suppression" | "review" | "ignore"
}

/**
 * INTENT DETECTION: Analyze message for suppression keywords
 * Returns suppression intent with confidence score
 */
function detectSuppressionIntent(message: string): DetectIntentOutput {
  const lowerMessage = message.toLowerCase().trim()

  // Stop/Unsubscribe patterns
  const stopPatterns = [
    /\bstop\b/,
    /\bunsubscribe\b/,
    /\bdo not (call|text|call|contact)\b/,
    /\bremove (me|my number)\b/,
    /\bopt.?out\b/,
    /\bno more\b/,
  ]

  // Do Not Call patterns
  const dncPatterns = [
    /\bdo not call\b/,
    /\bdo not call list\b/,
    /\bdo not call registry\b/,
    /\ndnc\b/,
  ]

  // Wrong number patterns
  const wrongNumberPatterns = [
    /\bwrong number\b/,
    /\bwrong person\b/,
    /\bi don't know (who|this)\b/,
    /\byou have the wrong.*number\b/,
  ]

  // Score by pattern match
  if (dncPatterns.some(p => p.test(lowerMessage))) {
    return {
      hasIntent: true,
      intentType: "do_not_call",
      confidence: 0.95,
      recommendedAction: "apply_suppression",
    }
  }

  if (stopPatterns.some(p => p.test(lowerMessage))) {
    return {
      hasIntent: true,
      intentType: "stop",
      confidence: 0.9,
      recommendedAction: "apply_suppression",
    }
  }

  if (wrongNumberPatterns.some(p => p.test(lowerMessage))) {
    return {
      hasIntent: true,
      intentType: "wrong_number",
      confidence: 0.85,
      recommendedAction: "review",
    }
  }

  return {
    hasIntent: false,
    confidence: 0,
    recommendedAction: "ignore",
  }
}

/**
 * WEBHOOK HANDLER: Process inbound suppression intent
 * 
 * POST /api/webhooks/inbound-suppression
 * Body: { source, contactId, leadId, message, ... }
 * 
 * Detects intent → Finds contact → Applies suppression → Syncs to lead
 */
export async function POST(request: NextRequest) {
  try {
    // ─── AUTH ──────────────────────────────────────────────────────────────
    // Unset secret = 404 (never a silently-open suppression writer);
    // wrong secret = 401. See the header for why this is not optional.
    const secret = process.env.INBOUND_SUPPRESSION_WEBHOOK_SECRET
    if (!secret) {
      return NextResponse.json({ error: "not found" }, { status: 404 })
    }
    const given =
      request.nextUrl.searchParams.get("secret") ??
      request.headers.get("x-webhook-secret")
    if (given !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    const payload: InboundSuppressionPayload = await request.json()
    const supabase = await createServiceClient()

    // ─── DETECT INTENT ─────────────────────────────────────────────────────
    const intent = detectSuppressionIntent(payload.message)

    if (!intent.hasIntent) {
      return NextResponse.json(
        { success: false, reason: "no_suppression_intent" },
        { status: 200 }
      )
    }

    // ─── FIND CONTACT ──────────────────────────────────────────────────────
    let contactId = payload.contactId
    let contact

    if (!contactId && payload.leadId) {
      // Find contact via lead
      const { data: lead } = await supabase
        .from("leads")
        .select("contact_id")
        .eq("id", payload.leadId)
        .maybeSingle()
      contactId = lead?.contact_id
    }

    if (!contactId && payload.phoneNumber) {
      // Find contact by phone.
      // tenant anchor (scope burn-down): scope the identity match to the payload's
      // brokerage when the caller carries one; otherwise the phone number is a
      // unique-ish inbound identity — keep the match but cap it at one row.
      let byPhone = supabase
        .from("contacts")
        .select("id")
        .eq("phone", payload.phoneNumber)
        .limit(1)
      if (payload.brokerageId) byPhone = byPhone.eq("brokerage_id", payload.brokerageId)
      const { data: contacts } = await byPhone
      contactId = contacts?.[0]?.id
    }

    if (!contactId && payload.emailAddress) {
      // Find contact by email.
      // tenant anchor (scope burn-down): same brokerage scoping as the phone match.
      let byEmail = supabase
        .from("contacts")
        .select("id")
        .eq("email", payload.emailAddress)
        .limit(1)
      if (payload.brokerageId) byEmail = byEmail.eq("brokerage_id", payload.brokerageId)
      const { data: contacts } = await byEmail
      contactId = contacts?.[0]?.id
    }

    if (!contactId) {
      return NextResponse.json(
        { success: false, reason: "contact_not_found" },
        { status: 404 }
      )
    }

    // ─── FETCH FULL CONTACT FOR COMPLIANCE ─────────────────────────────────
    const { data: contactData, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .maybeSingle()

    if (contactError || !contactData) {
      return NextResponse.json(
        { success: false, reason: "contact_fetch_failed" },
        { status: 500 }
      )
    }

    // ─── APPLY SUPPRESSION BASED ON INTENT ─────────────────────────────────
    let suppressionType: "dnc" | "call_stop" | "email_opt_out" | "sms_opt_out" | "manual"
    const suppressionFields: Record<string, boolean> = {}

    if (intent.intentType === "do_not_call" || intent.intentType === "stop") {
      suppressionType = "call_stop"
      suppressionFields.call_stop_flag = true
    } else if (intent.intentType === "do_not_text") {
      suppressionType = "sms_opt_out"
      suppressionFields.sms_opt_out = true
    } else if (intent.intentType === "unsubscribe") {
      suppressionType = "email_opt_out"
      suppressionFields.email_opt_out = true
    } else {
      suppressionType = "manual"
      suppressionFields.call_stop_flag = true
    }

    // ─── UPDATE CONTACT ────────────────────────────────────────────────────
    const { error: updateError } = await supabase
      .from("contacts")
      .update(suppressionFields)
      .eq("id", contactId)

    if (updateError) {
      console.error("[Webhook] Failed to update contact suppression:", updateError)
      return NextResponse.json(
        { success: false, reason: "suppression_update_failed" },
        { status: 500 }
      )
    }

    // ─── SYNC TO LEAD ──────────────────────────────────────────────────────
    if (payload.leadId) {
      await syncSuppressionState({
        sourceType: "contact",
        sourceId: contactId,
        suppressionFields: suppressionFields as any,
      })
    }

    // ─── RECORD SUPPRESSION EVENT ──────────────────────────────────────────
    await recordSuppressionEvent(
      contactId,
      suppressionType,
      `Inbound ${payload.source} suppression intent: "${payload.message.substring(0, 100)}"`,
      "webhook"
    )

    return NextResponse.json(
      {
        success: true,
        contactId,
        intentType: intent.intentType,
        confidence: intent.confidence,
        suppressionApplied: suppressionType,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[Webhook] Error processing inbound suppression:", error)
    return NextResponse.json(
      { success: false, error: "internal_server_error" },
      { status: 500 }
    )
  }
}
