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
  resolvedScope: "user" | "team" | "brokerage" | "platform_managed" | "env"
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

  // PLATFORM-MANAGED tier (the phone-system commercial model, lib/voice/
  // twilio-tenancy.ts): before falling to the shared env number, send from the
  // tenant's OWN provisioned number — the agent's number first, else a
  // brokerage-scoped one — via the tenant's Twilio creds (BYO → subaccount →
  // master). SMS from the number the contact recognizes, zero tenant setup.
  if (ctx.brokerageId) {
    const svc = createServiceClient()
    const { data: numbers } = await svc
      .from("tenant_phone_numbers")
      .select("phone_number, agent_user_id, scope_type")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("is_active", true)
      .limit(20)
    const list = (numbers ?? []) as Array<{ phone_number: string | null; agent_user_id: string | null; scope_type: string | null }>
    const own = ctx.userId ? list.find((n) => n.agent_user_id === ctx.userId) : null
    const shared = list.find((n) => n.scope_type === "brokerage")
    const num = own ?? shared ?? null
    if (num?.phone_number) {
      const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
      const creds = await resolveTenantTwilioCreds(svc, ctx.brokerageId)
      if (creds) {
        return {
          providerName: "twilio",
          credentials: { apiKey: creds.accountSid, apiSecret: creds.authToken, fromNumber: num.phone_number },
          isEnvFallback: false,
          credentialId: null,
          resolvedScope: "platform_managed",
        }
      }
    }
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

// ─── `resolveSMSProviderForBrokerage` — DELETED (wave 8) ─────────────────────
// SURVIVOR: resolveSMSProviderForActor, immediately above (this same file).
//
// It was a pure delegation wrapper — its entire body was
// `return resolveSMSProviderForActor({ brokerageId: brokerageId ?? null })` —
// introduced as a "backwards-compat wrapper for callers that don't yet have
// userId context". There were no such callers anywhere in the tree, and there
// is nothing for a caller to gain by going through it: ResolveSMSContext's
// fields are ALL optional, so `resolveSMSProviderForActor({ brokerageId })` is
// the same call with the same cascade, one less indirection, and the option of
// adding userId/teamId later without changing function.
//
// NOTHING TO MERGE, verified rather than assumed: the wrapper narrowed the
// context and added no branch, no fallback and no error handling of its own —
// the brokerage tier, the platform-managed tenant-number tier and the env
// fallback all live in the survivor and are reached identically either way.

