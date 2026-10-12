// lib/billing/phone-plan.ts
// ─────────────────────────────────────────────────────────────────────────────
// PHONE BILLING — BUNDLED INTO THE TIERS WITH METERING (owner decision).
//
// The product promise is "AI answers your phone" (see phone_system_tenancy in
// the manager registry) — the telephony is PLATFORM-OWNED and resold metered, so
// the subscriber never touches a Twilio/Vapi signup. This module makes the
// commercial half concrete: every tier BUNDLES a phone allowance (included
// numbers + included AI-voice minutes + included SMS segments); usage inside the
// bundle is free, usage beyond it is METERED overage.
//
// PURE + client-safe (no server-only imports) so the same allowance math drives
// the provisioning gate, the finance P&L rollup, and the tenant usage card with
// zero drift — and is provable by a tsx simulator. The DB-backed resolver that
// reads the tenant's tier + Superadmin → Plans overrides lives in
// lib/billing/phone-plan-resolve.ts.
//
// PRICING IS NOT SET (owner, wave 139 ECONOMICS / wave 140): "nothing may
// hard-code a tier price; unknown price stays explicitly unknown, never
// fabricated." The BUNDLE SIZES below (included numbers / minutes / segments and
// the runaway cap) are entitlements and stay as defaults; the OVERAGE RATES are
// prices and have NO code default — they are `null` (not configured) until
// Superadmin → Plans writes them into subscription_tiers.features.limits
// (overage_number_cents / overage_voice_minute_cents / overage_sms_cents).
// A `null` rate is the typed `price_not_configured` state
// (lib/billing/plan-catalog.ts): the provisioning gate REFUSES an overage
// number with a clear tenant message + a platform incident, and the meter
// reports the overage units with NO amount — never a guessed charge.
// TOMBSTONE (wave 140J): the twelve per-tier literals that sat here
// (300/5/2, 250/4/2, 200/3/1, 150/3/1 cents) were fabricated prices; survivor =
// the administered features.limits row, read by resolvePhoneAllowance below.

import type { CanonicalTier } from "@/lib/kernel/users"
import { isConfiguredPriceCents, priceNotConfiguredRefusal, type PriceNotConfiguredRefusal } from "./plan-catalog"

export interface PhoneAllowance {
  /** Phone numbers included in the plan at no extra charge. */
  includedNumbers: number
  /** AI-voice minutes/month included (both inbound reception + outbound dials). */
  includedVoiceMinutes: number
  /** SMS segments/month included. */
  includedSmsSegments: number
  /** Monthly USD-cents charge per number PROVISIONED beyond includedNumbers.
   *  null = NOT CONFIGURED (no administered rate) — an overage number is refused. */
  overageNumberCents: number | null
  /** USD-cents per AI-voice minute beyond includedVoiceMinutes (null = not configured). */
  overageVoiceMinuteCents: number | null
  /** USD-cents per SMS segment beyond includedSmsSegments (null = not configured). */
  overageSmsCents: number | null
  /** Runaway backstop: the MOST numbers a tenant may ever provision on this tier
   *  (null = unlimited, still metered as overage). NOT the included count — a
   *  tenant can provision past includedNumbers and pay overage up to this cap. */
  maxNumbers: number | null
}

/** The surface name every phone price_not_configured refusal and incident carries. */
export const PHONE_OVERAGE_PRICE_SURFACE = "phone_number_overage"

