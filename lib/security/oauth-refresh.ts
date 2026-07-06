// lib/security/oauth-refresh.ts
// ─────────────────────────────────────────────────────────────────────────────
// OAUTH REFRESH RUNNER — turns the credential-rotation MONITOR into rotation AUTOMATION.
// For a credential that is expiring/expired AND carries a refresh_token, this exchanges the
// refresh_token at the provider's token endpoint for a fresh access_token + expiry and writes
// it back — so a Google/Microsoft integration self-heals before it breaks the AI team's outbound.
//
// Two production properties:
//   • PROVIDER-GATED — a refresh only runs when that provider's OAuth client creds are in the env
//     (GOOGLE_OAUTH_CLIENT_ID/SECRET, MICROSOFT_OAUTH_CLIENT_ID/SECRET); otherwise it is skipped,
//     exactly like every other integration seam (no fabricated calls, no test spend).
//   • ENCRYPT-ON-WRITE — the refreshed access_token is written through encryptSecret (at-rest
//     encryption). This is the first safe encrypt-WRITE path: the readers were switched to the
//     backward-compatible decryptSecret first, so an encrypted token is transparently decrypted.

import { createServiceClient } from "@/lib/supabase/service"
import { credentialRotationStatus } from "@/lib/security/credential-rotation"
import { encryptSecret, decryptSecret } from "@/lib/security/secret-crypto"

type Svc = ReturnType<typeof createServiceClient>

/** PURE: should we attempt an automatic refresh? Only when it carries a refresh_token AND is
 *  at/near expiry (no point refreshing a healthy token). */
export function shouldAttemptRefresh(cred: { tokenExpiresAt: string | null; hasRefreshToken: boolean }, now: Date = new Date()): boolean {
  if (!cred.hasRefreshToken) return false
  const s = credentialRotationStatus({ tokenExpiresAt: cred.tokenExpiresAt }, now)
  return s === "expired" || s === "expiring_soon"
}

interface ProviderOAuth { tokenUrl: string; clientId?: string; clientSecret?: string }

/** PURE-ish: resolve the provider's OAuth token endpoint + client creds from env. null = unsupported
 *  or unconfigured (→ skip). */
export function resolveProviderOAuth(provider: string | null): ProviderOAuth | null {
  switch ((provider ?? "").toLowerCase()) {
    case "gmail":
    case "google_calendar":
    case "google":
      return { tokenUrl: "https://oauth2.googleapis.com/token", clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET }
    case "outlook":
    case "microsoft":
      return { tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token", clientId: process.env.MICROSOFT_OAUTH_CLIENT_ID, clientSecret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET }
    default:
      return null
  }
}

export interface RefreshOutcome { id: string; provider: string | null; result: "refreshed" | "skipped_unconfigured" | "skipped_unsupported" | "failed" }

/** Refresh one credential row (from platform_credentials / agent_api_credentials). Provider-gated. */
export async function refreshCredential(
  svc: Svc,
  row: { table: string; id: string; provider: string | null; refresh_token: string | null },
): Promise<RefreshOutcome> {
  const oauth = resolveProviderOAuth(row.provider)
  if (!oauth) return { id: row.id, provider: row.provider, result: "skipped_unsupported" }
  if (!oauth.clientId || !oauth.clientSecret) return { id: row.id, provider: row.provider, result: "skipped_unconfigured" }
  const refreshToken = decryptSecret(row.refresh_token) // decrypt in case the refresh_token is already encrypted
  if (!refreshToken) return { id: row.id, provider: row.provider, result: "failed" }

  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: oauth.clientId, client_secret: oauth.clientSecret })
    const resp = await fetch(oauth.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })
    if (!resp.ok) return { id: row.id, provider: row.provider, result: "failed" }
    const json = (await resp.json()) as { access_token?: string; expires_in?: number; refresh_token?: string }
    if (!json.access_token) return { id: row.id, provider: row.provider, result: "failed" }

    const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString()
    await svc.from(row.table).update({
      // ENCRYPT-ON-WRITE — safe because the readers use decryptSecret (backward-compatible).
      access_token: encryptSecret(json.access_token),
      ...(json.refresh_token ? { refresh_token: encryptSecret(json.refresh_token) } : {}),
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id)
    return { id: row.id, provider: row.provider, result: "refreshed" }
  } catch {
    return { id: row.id, provider: row.provider, result: "failed" }
  }
}

/** Scan expiring credentials with a refresh_token and attempt to refresh each. Cross-tenant. */
export async function runCredentialRefresh(client?: Svc, now: Date = new Date()): Promise<{ attempted: number; refreshed: number; skipped: number; failed: number; outcomes: RefreshOutcome[] }> {
  const svc = client ?? createServiceClient()
  const horizon = new Date(now.getTime() + 7 * 86_400_000).toISOString()
  const outcomes: RefreshOutcome[] = []

  for (const table of ["platform_credentials", "agent_api_credentials", "social_media_accounts", "calendar_provider_accounts"]) {
    const providerCol = table === "agent_api_credentials" ? "service_type" : table === "calendar_provider_accounts" ? "provider" : "platform"
    const { data } = await svc.from(table)
      .select(`id, refresh_token, token_expires_at, ${providerCol}`)
      .not("token_expires_at", "is", null).not("refresh_token", "is", null)
      .lte("token_expires_at", horizon).limit(500)
    for (const r of (data ?? []) as any[]) {
      if (!shouldAttemptRefresh({ tokenExpiresAt: r.token_expires_at, hasRefreshToken: !!r.refresh_token }, now)) continue
      outcomes.push(await refreshCredential(svc, { table, id: r.id, provider: r[providerCol] ?? null, refresh_token: r.refresh_token }))
    }
  }

  return {
    attempted: outcomes.length,
    refreshed: outcomes.filter((o) => o.result === "refreshed").length,
    skipped: outcomes.filter((o) => o.result.startsWith("skipped")).length,
    failed: outcomes.filter((o) => o.result === "failed").length,
    outcomes,
  }
}
