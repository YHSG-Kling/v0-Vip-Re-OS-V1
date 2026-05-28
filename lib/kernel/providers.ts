// lib/kernel/providers.ts
// LAYER 0 — provider resolution for the platform. Two tiers:
//
//   • PLATFORM (system-only): one vendor for the whole app, owned by the
//     platform. Superadmin may override the single vendor; there are NO
//     user/team/brokerage overrides. Per-agent ASSETS (avatar id, cloned
//     voice id) are applied downstream — only the VENDOR is platform-locked.
//     Types: ai, video, avatar, voice_clone, ai_voice, direct_mail.
//
//   • PER-TENANT (cascade): user → team → brokerage → superadmin → system
//     default. BYO credentials. Types: transaction, esign, email, sms, phone,
//     calendar, crm, accounting, social, payment.
//
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
// The vendor used when no override applies. For PLATFORM types this is the
// platform-primary vendor (superadmin can override it); for PER-TENANT types
// it is the fallback when a tenant has not connected their own.

const SYSTEM_DEFAULTS: Record<string, string> = {
  // Per-tenant (BYO via cascade)
  email:        "sendgrid",
  sms:          "twilio",
  phone:        "twilio",
  social:       "buffer",
  calendar:     "google",
  payment:      "stripe",
  esign:        "dotloop",
  transaction:  "dotloop",
  crm:          "follow_up_boss",
  accounting:   "quickbooks",
  idx:          "idxbroker",   // IDX/MLS feed — subscriber connects their own
  // Platform (system-only). D-ID is the platform-primary video/avatar engine.
  ai:           "anthropic",
  video:        "did",
  avatar:       "did",
  voice_clone:  "elevenlabs",
  ai_voice:     "vapi",
  direct_mail:  "lob",
  scraper:      "apify",       // lead-source scraping — platform-funded keys
  enrichment:   "peopledata",  // skip-trace / contact enrichment — platform-funded
}

// Platform tier — locked to a single vendor chosen by the platform. No
// per-user/team/brokerage overrides; superadmin may swap the vendor.
//
// NOTE on `ai`: this governs the AI *vendor* (the platform AI gateway). It is a
// DIFFERENT axis from AI *model selection*. `resolveAIModel` (lib/kernel/
// ai-model.ts) legitimately routes/caps the model TIER per brokerage/team/user
// for cost governance — that operates within this single platform vendor and is
// not a vendor override, so it does not conflict with `ai` being system-only.
const SYSTEM_ONLY_TYPES = new Set([
  "ai",
  "video",
  "avatar",
  "voice_clone",
  "ai_voice",
  "direct_mail",
  "scraper",
  "enrichment",
])

// ─── RESOLVE PROVIDER ─────────────────────────────────────────────────────────

export async function resolveProvider(
  params: ResolveProviderParams
): Promise<ResolvedProvider> {
  const { providerType, actorContext } = params
  const systemDefault = SYSTEM_DEFAULTS[providerType] ?? providerType

  const supabase = await createClient()

  // Platform tier: superadmin override (single vendor for the whole app) or
  // the system default. The per-user/team/brokerage cascade does not apply.
  if (SYSTEM_ONLY_TYPES.has(providerType)) {
    const { data: platformOverride } = await supabase
      .from("provider_overrides")
      .select("provider_key, config")
      .eq("provider_type", providerType)
      .eq("scope_type", "superadmin")
      .eq("enabled", true)
      .maybeSingle()

    if (platformOverride) {
      return {
        providerKey: platformOverride.provider_key,
        config: (platformOverride.config as Record<string, any>) ?? {},
      }
    }
    return { providerKey: systemDefault, config: {} }
  }

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
