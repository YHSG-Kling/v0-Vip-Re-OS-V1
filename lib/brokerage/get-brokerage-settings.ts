/**
 * SYSTEM 7.2 — Brokerage Settings Resolver
 *
 * Central authority for ALL brokerage configuration.
 *
 * Rules:
 * - No system may read global_settings.additional_settings directly
 * - All configuration access must go through this resolver
 * - No hardcoded state fallbacks — primary_state must be explicitly configured
 * - No hardcoded commission rates — commission_structures table owns those
 * - No hardcoded provider names — all routing is settings-driven
 * - Uses createServiceClient() to bypass RLS (infrastructure-level read)
 * - All getters require brokerageId — this is a multi-tenant platform
 */

import { createServiceClient } from "@/lib/supabase/service"

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type TransactionProvider =
  | "dotloop"
  | "skyslope"
  | "formsimplicity"
  | "brokermint"

export type TransactionMode =
  | "hybrid"
  | "external_full"
  | "internal_full"

export type AuthorityMode =
  | "internal"
  | "provider"

export type AccountingProvider =
  | "internal"
  | "quickbooks"
  | "xero"
  | "none"

export type ClosingEntityType =
  | "title_company"
  | "escrow_company"
  | "attorney"

export interface ComplianceLevels {
  /** Federal compliance (RESPA, TRID, Fair Housing, ECOA) — always recommended true */
  federal: boolean
  /** Which federal rule sets to run */
  federal_rules: string[]
  /** Whether to run state-level compliance checks */
  state: boolean
  /**
   * Primary state code for compliance rules.
   * NULL until explicitly configured — no silent fallback to any state.
   * State compliance is disabled if this is null.
   */
  state_code: string | null
  /** Additional states for multi-state brokerages */
  additional_state_codes: string[]
  /** Whether to run brokerage-specific custom rules from compliance_rules table */
  custom_rules_enabled: boolean
}

export interface PipelineSettings {
  /** Hours until offer expires after submission (default: 48) */
  offer_expiration_hours: number
  /** Days of no activity before stale warning (default: 7) */
  stale_lead_warning_days: number
  /** Days of no activity before stale critical alert (default: 14) */
  stale_lead_critical_days: number
  /** Hours for buyer financial verification SLA (default: 48) */
  financial_verification_sla_hours: number
  /** Hours to schedule first tour after tour eligibility (default: 72) */
  first_tour_sla_hours: number
  /** Hours to submit offer after offer eligibility (default: 168 = 7 days) */
  offer_submission_sla_hours: number
  /** Hours before escalating missing Closing Disclosure to compliance (default: 24) */
  cd_receipt_escalation_hours: number
}

export interface FinancialDefaults {
  /**
   * Property tax rate as decimal (e.g. 0.0125 = 1.25%).
   * Should be set to the brokerage's primary market rate.
   */
  property_tax_rate: number
  /** Default seller concession assumption for net sheet (e.g. 0.02 = 2%) */
  default_seller_concession_percent: number
  /** Default moving cost estimate in dollars */
  default_moving_cost: number
  /** PMI rate as decimal (e.g. 0.005 = 0.5% annually) */
  pmi_rate: number
  /** LTV threshold below which PMI is not required (e.g. 0.80 = 80%) */
  pmi_threshold_percent: number
}

export interface BrokerageSettings {
  // ── Transaction Provider ─────────────────────────────────
  transaction_provider: TransactionProvider
  transaction_mode: TransactionMode
  compliance_authority: AuthorityMode
  commission_authority: AuthorityMode
  accounting_authority: AuthorityMode

  // ── Accounting ───────────────────────────────────────────
  accounting_provider: AccountingProvider

  // ── Geography & Closing ──────────────────────────────────
  /**
   * The brokerage's primary operating state (ISO 2-letter code).
   * NULL until explicitly configured in brokerage setup.
   * Must be set before state compliance or state forms can run.
   */
  primary_state: string | null

  /**
   * primary_timezone:
   * IANA timezone string (e.g., 'America/New_York').
   * Used by Kernel Calendar Spine for date conversion.
   * Defaults to 'UTC' if not configured.
   */
  primary_timezone?: string

