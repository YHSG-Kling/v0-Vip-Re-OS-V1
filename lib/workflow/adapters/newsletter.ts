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

    // Fallback: dispatch as email — append a QR if step.qr_attached
    const { resolveQrCode } = await import("@/lib/workflow/qr-modifier")
    const qr = await resolveQrCode(step, ctx, {
      defaultLabel: "Newsletter QR",
      defaultPurpose: "newsletter",
    })

    const baseHtml = step.body ?? ""
    const html = qr
      ? `${baseHtml}<hr style="margin-top:32px;border:none;border-top:1px solid #e5e7eb"/>
         <p style="text-align:center;font-size:12px;color:#6b7280">${qr.label}</p>
         <p style="text-align:center"><a href="${qr.scanUrl}">${qr.imageUrl
           ? `<img src="${qr.imageUrl}" alt="QR" style="width:128px;height:128px"/>`
           : qr.scanUrl}</a></p>`
      : baseHtml

    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const result = await dispatchEmail({
      brokerageId,
      systemSource: "sequence",
      contactId: contact.id,
      from: "newsletter@platform.com",
      to: contact.email,
      subject: step.subject ?? "Your Newsletter",
      html,
    })

    return {
      status: result.success ? "sent" : "error",
      providerKey: "newsletter-email",
      messageId: result.messageId,
      error: result.error,
    }
  },
}
