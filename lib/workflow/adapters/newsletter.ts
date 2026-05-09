/**
 * Newsletter adapter — queues a newsletter send via the newsletter campaign engine.
 *
 * Tries queueNewsletterForContact from ai-newsletter.ts if it exists.
 * Falls back to dispatching email with rendered HTML if not yet exported.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const newsletterAdapter: ChannelAdapter = {
  channel: "newsletter",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, contact } = ctx

    if (!contact?.email) {
      return { status: "error", providerKey: "newsletter", error: "No email on contact" }
    }

    try {
      const m = await import("@/app/actions/ai-newsletter")
      const queueFn = (m as any).queueNewsletterForContact

      if (typeof queueFn === "function") {
        const result = await queueFn({
          brokerageId,
          contactId: contact.id,
          templateId: step.newsletter_template_id ?? undefined,
          sectionIds: step.newsletter_section_ids ?? undefined,
          subject: step.subject ?? undefined,
          customBody: step.body ?? undefined,
        })
        return {
          status: result?.success ? "sent" : "error",
          providerKey: "newsletter",
          messageId: result?.newsletterId,
          error: result?.error,
          output: { newsletter_id: result?.newsletterId },
        }
      }
    } catch { /* action not yet exported — fall through */ }

    // Fallback: dispatch as email
    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const result = await dispatchEmail({
      brokerageId,
      systemSource: "sequence",
      contactId: contact.id,
      from: "newsletter@platform.com",
      to: contact.email,
      subject: step.subject ?? "Your Newsletter",
      html: step.body ?? "",
    })

    return {
      status: result.success ? "sent" : "error",
      providerKey: "newsletter-email",
      messageId: result.messageId,
      error: result.error,
    }
  },
}
