// lib/providers/meta/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE META (Facebook/Instagram/WhatsApp Graph + Marketing API) SERVER
// ADAPTER (wave 71A, owner ruling: "for any of our providers for platform, if
// there is an sdk option, we should use that… keeping pricing in mind"). Meta's
// official Node SDK is `facebook-nodejs-business-sdk` (not previously installed
// — every graph.facebook.com call site hand-built the request through the
// connector gateway or a raw `fetch`). The SDK does not change per-call price
// (same Graph endpoints, same usage) — it removes the hand-built URL/query
// construction every call site repeated.
//
// GENERIC, NOT ENTITY-TYPED. facebook-nodejs-business-sdk ships typed classes
// (Page, Post, Campaign, AdAccount, CustomAudience, …) built on ONE underlying
// transport: `FacebookAdsApi.call(method, pathSegments, params)`. The 20-odd
// call sites this wave migrates span page posts, IG media containers,
// Messenger/IG DM send, engagement-metric reads, lead-ad reads, Custom
// Audience upload, and Marketing API campaign/adset/ad/insights calls across 8
// files with very different existing request shapes. Re-deriving each as a
// distinct typed SDK object (Page().createFeed(), CustomAudience().createUsers(),
// …) would multiply the surface for no functional gain — `api.call()` IS the
// SDK's own transport underneath every typed class, so calling it directly is
// still "adopting the SDK": every request leaves through the same official
// HTTP client the typed classes use (Http/axios inside the package, request
// signing, FacebookRequestError normalization), not a hand-rolled fetch.
//
// VERSION NOTE. The SDK pins Graph API v24.0 (`FacebookAdsApi.VERSION`); the
// call sites this replaces were pinned to v18.0/v19.0 (raw REST, hand-typed).
// Graph API versions are additive/back-compatible for the fields this repo
// reads and writes (feed/photos/media/messages/insights/customaudiences), and
// SDKs do not change price — riding the SDK's own current version is the
// intended behavior, not a side effect to work around. Recorded in
// docs/provider-matrix-2026-09.md.
//
// NOT MIGRATED, ON PURPOSE (see docs/provider-matrix-2026-09.md for the full
// list): OAuth AUTHORIZATION-CODE exchange and the long-lived
// `fb_exchange_token` EXCHANGE stay on REST. The Business SDK has no OAuth
// token-exchange method — `FacebookAdsApi` always requires an access token to
// construct (`new FacebookAdsApi(accessToken)`), so it cannot express the
// call that MINTS the first token, and the generic `api.call()` transport adds
// nothing over the existing connector-gateway POST for that one shape. Kept:
// lib/social/token-refresh.ts (fb_exchange_token sweep), lib/social/oauth-
// config.ts (pure config, no live call site), lib/platform/platform-
// social.ts::exchangeMetaLongLivedToken, and the shared multi-provider
// authorization-code exchange in app/api/integrations/oauth/[provider]/route.ts
// (shared with google/microsoft/docusign/quickbooks/xero/google_ads/zoom —
// not Meta-specific code).
//
// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled (see lib/providers/apify/client.ts for the fuller
// version of this note).
// Types come from types/facebook-nodejs-business-sdk.d.ts (the package ships
// none of its own — see that file's header).
import { FacebookAdsApi } from "facebook-nodejs-business-sdk"

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

// NO per-token cache: FacebookAdsApi instances are cheap (no connection pooling
// of their own — Http/axios does that per-call), and every caller here hands a
// DIFFERENT tenant's or the platform's own access token; caching by token would
// only add a Map to prune, never save real work.
function api(accessToken: string) {
  return new FacebookAdsApi(accessToken)
}

function mapError(err: unknown): AdapterResult<any> {
  // FacebookRequestError (src/exceptions.js): .status, .message, .response (body).
  const e = err as { status?: number; message?: string; response?: unknown }
  return {
    ok: false,
    status: typeof e?.status === "number" ? e.status : null,
    data: null,
    error: e?.message ?? "Meta Graph request failed",
  }
}

export type MetaPathSegments = Array<string | number>

/** GET through the Graph SDK. `pathSegments` become
 *  `https://graph.facebook.com/<VERSION>/<segments>`; `access_token` is
 *  appended to the query by the SDK itself, `params` merges into the same
 *  query — the SDK equivalent of the old connector-gateway `{style:"query",
 *  name:"access_token"}` / `{style:"bearer"}` auth shapes every migrated GET
 *  call site used (Graph accepts the token either way; the SDK only expresses
 *  the query-param form). */
export async function graphGet<T = any>(
  accessToken: string,
  pathSegments: MetaPathSegments,
  params: Record<string, unknown> = {},
): Promise<AdapterResult<T>> {
  if (!accessToken) return { ok: false, status: null, data: null, error: "unconfigured: no Meta access token" }
  try {
    const data = await api(accessToken).call("GET", pathSegments, params)
    return { ok: true, status: 200, data: data as T, error: null }
  } catch (err) {
    return mapError(err)
  }
}

/** POST through the Graph SDK. `body` becomes the request data (JSON-encoded
 *  by the SDK's own transport); `access_token` still rides the URL query,
 *  matching the old connector-gateway JSON-body POSTs every migrated write
 *  call site used. */
export async function graphPost<T = any>(
  accessToken: string,
  pathSegments: MetaPathSegments,
  body: Record<string, unknown> = {},
): Promise<AdapterResult<T>> {
  if (!accessToken) return { ok: false, status: null, data: null, error: "unconfigured: no Meta access token" }
  try {
    const data = await api(accessToken).call("POST", pathSegments, body)
    return { ok: true, status: 200, data: data as T, error: null }
  } catch (err) {
    return mapError(err)
  }
}
