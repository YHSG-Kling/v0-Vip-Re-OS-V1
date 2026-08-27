"use server"

// THE BROKERAGE OFFERINGS SETTINGS HOME — one place a broker/admin marks what their brokerage
// offers its agents (owner ruling 2026-08-27: "make sure that the brokerages have the ability in
// settings to mark if they offer residual income … also if they offer medical or retirement", and
// "tax assistance tech is an option for tenants built out").
//
// · Revenue-share opt-in (m264) — a broker toggles whether their brokerage offers agent-to-agent
//   (downline) revenue share. RESIDUAL INCOME IS THIS SETTING: the "offers residual income" mark is
//   revenue_share_enabled itself, not a second column (§6). When off, the commission waterfall's
//   revenue-share step is skipped and the command-center revenue-share board is hidden.
// · Medical / retirement benefit offerings (m574) — advertised to recruits by
//   lib/recruiting/recruiting-pitch-kit.ts and the public careers page, and surfaced as retention
//   levers by the retention radar. Fail-closed: unset = not offered.
// · Tax-assistance enablement (m574) — gates the 1099 tax tech for this tenant's agents at
//   lib/finance/tax-assistance.ts. Fail-closed, opt-in like farm mail.
//
// Broker/finance-admin only; tenant always from the SESSION (§4). Each column keeps exactly ONE
// writer: setRevenueShareEnabled for revenue_share_enabled, setBenefitOffering for the m574 columns.

import { createServiceClient } from "@/lib/supabase/service"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import {
  parseRevenueShareModel,
  REVENUE_SHARE_RATE_TYPES,
  REVENUE_SHARE_SOURCES,
  type RevenueShareModelState,
  type RevenueShareRateType,
  type RevenueShareSource,
} from "@/lib/commission/revenue-share-model"
// ★ ACT-AS WRITE SEAM ★ — the gate resolves the EFFECTIVE identity (the
// impersonated seat under act-as, never the raw staff row with its NULL
// brokerage). The finance predicate is unchanged and is evaluated on that
// impersonated identity; the setter additionally refuses read_only grants
// before the service-client write, which this gate alone protects.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"

async function resolveBrokerAdmin(
  mode: "read" | "write",
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const acting = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!acting.ok) return { ok: false, error: acting.error ?? "Unauthenticated" }
  if (!acting.brokerageId) return { ok: false, error: "No brokerage" }
  // A solo agent runs their own one-person shop, so they control their own revenue-share offering too —
  // allow the solo-tier owner in addition to broker/admin roles.
  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("plan_tier").eq("id", acting.brokerageId).maybeSingle()
  const isSolo = (brk as any)?.plan_tier === "solo_agent"
  // BROKERAGE-WIDE MONEY (m472). The ONE finance roster — the same set
  // public.is_brokerage_finance_admin() carries — so the app cannot admit where
  // RLS refuses. It EXCLUDES team_lead by the owner's ruling, and it ADDS
  // broker_owner, which the local literal omitted: the person who OWNS the
  // brokerage was refused by the gate guarding their own brokerage's setting.
  // Evaluated on the IMPERSONATED identity's user_type when acting-as.
  if (!isSolo && !isBrokerageFinanceAdmin({ user_type: acting.userType })) {
    return { ok: false, error: "Only a broker or admin can change this setting" }
  }
  return { ok: true, brokerageId: acting.brokerageId }
}

// TOMBSTONE (§1.1): getRevenueShareSetting was DELETED into getBenefitOfferings
// below. When the offerings card absorbed the old RevenueShareToggle, the
// four-mark read became this file's one reader-facing getter and the
// single-mark getter lost its last caller the same wave it gained a sibling —
// test:wired-surface caught it as a new orphan "use server" action, which in
// this file means a new PUBLIC HTTP ENDPOINT nobody calls (§4). The survivor
// returns revenueShare among its four marks through the same read gate.

