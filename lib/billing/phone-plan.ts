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
// PRICING IS NOT FINAL (owner decision): the DEFAULTS below are the fallback the
// gate uses until Superadmin → Plans writes per-tier numbers into
// subscription_tiers.features.limits — those overrides always win (resolvePhoneAllowance).

import type { CanonicalTier } from "@/lib/kernel/users"

export interface PhoneAllowance {
  /** Phone numbers included in the plan at no extra charge. */
  includedNumbers: number
  /** AI-voice minutes/month included (both inbound reception + outbound dials). */
  includedVoiceMinutes: number
  /** SMS segments/month included. */
  includedSmsSegments: number
  /** Monthly USD-cents charge per number PROVISIONED beyond includedNumbers. */
  overageNumberCents: number
  /** USD-cents per AI-voice minute beyond includedVoiceMinutes. */
  overageVoiceMinuteCents: number
  /** USD-cents per SMS segment beyond includedSmsSegments. */
  overageSmsCents: number
  /** Runaway backstop: the MOST numbers a tenant may ever provision on this tier
   *  (null = unlimited, still metered as overage). NOT the included count — a
   *  tenant can provision past includedNumbers and pay overage up to this cap. */
  maxNumbers: number | null
}

// ── Per-tier DEFAULTS (owner-tunable via subscription_tiers.features.limits) ───
// Generous inside-bundle so normal use is never billed twice; overage rates track
// the platform's own metered cost (twilio_voice ≈ $0.02/min, local number ≈
// $1.15/mo, SMS ≈ $0.008/segment — see PLATFORM_VENDOR_RATES) with margin.
export const PHONE_ALLOWANCE_DEFAULTS: Record<CanonicalTier, PhoneAllowance> = {
  solo_agent: {
    includedNumbers: 1,
    includedVoiceMinutes: 250,
    includedSmsSegments: 500,
    overageNumberCents: 300,        // $3.00 / extra number / mo
    overageVoiceMinuteCents: 5,     // $0.05 / min
    overageSmsCents: 2,             // $0.02 / segment
    maxNumbers: 3,
  },
  team: {
    includedNumbers: 5,
    includedVoiceMinutes: 1500,
    includedSmsSegments: 3000,
    overageNumberCents: 250,
    overageVoiceMinuteCents: 4,
    overageSmsCents: 2,
    maxNumbers: 15,
  },
  brokerage: {
    includedNumbers: 25,
    includedVoiceMinutes: 10000,
    includedSmsSegments: 20000,
    overageNumberCents: 200,
    overageVoiceMinuteCents: 3,
    overageSmsCents: 1,
    maxNumbers: 200,
  },
  multi_location: {
    includedNumbers: 100,
    includedVoiceMinutes: 50000,
    includedSmsSegments: 100000,
    overageNumberCents: 150,
    overageVoiceMinuteCents: 3,
    overageSmsCents: 1,
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
    overageNumberCents: overrideInt(lim, "overage_number_cents", base.overageNumberCents),
    overageVoiceMinuteCents: overrideInt(lim, "overage_voice_minute_cents", base.overageVoiceMinuteCents),
    overageSmsCents: overrideInt(lim, "overage_sms_cents", base.overageSmsCents),
    maxNumbers,
  }
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
  /** Monthly USD-cents this number adds ONLY when billing === "overage" (else 0). */
  monthlyOverageCents: number
  /** Human-readable reason when !allowed (the upgrade pitch). */
  reason?: string
}

/**
 * PURE: decide whether one more number may be provisioned, and whether it lands
 * inside the bundle or as metered overage. The gate NEVER blocks a tenant who is
 * merely over their included count — that number is billable, not forbidden
 * (metered resale). It blocks ONLY at the runaway backstop (maxNumbers).
 */
export function evaluateNumberProvisioning(params: {
  allowance: PhoneAllowance
  activeNumbers: number
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
  /** Billable overage cost in USD-cents (numbers × monthly + minutes + segments). */
  overageVoiceCents: number
  overageSmsCents: number
  overageNumberCents: number
  overageTotalCents: number
}

/**
 * PURE: fold a period's phone usage against the bundle into an included-vs-overage
 * meter. This is what the finance P&L rollup bills and the tenant usage card shows —
 * "you used 340 of 250 included minutes (90 metered @ $0.05)". Never negative.
 */
export function evaluatePhoneMetering(params: {
  allowance: PhoneAllowance
  voiceMinutes: number
  smsSegments: number
  activeNumbers: number
}): PhoneMeter {
  const { allowance, voiceMinutes, smsSegments, activeNumbers } = params
  const overageVoiceMinutes = Math.max(0, Math.ceil(voiceMinutes) - allowance.includedVoiceMinutes)
  const overageSmsSegments = Math.max(0, Math.ceil(smsSegments) - allowance.includedSmsSegments)
  const overageNumbers = Math.max(0, activeNumbers - allowance.includedNumbers)

  const overageVoiceCents = overageVoiceMinutes * allowance.overageVoiceMinuteCents
  const overageSmsCents = overageSmsSegments * allowance.overageSmsCents
  const overageNumberCents = overageNumbers * allowance.overageNumberCents

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
    overageTotalCents: overageVoiceCents + overageSmsCents + overageNumberCents,
  }
}
