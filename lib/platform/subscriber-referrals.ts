// lib/platform/subscriber-referrals.ts
// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIBER REFERRAL FEES — who referred a paying brokerage, and what the
// platform owes them. KEEP-ONE verdict: `brokerages` has NO referrer column
// (only signup_source), so the honest lane is the EXISTING growth-funnel rail:
//   • platform_prospects.source carries the referrer under the "referral:" scheme
//     ("referral:Jane Doe <jane@x.com>") — parsed here, never a new column;
//   • platform_prospects.converted_brokerage_id (already in the schema, dormant
//     until now) links the referral to the tenant it became;
//   • superadmin_audit_log (action "referral_fee.paid") is the append-only
//     PAYMENT ledger — paid history is read back from it, no new table.
// The fee rate is a named constant here: platform_settings (the singleton rail
// in lib/platform/platform-controls.ts) has no referral_fee_percent column and
// adding one is a migration this lane does not apply; when that column lands,
// swap the constant for a read. Pure math + parsing only — DB work lives in
// app/actions/superadmin/subscriber-referrals.ts.

/** Prospect.source scheme marking a subscriber referral. */
export const REFERRAL_SOURCE_PREFIX = "referral:"

/** Referral fee, % of the referred tenant's monthly subscription (MRR). */
export const REFERRAL_FEE_PERCENT = 10

/** PURE: build the platform_prospects.source value for a referral. */
export function makeReferralSource(referrer: string): string {
  return `${REFERRAL_SOURCE_PREFIX}${referrer.trim()}`
}

/** PURE: extract the referrer from a prospect source; null when not a referral. */
export function parseReferrer(source: string | null | undefined): string | null {
  if (!source || !source.startsWith(REFERRAL_SOURCE_PREFIX)) return null
  const who = source.slice(REFERRAL_SOURCE_PREFIX.length).trim()
  return who || null
}

/** PURE: monthly referral fee in cents — floor, never negative. */
export function computeReferralFeeCents(mrrCents: number, percent: number = REFERRAL_FEE_PERCENT): number {
  if (!Number.isFinite(mrrCents) || mrrCents <= 0) return 0
  if (!Number.isFinite(percent) || percent <= 0) return 0
  return Math.floor((mrrCents * percent) / 100)
}

export interface SubscriberReferralRow {
  prospectId: string
  referrer: string
  prospectName: string | null
  prospectEmail: string
  prospectCompany: string | null
  status: string
  /** Linked converted tenant (platform_prospects.converted_brokerage_id). */
  brokerageId: string | null
  brokerageName: string | null
  /** Referred tenant's monthly subscription price; 0 when unlinked / unsubscribed. */
  mrrCents: number
  feePercent: number
  feeCents: number
  /** Last "referral_fee.paid" audit entry for this prospect. */
  lastPaidAt: string | null
  lastPaidCents: number | null
  totalPaidCents: number
  createdAt: string
}
