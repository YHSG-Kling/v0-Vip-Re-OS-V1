/**
 * lib/workflow/qr-modifier.ts
 *
 * Universal QR-attachment modifier for workflow channel adapters.
 *
 * Any adapter can call resolveQrCode(step, ctx) to materialize a QR code
 * when step.qr_attached === true. The QR row is recorded in qr_codes and
 * the public scan URL + image URL are returned so the adapter can embed
 * them in the outgoing artifact (postcard back, newsletter footer, social
 * caption, email signature, etc.).
 *
 * The qr_target_url_pattern can include {{variables}} that will already
 * have been resolved at the executor's variable-graph layer before this
 * function sees them.
 */

import type { StepContext } from "./channel-registry"
import type { StepRow } from "./channel-registry"

export interface ResolvedQr {
  qrCodeId: string
  scanUrl:  string         // public URL the QR encodes (/api/qr/scan?slug=...)
  imageUrl: string | null  // PNG of the rendered code (if generator returned one)
  label:    string
}

/**
 * Resolve a QR code for a workflow step. Returns null when the step does
 * not have qr_attached or when the QR generator is unavailable.
 *
 * The adapter is responsible for embedding the returned URL/image into
 * its outgoing artifact (e.g. direct mail postcard back, social caption,
 * email footer, newsletter footer).
 */
export async function resolveQrCode(
  step:    StepRow,
  ctx:     StepContext,
  options: { defaultLabel: string; defaultPurpose: string }
): Promise<ResolvedQr | null> {
  if (!step.qr_attached) return null

  const targetUrl = step.qr_target_url_pattern ?? ""
  if (!targetUrl) return null

  try {
    const m = await import("@/app/actions/marketing-studio")
    const fn = (m as any).createQrCodeAction
    if (typeof fn !== "function") return null

    const result = await fn({
      brokerageId: ctx.brokerageId,
      agentId:     ctx.agentId,
      label:       step.qr_label ?? step.step_name ?? options.defaultLabel,
      targetUrl,
      purpose:     options.defaultPurpose,
    })

    if (!result?.success) return null

    return {
      qrCodeId: result.qrCode?.id ?? result.id ?? "",
      scanUrl:  result.qrCode?.scan_url ?? result.scanUrl ?? targetUrl,
      imageUrl: result.qrCode?.image_url ?? result.imageUrl ?? null,
      label:    step.qr_label ?? options.defaultLabel,
    }
  } catch {
    return null
  }
}
