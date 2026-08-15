// SYSTEM: Inbound Message Router (Provider-Routed)
// Single ingress for all inbound provider events (email / SMS).
// No CRON_SECRET — uses provider signature validation via inbound-router.ts.
// The Kernel remains the authority on what happens next.

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { normalizeInbound } from "@/lib/providers/inbound-router"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel"
import { processOptOut } from "@/app/actions/ai-isa/process-opt-out"
import { detectOptOutIntent } from "@/lib/ai-isa/opt-out-utils"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Step 1: Normalize + verify provider signature ──────────────────────────
  const result = await normalizeInbound(req)

  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason },
      { status: result.status }
    )
  }

  const inbound = result.message
  const supabase = createServiceClient()

  // ── Step 2: Normalize identifiers for matching ─────────────────────────────
  const emailNorm = inbound.fromEmail?.toLowerCase().trim() ?? null
  const phoneDigits = inbound.fromPhone?.replace(/\D/g, "") ?? null

  // ── Step 3: Match CONTACT first (contacts are primary) ─────────────────────
  let entityType: "contact" | "lead" | null = null
  let entityId: string | null = null

  if (emailNorm || phoneDigits) {
    let contactQuery = supabase
      .from("contacts")
      .select("id")
      .eq("brokerage_id", inbound.brokerageId)

    if (emailNorm && phoneDigits) {
      contactQuery = contactQuery.or(
        `email.eq.${emailNorm},phone_digits.eq.${phoneDigits}`
      )
    } else if (emailNorm) {
      contactQuery = contactQuery.eq("email", emailNorm)
    } else if (phoneDigits) {
      contactQuery = contactQuery.eq("phone_digits", phoneDigits)
    }

    const { data: contact } = await contactQuery.maybeSingle()

    if (contact) {
      entityType = "contact"
      entityId = contact.id
    }
  }

  // ── Step 4: Fall back to active LEAD if no contact matched ─────────────────
  if (!entityType && (emailNorm || phoneDigits)) {
    let leadQuery = supabase
      .from("leads")
      .select("id")
      .eq("brokerage_id", inbound.brokerageId)
      .eq("is_active", true)

    if (emailNorm && phoneDigits) {
      leadQuery = leadQuery.or(
        `email.eq.${emailNorm},phone_digits.eq.${phoneDigits}`
      )
    } else if (emailNorm) {
      leadQuery = leadQuery.eq("email", emailNorm)
    } else if (phoneDigits) {
      leadQuery = leadQuery.eq("phone_digits", phoneDigits)
    }

    const { data: lead } = await leadQuery.maybeSingle()

    if (lead) {
      entityType = "lead"
      entityId = lead.id
    }
  }

  // ── Step 5: No match — return 200 with linked:false (no-op) ────────────────
  if (!entityType || !entityId) {
    return NextResponse.json({ linked: false })
  }

  // ── Step 6: Write lifecycle_events ─────────────────────────────────────────
  // DB column is `metadata` (jsonb) — pass plain object, not JSON.stringify
  await supabase.from("lifecycle_events").insert({
    brokerage_id: inbound.brokerageId,
    entity_type: entityType,
    entity_id: entityId,
    event_type: KernelEvent.ISA_REPLY_RECEIVED,
    metadata: {
      provider: inbound.providerType,
      messageId: inbound.messageId,
      fromEmail: inbound.fromEmail,
      fromPhone: inbound.fromPhone,
      subject: inbound.subject,
      text: (inbound.text ?? "").slice(0, 500),
    },
  })

  // ── Step 7: Update last activity timestamps ─────────────────────────────────
  const now = new Date().toISOString()

  if (entityType === "contact") {
    await supabase
      .from("contacts")
      .update({ last_contacted_at: now })
      .eq("id", entityId)
  } else {
    await supabase
      .from("leads")
      .update({ last_activity_at: now })
      .eq("id", entityId)
  }

  // ── Step 7b: Opt-out detection ─────────────────────────────────────────────
  // Check inbound message text for STOP / unsubscribe signals before kernel handoff.
  // High-confidence matches suppress the channel immediately and automatically.
  // Medium-confidence creates a high-priority agent review suggestion.
  const messageText = inbound.text ?? inbound.subject ?? ""
  if (messageText) {
    const optOutCheck = detectOptOutIntent(messageText)

    if (optOutCheck.isOptOut && optOutCheck.confidence === "high") {
      await processOptOut({
        entityType,
        entityId,
        channel: optOutCheck.channel,
        source: inbound.providerType === "sms" ? "inbound_sms" : "inbound_email",
        rawMessage: messageText,
        brokerageId: inbound.brokerageId,
      }).catch((err) => {
        console.error("[InboundRouter] processOptOut failed (non-blocking):", err)
      })
    } else if (optOutCheck.isOptOut && optOutCheck.confidence === "medium") {
      // smart_assistant_suggestions: no brokerage_id, no contact_id, no metadata column
      // Map to available columns: agent_id via entity lookup, action_payload_json for context
      await supabase
        .from("smart_assistant_suggestions")
        .insert({
          title: "Possible opt-out request received",
          description: `Message: "${messageText.slice(0, 200)}" — Review and suppress channel if needed.`,
          priority: "high",
          context_type: "compliance",
          source_system: "inbound_router",
          status: "pending",
          action_type: "review_opt_out",
          action_payload_json: JSON.stringify({
            channel: optOutCheck.channel,
            confidence: optOutCheck.confidence,
            entityType,
            entityId,
            brokerageId: inbound.brokerageId,
          }),
        })
        .then(() => {}, () => {})
    }
  }

  // ── Step 8: Kernel handoff ──────────────────────────────────────────────────
  // Non-fatal: if kernel processing fails, the lifecycle_event is already recorded.
  try {
    await processKernelEvent({
      event: KernelEvent.ISA_REPLY_RECEIVED,
      brokerageId: inbound.brokerageId,
      entityType,
      entityId,
    })
  } catch (err) {
    console.error("[InboundRouter] processKernelEvent failed:", err)
  }

  // ── Step 9: Return success ──────────────────────────────────────────────────
  return NextResponse.json({ linked: true, entityType, entityId })
}
