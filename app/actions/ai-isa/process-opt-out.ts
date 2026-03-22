"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel"

export type OptOutChannel = "email" | "sms" | "phone" | "direct_mail" | "all"

export interface OptOutParams {
  entityType: "contact" | "lead"
  entityId: string
  channel: OptOutChannel
  source: "inbound_sms" | "inbound_email" | "portal" | "agent" | "admin" | "voice"
  rawMessage?: string
  brokerageId: string
}

export async function processOptOut(params: OptOutParams): Promise<{
  success: boolean
  channelsSuppressed: string[]
  globalDNC: boolean
  error?: string
}> {
  const supabase = createServiceClient()
  const { entityType, entityId, channel, source, rawMessage, brokerageId } = params

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
  const { error: updateError } = await supabase.from(table).update(updates).eq("id", entityId)

  if (updateError) {
    console.error("[processOptOut] DB update failed:", updateError)
    return { success: false, channelsSuppressed: [], globalDNC: false, error: updateError.message }
  }

  // Compliance audit — always write, never block on failure
  await supabase
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
    })
    .catch(() => {})

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

    await supabase
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
      .catch(() => {})
  }

  // Kernel event — downstream automation stops automatically
  await processKernelEvent({
    event: globalDNC ? KernelEvent.CONTACT_DNC_SET : KernelEvent.CONTACT_CHANNEL_OPT_OUT,
    brokerageId,
    entityType,
    entityId,
    metadata: { channel, source, globalDNC },
  }).catch(() => {})

  return { success: true, channelsSuppressed, globalDNC }
}

// ── Pure helper — no DB call, no async ──────────────────────────────────────

export function detectOptOutIntent(text: string): {
  isOptOut: boolean
  channel: OptOutChannel
  confidence: "high" | "medium"
} {
  const lower = text.toLowerCase().trim()

  // TCPA-standard single-word commands — highest confidence
  if (/^(stop|stopall|unsubscribe|cancel|end|quit|optout)$/i.test(lower)) {
    return { isOptOut: true, channel: "all", confidence: "high" }
  }

  // High-confidence global phrases
  const globalPhrases = [
    "do not contact me",
    "do not call me",
    "remove me from your list",
    "stop all messages",
    "unsubscribe from all",
    "take me off your list",
    "stop contacting me",
    "please stop",
    "leave me alone",
    "i do not want to be contacted",
    "do not reach out",
  ]
  if (globalPhrases.some((p) => lower.includes(p))) {
    return { isOptOut: true, channel: "all", confidence: "high" }
  }

  // Channel-specific patterns
  if (/stop.*email|no.*email|unsubscribe.*email|email.*stop/i.test(lower)) {
    return { isOptOut: true, channel: "email", confidence: "medium" }
  }
  if (/stop.*text|stop.*sms|no.*text|no.*sms|stop.*message/i.test(lower)) {
    return { isOptOut: true, channel: "sms", confidence: "high" }
  }
  if (/stop.*call|no.*call|do not call|don't call/i.test(lower)) {
    return { isOptOut: true, channel: "phone", confidence: "high" }
  }
  if (/stop.*mail|no.*mail|remove.*mail/i.test(lower)) {
    return { isOptOut: true, channel: "direct_mail", confidence: "medium" }
  }

  return { isOptOut: false, channel: "all", confidence: "high" }
}
