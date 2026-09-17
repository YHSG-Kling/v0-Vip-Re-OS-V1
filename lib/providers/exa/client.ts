// lib/providers/exa/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE EXA SERVER ADAPTER (wave 70B, owner ruling: "if there is an sdk
// option, we should use that... keeping pricing in mind"). Exa's official
// Node SDK is `exa-js` (not previously installed — lib/external/exa-client.ts
// ::exaSearch hand-built the POST request through the connector gateway). The
// SDK does not change price (same per-result/content billing, surfaced back
// on `costDollars`) — it removes the hand-built request/response mapping.
//
// BUNDLE NOTE. exa-js pulls in the `openai` package as a transitive dependency
// (for its OpenAI-tool-format helpers, unused here). Every caller of this
// adapter is server-only code (a lib module never imported by a client
// component) and reaches it through a dynamic `await import(...)`, so it is
// never bundled into a client chunk — the cost is a server-side install-size
// increase only, not a shipped-to-browser one.

// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled. A static import of this adapter from a file a proof
// script statically reaches (e.g. lib/external/apify-client.ts from
// lib/platform/provider-posture.ts's chain) would crash that proof for a
// directive with no live client-bundling risk to guard against here.
import Exa from "exa-js"

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

const clients = new Map<string, Exa>()
function client(apiKey: string): Exa {
  let c = clients.get(apiKey)
  if (!c) {
    c = new Exa(apiKey)
    clients.set(apiKey, c)
  }
  return c
}

function mapError(err: unknown): AdapterResult<any> {
  const e = err as { statusCode?: number; status?: number; message?: string }
  return {
    ok: false,
    status: typeof e?.statusCode === "number" ? e.statusCode : typeof e?.status === "number" ? e.status : null,
    data: null,
    error: e?.message ?? "Exa request failed",
  }
}

export interface RawSearchData {
  results: Array<Record<string, unknown>>
}

/** `POST /search` with caller-supplied options, passed through mostly as-is —
 *  for callers (lib/content-intel/exa-scraper.ts) that need fields
 *  `neuralSearch` doesn't expose (type/useAutoprompt/category/excludeDomains/
 *  includeText). Kept as a thin escape hatch rather than growing
 *  `neuralSearch`'s params into two different callers' shapes. */
export async function rawSearch(
  apiKey: string,
  query: string,
  options: Record<string, unknown>,
): Promise<AdapterResult<RawSearchData>> {
  try {
    const res = await client(apiKey).search(query, options as any)
    return { ok: true, status: 200, data: { results: res.results as unknown as Array<Record<string, unknown>> }, error: null }
  } catch (err) {
    return mapError(err)
  }
}

export interface NeuralSearchParams {
  query: string
  numResults?: number
  startPublishedDate?: string
  includeDomains?: string[]
}

export interface NeuralSearchData {
  results: Array<Record<string, unknown>>
  costDollarsTotal: number | null
}

/** `POST /search` (type: "neural") — same request shape exaSearch built by
 *  hand, now via the SDK. */
export async function neuralSearch(apiKey: string, params: NeuralSearchParams): Promise<AdapterResult<NeuralSearchData>> {
  try {
    const res = await client(apiKey).search(params.query, {
      type: "neural",
      numResults: params.numResults ?? 25,
      ...(params.startPublishedDate ? { startPublishedDate: params.startPublishedDate } : {}),
      ...(params.includeDomains ? { includeDomains: params.includeDomains } : {}),
      // Max-info scrape: full text (no maxCharacters cap), top highlights, and
      // the model-generated summary — same as the pre-SDK request body.
      contents: { text: true, highlights: { numSentences: 5 }, summary: true } as any,
    })
    return {
      ok: true,
      status: 200,
      data: { results: res.results as unknown as Array<Record<string, unknown>>, costDollarsTotal: res.costDollars?.total ?? null },
      error: null,
    }
  } catch (err) {
    return mapError(err)
  }
}
