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
  slug:     string
  scanUrl:  string         // public URL the QR encodes (/api/qr/scan?slug=...)
  targetUrl: string        // the SEMANTIC destination the code stands for
  imageUrl: string         // data:image/png;base64,… rendered by the vendored `qrcode` package
  label:    string
}

/**
 * Resolve a QR code for a workflow step. Returns null when the step does
 * not have qr_attached or when the mint is refused.
 *
 * The adapter is responsible for embedding the returned URL/image into
 * its outgoing artifact (e.g. direct mail postcard back, social caption,
 * email footer, newsletter footer).
 *
 * WHY THIS CALLS THE MINTER DIRECTLY, NOT createQrCodeAction:
 * a workflow step executes in CRON context — StepContext carries its own service-role client and
 * there is no session. It used to dynamically import `createQrCodeAction` and duck-type the
 * export, reading `result.qrCode?.scan_url` and `result.imageUrl`, neither of which that action
 * ever returned, so `imageUrl` was ALWAYS null and scanUrl always fell through to the raw target
 * URL — a QR that bypasses /api/qr/scan and records no scan. That action is now the SESSION gate
 * and refuses a caller with no session, so server-side minters go to
 * lib/marketing/tracked-qr.ts:mintTrackedQr directly with their own resolved tenant. This is the
 * pattern for any other cron-lane minter.
 *
 * The mint is IDEMPOTENT per (enrollment, step): a retried step re-uses the same tracked code
 * instead of minting a fresh one on every attempt.
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
    const { mintTrackedQr, isQrPurpose } = await import("@/lib/marketing/tracked-qr")

    // purpose is a CHECK-constrained vocabulary — an out-of-set value is a REFUSED insert, and
    // supabase-js resolves that refusal rather than throwing. Fall back rather than lose the QR.
    const purpose = isQrPurpose(options.defaultPurpose) ? options.defaultPurpose : "campaign"

    const minted = await mintTrackedQr(
      {
        brokerageId: ctx.brokerageId,
        agentId:     ctx.agentId,
        label:       `workflow:${ctx.enrollmentId}:${step.id ?? step.step_name ?? options.defaultLabel}`,
        targetUrl,
        purpose,
      },
      ctx.supabase as any,
    )

    if (!minted) return null

    return {
      qrCodeId:  minted.qrCodeId,
      slug:      minted.slug,
      scanUrl:   minted.scanUrl,
      targetUrl: minted.targetUrl,
      imageUrl:  minted.qrCodeDataUrl,
      label:     step.qr_label ?? options.defaultLabel,
    }
  } catch {
    return null
  }
}
