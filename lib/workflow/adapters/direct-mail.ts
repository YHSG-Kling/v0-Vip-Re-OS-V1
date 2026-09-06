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
    // agentId is no longer destructured here: the QR modifier reads it off ctx itself.
    const { contact, step, brokerageId } = ctx

    if (!contact?.mailing_address) {
      return { status: "error", providerKey: "lob", error: "No mailing address on contact" }
    }

    // THE UNIVERSAL QR MODIFIER — one implementation, called here.
    //
    // This adapter carried its own inline copy of the modifier, and every part
    // of it was broken: it imported `createQrCodeAction` from a module that does
    // not export it and discarded the result, then imported the real one and
    // called it from CRON — where there is no session, so now that the action is
    // the session gate it is refused outright. It also minted against a
    // `__placeholder__` target and read `qrResult.qrCode` fields the action never
    // returned. All of it sat inside a silent `catch {}`, so the postcard shipped
    // with no QR and nothing said so.
    //
    // lib/workflow/qr-modifier.ts:resolveQrCode is the survivor: it mints through
    // the one minter with the step's own tenant and a per-(enrollment, step)
    // idempotency key, so a retried step re-uses its code instead of printing a
    // second one.
    const { resolveQrCode } = await import("../qr-modifier")
    const resolvedQr = await resolveQrCode(step, ctx, {
      defaultLabel:   step.qr_label ?? step.step_name ?? "Campaign QR",
      defaultPurpose: "campaign",
    })
    const qrInfo = resolvedQr
      ? { id: resolvedQr.qrCodeId, slug: resolvedQr.slug, scanUrl: resolvedQr.scanUrl }
      : undefined

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