// ── Per-tier BUNDLE DEFAULTS (owner-tunable via subscription_tiers.features.limits) ───
// Generous inside-bundle so normal use is never billed twice. The overage
// rates are deliberately `null` — see the header: a rate exists only when
// administered.
export const PHONE_ALLOWANCE_DEFAULTS: Record<CanonicalTier, PhoneAllowance> = {
  solo_agent: {
    includedNumbers: 1,
    includedVoiceMinutes: 250,
    includedSmsSegments: 500,
    overageNumberCents: null,
    overageVoiceMinuteCents: null,
    overageSmsCents: null,
    maxNumbers: 3,
  },
  team: {
    includedNumbers: 5,
    includedVoiceMinutes: 1500,
    includedSmsSegments: 3000,
    overageNumberCents: null,
    overageVoiceMinuteCents: null,
    overageSmsCents: null,
    maxNumbers: 15,
  },
  brokerage: {
    includedNumbers: 25,
    includedVoiceMinutes: 10000,
    includedSmsSegments: 20000,
    overageNumberCents: null,
    overageVoiceMinuteCents: null,
    overageSmsCents: null,
    maxNumbers: 200,
  },
  multi_location: {
    includedNumbers: 100,
    includedVoiceMinutes: 50000,
    includedSmsSegments: 100000,
    overageNumberCents: null,
    overageVoiceMinuteCents: null,
    overageSmsCents: null,
    maxNumbers: null,               // unlimited (still metered as overage)
  },
}

/** Unknown/legacy/null tiers fail SAFE to the solo allowance (the tightest bundle
 *  — a mis-tagged tenant is never handed the multi-location bundle for free). */
export const DEFAULT_PHONE_ALLOWANCE = PHONE_ALLOWANCE_DEFAULTS.solo_agent

function isCanonicalTier(t: string | null | undefined): t is CanonicalTier {
  return !!t && t in PHONE_ALLOWANCE_DEFAULTS
}

/** Read one numeric override out of a tier's features.limits jsonb (positive
 *  integer wins; anything else → the default is kept). null is a VALID override
 *  ONLY for maxNumbers (explicit "unlimited") — handled by the caller. */
function overrideInt(limits: Record<string, unknown> | null | undefined, key: string, fallback: number): number {
  const raw = limits?.[key]
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback
}

/** Read one administered RATE (integer cents, zero allowed = explicitly free) out of
 *  features.limits; anything else is NOT CONFIGURED (null) — never a default. */
function overrideRate(limits: Record<string, unknown> | null | undefined, key: string): number | null {
  const raw = limits?.[key]
  return isConfiguredPriceCents(raw, { allowZero: true }) ? raw : null
}

/**
 * PURE: resolve a tenant's phone allowance — the per-tier default with any
 * Superadmin → Plans override (subscription_tiers.features.limits) folded on top.
 * This is the single source of truth every phone-billing surface resolves through.
 *
 * features.limits keys honored:
 *   included_phone_numbers · included_voice_minutes · included_sms_segments ·
 *   overage_number_cents · overage_voice_minute_cents · overage_sms_cents ·
 *   max_phone_numbers (a value of -1 or explicit null ⇒ unlimited)
 */
export function resolvePhoneAllowance(
  tier: string | null | undefined,
  featuresLimits?: Record<string, unknown> | null,
): PhoneAllowance {
  const base = isCanonicalTier(tier) ? PHONE_ALLOWANCE_DEFAULTS[tier] : DEFAULT_PHONE_ALLOWANCE
  const lim = featuresLimits ?? null
  // max_phone_numbers: -1 (or an explicit null override) means unlimited.
  const rawMax = lim?.["max_phone_numbers"]
  let maxNumbers = base.maxNumbers
  if (rawMax === null || rawMax === -1) maxNumbers = null
  else if (typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 0) maxNumbers = Math.floor(rawMax)

  return {
    includedNumbers: overrideInt(lim, "included_phone_numbers", base.includedNumbers),
    includedVoiceMinutes: overrideInt(lim, "included_voice_minutes", base.includedVoiceMinutes),
    includedSmsSegments: overrideInt(lim, "included_sms_segments", base.includedSmsSegments),
    // Rates: administered or null. `base` holds null for every tier (see header),
    // so the ONLY way a rate exists is the features.limits row.
    overageNumberCents: overrideRate(lim, "overage_number_cents") ?? base.overageNumberCents,
    overageVoiceMinuteCents: overrideRate(lim, "overage_voice_minute_cents") ?? base.overageVoiceMinuteCents,
    overageSmsCents: overrideRate(lim, "overage_sms_cents") ?? base.overageSmsCents,
    maxNumbers,
  }
}

