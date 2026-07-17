"use server"

// app/actions/superadmin/subscriber-referrals.ts
// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIBER REFERRAL FEES — DB wiring for lib/platform/subscriber-referrals.ts.
// Rides the EXISTING rails only: platform_prospects (source = "referral:<who>",
// converted_brokerage_id = the tenant it became), subscriptions + subscription_tiers
// for MRR, and superadmin_audit_log as the append-only payment ledger (action
// "referral_fee.paid" — "paid" state is READ BACK from the ledger, no new table).
// Money surface ⇒ gated on the "billing" capability (superadmin + platform admin).

import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import {
  parseReferrer, makeReferralSource, computeReferralFeeCents,
  REFERRAL_FEE_PERCENT, REFERRAL_SOURCE_PREFIX, type SubscriberReferralRow,
} from "@/lib/platform/subscriber-referrals"

const PAID_ACTION = "referral_fee.paid"

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
  | { ok: true; rows: SubscriberReferralRow[]; feePercent: number; brokerageOptions: Array<{ id: string; name: string }> }
  | { ok: false; error: string }
> {
  const auth = await requireBilling()
  if (!auth.ok) return auth
  const svc = createServiceClient()

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

  // Payment history from the append-only ledger.
  const lastPaidAt = new Map<string, string>()
  const lastPaidCents = new Map<string, number>()
  const totalPaidCents = new Map<string, number>()
  if (prospectIds.length > 0) {
    const { data: ledger, error: ledgerErr } = await svc
      .from("superadmin_audit_log")
      .select("target_id, created_at, details")
      .eq("action", PAID_ACTION)
      .eq("target_type", "platform_prospect")
      .in("target_id", prospectIds)
      .order("created_at", { ascending: false })
      .limit(1000)
    if (ledgerErr) return { ok: false, error: ledgerErr.message }
    for (const e of (ledger ?? []) as any[]) {
      const cents = Number(e.details?.amount_cents) || 0
      totalPaidCents.set(e.target_id, (totalPaidCents.get(e.target_id) ?? 0) + cents)
      if (!lastPaidAt.has(e.target_id)) { lastPaidAt.set(e.target_id, e.created_at); lastPaidCents.set(e.target_id, cents) }
    }
  }

  // Link targets for un-linked referrals (active tenants only — the picker stays small).
  const { data: options, error: optErr } = await svc
    .from("brokerages").select("id, name").eq("status", "active").order("name", { ascending: true }).limit(500)
  if (optErr) return { ok: false, error: optErr.message }

  const rows: SubscriberReferralRow[] = rows0.map((p) => {
    const mrrCents = p.converted_brokerage_id ? (mrrById.get(p.converted_brokerage_id) ?? 0) : 0
    return {
      prospectId: p.id,
      referrer: parseReferrer(p.source) ?? "—",
      prospectName: p.name, prospectEmail: p.email, prospectCompany: p.company,
      status: p.status ?? "new",
      brokerageId: p.converted_brokerage_id ?? null,
      brokerageName: p.converted_brokerage_id ? (nameById.get(p.converted_brokerage_id) ?? null) : null,
      mrrCents, feePercent: REFERRAL_FEE_PERCENT, feeCents: computeReferralFeeCents(mrrCents),
      lastPaidAt: lastPaidAt.get(p.id) ?? null,
      lastPaidCents: lastPaidCents.get(p.id) ?? null,
      totalPaidCents: totalPaidCents.get(p.id) ?? 0,
      createdAt: p.created_at,
    }
  })
  return { ok: true, rows, feePercent: REFERRAL_FEE_PERCENT, brokerageOptions: ((options ?? []) as any[]).map((b) => ({ id: b.id, name: b.name ?? "—" })) }
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

/** Record a referral-fee payment in the append-only ledger (superadmin_audit_log). */
export async function markReferralFeePaidAction(input: {
  prospectId: string; amountCents: number; note?: string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireBilling()
  if (!auth.ok) return auth
  const amountCents = Math.floor(Number(input.amountCents))
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { ok: false, error: "A positive amount is required" }
  const svc = createServiceClient()
  const { data: p } = await svc.from("platform_prospects").select("id, source, converted_brokerage_id").eq("id", input.prospectId).maybeSingle()
  if (!p) return { ok: false, error: "Referral not found" }
  const referrer = parseReferrer((p as any).source)
  if (!referrer) return { ok: false, error: "That prospect is not a referral" }
  // This row IS the payment record (append-only ledger) — its write must be checked,
  // not fire-and-forget like the side-audits above.
  const hdrs = await headers()
  const { error } = await svc.from("superadmin_audit_log").insert({
    actor_user_id: auth.userId, actor_email: auth.email, action: PAID_ACTION,
    target_type: "platform_prospect", target_id: input.prospectId,
    details: {
      amount_cents: amountCents, referrer,
      brokerage_id: (p as any).converted_brokerage_id ?? null,
      note: (input.note ?? "").trim() || null,
    },
    ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}
