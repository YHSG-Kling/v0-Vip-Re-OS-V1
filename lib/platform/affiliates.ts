// lib/platform/affiliates.ts
// ─────────────────────────────────────────────────────────────────────────────
// EXTERNAL AFFILIATE RAIL — MRR-COMMISSION BASED.
//
// NOT the rev-share tree — external partners, platform MRR commission only.
// lib/platform/subscriber-referrals.ts is a DIFFERENT rail: brokerages offering
// revenue share to THEIR agents (in-tenant, prospect-source based). This file
// is for EXTERNAL partners (influencers, coaches, vendors) who refer paying
// tenants to the PLATFORM and earn a % of that tenant's MRR for a fixed window
// (default 10% for 18 months — Lofty's public affiliate terms are the
// competitive bar). The two rails never share tables, math, or UI.
//
// Tables (migration l74 — already applied):
//   platform_affiliates          — the partner registry (code, %, duration, status)
//   affiliate_referrals          — affiliate → tenant attribution.
//                                  UNIQUE(brokerage_id) = one affiliate per tenant, FIRST WINS.
//   affiliate_commission_events  — monthly accruals. UNIQUE(referral_id, period) =
//                                  the accrual cron is idempotent by construction.
//
// MRR SOURCE — reuses THE margin-board source: v_platform_margin.mrr_cents
// (scripts/1055-superadmin-platform-margin-view.sql), the same per-brokerage
// number the superadmin platform CFO dashboard shows. No second MRR definition.
// "Live" additionally requires a paying subscription (active/past_due — never
// trialing/cancelled), so trials don't accrue commission.
//
// Pure half: validation + commission math + window logic (unit-testable).
// Server half: attribution insert + monthly accrual (service client).
// ─────────────────────────────────────────────────────────────────────────────

import { createServiceClient } from "@/lib/supabase/service"

// ── Constants ────────────────────────────────────────────────────────────────

/** Cookie set by /api/ref?code=… and read server-side by signupBrokerageAction. */
export const AFFILIATE_REF_COOKIE = "vip_aff_ref"
/** How long a click is attributable (last-click within 90 days). */
export const AFFILIATE_REF_COOKIE_DAYS = 90

/** Mirrors the platform_affiliates.code CHECK constraint. */
export const AFFILIATE_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/
/** Mirrors the affiliate_commission_events.period format ('YYYY-MM'). */
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export type AffiliateStatus = "active" | "paused" | "ended"
export type CommissionStatus = "accrued" | "paid" | "void"

// ── Pure: normalization + validation ─────────────────────────────────────────

/** PURE: canonical form of an affiliate code (trimmed; case preserved — codes
 *  are stored as created, lookups are case-insensitive). */
export function normalizeAffiliateCode(raw: string | null | undefined): string {
  return (raw ?? "").trim()
}

// TOMBSTONE (orphan doctrine §1.3) — this name is no longer exported: AffiliateInput.
// Nothing in the product imported it, and no simulator did either; the
// value is live and unchanged, reached through this module's own exported
// functions, which is where callers already get its effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
interface AffiliateInput {
  name: string
  email: string
  code: string
  commissionPercent: number
  durationMonths: number
}

export type AffiliateValidation =
  | { ok: true; value: AffiliateInput }
  | { ok: false; error: string }

/** PURE: validate a create/edit payload against the table's constraints. */
export function validateAffiliateInput(input: {
  name?: string | null
  email?: string | null
  code?: string | null
  commissionPercent?: number | null
  durationMonths?: number | null
}): AffiliateValidation {
  const name = (input.name ?? "").trim()
  if (name.length < 2) return { ok: false, error: "Affiliate name is required (2+ chars)." }

  const email = (input.email ?? "").trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Valid affiliate email required." }

  const code = normalizeAffiliateCode(input.code)
  if (!AFFILIATE_CODE_RE.test(code)) {
    return { ok: false, error: "Code must be 3–32 chars: letters, digits, dash, underscore." }
  }

  const commissionPercent = Number(input.commissionPercent ?? 10)
  if (!Number.isFinite(commissionPercent) || commissionPercent < 1 || commissionPercent > 50) {
    return { ok: false, error: "Commission percent must be between 1 and 50." }
  }

  const durationMonths = Number(input.durationMonths ?? 18)
  if (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 60) {
    return { ok: false, error: "Duration must be a whole number of months between 1 and 60." }
  }

  return { ok: true, value: { name, email, code, commissionPercent, durationMonths } }
}

// ── Pure: commission math + referral window ──────────────────────────────────

/** PURE: commission in cents on one month of MRR. Rounds to the nearest cent;
 *  garbage in (negative / non-finite) → 0, never NaN into the ledger. */
export function commissionFor(mrrCents: number, percent: number): number {
  if (!Number.isFinite(mrrCents) || mrrCents <= 0) return 0
  if (!Number.isFinite(percent) || percent <= 0) return 0
  return Math.round((mrrCents * Math.min(percent, 100)) / 100)
}