/** PURE: the typed refusal for one unset phone rate on one tier. */
function phoneRateNotConfigured(tier: string | null | undefined, rate: "overage_number_cents" | "overage_voice_minute_cents" | "overage_sms_cents", whatIsBlocked: string): PriceNotConfiguredRefusal {
  return priceNotConfiguredRefusal({
    surface: PHONE_OVERAGE_PRICE_SURFACE,
    what: `${tier ?? "unknown"} tier ${rate} (subscription_tiers.features.limits)`,
    whatIsBlocked,
  })
}

// ── Provisioning gate ─────────────────────────────────────────────────────────

export interface NumberProvisioningVerdict {
  /** May the next number be provisioned at all? False only past the hard cap. */
  allowed: boolean
  /** Is the next number INSIDE the bundle (free) or billable overage? */
  billing: "included" | "overage"
  /** Numbers already active for this tenant. */
  activeNumbers: number
  /** Bundle size (numbers included at no charge). */
  includedNumbers: number
  /** The hard cap (null = unlimited). */
  maxNumbers: number | null
  /** Monthly USD-cents this number adds ONLY when billing === "overage" (else 0).
   *  null = the overage rate is NOT CONFIGURED (then `allowed` is false and
   *  `priceNotConfigured` says why — never a guessed amount). */
  monthlyOverageCents: number | null
  /** Human-readable reason when !allowed (the upgrade pitch, or the price gap). */
  reason?: string
  /** Set when the refusal is the typed price_not_configured state (the caller
   *  raises the platform incident); absent on an allow or a hard-cap refusal. */
  priceNotConfigured?: PriceNotConfiguredRefusal
}

/**
 * PURE: decide whether one more number may be provisioned, and whether it lands
 * inside the bundle or as metered overage. The gate NEVER blocks a tenant who is
 * merely over their included count — that number is billable, not forbidden
 * (metered resale). It blocks at the runaway backstop (maxNumbers), and it
 * REFUSES an overage number whose rate is not configured: a metered number with
 * no administered price would be a charge invented in code (wave 140J).
 */
export function evaluateNumberProvisioning(params: {
  allowance: PhoneAllowance
  activeNumbers: number
  /** For the refusal's incident text only. */
  tier?: string | null
}): NumberProvisioningVerdict {
  const { allowance, activeNumbers } = params
  const nextCount = activeNumbers + 1
  const includedNumbers = allowance.includedNumbers
  const maxNumbers = allowance.maxNumbers

  if (maxNumbers !== null && nextCount > maxNumbers) {
    return {
      allowed: false,
      billing: "overage",
      activeNumbers,
      includedNumbers,
      maxNumbers,
      monthlyOverageCents: 0,
      reason: `Your plan caps active numbers at ${maxNumbers}. Upgrade to add more.`,
    }
  }

  const billing: "included" | "overage" = nextCount <= includedNumbers ? "included" : "overage"
  if (billing === "overage" && allowance.overageNumberCents === null) {
    const refusal = phoneRateNotConfigured(params.tier, "overage_number_cents", `this number was not added (numbers beyond the ${includedNumbers} included in your plan are metered)`)
    return {
      allowed: false,
      billing,
      activeNumbers,
      includedNumbers,
      maxNumbers,
      monthlyOverageCents: null,
      reason: refusal.tenantMessage,
      priceNotConfigured: refusal,
    }
  }
  return {
    allowed: true,
    billing,
    activeNumbers,
    includedNumbers,
    maxNumbers,
    monthlyOverageCents: billing === "overage" ? allowance.overageNumberCents : 0,
  }
}

// ── Usage metering (included vs billable overage) ─────────────────────────────

