"use server"

// app/actions/superadmin/subscriber-referrals.ts
// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIBER REFERRAL FEES — DB wiring for lib/platform/subscriber-referrals.ts.
// Rides the EXISTING rails: platform_prospects (source = "referral:<who>",
// converted_brokerage_id = the tenant it became) and subscriptions +
// subscription_tiers for MRR.
//
// PAID is a LEDGER since 2026-08-27 (owner ruling "make sure referral payouts
// are posted and received by the recipient"): markReferralFeePaidAction POSTS
// a referral_payouts row (m573 — idempotent per prospect+period, recipient
// resolved from the referrer email; lib/platform/referral-payouts.ts) and the
// recipient tenant's billing surface renders + acknowledges it (RECEIVED).
// superadmin_audit_log is the audit TRAIL beside the ledger — a ledger post
// writes trail action "referral_payout.posted"; the OLD action
// "referral_fee.paid" remains readable legacy history AND the degraded write
// path while m573 is unapplied (the two are disjoint, so totals never double
// count). Fee terms come from getReferralFeeTerms (platform_settings, m573;
// code default until applied — the source is reported, never guessed).
// Money surface ⇒ gated on the "billing" capability (superadmin + platform admin).

import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import {
  parseReferrer, makeReferralSource,
  REFERRAL_SOURCE_PREFIX, type SubscriberReferralRow,
} from "@/lib/platform/subscriber-referrals"
import {
  getReferralFeeTerms, postReferralPayout, summarizeLedgerByProspect,
  referralFeeCentsUnderTerms, type ReferralFeeTerms,
} from "@/lib/platform/referral-payouts"

/** Legacy audit-line payment record — pre-m573 history + the degraded write path. */
const PAID_ACTION = "referral_fee.paid"
/** Audit TRAIL for a ledger posting (never summed — the ledger row is the money). */
const POSTED_TRAIL_ACTION = "referral_payout.posted"

async function requireBilling(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("billing")
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  const svc = createServiceClient()
  const { data } = await svc.from("users").select("email").eq("id", gate.userId).maybeSingle()
  return { ok: true, userId: gate.userId, email: (data as any)?.email ?? "" }
}

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "platform_prospect", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[subscriber-referrals audit] failed:", err) }
}

export async function listSubscriberReferralsAction(): Promise<
  | {
      ok: true
      rows: SubscriberReferralRow[]
      feePercent: number
      /** The FULL configured terms (m576: basis + duration beside the m573 rate),
       *  each field naming its source — the posting surface shows staff exactly
       *  what the platform will compute, configured or reported default. */
      terms: ReferralFeeTerms
      brokerageOptions: Array<{ id: string; name: string }>
    }
  | { ok: false; error: string }
