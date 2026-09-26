/**
 * lib/external/zyte-client.ts
 *
 * Zyte API — automatic-extraction / browser-rendering web scraper. BUILT this wave (owner
 * ruling, wave 65): "zenrows or zyte can help find leads that are on real estate sites like
 * zillow/realtor.com/nextdoor/homes.com/reddit that have property search saved criterias or
 * online chatter". lib/external/zenrows-client.ts is the PRIMARY scraper for those pages; this
 * is the FALLBACK the OS reaches for when ZenRows is unconfigured or the target site is one
 * ZenRows is documented to be failing on (see docs/lead-acquisition-coverage-2026-09.md — the
 * researched 2026 benchmarks that motivated keeping a second provider in the seam).
 *
 * PICK-BY-CONFIGURED-KEY (never a hardcoded provider choice): `scrapeSiteWithBestProvider` in
 * zenrows-client.ts tries ZenRows first when ZENROWS_API_KEY is set, falls back to
 * `scrapeWithZyte` here when ZYTE_API_KEY is set (or ZenRows threw), and fails CLOSED — no
 * scrape, no cost — when neither key is present. That is the single call site lanes should use;
 * this module is the raw Zyte primitive.
 *
 * API shape (https://docs.zyte.com/zyte-api/): POST https://api.zyte.com/v1/extract,
 * HTTP Basic auth with the API key as the username and an empty password, body { url,
 * httpResponseBody: true } for a plain response or { url, browserHtml: true } for a
 * JS-rendered one. httpResponseBody comes back base64-encoded; browserHtml comes back as a
 * plain HTML string. Real REST API; no stubs — never throws (callConnector never throws),
 * returns a failure shape instead so callers can fall through cleanly.
 */
const ZYTE_BASE = "https://api.zyte.com/v1"

export interface ZyteResponse {
  ok: boolean
  html: string
  /** Which Zyte extraction mode produced `html`. */
  mode: "browserHtml" | "httpResponseBody" | null
  statusCode: number | null
  cost: number
  error: string | null
}

/** True when ZYTE_API_KEY is configured — the provider picker's fallback gate. */
export function zyteConfigured(): boolean {
  return !!process.env.ZYTE_API_KEY
}

/**
 * Fetch a page's HTML through Zyte API. `jsRender: true` requests `browserHtml` (headless
 * Chrome rendering — needed for the saved-search / "contact agent" widgets on Zillow, Realtor.com
 * and Homes.com, which are client-rendered); otherwise requests the plain `httpResponseBody`.
 * Never throws — a missing key or a refused request comes back as `{ ok: false, error }` so
 * callers can fall through to the next provider or fail closed honestly.
 */
export async function scrapeWithZyte(
  url: string,
  options: { jsRender?: boolean } = {},
): Promise<ZyteResponse> {
  const apiKey = process.env.ZYTE_API_KEY
  if (!apiKey) {
    return { ok: false, html: "", mode: null, statusCode: null, cost: 0, error: "ZYTE_API_KEY not configured" }
  }

  const mode: "browserHtml" | "httpResponseBody" = options.jsRender ? "browserHtml" : "httpResponseBody"

  // Single egress: route through the connector-gateway (one way in/out).
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ url?: string; statusCode?: number; browserHtml?: string; httpResponseBody?: string }>({
    connector: "zyte",
    baseUrl:   ZYTE_BASE,
    path:      "/extract",
    method:    "POST",
    auth:      { style: "basic", username: apiKey, password: "" },
    body:      { url, [mode]: true },
    timeoutMs: 60_000,
  })

  if (!res.ok || !res.data) {
    return {
      ok: false, html: "", mode: null, statusCode: res.status ?? null, cost: 0,
      error: res.error ?? `Zyte API error: ${res.status ?? "network"}`,
    }
  }

  const html = mode === "browserHtml"
    ? (res.data.browserHtml ?? "")
    : decodeBase64Body(res.data.httpResponseBody)

  if (!html) {
    return {
      ok: false, html: "", mode, statusCode: res.data.statusCode ?? res.status ?? null, cost: estimateZyteCost(mode),
      error: "Zyte returned no extractable HTML",
    }
  }

  return {
    ok: true, html, mode, statusCode: res.data.statusCode ?? res.status ?? null,
    cost: estimateZyteCost(mode), error: null,
  }
}

/** Pure: base64-decode Zyte's `httpResponseBody`, defensively. */
export function decodeBase64Body(b64: string | undefined | null): string {
  if (!b64) return ""
  try { return Buffer.from(b64, "base64").toString("utf-8") }
  catch { return "" }
}

/**
 * Pure: approximate per-request USD cost. Zyte is TIER-based (5 tiers, auto-assigned per
 * domain, reviewed quarterly) rather than a flat rate — see docs/lead-acquisition-coverage-
 * 2026-09.md for the full published tier table. We do not know which tier a given domain lands
 * on ahead of the call (Zyte assigns it after the first request), so this estimates at the
 * PAYG mid-tier (Tier 3 "moderate") rate as an honest approximation for the vendor ledger, not
 * a claim of the exact billed amount — the same posture the ZenRows client already takes with
 * its flat $0.01/call estimate.
 */
export function estimateZyteCost(mode: "browserHtml" | "httpResponseBody"): number {
  return mode === "browserHtml" ? 0.004 : 0.00044 // Tier 3 PAYG: $4.02/1k rendered, $0.44/1k HTTP
}