export async function setRevenueShareEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  // "write": read_only impersonation is refused inside the gate.
  const ctx = await resolveBrokerAdmin("write")
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const svc = createServiceClient()
  const { error } = await svc.from("brokerages").update({ revenue_share_enabled: enabled }).eq("id", ctx.brokerageId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ─── BENEFIT OFFERINGS + TAX ASSISTANCE (m574) ───────────────────────────────

/** The client names a BENEFIT, never a column — the allow-list below is the only
 *  mapping, so a tampered payload can't reach any other brokerages column. */
export type OfferingKey = "medical" | "retirement" | "tax_assistance"

const OFFERING_COLUMNS: Record<OfferingKey, "offers_medical_benefits" | "offers_retirement_benefits" | "tax_assistance_enabled"> = {
  medical: "offers_medical_benefits",
  retirement: "offers_retirement_benefits",
  tax_assistance: "tax_assistance_enabled",
}

export interface BrokerageOfferings {
  /** Residual income = agent-to-agent revenue share (revenue_share_enabled — the ONE mark, §6). */
  revenueShare: boolean
  medical: boolean
  retirement: boolean
  taxAssistance: boolean
}

/**
 * Read every offering mark for the settings card in one call. FAIL-CLOSED: a
 * refused read is an error, never a confident "all off" — but a genuinely unset
 * column is honestly false (unset = not offered).
 */
export async function getBenefitOfferings(): Promise<{ ok: boolean; offerings: BrokerageOfferings; error?: string }> {
  const off: BrokerageOfferings = { revenueShare: false, medical: false, retirement: false, taxAssistance: false }
  const ctx = await resolveBrokerAdmin("read")
  if (!ctx.ok) return { ok: false, offerings: off, error: ctx.error }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("brokerages")
    .select("revenue_share_enabled, offers_medical_benefits, offers_retirement_benefits, tax_assistance_enabled")
    .eq("id", ctx.brokerageId)
    .maybeSingle()
  // Read, never discarded — supabase-js resolves a rejected read, and swallowing
  // it would render a failed load as "nothing offered".
  if (error) return { ok: false, offerings: off, error: error.message }
  const row = (data ?? {}) as Record<string, boolean | null | undefined>
  return {
    ok: true,
    offerings: {
      revenueShare: row.revenue_share_enabled === true,
      medical: row.offers_medical_benefits === true,
      retirement: row.offers_retirement_benefits === true,
      taxAssistance: row.tax_assistance_enabled === true,
    },
  }
}

/**
 * Mark one offering on or off. Revenue share (residual income) deliberately does
 * NOT route through here — setRevenueShareEnabled above stays that column's one
 * writer. The write is counted: a service-client update pinned to the session
 * tenant should always match one row, so zero rows means the brokerage row is
 * gone and the save must not report success.
 */
export async function setBenefitOffering(
  benefit: OfferingKey,
  offered: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const column = OFFERING_COLUMNS[benefit]
  if (!column) return { ok: false, error: `Unknown offering "${String(benefit)}"` }
  // "write": read_only impersonation is refused inside the gate.
  const ctx = await resolveBrokerAdmin("write")
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const svc = createServiceClient()
  const { data: saved, error } = await svc
    .from("brokerages")
    .update({ [column]: offered === true, updated_at: new Date().toISOString() })
    .eq("id", ctx.brokerageId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!saved || saved.length === 0) return { ok: false, error: "The setting was not saved — your brokerage record could not be found." }
  return { ok: true }
}

// ─── REVENUE-SHARE DISTRIBUTION MODEL (m575) ─────────────────────────────────
// Owner ruling 2026-08-27 (verbatim): "revenue share mark should not be created
// with any assumption of how it gets configured so the settings should be
// telling the platform how the revenue share gets distributed whether it is a
// portion of the income or the brokerage pays the share as a flat fee or % and
// duration." The mark above (setRevenueShareEnabled) says WHETHER the brokerage
// offers it; this model says HOW — and until it is configured, the waterfall's
// step 09 pays NOTHING and no downline edge is planted (fail-closed, never a
// platform-invented 5%). Same gates as every other mark in this home (§4/§5:
// broker/finance-admin configuration, tenant from the SESSION).

/**
 * Read the configured distribution model for the settings panel. The state
 * reports exactly what is unconfigured (`missing`) — the panel shows the
 * broker that the enabled mark alone pays nothing until the model is set.
 */
export async function getRevenueShareDistributionModel(): Promise<
  { ok: true; state: RevenueShareModelState } | { ok: false; error: string }
> {
  const ctx = await resolveBrokerAdmin("read")
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const svc = createServiceClient()
  // select("*") deliberately: naming the m575 columns pre-apply is a 42703
  // refusal of the whole read — the whole-row read keeps this correct before
  // and after (the getReferralFeeTerms idiom).
  const { data, error } = await svc.from("brokerages").select("*").eq("id", ctx.brokerageId).maybeSingle()
  // §3: the error is read — a refused read must never render as "unconfigured".
  if (error) return { ok: false, error: error.message }
  return { ok: true, state: parseRevenueShareModel((data ?? null) as Record<string, unknown> | null) }
}

export interface RevenueShareModelInput {
  sourceOfFunds: RevenueShareSource
  rateType: RevenueShareRateType
  /** Required when rateType='percent' (0 < percent ≤ 100). */
  percent?: number | null
  /** Required when rateType='flat' — whole cents per closing. */
  flatCents?: number | null
  /** Months new relationships run; 0 = indefinite (an explicit choice). */
  durationMonths: number
}

/**
 * The ONE writer of the five m575 model columns. Validated against the same
 * vocabularies the CHECKs enforce, counted (§3 — zero rows updated ≠ saved),
 * and pre-apply honest: naming absent columns refuses the WHOLE update
 * (PGRST204), reported as "m575 written, not applied" rather than a mystery.
 */
export async function setRevenueShareDistributionModel(
  input: RevenueShareModelInput,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveBrokerAdmin("write")
  if (!ctx.ok) return { ok: false, error: ctx.error }

  if (!REVENUE_SHARE_SOURCES.includes(input.sourceOfFunds)) {
    return { ok: false, error: "Source must be 'agent' (a portion of the agent's income) or 'brokerage' (the brokerage pays)." }
  }
  if (!REVENUE_SHARE_RATE_TYPES.includes(input.rateType)) {
    return { ok: false, error: "Rate type must be 'percent' or 'flat'." }
  }
  const percent = input.rateType === "percent" ? Number(input.percent) : null
  const flatCents = input.rateType === "flat" ? Math.floor(Number(input.flatCents)) : null
  if (input.rateType === "percent" && !(Number.isFinite(percent as number) && (percent as number) > 0 && (percent as number) <= 100)) {
    return { ok: false, error: "A percent model needs a share between 0 and 100." }
  }
  if (input.rateType === "flat" && !(Number.isInteger(flatCents as number) && (flatCents as number) > 0)) {
    return { ok: false, error: "A flat model needs a positive amount per closing." }
  }
  const durationMonths = Math.floor(Number(input.durationMonths))
  if (!(Number.isInteger(durationMonths) && durationMonths >= 0)) {
    return { ok: false, error: "Duration must be a number of months (0 = indefinite, chosen explicitly)." }
  }

  const svc = createServiceClient()
  const { data: saved, error } = await svc
    .from("brokerages")
    .update({
      revenue_share_source_of_funds: input.sourceOfFunds,
      revenue_share_rate_type: input.rateType,
      revenue_share_default_percent: percent,
      revenue_share_flat_cents: flatCents,
      revenue_share_duration_months: durationMonths,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ctx.brokerageId)
    .select("id")
  if (error) {
    if ((error as { code?: string }).code === "PGRST204") {
      return { ok: false, error: "The distribution-model columns do not exist yet — migration m575 is written but not applied." }
    }
    return { ok: false, error: error.message }
  }
  if (!saved || saved.length === 0) return { ok: false, error: "The model was not saved — your brokerage record could not be found." }
  return { ok: true }
}
