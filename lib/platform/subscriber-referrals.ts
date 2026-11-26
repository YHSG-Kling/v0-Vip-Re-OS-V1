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
// The fee TERMS' one home (§6) is platform_settings.referral_fee_percent
// (migration m573 — written, applied by the integrator); the constant below is
// the DEFAULT the resolver falls back to until the column exists. Read the
// live terms through lib/platform/referral-payouts.ts::getReferralFeeTerms —
// never this constant directly on a money surface.
//
// PAID is TWO facts since 2026-08-27 (owner ruling "make sure referral payouts
// are posted and received by the recipient"):
//   POSTED   — a referral_payouts ledger row (m573; UNIQUE(prospect_id,period)
//             = idempotent), written by markReferralFeePaidAction through
//             lib/platform/referral-payouts.ts. The superadmin_audit_log entry
//             is the audit TRAIL beside it, no longer the ledger.
//   RECEIVED — the recipient's own surface: a tenant-referrer's billing page
//             (app/dashboard/admin/billing) lists their earnings and lets them
//             acknowledge receipt (status posted → received). Non-tenant
//             referrers are recorded with recipient_email only — their cash
//             pay-out rail is honestly not built.
// Pure math + parsing only — DB work lives in
// app/actions/superadmin/subscriber-referrals.ts + lib/platform/referral-payouts.ts.

/** Prospect.source scheme marking a subscriber referral. */
export const REFERRAL_SOURCE_PREFIX = "referral:"

/** DEFAULT referral fee, % of the referred tenant's monthly subscription (MRR).
 *  Fallback only — the live terms live on platform_settings.referral_fee_percent
 *  (m573) via getReferralFeeTerms. */
export const REFERRAL_FEE_PERCENT = 10

// ─── FULL TERMS (m576): BASIS + DURATION, no assumption (owner ruling
// 2026-08-27, verbatim: "platform should not make assumption even with
// referrals."). Every default below is a FALLBACK the resolver reports as
// default_constant — never policy on its own.

/** Fee BASIS vocabulary — the repo's rate-type pair (§6), mirroring the m576 CHECK.
 *  'percent' = % of the referred tenant's MRR; 'flat' = flat amount per conversion. */
export const REFERRAL_FEE_BASES = ["percent", "flat"] as const
export type ReferralFeeBasis = (typeof REFERRAL_FEE_BASES)[number]

/** DEFAULT basis: percent-of-MRR — the m573 shape, the only one that existed
 *  before m576 gave basis a home. Fallback only, reported as default_constant. */
export const REFERRAL_FEE_BASIS_DEFAULT: ReferralFeeBasis = "percent"

/** DEFAULT duration in months of MRR, anchored on the first posted period per
 *  prospect. Deliberately BOUNDED (12): indefinite (0) must be an EXPLICIT
 *  platform_settings choice, never a default the code invents. Fallback only,
 *  reported as default_constant. */
export const REFERRAL_FEE_DURATION_MONTHS_DEFAULT = 12

/**
 * PURE: 1-based month index of `period` within a fee run anchored at
 * `anchorPeriod` (both 'YYYY-MM'). anchor === period → 1; the month after → 2.
 * A period BEFORE the anchor yields ≤ 0 — callers anchor on the earlier of the
 * two, so that never escapes.
 */
export function monthIndexForPeriod(anchorPeriod: string, period: string): number {
  const [ay, am] = anchorPeriod.split("-").map(Number)
  const [py, pm] = period.split("-").map(Number)
  if (![ay, am, py, pm].every(Number.isFinite)) return Number.NaN
  return (py - ay) * 12 + (pm - am) + 1
}

// referralFeeCentsUnderTerms (the basis-aware fee math) lives in
// lib/platform/referral-payouts.ts beside the ReferralFeeTerms it computes
// from — this module stays the pure parsing/constants half.

/**
 * PURE: one line describing the configured terms for the surfaces that POST —
 * staff must see what the platform will compute, including where each piece of
 * the terms came from (configured vs the reported code default).
 */
export function describeReferralFeeTerms(terms: {
  basis: ReferralFeeBasis
  percent: number
  flatCents: number | null
  durationMonths: number
  basisSource: string
  durationSource: string
}): string {
  const rate =
    terms.basis === "flat"
      ? `$${((terms.flatCents ?? 0) / 100).toFixed(2)} flat per conversion`
      : `${terms.percent}% of the referred tenant's MRR`
  const run =
    terms.durationMonths === 0
      ? "runs indefinitely"
      : terms.durationMonths === 1
        ? "one-time (1 month)"
        : `runs ${terms.durationMonths} months`
  const src =
    terms.basisSource === "platform_settings" && terms.durationSource === "platform_settings"
      ? "configured terms"
      : "platform default — configure in platform_settings"
  return `${rate} · ${run} (${src})`
}

/** referral_payouts.status vocabulary — mirrors the m573 CHECK (one home, §6). */
export const REFERRAL_PAYOUT_STATUSES = ["posted", "received", "void"] as const
export type ReferralPayoutStatus = (typeof REFERRAL_PAYOUT_STATUSES)[number]

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

/**
 * PURE: the email inside a referrer string, or null. The referrer is free text
 * ("Jane Doe <jane@x.com>", "jane@x.com", or just "Jane Doe" — the growth card
 * says "name or email"). The email is the only key that can resolve WHO gets
 * the payout: a users.email match makes the referrer a TENANT (payout lands on
 * their brokerage's billing surface); no email / no match = non-tenant referrer,
 * recorded on the ledger by address alone.
 */
export function parseReferrerEmail(referrer: string | null | undefined): string | null {
  if (!referrer) return null
  // Angle-bracket form first ("Name <email>"), then a bare email token.
  const angled = referrer.match(/<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>/)
  const bare = angled?.[1] ?? referrer.match(/(?:^|\s)([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)(?:$|\s)/)?.[1] ?? null
  if (!bare) return null
  const email = bare.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
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
  /** Latest payment fact — a referral_payouts ledger row when the ledger exists,
   *  else the last legacy "referral_fee.paid" audit entry. */
  lastPaidAt: string | null
  lastPaidCents: number | null
  /** Ledger rows + legacy audit lines (disjoint by construction — a ledger post
   *  writes the trail action "referral_payout.posted", never "referral_fee.paid"). */
  totalPaidCents: number
  /** POSTED half (m573 ledger). 0 / null until the ledger exists + has rows. */
  ledgerPostedCents: number
  ledgerReceivedCents: number
  /** Where the latest posting resolved its recipient (tenant-referrer), if anywhere. */
  recipientBrokerageId: string | null
  /** WHOM TO PAY for a non-tenant referrer — the resolved recipient email off
   *  the latest ledger posting (null for tenant referrers, who receive in-app). */
  recipientEmail: string | null
  createdAt: string
}
