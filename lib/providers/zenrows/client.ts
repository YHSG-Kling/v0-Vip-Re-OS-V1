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
  /** A browser LOAD STATE. CORRECTED wave 153 (lane 153G): ZenRows' `wait_for` is a CSS SELECTOR to wait for
   *  (docs.zenrows.com/fetch/api-reference, read 2026-11-14) — sending "networkidle" asked ZenRows to wait for an element
   *  named `networkidle` on every JS-rendered call. A load state is therefore NOT sent; js_render already waits for the
   *  page to load. Pass `waitForSelector` for a real selector. */
  waitFor?: "networkidle" | "domcontentloaded"
  /** A CSS selector ZenRows waits for before returning (its documented `wait_for`). */
  waitForSelector?: string
  customHeaders?: Record<string, string>
  /** Return the TARGET's status (ZenRows `original_status`) — a 304 to a conditional request reads as 304, not a failure. */
  originalStatus?: boolean
}

/** What a page fetch returns beyond the body: the target's `Zr-` headers (prefix kept off, lowercased) and the request's
 *  dollar cost as ZenRows states it (`X-Request-Cost`; null when the header is absent — the caller then estimates). */
interface ScrapePageExtras { targetHeaders: Record<string, string>; requestCostUsd: number | null }

function readExtras(res: { headers?: { forEach?: (cb: (value: string, key: string) => void) => void } | null }): ScrapePageExtras {
  const targetHeaders: Record<string, string> = {}
  let requestCostUsd: number | null = null
  res.headers?.forEach?.((value, key) => {
    const k = key.toLowerCase()
    if (k.startsWith("zr-")) targetHeaders[k.slice(3)] = value
    if (k === "x-request-cost") { const n = Number(value); requestCostUsd = Number.isFinite(n) && n >= 0 ? n : null }
  })
  return { targetHeaders, requestCostUsd }
}

/** `GET https://api.zenrows.com/v1/?url=...` — same request shape
 *  scrapeWithZenRows built by hand, now via the SDK's `fetch()`. */
export async function scrapePage(apiKey: string, url: string, params: ScrapeParams): Promise<AdapterResult<string> & ScrapePageExtras> {
  try {
    const res = await client(apiKey).fetch(
      url,
      {
        js_render: params.jsRender !== false,
        ...(params.waitForSelector ? { wait_for: params.waitForSelector } : {}),
        premium_proxy: !!params.premiumProxy,
        ...(params.originalStatus ? { original_status: true } : {}),
        ...(params.customHeaders ? { custom_headers: true } : {}),
      },
      params.customHeaders ? { headers: params.customHeaders } : undefined,
    )
    const extras = readExtras(res as never)
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, status: res.status, data: null, error: body || `HTTP ${res.status}`, ...extras }
    }
    const body = await res.text()
    return { ok: true, status: res.status, data: body, error: null, ...extras }
  } catch (err) {
    const e = err as { message?: string }
    return { ok: false, status: null, data: null, error: e?.message ?? "ZenRows request failed", targetHeaders: {}, requestCostUsd: null }
  }
}