/** PURE: ISO timestamp + N calendar months (UTC; JS end-of-month overflow rules). */
export function addMonthsIso(iso: string, months: number): string {
  const d = new Date(iso)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString()
}

export interface ReferralWindow {
  attributed_at: string
  first_payment_at: string | null
  /** The affiliate's duration_months at accrual time. */
  duration_months: number
}

/** PURE: when the commission window closes — duration_months after the window
 *  anchor (first_payment_at when the tenant has paid, else attributed_at). */
export function referralWindowEnd(r: ReferralWindow): string {
  return addMonthsIso(r.first_payment_at ?? r.attributed_at, r.duration_months)
}

/** PURE: is this referral still inside its commission window at `now`? */
export function referralActive(r: ReferralWindow, now: Date): boolean {
  const anchor = Date.parse(r.first_payment_at ?? r.attributed_at)
  if (Number.isNaN(anchor)) return false
  return now.getTime() < Date.parse(referralWindowEnd(r))
}

/** PURE: 'YYYY-MM' for a Date (UTC). */
export function periodFor(now: Date): string {
  return now.toISOString().slice(0, 7)
}

// ── Server half ──────────────────────────────────────────────────────────────

type Svc = ReturnType<typeof createServiceClient>

/** Escape ilike metacharacters in a (already regex-validated) code. */
function ilikePattern(code: string): string {
  return code.replace(/([%_\\])/g, "\\$1")
}

export type AttributionResult =
  | { ok: true; affiliateId: string; referralId: string; expiresAt: string }
  | { ok: false; reason: "invalid_code" | "unknown_code" | "affiliate_not_active" | "already_attributed" | "error"; detail?: string }

/**
 * Attribute a freshly provisioned tenant to an affiliate by ref code.
 * UNIQUE(brokerage_id) on affiliate_referrals makes this FIRST WINS — a second
 * attribution attempt for the same tenant is a clean no-op (23505 → reported,
 * never thrown). Callers treat the whole thing as best-effort: attribution must
 * never fail a signup.
 */
export async function attributeSignupToAffiliate(
  code: string,
  brokerageId: string,
  client?: Svc,
  now: Date = new Date(),
): Promise<AttributionResult> {
  const normalized = normalizeAffiliateCode(code)
  if (!AFFILIATE_CODE_RE.test(normalized)) return { ok: false, reason: "invalid_code" }

  const svc = client ?? createServiceClient()
  const { data: matches, error: lookupErr } = await svc
    .from("platform_affiliates")
    .select("id, code, status, duration_months")
    .ilike("code", ilikePattern(normalized))
    .limit(2)
  if (lookupErr) return { ok: false, reason: "error", detail: lookupErr.message }
  // Prefer the exact-case row when case-variant codes coexist.
  const affiliate =
    (matches ?? []).find((a: any) => a.code === normalized) ?? (matches ?? [])[0] ?? null
  if (!affiliate) return { ok: false, reason: "unknown_code" }
  if (affiliate.status !== "active") return { ok: false, reason: "affiliate_not_active" }

  const attributedAt = now.toISOString()
  const expiresAt = addMonthsIso(attributedAt, Number(affiliate.duration_months) || 18)
  const { data: inserted, error: insErr } = await svc
    .from("affiliate_referrals")
    .insert({
      affiliate_id: affiliate.id,
      brokerage_id: brokerageId,
      attributed_at: attributedAt,
      first_payment_at: null,
      expires_at: expiresAt,
    })
    .select("id")
    .single()
  if (insErr) {
    if ((insErr as any).code === "23505") return { ok: false, reason: "already_attributed" }
    return { ok: false, reason: "error", detail: insErr.message }
  }
  return { ok: true, affiliateId: affiliate.id, referralId: (inserted as any).id, expiresAt }
}

export interface AccrualSummary {
  period: string
  referralsConsidered: number
  /** New commission events written this run. */
  accrued: number
  /** Already had an event for this period (idempotent re-run). */
  alreadyAccrued: number
  skippedAffiliateInactive: number
  skippedWindowClosed: number
  skippedNoLiveMrr: number
  /** First-ever paying observation — first_payment_at stamped this run. */
  firstPaymentsMarked: number
  commissionCentsAccrued: number
  errors: string[]
}

/**
 * MONTHLY ACCRUAL — one commission event per (referral, period).
 *
 * For every referral whose affiliate is active and whose commission window is
 * open, on a brokerage with LIVE MRR (v_platform_margin.mrr_cents > 0 — the
 * SAME per-brokerage number the platform margin board shows — AND a paying
 * subscription: active/past_due, never trialing/cancelled), upsert an
 * affiliate_commission_events row for `period`. UNIQUE(referral_id, period)
 * + ignoreDuplicates makes re-runs no-ops: an event once written (accrued OR
 * paid) is never overwritten by the cron.
 *
 * Also stamps first_payment_at the first time a referral's tenant is observed
 * paying — which re-anchors the commission window (duration runs from first
 * payment, not from the click) and refreshes the stored expires_at to match.
 */
