// lib/providers/quickbooks/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE QUICKBOOKS (INTUIT) OAUTH ADAPTER (wave 71A, owner ruling: "for any
// of our providers for platform, if there is an sdk option, we should use
// that… keeping pricing in mind"). Intuit's ONLY official Node package is
// `intuit-oauth` (OAuth 2.0 / OpenID Connect: authorize URL, token exchange,
// refresh, revoke) — verified against the npm registry and Intuit's own
// developer docs. `node-quickbooks` (the accounting-object REST wrapper —
// customer/invoice/purchase/journal-entry create, company info) is a
// COMMUNITY package (Michael Cohen), not published by Intuit, so it is
// DECLINED under the official-SDK ruling: it was installed to verify its API
// shape, then uninstalled once intuit-oauth's split (token lifecycle only)
// was confirmed as the correct one. There is no official Intuit accounting
// SDK for Node — the QBO business-object calls in
// lib/providers/accounting/quickbooks.ts's `request()` and
// lib/connections/accounting-scopes.ts's `qboRequest()` stay on the
// connector-gateway REST path, documented there with this same reasoning.
//
// SCOPE — token REFRESH only (grant_type=refresh_token). This repo's OAuth
// CODE exchange (grant_type=authorization_code, the initial connect) lives in
// the shared multi-provider handler at
// app/api/integrations/oauth/[provider]/route.ts, which is NOT QuickBooks-
// specific code (shared with google/microsoft/docusign/xero/…) and stays REST
// for that reason, same as the Meta OAuth code-exchange carve-out.
//
// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled (see lib/providers/apify/client.ts for the fuller
// version of this note).
import OAuthClient from "intuit-oauth"

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

export interface RefreshedQuickBooksTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  xRefreshTokenExpiresIn: number | null
}

function mapError(err: unknown): AdapterResult<any> {
  // OAuthClient rejects with an OAuthError/TokenError carrying `.originalMessage`
  // (set by createError) or a plain `.message`; status is not reliably exposed
  // on every rejection shape, so it is left null rather than guessed.
  const e = err as { originalMessage?: string; message?: string }
  return {
    ok: false,
    status: null,
    data: null,
    error: e?.originalMessage ?? e?.message ?? "QuickBooks token refresh failed",
  }
}

/** `POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`
 *  (grant_type=refresh_token) — the SDK equivalent of the hand-built Basic-
 *  auth form POST both quickbooks.ts::refreshAccessToken and accounting-
 *  scopes.ts::ensureFreshQuickBooksToken used. `environment` only changes
 *  which host the SDK targets for the AUTHORIZE step; refreshUsingToken always
 *  hits the one production token endpoint regardless, so "production" is safe
 *  here even for a caller that connected in a QBO sandbox company. */
export async function refreshQuickBooksToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<AdapterResult<RefreshedQuickBooksTokens>> {
  if (!clientId || !clientSecret) return { ok: false, status: null, data: null, error: "unconfigured: QuickBooks app credentials missing" }
  if (!refreshToken) return { ok: false, status: null, data: null, error: "unconfigured: no QuickBooks refresh token" }
  try {
    const oauthClient = new OAuthClient({ environment: "production", clientId, clientSecret, redirectUri: "" })
    const authResponse = await oauthClient.refreshUsingToken(refreshToken)
    const json = authResponse.getJson() as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      x_refresh_token_expires_in?: number
    }
    if (!json?.access_token || !json?.refresh_token) {
      return { ok: false, status: null, data: null, error: "QuickBooks refresh response carried no token" }
    }
    return {
      ok: true,
      status: 200,
      data: {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresIn: json.expires_in ?? 3600,
        xRefreshTokenExpiresIn: json.x_refresh_token_expires_in ?? null,
      },
      error: null,
    }
  } catch (err) {
    return mapError(err)
  }
}
