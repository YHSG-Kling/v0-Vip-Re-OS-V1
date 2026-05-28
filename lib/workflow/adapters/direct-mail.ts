/**
 * Direct mail adapter — Lob fulfillment.
 * Supports piece types: postcard (4x6, 6x9), letter, handwritten_letter, thank_you_note.
 * QR code is attached when step.qr_attached = true (universal QR modifier).
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"
import { dispatchDirectMail } from "@/lib/providers/dispatch"

export const directMailAdapter: ChannelAdapter = {
  channel: "direct_mail",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { contact, step, brokerageId, agentId } = ctx

    if (!contact?.mailing_address) {
      return { status: "error", providerKey: "lob", error: "No mailing address on contact" }
    }

    // Generate QR code if the modifier is enabled
    let qrInfo: { id: string; slug: string; scanUrl: string } | undefined
    if (step.qr_attached && step.qr_target_url_pattern) {
      try {
        const { createQrCodeAction } = await import("@/app/actions/ai-direct-mail")
          .then(() => ({ createQrCodeAction: null as any })) // fallback if not exported
          .catch(() => ({ createQrCodeAction: null }))

        // createQrCodeAction is in marketing-studio, not ai-direct-mail
        const { createQrCodeAction: createQr } = await import("@/app/actions/marketing-studio")
          .then(m => ({ createQrCodeAction: (m as any).createQrCodeAction as Function | undefined }))
          .catch(() => ({ createQrCodeAction: undefined }))

        if (createQr && agentId) {
          const origin = process.env.NEXT_PUBLIC_APP_URL ?? ""
          const qrResult = await createQr({
            brokerageId,
            agentId,
            label: step.qr_label ?? step.step_name ?? "Campaign QR",
            targetUrl: `${origin}/api/qr/scan?slug=__placeholder__`,
            purpose: "campaign",
          })
          if (qrResult?.success && qrResult?.qrCode) {
            qrInfo = {
              id: qrResult.qrCode.id,
              slug: qrResult.qrCode.slug,
              scanUrl: `${origin}/api/qr/scan?slug=${qrResult.qrCode.slug}`,
            }
          }
        }
      } catch { /* QR generation failure should not block mail */ }
    }

    const result = await dispatchDirectMail({
      brokerageId,
      systemSource: "sequence",
      contactId: contact.id,
      recipientName: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Resident",
      mailingAddress: contact.mailing_address,
      city: contact.city ?? "",
      state: contact.state ?? "",
      zip: contact.zip ?? "",
      templateId: step.direct_mail_template_id ?? "",
      mergeVars: {
        piece_type: step.direct_mail_piece_type ?? "postcard",
        ...(qrInfo ? { qr_url: qrInfo.scanUrl, qr_slug: qrInfo.slug } : {}),
      },
    })

    return {
      status: result.success ? "sent" : "error",
      providerKey: result.providerKey,
      messageId: result.messageId,
      error: result.error,
      output: qrInfo ? { qr_code_id: qrInfo.id, qr_slug: qrInfo.slug } : undefined,
    }
  },
}
