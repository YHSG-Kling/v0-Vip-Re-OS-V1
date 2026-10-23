// lib/providers/zenrows/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ZENROWS SERVER ADAPTER (wave 70B, owner ruling: "if there is an sdk
// option, we should use that... keeping pricing in mind"). ZenRows' official
// Node SDK is `zenrows` (not previously installed — lib/external/zenrows-
// client.ts::scrapeWithZenRows hand-built the GET request through the
// connector gateway). The SDK does not change price (same credit-per-request
// billing) — it removes the hand-built query-string mapping.
//
// The SDK's `fetch()` returns the raw `Response`, exactly like the gateway's
// `responseType: "text"` mode did — callers still read `.text()` themselves.

// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled. A static import of this adapter from a file a proof
// script statically reaches (e.g. lib/external/apify-client.ts from
// lib/platform/provider-posture.ts's chain) would crash that proof for a
// directive with no live client-bundling risk to guard against here.
import { ZenRows } from "zenrows"

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

// NO per-key cache: the SDK binds `fetch` (via fetch-retry) when the client is
// CONSTRUCTED, so a cached instance pins whatever global fetch existed at first
// use — under a proof's fetch mock, or a runtime that patches fetch later, every
// later call would silently reuse the stale transport. Construction is cheap.
function client(apiKey: string): ZenRows {
  return new ZenRows(apiKey)
}

export interface ScrapeParams {
  jsRender?: boolean
  premiumProxy?: boolean
  waitFor?: "networkidle" | "domcontentloaded"
  customHeaders?: Record<string, string>
}

/** `GET https://api.zenrows.com/v1/?url=...` — same request shape
 *  scrapeWithZenRows built by hand, now via the SDK's `fetch()`. */
export async function scrapePage(apiKey: string, url: string, params: ScrapeParams): Promise<AdapterResult<string>> {
  try {
    const res = await client(apiKey).fetch(
      url,
      {
        js_render: params.jsRender !== false,
        wait_for: params.waitFor ?? "networkidle",
        premium_proxy: !!params.premiumProxy,
        ...(params.customHeaders ? { custom_headers: true } : {}),
      },
      params.customHeaders ? { headers: params.customHeaders } : undefined,
    )
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, status: res.status, data: null, error: body || `HTTP ${res.status}` }
    }
    const body = await res.text()
    return { ok: true, status: res.status, data: body, error: null }
  } catch (err) {
    const e = err as { message?: string }
    return { ok: false, status: null, data: null, error: e?.message ?? "ZenRows request failed" }
  }
}
