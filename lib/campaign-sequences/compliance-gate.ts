/**
 * lib/campaign-sequences/compliance-gate.ts
 *
 * Sequence-level authority gate. Wraps evaluateOutbound from the kernel compliance layer.
 * The compliance gate is ALWAYS active on every sequence — it cannot be disabled.
 * This file must NEVER be modified to bypass or skip the gate.
 */

import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { SupabaseClient } from "@supabase/supabase-js"

interface AuthorityCheckResult {
  allowed: boolean
  reason?: string
}

/**
 * checkSequenceAuthority
 *
 * Verifies that sending to a contact on this channel is allowed by:
 *  - TCPA consent (for sms/phone)
 *  - Authority rules (contact state / ISA re-engagement)
 *  - Fair housing
 *  - Them-first
 *  - Brand voice
 *
 * Content is intentionally empty string — this is a gate-only check.
 * Actual content compliance is validated at compose time.
 */
export async function checkSequenceAuthority(
  contactId: string,
  channel: string,
  actorContext: { brokerageId: string; userId: string },
  supabase: SupabaseClient
): Promise<AuthorityCheckResult> {
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single()

  if (error || !contact) {
    return { allowed: false, reason: "Contact not found" }
  }

  // Map sequence channel to messageType expected by evaluateOutbound
  const channelToMessageType: Record<string, string> = {
    email: "email",
    sms: "sms",
    voice: "phone",
    direct_mail: "email", // direct_mail has no consent gate — treat as email for authority check
    in_app: "email",
    video: "email",
  }
  const messageType = channelToMessageType[channel] ?? "email"

  const result = await evaluateOutbound({
    contact,
    channel: messageType,
    content: "", // gate-only — content check skipped
    messageType,
    actorContext: {
      ...actorContext,
      actorType: "ai_isa",
      role: "isa",
    },
  })

  return result.allowed
    ? { allowed: true }
    : { allowed: false, reason: result.blockedReason ?? result.violations?.[0] }
}
