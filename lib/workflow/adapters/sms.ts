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

    // Wave 91 (lane 91B) — a LEAD is never texted (owner: "Leads usually are non consenting so no
    // sms or calls allowed only email and direct mail"). On a lead-entity step `contact.id` is a
    // leads.id; it used to be handed to dispatchSms as a contactId. The ONE predicate refuses it.
    const { channelRefusalForRecipient } = await import("@/lib/ai-isa/lead-channel-policy")
    const leadStage = channelRefusalForRecipient(entity === "lead" ? { leadId: (contact?.id as string) ?? "lead" } : { contactId: (contact?.id as string) ?? null }, "sms")
    if (leadStage) {
      return { status: "skipped", providerKey: "sms", error: leadStage }
    }

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

    if (rendered.empty) {
      // Never send blank/hardcoded filler — skip; re-touched next tick.
      return { status: "error", providerKey: "sms", error: "no copy generated — not sending blank/ungenerated sms" }
    }

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
