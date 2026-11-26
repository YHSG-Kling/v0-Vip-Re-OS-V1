// lib/recruiting/benefit-offerings.ts
//
// BROKERAGE BENEFIT OFFERINGS — the ONE reader for what a brokerage has marked
// itself as offering its agents (owner ruling, 2026-08-27: "make sure that the
// brokerages have the ability in settings to mark if they offer residual income
// … also if they offer medical or retirement").
//
// THE THREE MARKS, and where each lives on the `brokerages` row:
//   · residual income  → revenue_share_enabled (m264 — residual income IS
//     agent-to-agent revenue share; there is deliberately NO second column, §6)
//   · medical          → offers_medical_benefits    (m574)
//   · retirement       → offers_retirement_benefits (m574)
//
// WRITER: app/actions/settings/revenue-share-setting.ts — the one brokerage-
// offerings settings home (broker/finance-admin gated, tenant from session).
//
// FAIL-CLOSED. A read that errors, a missing row, or an unset column all
// resolve to NOT OFFERED. "Nobody checked" must never render as "offered" —
// these marks end up in recruit-facing sales documents and on the public
// careers page, where an invented benefit is a misstatement of terms.
//
// COMPLIANCE WORDING (benefit-claim seam with compliance_officer — see
// MANAGER_COLLABORATIONS.benefit_offerings in lib/kernel/manager-registry.ts):
// the labels below state that a benefit is OFFERED, never a promise of
// coverage, amount, or eligibility. Every surface that renders them must keep
// the eligibility qualifier (BENEFITS_ELIGIBILITY_NOTE) beside the claims.

import type { ClientPdfSection } from "@/lib/documents/client-pdf"

export interface BenefitOfferings {
  /** Residual income: agent-to-agent (downline) revenue share — brokerages.revenue_share_enabled. */
  revenueShare: boolean
  /** brokerages.offers_medical_benefits */
  medical: boolean
  /** brokerages.offers_retirement_benefits */
  retirement: boolean
}

export const NO_BENEFITS: BenefitOfferings = { revenueShare: false, medical: false, retirement: false }

/** The non-promissory qualifier every benefit-claim surface renders beside the labels. */
export const BENEFITS_ELIGIBILITY_NOTE =
  "Eligibility, enrollment windows, and plan details are governed by the brokerage's plan documents and independent-contractor agreement."

/** Minimal client shape — lets callers hand any supabase-like client through. */
type SupabaseLike = { from: (table: string) => any }

/**
 * Load a brokerage's benefit offerings. FAIL-CLOSED: any error or missing row →
 * NO_BENEFITS. The error is READ, never discarded (supabase-js resolves
 * refusals), and only an explicit `=== true` marks a benefit offered.
 */
export async function loadBenefitOfferings(svc: SupabaseLike, brokerageId: string): Promise<BenefitOfferings> {
  if (!brokerageId) return NO_BENEFITS
  const { data, error } = await svc
    .from("brokerages")
    .select("revenue_share_enabled, offers_medical_benefits, offers_retirement_benefits")
    .eq("id", brokerageId)
    .maybeSingle()
  if (error || !data) return NO_BENEFITS
  const row = data as {
    revenue_share_enabled?: boolean | null
    offers_medical_benefits?: boolean | null
    offers_retirement_benefits?: boolean | null
  }
  return {
    revenueShare: row.revenue_share_enabled === true,
    medical: row.offers_medical_benefits === true,
    retirement: row.offers_retirement_benefits === true,
  }
}

/**
 * PURE: the offered benefits as recruit-facing labels — ONLY the marks that are
 * true, in a stable order. Empty when nothing is offered (a surface renders
 * nothing, never a hollow "Benefits" heading). Wording states the offering
 * without promising terms — the compliance seam this vocabulary lives on.
 */
export function offeredBenefitLabels(o: BenefitOfferings): string[] {
  const labels: string[] = []
  if (o.revenueShare) labels.push("Revenue share — residual income on the production of agents you help bring aboard")
  if (o.medical) labels.push("Medical benefits offered")
  if (o.retirement) labels.push("Retirement savings offered")
  return labels
}

/**
 * PURE: the recruiting one-pager's benefits section, or NULL when the brokerage
 * offers none (fail-closed: no section is ever rendered from unset marks).
 * Consumed by lib/recruiting/recruiting-pitch-kit.ts.
 */
export function benefitsPitchSection(o: BenefitOfferings): ClientPdfSection | null {
  const bullets = offeredBenefitLabels(o)
  if (bullets.length === 0) return null
  return {
    heading: "Benefits this brokerage offers",
    bullets,
    paragraphs: [BENEFITS_ELIGIBILITY_NOTE],
  }
}
