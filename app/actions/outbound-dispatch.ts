// app/actions/outbound-dispatch.ts
// SERVER ACTIONS: Compliance-gated dispatch with audit trail
// These actions wrap the dispatch providers and enforce compliance at the action boundary

"use server"

import { createClient } from "@/lib/supabase/server"
import { dispatchEmail, dispatchSms, dispatchPhone } from "@/lib/providers/dispatch"
import { evaluateOutboundCompliance } from "@/lib/kernel/communication-compliance"
import { recordSuppressionEvent } from "@/lib/kernel/suppression-sync"
import type { CommunicationChannel } from "@/lib/kernel/communication-compliance"

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACTS: Action input/output
// ─────────────────────────────────────────────────────────────────────────────

export interface SendOutboundInput {
  contactId: string
  channel: CommunicationChannel
  subject?: string // For email
  message: string // For SMS/email body/phone context
  metadata?: Record<string, any>
}

export interface SendOutboundOutput {
  success: boolean
  messageId?: string
  error?: string
  blocked?: boolean
  blockReason?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED ACTION: Send outbound via any channel
// ─────────────────────────────────────────────────────────────────────────────

export async function sendOutbound(
  input: SendOutboundInput
): Promise<SendOutboundOutput> {
  try {
    const supabase = await createClient()

    // ─── FETCH CONTACT ─────────────────────────────────────────────────────
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", input.contactId)
      .maybeSingle()

    if (contactError || !contact) {
      return {
        success: false,
        error: "Contact not found",
      }
    }

    // ─── EVALUATE COMPLIANCE ───────────────────────────────────────────────
    const complianceResult = await evaluateOutboundCompliance({
      contact,
      channel: input.channel,
      content: input.message,
      actorContext: {
        brokerageId: contact.brokerage_id,
        actorType: "agent",
        userId: (await supabase.auth.getUser()).data.user?.id,
      },
    })

    if (!complianceResult.allowed) {
      return {
        success: false,
        blocked: true,
        blockReason: complianceResult.primaryReason,
        error: `Cannot send via ${input.channel}: ${complianceResult.violations
          .map(v => v.message)
          .join(", ")}`,
      }
    }

    // ─── DISPATCH ───────────────────────────────────────────────────────────
    let dispatchResult

    if (input.channel === "email") {
      dispatchResult = await dispatchEmail({
        contactId: input.contactId,
        brokerageId: contact.brokerage_id,
        to: contact.email || "",
        from: `noreply@${process.env.NEXT_PUBLIC_APP_DOMAIN}`,
        subject: input.subject || "Message from us",
        html: input.message,
        metadata: input.metadata,
      })
    } else if (input.channel === "sms") {
      dispatchResult = await dispatchSms({
        contactId: input.contactId,
        brokerageId: contact.brokerage_id,
        to: contact.phone || "",
        message: input.message,
        metadata: input.metadata,
      })
    } else if (input.channel === "phone") {
      // Phone dispatch requires TwiML URL — typically set up by caller
      return {
        success: false,
        error: "Phone dispatch requires TwiML setup via direct call",
      }
    } else {
      return {
        success: false,
        error: `Unsupported channel: ${input.channel}`,
      }
    }

    return {
      success: dispatchResult.success,
      messageId: dispatchResult.messageId,
      error: dispatchResult.error,
    }
  } catch (error) {
    console.error("[Dispatch] Error in sendOutbound:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ACTION: Apply suppression manually (override)
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplySuppressionInput {
  contactId: string
  suppressionType: "dnc" | "call_stop" | "email_opt_out" | "sms_opt_out"
  reason: string
}

export interface ApplySuppressionOutput {
  success: boolean
  error?: string
}

export async function applySuppression(
  input: ApplySuppressionInput
): Promise<ApplySuppressionOutput> {
  try {
    const supabase = await createClient()

    // Verify caller is authenticated
    const authUser = await supabase.auth.getUser()
    if (!authUser.data.user) {
      return {
        success: false,
        error: "Not authenticated",
      }
    }

    // ─── BUILD UPDATE PAYLOAD ──────────────────────────────────────────────
    const updatePayload: Record<string, any> = {}

    if (input.suppressionType === "dnc" || input.suppressionType === "call_stop") {
      updatePayload.call_stop_flag = true
    } else if (input.suppressionType === "email_opt_out") {
      updatePayload.email_opt_out = true
    } else if (input.suppressionType === "sms_opt_out") {
      updatePayload.sms_opt_out = true
    }

    // ─── UPDATE CONTACT ────────────────────────────────────────────────────
    const { error: updateError } = await supabase
      .from("contacts")
      .update(updatePayload)
      .eq("id", input.contactId)

    if (updateError) {
      return {
        success: false,
        error: `Failed to update contact: ${updateError.message}`,
      }
    }

    // ─── RECORD SUPPRESSION EVENT ──────────────────────────────────────────
    await recordSuppressionEvent(
      input.contactId,
      input.suppressionType,
      input.reason,
      "admin"
    )

    return { success: true }
  } catch (error) {
    console.error("[Dispatch] Error in applySuppression:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
