// ─── CDA-DELIVERY POLICY (Deal Coordinator reaper) ──────────────────────────
// Pure, import-free policy for the "CDA approved but never delivered to title"
// failure. The CDA (Commission Disbursement Authorization) tells title/escrow how
// to split funds at closing. cda-workflow delivers it best-effort on approval — if
// that send fails (title email bounces, recipient missing), the CDA sits 'approved'
// with sent_to_title_at NULL and nobody is told, so funds can't disburse at closing.
//
// Only the CDA-to-title model needs delivery: when uses_cda === false the brokerage
// pays out directly, so there's nothing to send. Pure → unit-testable.

// How long an approved-but-unsent CDA may sit before we escalate (delivery is
// supposed to happen synchronously on approval, so a few hours is generous).
export const CDA_DELIVERY_GRACE_HOURS = 12

export type CdaDeliveryAction = "keep" | "escalate"

export interface CdaDeliveryInput {
  status: string | null | undefined
  /** Timestamp the CDA was delivered to title; null = never sent. */
  sentToTitleAt: string | null | undefined
  /** false = brokerage payout model (no title delivery needed); true/null = CDA-to-title. */
  usesCda: boolean | null | undefined
  /** updated_at — proxy for when the CDA was approved (no approved_at column). */
  updatedAt: string | null | undefined
  /** Caller passes "now" so the policy stays deterministic/testable. */
  now: Date
}

export function classifyUndeliveredCda(input: CdaDeliveryInput): CdaDeliveryAction {
  const status = (input.status ?? "").toLowerCase().trim()
  if (status !== "approved") return "keep" // only an approved CDA owes a delivery
  if (input.sentToTitleAt) return "keep" // already delivered to title
  if (input.usesCda === false) return "keep" // brokerage payout model — no title delivery
  if (!input.updatedAt) return "keep"

  const approved = Date.parse(input.updatedAt)
  if (Number.isNaN(approved)) return "keep"

  const graceMs = CDA_DELIVERY_GRACE_HOURS * 60 * 60 * 1000
  return input.now.getTime() - approved > graceMs ? "escalate" : "keep"
}
