"use server"

/**
 * Superadmin affiliate actions — the EXTERNAL MRR-commission rail
 * (NOT the rev-share tree; see lib/platform/affiliates.ts).
 *
 * Gate: platform 'billing' capability (write for every mutation).
 * Audit: every mutation → superadmin_audit_log (non-fatal on failure) —
 * same conventions as the coupon actions.
 */

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  PERIOD_RE,
  referralActive,
  referralWindowEnd,
  validateAffiliateInput,
} from "@/lib/platform/affiliates"

const AFFILIATES_PATH = "/dashboard/superadmin/affiliates"

// ── Gate + audit ─────────────────────────────────────────────────────────────

async function audit(actorUserId: string, action: string, targetId: string | null, details: Record<string, unknown>): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { data: actor } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId,
      actor_email: (actor as any)?.email ?? null,
      action,
      target_type: "platform_affiliate",
      target_id: targetId,
      details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[affiliate-audit] write failed:", err) // non-fatal — audit never blocks the action
  }
}

// ── LIST ─────────────────────────────────────────────────────────────────────

export interface AffiliateReferralRow {
  id: string
  brokerage_id: string
  brokerage_name: string
  attributed_at: string
  first_payment_at: string | null
  window_end: string
  active: boolean
  subscription_status: string | null
  /** Current MRR from v_platform_margin — the margin-board source. */
  mrr_cents: number
}

export interface AffiliatePeriodRow {
  period: string
  accrued_cents: number
  paid_cents: number
  void_cents: number
  events: number
}

export interface AffiliateRow {
  id: string
  name: string
  email: string
  code: string
  commission_percent: number
  duration_months: number
  status: "active" | "paused" | "ended"
  payout_details: Record<string, unknown> | null
  notes: string | null
  created_at: string
  referrals: AffiliateReferralRow[]
  periods: AffiliatePeriodRow[]
  total_accrued_cents: number
  total_paid_cents: number
}

export async function listAffiliatesAction(): Promise<
  | { ok: true; affiliates: AffiliateRow[] }
  | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("billing")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()

  const [affR, refR, evtR, marginR, subsR, brokR] = await Promise.all([
    svc.from("platform_affiliates")
      .select("id, name, email, code, commission_percent, duration_months, status, payout_details, notes, created_at")
      .order("created_at", { ascending: false }).limit(1000),
    svc.from("affiliate_referrals")
      .select("id, affiliate_id, brokerage_id, attributed_at, first_payment_at, expires_at")
      .order("attributed_at", { ascending: false }).limit(5000),
    svc.from("affiliate_commission_events")
      .select("affiliate_id, referral_id, period, mrr_cents, commission_cents, status")
      .order("period", { ascending: false }).limit(10000),
    svc.from("v_platform_margin").select("brokerage_id, brokerage_name, mrr_cents").limit(5000),
    svc.from("subscriptions").select("brokerage_id, status").limit(5000),
    svc.from("brokerages").select("id, name").limit(5000),
  ])
  const firstErr = [affR, refR, evtR].find((r) => r.error)?.error
  if (firstErr) return { ok: false, error: firstErr.message }

  const marginByBrokerage = new Map<string, { name: string | null; mrrCents: number }>()
  for (const m of (marginR.data ?? []) as any[]) {
    marginByBrokerage.set(m.brokerage_id, { name: m.brokerage_name ?? null, mrrCents: Number(m.mrr_cents) || 0 })
  }
  const nameByBrokerage = new Map<string, string>()
  for (const b of (brokR.data ?? []) as any[]) nameByBrokerage.set(b.id, b.name ?? "")
  const subByBrokerage = new Map<string, string>()
  for (const s of (subsR.data ?? []) as any[]) if (!subByBrokerage.has(s.brokerage_id)) subByBrokerage.set(s.brokerage_id, s.status)

  const now = new Date()
  const affiliates: AffiliateRow[] = ((affR.data ?? []) as any[]).map((a) => {
    const referrals: AffiliateReferralRow[] = ((refR.data ?? []) as any[])
      .filter((r) => r.affiliate_id === a.id)
      .map((r) => {
        const win = {
          attributed_at: r.attributed_at,
          first_payment_at: r.first_payment_at,
          duration_months: Number(a.duration_months) || 18,
        }
        const margin = marginByBrokerage.get(r.brokerage_id)
        return {
          id: r.id,
          brokerage_id: r.brokerage_id,
          brokerage_name: (margin?.name ?? nameByBrokerage.get(r.brokerage_id) ?? "").trim()
            || `Brokerage ${String(r.brokerage_id).slice(0, 8)}`,
          attributed_at: r.attributed_at,
          first_payment_at: r.first_payment_at,
          window_end: referralWindowEnd(win),
          active: referralActive(win, now),
          subscription_status: subByBrokerage.get(r.brokerage_id) ?? null,
          mrr_cents: margin?.mrrCents ?? 0,
        }
      })

    const byPeriod = new Map<string, AffiliatePeriodRow>()
    let totalAccrued = 0
    let totalPaid = 0
    for (const e of ((evtR.data ?? []) as any[]).filter((e) => e.affiliate_id === a.id)) {
      const row = byPeriod.get(e.period) ?? { period: e.period, accrued_cents: 0, paid_cents: 0, void_cents: 0, events: 0 }
      const cents = Number(e.commission_cents) || 0
      if (e.status === "paid") { row.paid_cents += cents; totalPaid += cents }
      else if (e.status === "void") { row.void_cents += cents }
      else { row.accrued_cents += cents; totalAccrued += cents }
      row.events += 1
      byPeriod.set(e.period, row)
    }

    return {
      id: a.id, name: a.name, email: a.email, code: a.code,
      commission_percent: Number(a.commission_percent), duration_months: Number(a.duration_months),
      status: a.status, payout_details: a.payout_details ?? null, notes: a.notes ?? null,
      created_at: a.created_at,
      referrals,
      periods: [...byPeriod.values()].sort((x, y) => y.period.localeCompare(x.period)),
      total_accrued_cents: totalAccrued,
      total_paid_cents: totalPaid,
    }
  })

  return { ok: true, affiliates }
}

