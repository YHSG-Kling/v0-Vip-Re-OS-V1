/**
 * SMS provider resolution — picks the calling user/team/brokerage's configured
 * SMS provider (Twilio / Telnyx / Bandwidth) and loads its credentials.
 *
 * Resolution cascade (highest precedence first — each agent's own settings
 * win because email/SMS/phone are what the USER uses):
 *   1. provider_overrides (scope='user', provider_type='sms', enabled=true)
 *   2. provider_overrides (scope='team',     ...)
 *   3. provider_overrides (scope='brokerage',...)
 *   4. platform_credentials  (most recent active row for the user)
 *   5. platform_credentials  (most recent active row for the brokerage)
 *   6. Environment fallback (TWILIO_* env vars) — dev only.
 *
 * Throws when no provider is configured — callers must surface to admin.
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
  /** True when we fell through to TWILIO_* env vars rather than per-actor credentials. */
  isEnvFallback: boolean
  credentialId:  string | null
  /** Which scope the resolution landed on (helps debugging). */
  resolvedScope: "user" | "team" | "brokerage" | "env"
}

export interface ResolveSMSContext {
  brokerageId?: string | null
  userId?:      string | null
  teamId?:      string | null
}

async function readOverride(
  scope: "user" | "team" | "brokerage",
  scopeId: string,
): Promise<string | null> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("provider_overrides")
    .select("provider_key")
    .eq("provider_type", "sms")
    .eq("scope_type", scope)
    .eq("scope_id", scopeId)
    .eq("enabled", true)
    .maybeSingle()
  const k = data?.provider_key as string | undefined
  return (k && isSupportedSMSProvider(k)) ? k : null
}

async function readCredential(params: {
  scopeColumn: "agent_user_id" | "brokerage_id"
  scopeId: string
  preferredProvider: string | null
}): Promise<{
  platform: SupportedSMSProvider
  credentials: SMSProviderCredentials
  credentialId: string
} | null> {
  const svc = createServiceClient()
  const q = svc
    .from("platform_credentials")
    .select("id, platform, api_key, account_id, access_token, refresh_token, config")
    .eq(params.scopeColumn, params.scopeId)
    .eq("is_active", true)
    .in("platform", params.preferredProvider ? [params.preferredProvider] : SUPPORTED_SMS_PLATFORMS)
    .order("last_tested_at", { ascending: false, nullsFirst: false })
    .limit(1)
  const { data: cred } = await q.maybeSingle()
  if (!cred || !isSupportedSMSProvider(cred.platform)) return null
  const cfg = (cred.config as Record<string, unknown> | null) ?? {}
  return {
    platform: cred.platform as SupportedSMSProvider,
    credentials: {
      apiKey:     (cred.api_key as string) ?? (cred.access_token as string) ?? "",
      apiSecret:  (cfg.auth_token as string | undefined)
                  ?? (cred.refresh_token as string | undefined)
                  ?? (cfg.api_password as string | undefined),
      fromNumber: (cfg.from_number as string | undefined) ?? (cred.account_id as string | undefined),
      config:     cfg,
    },
    credentialId: cred.id as string,
  }
}

export async function resolveSMSProviderForActor(
  ctx: ResolveSMSContext,
): Promise<ResolvedSMSProvider> {
  // 1. User-scoped override → user-scoped credential
  if (ctx.userId) {
    const userPick = await readOverride("user", ctx.userId)
    const userCred = await readCredential({
      scopeColumn: "agent_user_id",
      scopeId:     ctx.userId,
      preferredProvider: userPick,
    })
    if (userCred) {
      return {
        providerName:  userCred.platform,
        credentials:   userCred.credentials,
        credentialId:  userCred.credentialId,
        isEnvFallback: false,
        resolvedScope: "user",
      }
    }
    if (userPick) {
      // User override declared but no user-scoped credential — fall through to
      // brokerage credentials matching the user's selection.
    }
  }

  // 2. Team-scoped override
  let teamPick: string | null = null
  if (ctx.teamId) {
    teamPick = await readOverride("team", ctx.teamId)
  }

  // 3. Brokerage-scoped override
  let brokeragePick: string | null = null
  if (ctx.brokerageId) {
    brokeragePick = await readOverride("brokerage", ctx.brokerageId)
  }

  const preferredProvider = teamPick ?? brokeragePick ?? null

  // 4. Brokerage-scoped credential (matching the highest-scope override if any)
  if (ctx.brokerageId) {
    const brokCred = await readCredential({
      scopeColumn:       "brokerage_id",
      scopeId:           ctx.brokerageId,
      preferredProvider,
    })
    if (brokCred) {
      return {
        providerName:  brokCred.platform,
        credentials:   brokCred.credentials,
        credentialId:  brokCred.credentialId,
        isEnvFallback: false,
        resolvedScope: teamPick ? "team" : "brokerage",
      }
    }
    if (preferredProvider) {
      throw new Error(
        `Selected '${preferredProvider}' as SMS provider but no active credentials are configured. Add credentials in Settings → Integrations.`
      )
    }
  }

  // 5. Environment fallback — Twilio only
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
      resolvedScope: "env",
    }
  }

  throw new Error("No SMS provider is configured. Add credentials in Settings → Integrations.")
}

/** Backwards-compat wrapper — callers that don't yet have userId context. */
export async function resolveSMSProviderForBrokerage(
  brokerageId: string | null | undefined,
): Promise<ResolvedSMSProvider> {
  return resolveSMSProviderForActor({ brokerageId: brokerageId ?? null })
}