> {
  const auth = await requireBilling()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const terms = await getReferralFeeTerms(svc)

  const { data: prospects, error } = await svc
    .from("platform_prospects")
    .select("id, name, email, company, status, source, converted_brokerage_id, created_at")
    .like("source", `${REFERRAL_SOURCE_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) return { ok: false, error: error.message }

  const rows0 = (prospects ?? []) as any[]
  const prospectIds = rows0.map((p) => p.id)
  const brokerageIds = Array.from(new Set(rows0.map((p) => p.converted_brokerage_id).filter(Boolean))) as string[]

  // Referred tenants' names + current subscription price (latest non-cancelled sub → tier price).
  const nameById = new Map<string, string>()
  const mrrById = new Map<string, number>()
  if (brokerageIds.length > 0) {
    const [{ data: brks, error: brkErr }, { data: subs, error: subErr }, { data: tiers, error: tierErr }] = await Promise.all([
      svc.from("brokerages").select("id, name").in("id", brokerageIds),
      svc.from("subscriptions").select("brokerage_id, tier_id, status, created_at").in("brokerage_id", brokerageIds).order("created_at", { ascending: false }),
      svc.from("subscription_tiers").select("id, monthly_price_cents").limit(200),
    ])
    if (brkErr) return { ok: false, error: brkErr.message }
    if (subErr) return { ok: false, error: subErr.message }
    if (tierErr) return { ok: false, error: tierErr.message }
    for (const b of (brks ?? []) as any[]) nameById.set(b.id, b.name ?? "—")
    const priceByTier = new Map<string, number>()
    for (const t of (tiers ?? []) as any[]) priceByTier.set(t.id, Number(t.monthly_price_cents) || 0)
    for (const s of (subs ?? []) as any[]) {
      if (mrrById.has(s.brokerage_id)) continue // ordered desc — first row is the latest
      mrrById.set(s.brokerage_id, s.status === "cancelled" ? 0 : (priceByTier.get(s.tier_id) ?? 0))
    }
  }

  // Payment history — the referral_payouts LEDGER (posted/received) plus the
  // LEGACY audit-line records ("referral_fee.paid": pre-ledger payments, and
  // the degraded write path while m573 is unapplied). The two are DISJOINT by
  // construction — a ledger post writes the trail action
  // "referral_payout.posted", never "referral_fee.paid" — so summing both is
  // the total without double counting.
  const lastPaidAt = new Map<string, string>()
  const lastPaidCents = new Map<string, number>()
  const totalPaidCents = new Map<string, number>()
  const ledgerSummary = await summarizeLedgerByProspect(prospectIds, svc)
  if (ledgerSummary.error) return { ok: false, error: ledgerSummary.error }
  for (const [pid, s] of ledgerSummary.byProspect) {
    totalPaidCents.set(pid, s.postedCents)
    if (s.lastPostedAt) { lastPaidAt.set(pid, s.lastPostedAt); lastPaidCents.set(pid, s.lastPostedCents ?? 0) }
  }
  if (prospectIds.length > 0) {
    const { data: legacy, error: legacyErr } = await svc
      .from("superadmin_audit_log")
      .select("target_id, created_at, details")
      .eq("action", PAID_ACTION)
      .eq("target_type", "platform_prospect")
      .in("target_id", prospectIds)
      .order("created_at", { ascending: false })
      .limit(1000)
    if (legacyErr) return { ok: false, error: legacyErr.message }
    for (const e of (legacy ?? []) as any[]) {
      const cents = Number(e.details?.amount_cents) || 0
      totalPaidCents.set(e.target_id, (totalPaidCents.get(e.target_id) ?? 0) + cents)
      // The ledger's latest posting wins over an older legacy line; a NEWER
      // legacy line (written while the ledger was unavailable) wins on recency.
      const cur = lastPaidAt.get(e.target_id)
      if (!cur || Date.parse(e.created_at) > Date.parse(cur)) {
        lastPaidAt.set(e.target_id, e.created_at); lastPaidCents.set(e.target_id, cents)
      }
    }
  }

  // Link targets for un-linked referrals (active tenants only — the picker stays small).
  const { data: options, error: optErr } = await svc
    .from("brokerages").select("id, name").eq("status", "active").order("name", { ascending: true }).limit(500)
  if (optErr) return { ok: false, error: optErr.message }

  const rows: SubscriberReferralRow[] = rows0.map((p) => {
    const mrrCents = p.converted_brokerage_id ? (mrrById.get(p.converted_brokerage_id) ?? 0) : 0
    const ledger = ledgerSummary.byProspect.get(p.id)
    return {
      prospectId: p.id,
      referrer: parseReferrer(p.source) ?? "—",
      prospectName: p.name, prospectEmail: p.email, prospectCompany: p.company,
      status: p.status ?? "new",
      brokerageId: p.converted_brokerage_id ?? null,
      brokerageName: p.converted_brokerage_id ? (nameById.get(p.converted_brokerage_id) ?? null) : null,
      // The fee the CONFIGURED terms compute — basis-aware (m576): percent-of-MRR
      // (computeReferralFeeCents(mrrCents, terms.percent) under the hood) or a
      // flat amount per conversion, never an assumed shape.
      mrrCents, feePercent: terms.percent,
      feeCents: referralFeeCentsUnderTerms(terms, mrrCents, !!p.converted_brokerage_id),
      lastPaidAt: lastPaidAt.get(p.id) ?? null,
      lastPaidCents: lastPaidCents.get(p.id) ?? null,
      totalPaidCents: totalPaidCents.get(p.id) ?? 0,
      ledgerPostedCents: ledger?.postedCents ?? 0,
      ledgerReceivedCents: ledger?.receivedCents ?? 0,
      recipientBrokerageId: ledger?.recipientBrokerageId ?? null,
      recipientEmail: ledger?.recipientEmail ?? null,
      createdAt: p.created_at,
    }
  })
  return { ok: true, rows, feePercent: terms.percent, terms, brokerageOptions: ((options ?? []) as any[]).map((b) => ({ id: b.id, name: b.name ?? "—" })) }
}

/** Record a subscriber referral — a prospect whose source names the referrer. Idempotent by email. */
export async function recordSubscriberReferralAction(input: {
  referrer: string; email: string; name?: string; company?: string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireBilling()
  if (!auth.ok) return auth
  const referrer = (input.referrer ?? "").trim()
  const email = (input.email ?? "").trim().toLowerCase()
  if (!referrer) return { ok: false, error: "Referrer is required" }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "A valid prospect email is required" }
  const svc = createServiceClient()
  const { data, error } = await svc.from("platform_prospects").upsert({
    email, name: (input.name ?? "").trim() || null, company: (input.company ?? "").trim() || null,
    source: makeReferralSource(referrer), updated_at: new Date().toISOString(),
  }, { onConflict: "email" }).select("id").single()
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "subscriber_referral.recorded", (data as any).id, { referrer, email })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}

/** Link a referral to the tenant it became (sets the dormant converted_brokerage_id + status). */
export async function linkReferralConversionAction(input: {
  prospectId: string; brokerageId: string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireBilling()
  if (!auth.ok) return auth
  if (!input.prospectId || !input.brokerageId) return { ok: false, error: "Prospect and brokerage are required" }
  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id, name").eq("id", input.brokerageId).maybeSingle()
  if (!brk) return { ok: false, error: "Brokerage not found" }
  const { error } = await svc.from("platform_prospects")
    .update({ converted_brokerage_id: input.brokerageId, status: "converted", updated_at: new Date().toISOString() })
    .eq("id", input.prospectId)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "subscriber_referral.linked", input.prospectId, { brokerage_id: input.brokerageId, brokerage_name: (brk as any).name })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}

/**
 * POST a referral-fee payout. The payment record is a referral_payouts LEDGER
 * row (m573): idempotent per (prospect, period), recipient resolved from the
 * referrer's email (a tenant referrer sees it on their billing page — the
 * RECEIVED half), the write .select()ed and counted (§3). The audit log gets
 * the TRAIL ("referral_payout.posted"). While m573 is unapplied the ledger is
 * honestly unavailable and this degrades to the legacy audit-line record
 * ("referral_fee.paid") — the pre-existing behavior, now labeled as degraded
 * in the result instead of being the design.
 */
export async function markReferralFeePaidAction(input: {
  prospectId: string; amountCents: number; note?: string
  /** Billing period the fee is for ('YYYY-MM'); defaults to the current month. */
  period?: string
}): Promise<{
  ok: boolean; error?: string
  /** Where the payment record landed: the m573 ledger, or the legacy audit line. */
  recordedIn?: "ledger" | "audit_log_legacy"
  /** Tenant-referrer resolution — null means a non-tenant referrer (no billing surface yet). */
  recipientBrokerageId?: string | null
  period?: string
}> {
  const auth = await requireBilling()
  if (!auth.ok) return auth
  const amountCents = Math.floor(Number(input.amountCents))
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { ok: false, error: "A positive amount is required" }
  const svc = createServiceClient()
  const { data: p } = await svc.from("platform_prospects").select("id, source, converted_brokerage_id").eq("id", input.prospectId).maybeSingle()
  if (!p) return { ok: false, error: "Referral not found" }
  const referrer = parseReferrer((p as any).source)
  if (!referrer) return { ok: false, error: "That prospect is not a referral" }

  const terms = await getReferralFeeTerms(svc)
  const posted = await postReferralPayout(svc, {
    prospectId: input.prospectId,
    referrer,
    amountCents,
    feePercent: terms.percent,
    period: input.period ?? null,
    note: input.note ?? null,
    postedBy: auth.userId,
  })

  if (posted.ok) {
    // TRAIL beside the ledger (best-effort — the money row is already committed).
    await audit(auth.userId, auth.email, POSTED_TRAIL_ACTION, input.prospectId, {
      payout_id: posted.payoutId, amount_cents: amountCents, period: posted.period,
      fee_percent: terms.percent, fee_percent_source: terms.source, referrer,
      recipient_brokerage_id: posted.recipient.brokerageId,
      recipient_email: posted.recipient.email,
      brokerage_id: (p as any).converted_brokerage_id ?? null,
      note: (input.note ?? "").trim() || null,
    })
    revalidatePath("/dashboard/superadmin/growth")
    revalidatePath("/dashboard/admin/billing")
    return { ok: true, recordedIn: "ledger", recipientBrokerageId: posted.recipient.brokerageId, period: posted.period }
  }

  if (posted.reason !== "ledger_unavailable") {
    // Idempotency refusal / validation / real error — surfaced, never re-recorded.
    return { ok: false, error: posted.error }
  }

  // DEGRADED PATH (m573 written, not applied): the legacy audit line IS the
  // payment record, exactly as before this lane — its write must be checked,
  // not fire-and-forget like the side-audits.
  const hdrs = await headers()
  const { error } = await svc.from("superadmin_audit_log").insert({
    actor_user_id: auth.userId, actor_email: auth.email, action: PAID_ACTION,
    target_type: "platform_prospect", target_id: input.prospectId,
    details: {
      amount_cents: amountCents, referrer,
      brokerage_id: (p as any).converted_brokerage_id ?? null,
      note: (input.note ?? "").trim() || null,
      ledger_unavailable: "referral_payouts missing — apply m573",
    },
    ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true, recordedIn: "audit_log_legacy", recipientBrokerageId: posted.recipient?.brokerageId ?? null }
}
