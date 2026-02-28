// lib/kernel/providers.ts
// LAYER 0 — provider resolution for the platform.
// Cascades through: user → team → brokerage → superadmin → system default.
// direct_mail and video bypass the cascade and return system defaults immediately.
// No side effects. Read-only.

import { createClient } from "@/lib/supabase/server"
import type { ProviderType } from "./types"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface ResolveProviderParams {
  providerType: string
  actorContext: {
    userId: string
    brokerageId: string
    teamId?: string
  }
}

export interface ResolvedProvider {
  providerKey: string
  config: Record<string, any>
}

// ─── SYSTEM DEFAULTS ──────────────────────────────────────────────────────────
// direct_mail and video are system-only — no per-user/team/brokerage overrides.

const SYSTEM_DEFAULTS: Record<string, string> = {
  email:        "sendgrid",
  sms:          "twilio",
  social:       "buffer",
  phone:        "twilio",
  calendar:     "google",
  payment:      "stripe",
  esign:        "dotloop",
  transaction:  "dotloop",
  ai:           "anthropic",
  direct_mail:  "lob",
  video:        "heygen",
}

// Types that are locked to the system default — no override cascade.
const SYSTEM_ONLY_TYPES = new Set(["direct_mail", "video"])

// ─── RESOLVE PROVIDER ─────────────────────────────────────────────────────────

export async function resolveProvider(
  params: ResolveProviderParams
): Promise<ResolvedProvider> {
  const { providerType, actorContext } = params
  const systemDefault = SYSTEM_DEFAULTS[providerType] ?? providerType

  // direct_mail and video skip the override cascade entirely.
  if (SYSTEM_ONLY_TYPES.has(providerType)) {
    return { providerKey: systemDefault, config: {} }
  }

  const supabase = await createClient()

  // ── 1. User personal override ─────────────────────────────────────────────
  const { data: userOverride } = await supabase
    .from("provider_overrides")
    .select("provider_key, config")
    .eq("provider_type", providerType)
    .eq("scope_type", "user")
    .eq("scope_id", actorContext.userId)
    .eq("enabled", true)
    .maybeSingle()

  if (userOverride) {
    return {
      providerKey: userOverride.provider_key,
      config: (userOverride.config as Record<string, any>) ?? {},
    }
  }

  // ── 2. Team override ──────────────────────────────────────────────────────
  if (actorContext.teamId) {
    const { data: teamOverride } = await supabase
      .from("provider_overrides")
      .select("provider_key, config")
      .eq("provider_type", providerType)
      .eq("scope_type", "team")
      .eq("scope_id", actorContext.teamId)
      .eq("enabled", true)
      .maybeSingle()

    if (teamOverride) {
      return {
        providerKey: teamOverride.provider_key,
        config: (teamOverride.config as Record<string, any>) ?? {},
      }
    }
  }

  // ── 3. Brokerage override ─────────────────────────────────────────────────
  const { data: brokerageOverride } = await supabase
    .from("provider_overrides")
    .select("provider_key, config")
    .eq("provider_type", providerType)
    .eq("scope_type", "brokerage")
    .eq("scope_id", actorContext.brokerageId)
    .eq("enabled", true)
    .maybeSingle()

  if (brokerageOverride) {
    return {
      providerKey: brokerageOverride.provider_key,
      config: (brokerageOverride.config as Record<string, any>) ?? {},
    }
  }

  // ── 4. Superadmin override ────────────────────────────────────────────────
  // scope_type='superadmin' rows have no scoped UUID — match on type alone.
  const { data: superadminOverride } = await supabase
    .from("provider_overrides")
    .select("provider_key, config")
    .eq("provider_type", providerType)
    .eq("scope_type", "superadmin")
    .eq("enabled", true)
    .maybeSingle()

  if (superadminOverride) {
    return {
      providerKey: superadminOverride.provider_key,
      config: (superadminOverride.config as Record<string, any>) ?? {},
    }
  }

  // ── 5. System default ─────────────────────────────────────────────────────
  return { providerKey: systemDefault, config: {} }
}