// ── CREATE ───────────────────────────────────────────────────────────────────

export async function createAffiliateAction(input: {
  name: string
  email: string
  code: string
  commissionPercent: number
  durationMonths: number
  payoutNotes?: string
  notes?: string
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("billing", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }

  const check = validateAffiliateInput(input)
  if (!check.ok) return check
  const v = check.value

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("platform_affiliates")
    .insert({
      name: v.name,
      email: v.email,
      code: v.code,
      commission_percent: v.commissionPercent,
      duration_months: v.durationMonths,
      status: "active",
      payout_details: input.payoutNotes?.trim() ? { notes: input.payoutNotes.trim() } : null,
      notes: input.notes?.trim() || null,
      created_by: gate.userId,
    })
    .select("id")
    .single()
  if (error) {
    return {
      ok: false,
      error: (error as any).code === "23505"
        ? "An affiliate with that email or code already exists."
        : error.message,
    }
  }

  await audit(gate.userId, "affiliate.created", (data as any).id, {
    name: v.name, email: v.email, code: v.code,
    commission_percent: v.commissionPercent, duration_months: v.durationMonths,
  })
  revalidatePath(AFFILIATES_PATH)
  return { ok: true, id: (data as any).id }
}

// ── UPDATE ───────────────────────────────────────────────────────────────────

export async function updateAffiliateAction(id: string, patch: {
  name: string
  email: string
  code: string
  commissionPercent: number
  durationMonths: number
  status: "active" | "paused" | "ended"
  payoutNotes?: string
  notes?: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("billing", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!id) return { ok: false, error: "Affiliate id required." }
  if (!["active", "paused", "ended"].includes(patch.status)) return { ok: false, error: "Invalid status." }

  const check = validateAffiliateInput(patch)
  if (!check.ok) return check
  const v = check.value

  const svc = createServiceClient()
  const { error } = await svc
    .from("platform_affiliates")
    .update({
      name: v.name,
      email: v.email,
      code: v.code,
      commission_percent: v.commissionPercent,
      duration_months: v.durationMonths,
      status: patch.status,
      payout_details: patch.payoutNotes?.trim() ? { notes: patch.payoutNotes.trim() } : null,
      notes: patch.notes?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
  if (error) {
    return {
      ok: false,
      error: (error as any).code === "23505"
        ? "An affiliate with that email or code already exists."
        : error.message,
    }
  }

  await audit(gate.userId, "affiliate.updated", id, {
    code: v.code, commission_percent: v.commissionPercent,
    duration_months: v.durationMonths, status: patch.status,
  })
  revalidatePath(AFFILIATES_PATH)
  return { ok: true }
}

// ── MARK PERIOD PAID ─────────────────────────────────────────────────────────

/** Flip every ACCRUED event for (affiliate, period) to PAID. Audited; paid/void
 *  rows are never touched, so the action is idempotent. */
export async function markPeriodPaidAction(
  affiliateId: string,
  period: string,
): Promise<{ ok: true; marked: number; paidCents: number } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("billing", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!affiliateId) return { ok: false, error: "Affiliate id required." }
  if (!PERIOD_RE.test(period ?? "")) return { ok: false, error: "Invalid period — expected YYYY-MM." }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("affiliate_commission_events")
    .update({ status: "paid" })
    .eq("affiliate_id", affiliateId)
    .eq("period", period)
    .eq("status", "accrued")
    .select("id, commission_cents")
  if (error) return { ok: false, error: error.message }

  const rows = (data ?? []) as any[]
  const paidCents = rows.reduce((s, r) => s + (Number(r.commission_cents) || 0), 0)
  await audit(gate.userId, "affiliate.period_paid", affiliateId, {
    period, events_marked: rows.length, paid_cents: paidCents,
  })
  revalidatePath(AFFILIATES_PATH)
  return { ok: true, marked: rows.length, paidCents }
}