  /** Whether closing is handled by title company, escrow, or attorney */
  closing_entity_type: ClosingEntityType

  // ── Sub-configurations ───────────────────────────────────
  compliance_levels: ComplianceLevels
  pipeline_settings: PipelineSettings
  financial_defaults: FinancialDefaults
}

// ─────────────────────────────────────────────────────────────
// Safe Defaults
//
// Used ONLY when global_settings has no additional_settings row.
// These are structural fallbacks, not business defaults.
// primary_state is intentionally null — must be configured.
// ─────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: BrokerageSettings = {
  transaction_provider: "dotloop",
  transaction_mode: "hybrid",
  compliance_authority: "internal",
  commission_authority: "internal",
  accounting_authority: "internal",
  accounting_provider: "internal",

  // ── No state fallback — null forces explicit setup ────────
  primary_state: null,
  primary_timezone: 'UTC',
  closing_entity_type: "title_company",

  compliance_levels: {
    federal: true,
    federal_rules: ["RESPA", "TRID", "fair_housing", "ECOA"],
    // State compliance is OFF until state_code is configured
    state: false,
    state_code: null,
    additional_state_codes: [],
    custom_rules_enabled: false,
  },

  pipeline_settings: {
    offer_expiration_hours: 48,
    stale_lead_warning_days: 7,
    stale_lead_critical_days: 14,
    financial_verification_sla_hours: 48,
    first_tour_sla_hours: 72,
    offer_submission_sla_hours: 168,
    cd_receipt_escalation_hours: 24,
  },

  financial_defaults: {
    property_tax_rate: 0.0125,
    default_seller_concession_percent: 0.02,
    default_moving_cost: 2000,
    pmi_rate: 0.005,
    pmi_threshold_percent: 0.80,
  },
}

// ─────────────────────────────────────────────────────────────
// Core Resolver
// ─────────────────────────────────────────────────────────────

/**
 * Load brokerage settings for the given brokerageId.
 *
 * Uses createServiceClient() — bypasses RLS for infrastructure reads.
 * Deep-merges DB values over defaults so partial configs are safe.
 *
 * @param brokerageId - UUID of the brokerage to load settings for
 */
export async function getBrokerageSettings(
  brokerageId: string
): Promise<BrokerageSettings> {
  if (!brokerageId) {
    console.warn("[settings-resolver] No brokerageId provided — using DEFAULT_SETTINGS")
    return DEFAULT_SETTINGS
  }

  // Service client — bypasses RLS, no session required
  // Safe for server actions, background jobs, webhooks, and cron
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", brokerageId)
    .single()

  if (error || !data?.additional_settings) {
    console.warn(
      `[settings-resolver] No additional_settings found for brokerage ${brokerageId} — using DEFAULT_SETTINGS`
    )
    return DEFAULT_SETTINGS
  }

  const raw = data.additional_settings

  // Deep merge: DB values override defaults, nested objects merged independently
  // This ensures a partial config (e.g. only pipeline_settings set) still
  // returns safe defaults for all other keys
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    primary_timezone: raw.primary_timezone || 'UTC',
    compliance_levels: {
      ...DEFAULT_SETTINGS.compliance_levels,
      ...(raw.compliance_levels ?? {}),
    },
    pipeline_settings: {
      ...DEFAULT_SETTINGS.pipeline_settings,
      ...(raw.pipeline_settings ?? {}),
    },
    financial_defaults: {
      ...DEFAULT_SETTINGS.financial_defaults,
      ...(raw.financial_defaults ?? {}),
    },
  }
}

// ─────────────────────────────────────────────────────────────
// Strongly Typed Getters
//
// Every system must use these — never read additional_settings directly.
// All getters require brokerageId (multi-tenant platform).
// ─────────────────────────────────────────────────────────────

/** Which transaction management provider this brokerage uses */
export async function getTransactionProvider(
  brokerageId: string
): Promise<TransactionProvider> {
  return (await getBrokerageSettings(brokerageId)).transaction_provider
}

