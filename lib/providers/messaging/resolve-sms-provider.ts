/**
 * SMS provider resolution — picks the brokerage's configured SMS provider
 * (Twilio / Telnyx / Bandwidth) and loads its credentials.
 *
 * Resolution order:
 *   1. provider_overrides (scope='brokerage', provider_type='sms', enabled=true)
 *   2. platform_credentials (most recent active row whose platform is a
 *      supported SMS provider)
 *   3. Environment fallback (TWILIO_* env vars) — only used in dev / before
 *      a brokerage has set up its own credentials.
 *
 * Throws clear errors when no provider is configured — callers must surface
 * to the admin instead of silently falling through to a hardcoded provider.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import {
  isSupportedSMSProvider,
  type SupportedSMSProvider,
  type SMSProviderCredentials,
} from "./sms-adapters"

const SUPPORTED_SMS_PLATFORMS = ["twilio", "telnyx", "bandwidth"]

export interface ResolvedSMSProvider {
  providerName: SupportedSMSProvider
  credentials:  SMSProviderCredentials
  /** True when we fell through to TWILIO_* env vars rather than per-brokerage credentials. */
  isEnvFallback: boolean
  credentialId:  string | null
}

export async function resolveSMSProviderForBrokerage(
  brokerageId: string | null | undefined,
): Promise<ResolvedSMSProvider> {
  const svc = createServiceClient()
  let preferredProvider: string | null = null

  // 1. Brokerage-scoped override
  if (brokerageId) {
    const { data: override } = await svc
      .from("provider_overrides")
      .select("provider_key")
      .eq("provider_type", "sms")
      .eq("scope_type", "brokerage")
      .eq("scope_id", brokerageId)
      .eq("enabled", true)
      .maybeSingle()
    if (override?.provider_key && isSupportedSMSProvider(override.provider_key)) {
      preferredProvider = override.provider_key
    }
  }

  // 2. platform_credentials (filter by preferredProvider if known)
  if (brokerageId) {
    let q = svc
      .from("platform_credentials")
      .select("id, platform, api_key, account_id, access_token, refresh_token, config")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .in("platform", preferredProvider ? [preferredProvider] : SUPPORTED_SMS_PLATFORMS)
      .order("last_tested_at", { ascending: false, nullsFirst: false })
      .limit(1)
    const { data: cred } = await q.maybeSingle()
    if (cred && isSupportedSMSProvider(cred.platform)) {
      const cfg = (cred.config as Record<string, unknown> | null) ?? {}
      return {
        providerName: cred.platform as SupportedSMSProvider,
        credentials: {
          apiKey:     (cred.api_key as string) ?? (cred.access_token as string) ?? "",
          apiSecret:  (cfg.auth_token as string | undefined)
                      ?? (cred.refresh_token as string | undefined)
                      ?? (cfg.api_password as string | undefined),
          fromNumber: (cfg.from_number as string | undefined) ?? (cred.account_id as string | undefined),
          config:     cfg,
        },
        isEnvFallback: false,
        credentialId:  cred.id as string,
      }
    }
    if (preferredProvider) {
      // Override said e.g. telnyx but no active credential found — fail loudly
      throw new Error(
        `Brokerage selected '${preferredProvider}' as SMS provider but no active credentials are configured. Add credentials in Settings → Integrations.`
      )
    }
  }

  // 3. Environment fallback — Twilio only (only the env vars exist for dev)
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    return {
      providerName: "twilio",
      credentials: {
        apiKey:     process.env.TWILIO_ACCOUNT_SID,
        apiSecret:  process.env.TWILIO_AUTH_TOKEN,
        fromNumber: process.env.TWILIO_PHONE_NUMBER,
      },
      isEnvFallback: true,
      credentialId:  null,
    }
  }

  throw new Error("No SMS provider is configured. Add credentials in Settings → Integrations.")
}
