// lib/billing/phone-plan-resolve.ts
// ─────────────────────────────────────────────────────────────────────────────
// The DB-backed half of phone-plan.ts: resolve a tenant's PHONE ALLOWANCE (the
// per-tier bundle + any Superadmin → Plans override) and evaluate a provisioning
// request against its month-to-date active numbers. The provisioning gate
// (lib/voice/number-provisioning.ts) and the finance P&L rollup both resolve
// through HERE so the bundle math is computed in exactly one place.
//
// Tier resolution mirrors budget-gate.ts (brokerages.plan_tier) and the tier's
// features.limits jsonb carries the owner-tunable overrides — the SAME jsonb
// calculateOverageExposure already reads for per-metric caps.

import "server-only"
import {
  resolvePhoneAllowance,
  evaluateNumberProvisioning,
  evaluatePhoneMetering,
  type PhoneAllowance,
  type NumberProvisioningVerdict,
  type PhoneMeter,
} from "./phone-plan"

type Svc = { from: (table: string) => any }

/**
 * Resolve one brokerage's phone allowance: its plan tier (brokerages.plan_tier),
 * folded with the tier catalog's features.limits overrides. Fails SAFE — any read
 * error resolves to the tightest (solo) bundle rather than handing out a free
 * upgrade, and never throws.
 */
export async function resolveTenantPhoneAllowance(
  svc: Svc,
  brokerageId: string,
): Promise<{ tier: string; allowance: PhoneAllowance }> {
  try {
    const { data: brokerage } = await svc
      .from("brokerages")
      .select("plan_tier")
      .eq("id", brokerageId)
      .maybeSingle()
    const tier: string = brokerage?.plan_tier ?? "solo_agent"

    // The owner-tunable overrides live on the tier catalog row (features.limits).
    const { data: tierRow } = await svc
      .from("subscription_tiers")
      .select("features")
      .eq("tier_name", tier)
      .maybeSingle()
    const limits = ((tierRow?.features as any)?.limits ?? null) as Record<string, unknown> | null

    return { tier, allowance: resolvePhoneAllowance(tier, limits) }
  } catch {
    return { tier: "solo_agent", allowance: resolvePhoneAllowance("solo_agent", null) }
  }
}

/**
 * Count a tenant's ACTIVE provisioned numbers and evaluate whether one more may be
 * provisioned — and whether it lands inside the bundle (free) or as metered
 * overage. This is the entitlement the provisioning gate consults BEFORE any
 * Twilio purchase. Fails SAFE: a count read error is treated as 0 active so a
 * broken read never blocks a legitimate first number.
 */
export async function evaluateTenantNumberProvisioning(
  svc: Svc,
  brokerageId: string,
): Promise<NumberProvisioningVerdict & { tier: string; allowance: PhoneAllowance }> {
  const { tier, allowance } = await resolveTenantPhoneAllowance(svc, brokerageId)
  let activeNumbers = 0
  try {
    const { count } = await svc
      .from("vapi_phone_numbers")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
    activeNumbers = count ?? 0
  } catch {
    activeNumbers = 0
  }
  const verdict = evaluateNumberProvisioning({ allowance, activeNumbers })
  return { ...verdict, tier, allowance }
}

/**
 * Fold a tenant's month-to-date phone usage against its plan bundle into an
 * included-vs-metered-overage meter — the line the finance P&L bills and the
 * tenant usage card shows. Voice minutes + active numbers come from the SAME
 * voice-usage rollup the phone-settings card already reads (usage_logs 'voice_call'
 * minutes + vapi_phone_numbers); SMS segments are counted from the unified inbox (messages
 * type='sms'). Fails SAFE — a read error meters zero usage rather than throwing.
 *
 * @param month YYYY-MM (defaults to the current calendar month).
 */
export async function loadTenantPhoneMeter(
  svc: Svc,
  brokerageId: string,
  month?: string,
): Promise<{ tier: string; allowance: PhoneAllowance; meter: PhoneMeter; month: string }> {
  const m = month ?? new Date().toISOString().slice(0, 7)
  const { tier, allowance } = await resolveTenantPhoneAllowance(svc, brokerageId)

  let voiceMinutes = 0
  let activeNumbers = 0
  let smsSegments = 0
  try {
    const { loadVoiceUsage } = await import("@/lib/voice/twilio-tenancy")
    const usage = await loadVoiceUsage(svc, brokerageId, m)
    voiceMinutes = usage.minutes
    activeNumbers = usage.activeNumbers
  } catch { /* fail-safe zero */ }

  try {
    const start = `${m}-01`
    const end = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 10)
    const { count } = await svc
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("type", "sms")
      .gte("created_at", start)
      .lt("created_at", end)
    smsSegments = count ?? 0
  } catch { /* fail-safe zero */ }

  const meter = evaluatePhoneMetering({ allowance, voiceMinutes, smsSegments, activeNumbers })
  return { tier, allowance, meter, month: m }
}