/** How deeply the provider is integrated (hybrid / external_full / internal_full) */
export async function getTransactionMode(
  brokerageId: string
): Promise<TransactionMode> {
  return (await getBrokerageSettings(brokerageId)).transaction_mode
}

/** Which accounting system to push commission data to */
export async function getAccountingProvider(
  brokerageId: string
): Promise<AccountingProvider> {
  return (await getBrokerageSettings(brokerageId)).accounting_provider
}

/**
 * The brokerage's primary operating state.
 *
 * Returns null if not configured — callers must guard:
 *   const state = await getPrimaryState(brokerageId)
 *   if (!state) throw new Error("Brokerage primary_state not configured")
 */
export async function getPrimaryState(
  brokerageId: string
): Promise<string | null> {
  return (await getBrokerageSettings(brokerageId)).primary_state
}

/**
 * The primary operating state with a hard guard.
 * Use this when state is required and absence is a fatal error.
 */
export async function getRequiredPrimaryState(
  brokerageId: string
): Promise<string> {
  const state = await getPrimaryState(brokerageId)
  if (!state) {
    throw new Error(
      `[settings-resolver] Brokerage ${brokerageId} has no primary_state configured. ` +
      `Set primary_state in global_settings.additional_settings before running state-dependent operations.`
    )
  }
  return state
}

/** Whether closing is handled by title company, escrow, or attorney */
export async function getClosingEntityType(
  brokerageId: string
): Promise<ClosingEntityType> {
  return (await getBrokerageSettings(brokerageId)).closing_entity_type
}

/** Full compliance configuration including federal, state, and custom levels */
export async function getComplianceLevels(
  brokerageId: string
): Promise<ComplianceLevels> {
  return (await getBrokerageSettings(brokerageId)).compliance_levels
}

/** SLA windows and escalation thresholds for the lead and transaction pipeline */
export async function getPipelineSettings(
  brokerageId: string
): Promise<PipelineSettings> {
  return (await getBrokerageSettings(brokerageId)).pipeline_settings
}

/** Financial calculation defaults for calculators, net sheets, and projections */
export async function getFinancialDefaults(
  brokerageId: string
): Promise<FinancialDefaults> {
  return (await getBrokerageSettings(brokerageId)).financial_defaults
}

/** Authority routing: is compliance handled internally or by the provider? */
export async function getComplianceAuthority(
  brokerageId: string
): Promise<AuthorityMode> {
  return (await getBrokerageSettings(brokerageId)).compliance_authority
}

/** Authority routing: is commission calculation handled internally or by the provider? */
export async function getCommissionAuthority(
  brokerageId: string
): Promise<AuthorityMode> {
  return (await getBrokerageSettings(brokerageId)).commission_authority
}

/** Authority routing: is accounting export handled internally or by the provider? */
export async function getAccountingAuthority(
  brokerageId: string
): Promise<AuthorityMode> {
  return (await getBrokerageSettings(brokerageId)).accounting_authority
}

// ─────────────────────────────────────────────────────────────
// Specific Pipeline Setting Getters
// ─────────────────────────────────────────────────────────────

/** Get offer expiration hours from pipeline settings */
export async function getOfferExpirationHours(
  brokerageId: string
): Promise<number> {
  const settings = await getPipelineSettings(brokerageId)
  return settings.offer_expiration_hours
}

/** Get stale lead warning threshold in days */
export async function getStaleLeadWarningDays(
  brokerageId: string
): Promise<number> {
  const settings = await getPipelineSettings(brokerageId)
  return settings.stale_lead_warning_days
}

/** Get financial verification SLA in hours */
export async function getFinancialVerificationSLAHours(
  brokerageId: string
): Promise<number> {
  const settings = await getPipelineSettings(brokerageId)
  return settings.financial_verification_sla_hours
}

// ─────────────────────────────────────────────────────────────
// Convenience: Load Full Settings Once, Destructure Locally
//
// Use this pattern in files that need multiple settings values
// to avoid making N separate async calls:
//
//   const settings = await getBrokerageSettings(brokerageId)
//   const { closing_entity_type, compliance_levels, pipeline_settings } = settings
//
// ─────────────────────────────────────────────────────────────
