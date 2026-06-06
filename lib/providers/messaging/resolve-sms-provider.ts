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
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
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

/** Map a unified ScopedConnection onto the SMS adapter credential shape. */
function toSMSCredentials(conn: {
  apiKey: string | null; accessToken: string | null; refreshToken: string | null
  accountId: string | null; config: Record<string, unknown>
}): SMSProviderCredentials {
  const cfg = conn.config ?? {}
  return {
    apiKey:     conn.apiKey ?? conn.accessToken ?? "",
    apiSecret:  (cfg.auth_token as string | undefined)
                ?? conn.refreshToken ?? (cfg.api_password as string | undefined),
    fromNumber: (cfg.from_number as string | undefined) ?? conn.accountId ?? undefined,
    config:     cfg,
  }
}

export async function resolveSMSProviderForActor(
  ctx: ResolveSMSContext,
): Promise<ResolvedSMSProvider> {
  // Provider SELECTION (provider_overrides), most-specific scope first. The actual CREDENTIAL
  // read goes through the unified ownership cascade (resolveScopedConnection: agent → team →
  // brokerage → platform, with the legacy connection-manager fallback) so per-tier scoping is
  // resolved in ONE place — this also closes the old gap where a team override had no
  // team-scoped credential read and silently fell back to brokerage.
  const userPick      = ctx.userId      ? await readOverride("user", ctx.userId)            : null
  const teamPick      = ctx.teamId      ? await readOverride("team", ctx.teamId)            : null
  const brokeragePick = ctx.brokerageId ? await readOverride("brokerage", ctx.brokerageId)  : null
  const preferredProvider = userPick ?? teamPick ?? brokeragePick ?? null

  const scopeCtx = {
    agentUserId: ctx.userId ?? null,
    teamId:      ctx.teamId ?? null,
    brokerageId: ctx.brokerageId ?? null,
  }
  const ownerScopeToResolved = (ownerType: string): ResolvedSMSProvider["resolvedScope"] =>
    ownerType === "agent" ? "user" : ownerType === "team" ? "team" : "brokerage"

  // Try the selected provider first; otherwise probe each supported SMS provider in order.
  const providersToTry = preferredProvider ? [preferredProvider] : SUPPORTED_SMS_PLATFORMS
  for (const provider of providersToTry) {
    const conn = await resolveScopedConnection(provider, scopeCtx)
    if (conn && isSupportedSMSProvider(conn.provider)) {
      return {
        providerName:  conn.provider as SupportedSMSProvider,
        credentials:   toSMSCredentials(conn),
        credentialId:  conn.credentialId,
        isEnvFallback: false,
        resolvedScope: ownerScopeToResolved(conn.ownerType),
      }
    }
  }

  if (preferredProvider) {
    throw new Error(
      `Selected '${preferredProvider}' as SMS provider but no active credentials are configured. Add credentials in Settings → Integrations.`
    )
  }

  // Environment fallback — Twilio only
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