export async function accrueCommissions(
  period?: string,
  client?: Svc,
  now: Date = new Date(),
): Promise<AccrualSummary> {
  const p = period?.trim() || periodFor(now)
  if (!PERIOD_RE.test(p)) {
    return {
      period: p, referralsConsidered: 0, accrued: 0, alreadyAccrued: 0,
      skippedAffiliateInactive: 0, skippedWindowClosed: 0, skippedNoLiveMrr: 0,
      firstPaymentsMarked: 0, commissionCentsAccrued: 0,
      errors: [`Invalid period '${p}' — expected YYYY-MM.`],
    }
  }

  const svc = client ?? createServiceClient()
  const summary: AccrualSummary = {
    period: p, referralsConsidered: 0, accrued: 0, alreadyAccrued: 0,
    skippedAffiliateInactive: 0, skippedWindowClosed: 0, skippedNoLiveMrr: 0,
    firstPaymentsMarked: 0, commissionCentsAccrued: 0, errors: [],
  }

  const [affiliatesR, referralsR, marginR, subsR] = await Promise.all([
    svc.from("platform_affiliates").select("id, status, commission_percent, duration_months").limit(2000),
    svc.from("affiliate_referrals").select("id, affiliate_id, brokerage_id, attributed_at, first_payment_at, expires_at").limit(5000),
    // THE margin-board MRR source (v_platform_margin, migration 1055) — one row per brokerage.
    svc.from("v_platform_margin").select("brokerage_id, mrr_cents").limit(5000),
    svc.from("subscriptions").select("brokerage_id, status").limit(5000),
  ])
  for (const r of [affiliatesR, referralsR, marginR, subsR]) {
    if (r.error) summary.errors.push(r.error.message)
  }
  if (referralsR.error || marginR.error) return summary

  const affiliateById = new Map<string, any>()
  for (const a of (affiliatesR.data ?? []) as any[]) affiliateById.set(a.id, a)
  const mrrByBrokerage = new Map<string, number>()
  for (const m of (marginR.data ?? []) as any[]) mrrByBrokerage.set(m.brokerage_id, Number(m.mrr_cents) || 0)
  // First subscription row per brokerage — same dedupe idiom as subscription-oversight.
  const subByBrokerage = new Map<string, any>()
  for (const s of (subsR.data ?? []) as any[]) if (!subByBrokerage.has(s.brokerage_id)) subByBrokerage.set(s.brokerage_id, s)

  for (const ref of (referralsR.data ?? []) as any[]) {
    summary.referralsConsidered += 1
    const affiliate = affiliateById.get(ref.affiliate_id)
    if (!affiliate || affiliate.status !== "active") { summary.skippedAffiliateInactive += 1; continue }

    const durationMonths = Number(affiliate.duration_months) || 18
    const subStatus: string | null = subByBrokerage.get(ref.brokerage_id)?.status ?? null
    const paying = subStatus === "active" || subStatus === "past_due"
    const mrrCents = mrrByBrokerage.get(ref.brokerage_id) ?? 0

    // First paying observation → anchor the window at first payment and refresh
    // the stored expires_at (the window runs duration_months from FIRST PAYMENT).
    let firstPaymentAt: string | null = ref.first_payment_at
    if (paying && mrrCents > 0 && !firstPaymentAt) {
      firstPaymentAt = now.toISOString()
      const { error } = await svc
        .from("affiliate_referrals")
        .update({ first_payment_at: firstPaymentAt, expires_at: addMonthsIso(firstPaymentAt, durationMonths) })
        .eq("id", ref.id)
      if (error) summary.errors.push(`first_payment ${ref.id}: ${error.message}`)
      else summary.firstPaymentsMarked += 1
    }

    if (!referralActive({ attributed_at: ref.attributed_at, first_payment_at: firstPaymentAt, duration_months: durationMonths }, now)) {
      summary.skippedWindowClosed += 1
      continue
    }
    if (!paying || mrrCents <= 0) { summary.skippedNoLiveMrr += 1; continue }

    const commissionCents = commissionFor(mrrCents, Number(affiliate.commission_percent) || 0)
    if (commissionCents <= 0) { summary.skippedNoLiveMrr += 1; continue }

    // Idempotency: UNIQUE(referral_id, period) + ignoreDuplicates — a re-run
    // (or a manual + cron overlap) never double-accrues and never touches a
    // row that was already marked paid.
    const { data: written, error: upErr } = await svc
      .from("affiliate_commission_events")
      .upsert({
        affiliate_id: ref.affiliate_id,
        referral_id: ref.id,
        brokerage_id: ref.brokerage_id,
        mrr_cents: mrrCents,
        commission_cents: commissionCents,
        period: p,
        status: "accrued",
      }, { onConflict: "referral_id,period", ignoreDuplicates: true })
      .select("id")
    if (upErr) { summary.errors.push(`accrual ${ref.id}: ${upErr.message}`); continue }
    if ((written ?? []).length > 0) {
      summary.accrued += 1
      summary.commissionCentsAccrued += commissionCents
    } else {
      summary.alreadyAccrued += 1
    }
  }

  return summary
}
