// lib/kernel/override-vocab.ts
//
// CANONICAL feature_access_overrides.override_type vocabulary. The table's CHECK constraint enforces
// ('grant_trial' | 'disable') — the vocabulary used by the billing entitlement engine (lib/kernel/billing.ts).
// A second engine (lib/kernel/0.1-feature-access.ts) historically used ('trial' | 'disabled'), which the
// CHECK REJECTS on write and which never matches billing's rows on read — so an override granted by one
// engine was invisible (or failed) in the other. This is the single source of truth that reconciles them:
// WRITE canonical ('grant_trial'/'disable'); READ tolerant of both legacy spellings.

export type OverrideKind = "grant_trial" | "disable"

/** PURE: fold any historical override_type spelling onto the canonical, DB-valid value (null if unknown). */
export function normalizeOverrideType(raw: string | null | undefined): OverrideKind | null {
  switch ((raw ?? "").toLowerCase()) {
    case "grant_trial":
    case "trial":
      return "grant_trial"
    case "disable":
    case "disabled":
      return "disable"
    default:
      return null
  }
}

export const isTrialOverride = (raw: string | null | undefined): boolean => normalizeOverrideType(raw) === "grant_trial"
export const isDisableOverride = (raw: string | null | undefined): boolean => normalizeOverrideType(raw) === "disable"