export interface PhoneMeter {
  /** Bundle sizes. */
  includedVoiceMinutes: number
  includedSmsSegments: number
  includedNumbers: number
  /** This period's usage. */
  voiceMinutes: number
  smsSegments: number
  activeNumbers: number
  /** Billable overage counts (0 when inside the bundle). */
  overageVoiceMinutes: number
  overageSmsSegments: number
  overageNumbers: number
  /** Billable overage cost in USD-cents (numbers × monthly + minutes + segments).
   *  A line is `null` when overage units exist on it but its rate is NOT
   *  CONFIGURED; the total is `null` when any priced line is. Zero units on an
   *  unpriced line is an honest 0 — nothing is owed, nothing is unknown. */
  overageVoiceCents: number | null
  overageSmsCents: number | null
  overageNumberCents: number | null
  overageTotalCents: number | null
  /** The unset rates that made a line `null` (empty when every amount is known). */
  priceNotConfigured: PriceNotConfiguredRefusal[]
}

/** One meter line: units × rate, or null when units exist and the rate is unset. */
function meterLine(units: number, rateCents: number | null): number | null {
  if (units <= 0) return 0
  return rateCents === null ? null : units * rateCents
}

/**
 * PURE: fold a period's phone usage against the bundle into an included-vs-overage
 * meter. This is what the finance P&L rollup bills and the tenant usage card shows —
 * "you used 340 of 250 included minutes (90 metered @ $0.05)". Never negative.
 * An overage line whose rate is not configured reports its UNITS and no amount
 * (price_not_configured) — the units are a fact, the amount would be a guess.
 */
export function evaluatePhoneMetering(params: {
  allowance: PhoneAllowance
  voiceMinutes: number
  smsSegments: number
  activeNumbers: number
  /** For the refusal's incident text only. */
  tier?: string | null
}): PhoneMeter {
  const { allowance, voiceMinutes, smsSegments, activeNumbers } = params
  const overageVoiceMinutes = Math.max(0, Math.ceil(voiceMinutes) - allowance.includedVoiceMinutes)
  const overageSmsSegments = Math.max(0, Math.ceil(smsSegments) - allowance.includedSmsSegments)
  const overageNumbers = Math.max(0, activeNumbers - allowance.includedNumbers)

  const overageVoiceCents = meterLine(overageVoiceMinutes, allowance.overageVoiceMinuteCents)
  const overageSmsCents = meterLine(overageSmsSegments, allowance.overageSmsCents)
  const overageNumberCents = meterLine(overageNumbers, allowance.overageNumberCents)

  const priceNotConfigured: PriceNotConfiguredRefusal[] = []
  if (overageVoiceCents === null) priceNotConfigured.push(phoneRateNotConfigured(params.tier, "overage_voice_minute_cents", `${overageVoiceMinutes} metered voice minute(s) carry no amount`))
  if (overageSmsCents === null) priceNotConfigured.push(phoneRateNotConfigured(params.tier, "overage_sms_cents", `${overageSmsSegments} metered SMS segment(s) carry no amount`))
  if (overageNumberCents === null) priceNotConfigured.push(phoneRateNotConfigured(params.tier, "overage_number_cents", `${overageNumbers} metered number(s) carry no amount`))

  return {
    includedVoiceMinutes: allowance.includedVoiceMinutes,
    includedSmsSegments: allowance.includedSmsSegments,
    includedNumbers: allowance.includedNumbers,
    voiceMinutes: Math.ceil(voiceMinutes),
    smsSegments: Math.ceil(smsSegments),
    activeNumbers,
    overageVoiceMinutes,
    overageSmsSegments,
    overageNumbers,
    overageVoiceCents,
    overageSmsCents,
    overageNumberCents,
    overageTotalCents: priceNotConfigured.length > 0 ? null : (overageVoiceCents ?? 0) + (overageSmsCents ?? 0) + (overageNumberCents ?? 0),
    priceNotConfigured,
  }
}
