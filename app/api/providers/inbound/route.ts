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
  const supabase = createServiceClient()

  // ── Step 1: Normalize + verify provider signature ──────────────────────────
  // Twilio: tenant numbers live on SUBACCOUNTS that sign with their own token —
  // the resolver hands the router the owning tenant's token + the master.
  const result = await normalizeInbound(req, {
    twilioTokenResolver: async (params) => {
      const { twilioTokenCandidates } = await import("@/lib/voice/sms-inbound")
      return twilioTokenCandidates(supabase, params)
    },
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason },
      { status: result.status }
    )
  }

  const inbound = result.message

  // ── Step 1b: Twilio per-number tenancy — the CALLED number IS the tenant ────
  // (no brokerage_id query param needed on per-number webhooks; the same
  // registry the voice lane binds). Also remembers the number's agent so an
  // unknown texter can be captured ASSIGNED, not orphaned.
  let numberCtx: Awaited<ReturnType<typeof import("@/lib/voice/sms-inbound").resolveTenantByOwnNumber>> = null
  if (inbound.providerType === "twilio") {
    const { resolveTenantByOwnNumber } = await import("@/lib/voice/sms-inbound")
    numberCtx = await resolveTenantByOwnNumber(supabase, inbound.toPhone)
    if (!inbound.brokerageId) {
      if (!numberCtx) {
        return NextResponse.json({ error: "This number isn't registered to a tenant" }, { status: 404 })
      }
      inbound.brokerageId = numberCtx.brokerageId
    }
  }

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

  // ── Step 5: No match. An email no-ops, but an UNKNOWN NUMBER texting the
  // tenant's own line is a hand-raise — capture a consented contact assigned
  // to the number's agent (texting in IS consent for the thread — the same
  // provenance rule as the inbound-call lane). ───────────────────────────────
  if (!entityType || !entityId) {
    if (inbound.providerType === "twilio" && numberCtx && inbound.fromPhone && (inbound.text ?? "").trim()) {
      const { captureTextingContact } = await import("@/lib/voice/sms-inbound")
      const captured = await captureTextingContact(
        supabase, numberCtx, inbound.fromPhone,
        inbound.channel === "whatsapp" ? "whatsapp" : "sms",
      )
      if (captured) {
        entityType = "contact"
        entityId = captured
      }
    }
    if (!entityType || !entityId) return NextResponse.json({ linked: false })
  }

  // ── Step 5b: Land the text in the UNIFIED INBOX (the messages row the
  // universal inbox reads — previously inbound texts were invisible there).
  // Idempotent by MessageSid; the owning agent gets a high-priority heads-up. ──
  if (inbound.providerType === "twilio" && entityType === "contact" && (inbound.text ?? "").trim()) {
    const { recordInboundMessage, draftProactiveReply } = await import("@/lib/voice/sms-inbound")
    try {
      const rec = await recordInboundMessage(supabase, {
        brokerageId: inbound.brokerageId,
        contactId: entityId,
        agentUserId: numberCtx?.agentUserId ?? null,
        channel: inbound.channel === "whatsapp" ? "whatsapp" : "sms",
        body: inbound.text ?? "",
        messageSid: inbound.messageId,
        fromPhone: inbound.fromPhone,
        toPhone: inbound.toPhone,
      })
      // PROACTIVE DRAFT: the text arrives with the reply already prepared —
      // gated on the reply-coach rail (agent accepts/edits/sends; the
      // generator enforces DNC/TCPA + brand voice). Best-effort.
      if (rec.recorded && rec.messageId && rec.conversationId && rec.agentUserId) {
        await draftProactiveReply({
          brokerageId: inbound.brokerageId,
          contactId: entityId,
          conversationId: rec.conversationId,
          messageId: rec.messageId,
          agentUserId: rec.agentUserId,
          body: inbound.text ?? "",
        }).catch((err) => console.error("[InboundRouter] proactive draft failed (non-blocking):", err))
      }
    } catch (err) {
      console.error("[InboundRouter] inbox record failed (non-blocking):", err)
    }

    // ── WRITTEN CRITERIA → LIVING ALERT (SMS ear) ───────────────────────────
    // The same listener the voice sweep runs on call transcripts, on the
    // contact's TEXTED words: a body stating concrete search criteria (high
    // confidence, ≥2 concrete signals) proposes ONE inactive property alert
    // (source 'text_conversation') on the approval rail. Reads ONLY the
    // contact's inbound body — never AI drafts. Deduped per MessageSid
    // ([msg:<id>] in alert_name); best-effort — never breaks ingress.
    try {
      const { proposeWrittenCriteriaAlert } = await import("@/lib/buyer-search/written-criteria-alert")
      await proposeWrittenCriteriaAlert(supabase, {
        brokerageId: inbound.brokerageId,
        contactId: entityId,
        agentUserId: numberCtx?.agentUserId ?? null,
        messageRef: inbound.messageId,
        body: inbound.text ?? "",
      })
    } catch (err) {
      console.error("[InboundRouter] written-criteria listener failed (non-blocking):", err)
    }
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

  // ── Step 6b: Behavioural event log — sms_reply ─────────────────────────────
  // The contact texting back is a scored responsiveness signal (sms_reply,
  // 10 pts in lib/lead-scoring/behavioral-events), read by the canonical
  // scorer's behavioural 30% from lead_behavioral_data. This ingress is the
  // only place that knows the reply happened, and it can never hold the agent
  // session the old tracker action demanded. Identity/tenant are the ones THIS
  // route already resolved server-side: the signature-verified provider event's
  // sender matched within inbound.brokerageId (Steps 1–5) — never the body.
  // entityId is a contact id or a scraped-lead id; both are the id class the
  // scorer queries lead_behavioral_data.lead_id with. Best-effort: the recorder
  // logs a refused write as not-recorded and never breaks ingress.
  if (inbound.providerType === "twilio" && (inbound.text ?? "").trim()) {
    const { recordBehavioralEvent } = await import("@/lib/lead-scoring/record-behavioral-event")
    await recordBehavioralEvent({
      brokerageId: inbound.brokerageId,
      contactId: entityId,
      eventType: "sms_reply",
      eventData: {
        channel: inbound.channel === "whatsapp" ? "whatsapp" : "sms",
        provider_message_id: inbound.messageId ?? null,
        entity_type: entityType,
      },
    })
  }

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
      // A MEDIUM-confidence opt-out needs a human to confirm + suppress — failing to action it means
      // we keep messaging someone who may have opted out (TCPA exposure). Previously this row carried
      // NO brokerage_id / agent_id / user_id (the "no brokerage_id column" comment was wrong — it
      // exists), so it was orphaned: invisible to every scoped view and reaching no one. Scope it to
      // the brokerage, route it to the owning agent, and alert compliance/admins.
      let ownerAgentId: string | null = null
      if (entityType === "contact" && entityId) {
        const { data: c } = await supabase.from("contacts").select("agent_id").eq("id", entityId).maybeSingle()
        ownerAgentId = (c as { agent_id?: string | null } | null)?.agent_id ?? null
      } else if (entityType === "lead" && entityId) {
        const { data: l } = await supabase.from("leads").select("agent_id").eq("id", entityId).maybeSingle()
        ownerAgentId = (l as { agent_id?: string | null } | null)?.agent_id ?? null
      }

      await supabase
        .from("smart_assistant_suggestions")
        .insert({
          brokerage_id: inbound.brokerageId,
          agent_id: ownerAgentId,
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

      // Alert the humans who own consent — compliance officers + admins. Best-effort.
      try {
        const { data: reviewers } = await supabase
          .from("users")
          .select("id")
          .eq("brokerage_id", inbound.brokerageId)
          .in("user_type", ["compliance_officer", "admin", "broker"])
        for (const r of reviewers ?? []) {
          await supabase.from("notifications").insert({
            user_id: r.id,
            brokerage_id: inbound.brokerageId,
            type: "opt_out_review_required",
            title: "Possible opt-out needs review",
            body: `A ${optOutCheck.channel} message may be an opt-out: "${messageText.slice(0, 160)}". Confirm and suppress if needed.`,
            entity_type: entityType ?? "contact",
            entity_id: entityId ?? null,
            priority: "high",
            channel: "in_app",
          })
        }
      } catch (e) {
        console.error("[InboundRouter] failed to alert compliance of possible opt-out:", e)
      }
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

  // ── Step 8b: AI ISA inbound-intent classification + conversion (LEAD replies) ────
  // The autonomy capstone: a lead's reply is read, its intent classified, and self-routed to the
  // right conversion milestone (positive_reply / criteria_request / preapproval / showing) via the
  // canonical handoff — negative replies HALT, ambiguous keep nurturing. The route already verified
  // the provider signature, so we forward CRON_SECRET as the trusted-internal token the handler
  // documents (handle-inbound-email.ts: "webhook ingress should forward CRON_SECRET in internalSecret").
  // Best-effort + idempotent — never breaks ingress. (Contacts route through their own portal/qual loop.)
  if (entityType === "lead" && entityId && inbound.fromEmail) {
    try {
      const { processInboundEmail } = await import("@/app/actions/ai-isa/handle-inbound-email")
      await processInboundEmail({
        leadId: entityId,
        fromEmail: inbound.fromEmail,
        subject: inbound.subject ?? "",
        body: inbound.text ?? inbound.subject ?? "",
        internalSecret: process.env.CRON_SECRET,
      })
    } catch (err) {
      console.error("[InboundRouter] inbound-intent classification failed:", err)
    }
  }

  // ── Step 8c: THE SAME DOOR, FOR EVERY LEAD INBOUND — including the ones 8b
  // could never see. ───────────────────────────────────────────────────────────
  //
  // Step 8b is guarded on `inbound.fromEmail`, which an SMS never carries. So a
  // LEAD who TEXTED in was matched at Step 4, logged at Step 6, scanned for
  // opt-out at Step 7b — and then dropped. Their words never reached the intent
  // classifier and they could not convert, ever. The owner's ruling names texts
  // explicitly alongside calls, email and direct mail.
  //
  // This runs for BOTH branches, and does different work in each:
  //   • SMS/WhatsApp (no fromEmail) — records the message and runs the FULL
  //     evaluation: opt-out, then intent, then automatic conversion on a clear
  //     positive through the canonical lane.
  //   • Email (8b already classified) — `intentAlreadyRouted: true`, so it records
  //     the message and BINDS the opt-out without a second model call. That
  //     binding is the part 8b does not do: Step 7b's processOptOut writes flags
  //     on the row but no `contact_suppression_list` row, and for a LEAD the
  //     address-keyed suppression list is the only arm of `checkSuppression` that
  //     can fire (the flag arm is contact-keyed).
  //
  // Idempotent by construction: the door records to `lead_conversation_history`
  // first, where m488's partial unique index on (lead_id, provider_ref) refuses a
  // retried webhook before any evaluation runs.
  //
  // Best-effort — a classification failure must never break ingress.
  if (entityType === "lead" && entityId && (inbound.text ?? "").trim()) {
    try {
      const { ingestInboundLeadSignalAction } = await import("@/app/actions/lead-signal-ingest")
      await ingestInboundLeadSignalAction({
        brokerageId: inbound.brokerageId,
        leadId: entityId,
        channel: inbound.fromEmail ? "email" : "sms",
        body: inbound.text ?? "",
        providerRef: inbound.messageId ?? null,
        context: {
          provider: inbound.providerType,
          from_email: inbound.fromEmail ?? null,
          from_phone: inbound.fromPhone ?? null,
          subject: inbound.subject ?? null,
        },
        intentAlreadyRouted: !!inbound.fromEmail,
        internalSecret: process.env.CRON_SECRET,
      })
    } catch (err) {
      console.error("[InboundRouter] lead inbound-intent door failed:", err)
    }
  }

  // ── Step 9: Return success ──────────────────────────────────────────────────
  return NextResponse.json({ linked: true, entityType, entityId })
}
