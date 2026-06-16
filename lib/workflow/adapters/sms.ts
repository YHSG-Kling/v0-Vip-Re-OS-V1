/**
 * SMS channel adapter.
 * TCPA consent must already be verified by the step-executor compliance gate
 * before this adapter is called.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"
import { dispatchSms } from "@/lib/providers/dispatch"

export const smsAdapter: ChannelAdapter = {
  channel: "sms",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { contact, step, brokerageId, agentUserId, entity } = ctx

    if (!contact?.phone) {
      return { status: "error", providerKey: "sms", error: "No phone on contact" }
    }

    const { renderSequenceStep } = await import("@/lib/campaign-sequences/render-step")
    const rendered = await renderSequenceStep({
      brokerageId,
      contactId: contact.id,
      agentUserId,
      entity: entity ?? "contact",
      step: { channel: "sms", subject: null, body: step.body },
      personaIntent: (step as any).ai_intent ?? null,
    })

    if (rendered.brandVoiceViolations.length > 0) {
      return {
        status: "error",
        providerKey: "sms",
        error: `Brand voice violation: ${rendered.brandVoiceViolations.join("; ")}`,
      }
    }

    const result = await dispatchSms({
      brokerageId,
      systemSource: "sequence",
      contactId: contact.id,
      to: contact.phone,
      message: rendered.textBody,
    })

    return {
      status: result.success ? "sent" : "error",
      providerKey: result.providerKey,
      messageId: result.messageId,
      error: result.error,
    }
  },
}
