/**
 * Email channel adapter.
 * Tries agent's personal OAuth (Gmail/Outlook) first, falls back to SendGrid.
 * Runs render-step pipeline (token interpolation + brand voice + signature).
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"
import { dispatchEmail } from "@/lib/providers/dispatch"

export const emailAdapter: ChannelAdapter = {
  channel: "email",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { contact, step, brokerageId, agentUserId } = ctx

    if (!contact?.email) {
      return { status: "error", providerKey: "email", error: "No email on contact" }
    }

    const { renderSequenceStep } = await import("@/lib/campaign-sequences/render-step")
    const rendered = await renderSequenceStep({
      brokerageId,
      contactId: contact.id,
      agentUserId,
      step: { channel: "email", subject: step.subject, body: step.body },
      channelPurpose: "campaign",
    })

    if (rendered.brandVoiceViolations.length > 0) {
      return {
        status: "error",
        providerKey: "email",
        error: `Brand voice violation: ${rendered.brandVoiceViolations.join("; ")}`,
      }
    }

    // Try personal OAuth first
    if (agentUserId) {
      try {
        const { sendPersonalEmail } = await import("@/lib/providers/email/personal-email-adapter")
        const personal = await sendPersonalEmail({
          agentUserId,
          to: contact.email,
          subject: rendered.subject ?? "(No Subject)",
          htmlBody: rendered.htmlBody,
          textBody: rendered.textBody,
        })
        if (personal.success) {
          return {
            status: "sent",
            providerKey: personal.provider ?? "personal",
            messageId: personal.messageId,
          }
        }
      } catch { /* fall through */ }
    }

    const result = await dispatchEmail({
      brokerageId,
      systemSource: "sequence",
      contactId: contact.id,
      from: "noreply@platform.com",
      to: contact.email,
      subject: rendered.subject ?? "(No Subject)",
      html: rendered.htmlBody,
    })

    return {
      status: result.success ? "sent" : "error",
      providerKey: result.providerKey,
      messageId: result.messageId,
      error: result.error,
    }
  },
}
