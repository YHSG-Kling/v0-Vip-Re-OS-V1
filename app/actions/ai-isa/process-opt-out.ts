"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { bestEffort } from "@/lib/db/best-effort"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel"
import type { OptOutChannel } from "@/lib/ai-isa/opt-out-utils"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export interface OptOutParams {
  entityType: "contact" | "lead"
  entityId: string
  channel: OptOutChannel
  source: "inbound_sms" | "inbound_email" | "inbound_call" | "portal" | "agent" | "admin" | "voice"
  rawMessage?: string
  brokerageId: string
}

/**
 * processOptOut — TCPA-critical suppression writer.
 *
 * AUTH (dual-mode):
 *   1. UI / session caller (source: "agent" | "admin" | "portal" | "voice")
 *      — must have a session whose brokerage matches the entity.
 *   2. Inbound webhook caller (source: "inbound_sms" | "inbound_email") —
 *      arrives through app/api/providers/inbound/route.ts which has already
 *      verified the provider signature (Twilio HMAC / SendGrid / Postmark /
 *      Mailgun) via lib/providers/inbound-router.normalizeInbound. We trust
 *      that path but still re-verify the entity row's brokerage_id matches
 *      what the caller supplied so a forged param cannot suppress contacts
 *      in a different tenant.
 *
 * In BOTH modes, the effective brokerageId is taken from the verified
 * entity row — never the raw caller param — before any writes.
 */
export async function processOptOut(params: OptOutParams): Promise<{
  success: boolean
  channelsSuppressed: string[]
  globalDNC: boolean
  error?: string
}> {
  const supabase = createServiceClient()
  const { entityType, entityId, channel, source, rawMessage } = params

  // ── AUTH GATE ──────────────────────────────────────────────────────────
  // inbound_call = the Twilio voice turn webhook ("stop calling" said on a
  // live AI call) — same signature-verified ingress class as inbound_sms.
  const WEBHOOK_SOURCES = new Set(["inbound_sms", "inbound_email", "inbound_call"])
  const isWebhookSource = WEBHOOK_SOURCES.has(source)

  let effectiveBrokerageId: string

  if (isWebhookSource) {
    // Caller is the provider-inbound route post sig verify. We still re-
    // resolve the brokerage from the entity row so a forged brokerageId
    // param cannot redirect this write to another tenant.
    const table = entityType === "contact" ? "contacts" : "leads"
    const { data: entityRow } = await supabase
      .from(table)
      .select("brokerage_id")
      .eq("id", entityId)
      .maybeSingle()
    if (!entityRow?.brokerage_id) {
      return { success: false, channelsSuppressed: [], globalDNC: false, error: "Entity not found" }
    }
    effectiveBrokerageId = entityRow.brokerage_id
  } else {
    // Session-auth path (agent/admin/portal/voice).
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, channelsSuppressed: [], globalDNC: false, error: "Unauthorized" }
    }
    // Verify the entity belongs to the caller's brokerage. NEVER trust
    // the caller-supplied brokerageId.
    const table = entityType === "contact" ? "contacts" : "leads"
    const { data: entityRow } = await supabase
      .from(table)
      .select("brokerage_id")
      .eq("id", entityId)
      .maybeSingle()
    if (!entityRow || entityRow.brokerage_id !== ctx.brokerageId) {
      return { success: false, channelsSuppressed: [], globalDNC: false, error: "Forbidden" }
    }
    effectiveBrokerageId = ctx.brokerageId
  }

  // From here on, use effectiveBrokerageId — never params.brokerageId.
  const brokerageId = effectiveBrokerageId

  const channelsSuppressed: string[] = []
  let globalDNC = false
  const now = new Date().toISOString()

  // Determine scope of suppression
  const isGlobal =
    channel === "all" ||
    (rawMessage != null &&
      /\b(stop all|do not contact|dnc|remove me from everything|unsubscribe all)\b/i.test(rawMessage))

  const updates: Record<string, unknown> = {
    opted_out_at: now,
    opt_out_reason: rawMessage?.slice(0, 500) ?? `Opt-out via ${source}`,
    opt_out_source: source,
    updated_at: now,
  }

  if (isGlobal) {
    updates.dnc_status = true
    updates.email_opt_out = true
    updates.sms_opt_out = true
    updates.phone_opt_out = true
    updates.direct_mail_opt_out = true
    updates.opt_out_channels = ["email", "sms", "phone", "direct_mail"]
    // contacts table has isa_reengage_allowed; leads table does not
    if (entityType === "contact") {
      updates.isa_reengage_allowed = false
    }
    channelsSuppressed.push("email", "sms", "phone", "direct_mail")
    globalDNC = true
  } else {
    const channelColumn: Partial<Record<OptOutChannel, string>> = {
      email: "email_opt_out",
      sms: "sms_opt_out",
      phone: "phone_opt_out",
      direct_mail: "direct_mail_opt_out",
    }
    const col = channelColumn[channel]
    if (col) {
      updates[col] = true
      channelsSuppressed.push(channel)
      // Append channel to opt_out_channels array via fetch-and-update
      // (Supabase does not expose array append in a single update call)
      const table = entityType === "contact" ? "contacts" : "leads"
      const { data: current } = await supabase
        .from(table)
        .select("opt_out_channels")
        .eq("id", entityId)
        .maybeSingle()

      if (current) {
        const existing: string[] = (current as { opt_out_channels?: string[] }).opt_out_channels ?? []
        if (!existing.includes(channel)) {
          updates.opt_out_channels = [...existing, channel]
        }
      }
    }
  }

  const table = entityType === "contact" ? "contacts" : "leads"
  const { error: updateError } = await supabase
    .from(table)
    .update(updates)
    .eq("id", entityId)
    .eq("brokerage_id", brokerageId)

  if (updateError) {
    console.error("[processOptOut] DB update failed:", updateError)
    return { success: false, channelsSuppressed: [], globalDNC: false, error: updateError.message }
  }

  // Compliance audit — always write, never block on failure.
  //
  // "Never block on failure" was the intent; dropping the result was the
  // implementation. supabase-js resolves a rejected insert, so a failed write to
  // the OPT-OUT audit record — the row proving the OS honoured a consumer's
  // request to be left alone — produced no error, no log, and no row. bestEffort
  // keeps it non-blocking AND makes the failure visible, which is what
  // "tolerated" is supposed to mean.
  await bestEffort(
    supabase
    .from("compliance_events")
    .insert({
      brokerage_id: brokerageId,
      gate_name: "opt_out_processor",
      allowed: false,
      violations: [`Opt-out received via ${source}: ${channel}`],
      blocked_reason: `Contact opted out of ${channel} via ${source}`,
      actor_role: "system",
      entity_type: entityType,
      entity_id: entityId,
      message_type: channel,
    }),
    "opt-out compliance audit row",
  )

  // Agent notification via activities (uses notes: text, not metadata)
  const { data: entity } = await supabase
    .from(table)
    .select("agent_id, first_name, last_name")
    .eq("id", entityId)
    .maybeSingle()

  if (entity?.agent_id) {
    const notesPayload = JSON.stringify({
      opt_out_channel: channel,
      source,
      global_dnc: globalDNC,
      channels_suppressed: channelsSuppressed,
    })

    // THE consumer-facing compliance record of an opt-out. This is the row a
    // broker would hand a regulator to show the request was received and acted
    // on, so it does not get to fail quietly.
    const { error: optOutActivityError } = await supabase
      .from("activities")
      .insert({
        agent_id: entity.agent_id,
        contact_id: entityType === "contact" ? entityId : null,
        brokerage_id: brokerageId,
        activity_type: globalDNC ? "contact_dnc_set" : "contact_channel_opt_out",
        title: globalDNC
          ? `${entity.first_name} opted out of ALL communications`
          : `${entity.first_name} opted out of ${channel}`,
        description: rawMessage
          ? `Message received: "${rawMessage.slice(0, 200)}"`
          : `Opt-out recorded via ${source}`,
        status: "completed",
        priority: "high",
        notes: notesPayload,
      })
    if (optOutActivityError) {
      console.error("[processOptOut] opt-out activity REJECTED — the suppression is applied but has no timeline record:", optOutActivityError.message)
    }
  }

  // Kernel event — downstream automation stops automatically
  await processKernelEvent({
    event: globalDNC ? KernelEvent.CONTACT_DNC_SET : KernelEvent.CONTACT_CHANNEL_OPT_OUT,
    brokerageId,
    entityType,
    entityId,
  })

  return { success: true, channelsSuppressed, globalDNC }
}


