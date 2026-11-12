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

// ── WAVE 151 (lane 151D) — THE HUNTING SURFACE OF THE SAME ADAPTER ───────────
// Owner correction (2026-11-09, verbatim): "exa is to find people when it is a scraper or
// hunting." Exa's real API surface beyond `/search` text: STRUCTURED EXTRACTION (a JSON schema on
// the summary — the page's facts come back as fields, not prose), SEARCH MONITORS (`/monitors`: a
// scheduled search whose NEW results are PUSHED to a signed webhook — monitored deltas instead of a
// repeated search), and their RUNS. All three ride the ONE SDK client above; every call maps a thrown
// SDK error to ok:false and never throws. Research (`/research`) and Websets are deliberately NOT
// wrapped here: no play consumes them yet (an export nothing calls is an orphan — CLAUDE.md §1).
// The API key is the CALLER's (lib/providers/exa/hunting.ts productionExaHuntClient reads
// EXA_API_KEY by NAME and hands null when absent — WAITING_EXTERNAL, never a fabricated result).

export interface StructuredSearchParams {
  query: string
  numResults?: number
  startPublishedDate?: string
  includeDomains?: string[]
  excludeDomains?: string[]
  /** Exa's content category ("news", "company", "tweet", …) — narrows the corpus, not the territory. */
  category?: string
  /** A JSON schema for Exa's structured summary — the page's facts as fields. null = plain summary. */
  schema?: Record<string, unknown> | null
  /** Page-text cap per result. The hunting path keeps an EXCERPT only (no reuse license is assumed). */
  maxCharacters?: number
}

export interface StructuredSearchData {
  results: Array<Record<string, unknown>>
  costDollarsTotal: number | null
}

/** `POST /search` (type: "auto") with highlights and a SCHEMA-SHAPED summary — Exa's structured extraction. */
export async function structuredSearch(apiKey: string, params: StructuredSearchParams): Promise<AdapterResult<StructuredSearchData>> {
  try {
    const res = await client(apiKey).search(params.query, {
      type: "auto",
      numResults: params.numResults ?? 10,
      ...(params.startPublishedDate ? { startPublishedDate: params.startPublishedDate } : {}),
      ...(params.includeDomains?.length ? { includeDomains: params.includeDomains } : {}),
      ...(params.excludeDomains?.length ? { excludeDomains: params.excludeDomains } : {}),
      ...(params.category ? { category: params.category } : {}),
      contents: {
        text: { maxCharacters: params.maxCharacters ?? 2000 },
        highlights: { numSentences: 3 },
        summary: params.schema ? { schema: params.schema } : true,
      },
    } as any)
    return {
      ok: true,
      status: 200,
      data: { results: res.results as unknown as Array<Record<string, unknown>>, costDollarsTotal: (res as { costDollars?: { total?: number } }).costDollars?.total ?? null },
      error: null,
    }
  } catch (err) {
    return mapError(err)
  }
}

export interface CreateSearchMonitorInput {
  name: string
  query: string
  numResults?: number
  includeDomains?: string[]
  excludeDomains?: string[]
  /** Exa interval period — "1h" | "6h" | "1d" | "7d" (minimum 1h; the play chooses by freshness, never by outreach). */
  period: string
  outputSchema?: Record<string, unknown> | null
  /** Echoed back on every delivery — NEVER trusted for tenancy (the provider_monitors row decides). */
  metadata?: Record<string, string>
  webhookUrl: string
}

export interface CreatedSearchMonitor {
  monitorId: string
  /** Returned ONCE by Exa at creation — the caller seals it (lib/security/secret-crypto.ts) and never logs it. */
  webhookSecret: string
  status: string
  nextRunAt: string | null
}

/** `POST /monitors` — a scheduled search whose new results are pushed to our signed webhook (monitor.run.completed). */
export async function createSearchMonitor(apiKey: string, input: CreateSearchMonitorInput): Promise<AdapterResult<CreatedSearchMonitor>> {
  try {
    const res = await client(apiKey).monitors.create({
      name: input.name,
      search: {
        query: input.query,
        numResults: input.numResults ?? 10,
        ...(input.includeDomains?.length ? { includeDomains: input.includeDomains } : {}),
        ...(input.excludeDomains?.length ? { excludeDomains: input.excludeDomains } : {}),
        contents: { text: { maxCharacters: 2000 }, highlights: { numSentences: 3 } } as any,
      },
      trigger: { type: "interval", period: input.period },
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      webhook: { url: input.webhookUrl, events: ["monitor.run.completed"] },
    })
    return {
      ok: true,
      status: 200,
      data: { monitorId: res.id, webhookSecret: res.webhookSecret, status: res.status, nextRunAt: res.nextRunAt ?? null },
      error: null,
    }
  } catch (err) {
    return mapError(err)
  }
}

export interface SearchMonitorRunData {
  status: string
  results: Array<Record<string, unknown>>
  content: unknown
  completedAt: string | null
}

/** `GET /monitors/{id}/runs/{runId}` — the run a delivery names, read back from Exa (the payload's ids are never trusted alone). */
export async function getSearchMonitorRun(apiKey: string, monitorId: string, runId: string): Promise<AdapterResult<SearchMonitorRunData>> {
  try {
    const run = await client(apiKey).monitors.runs.get(monitorId, runId)
    return {
      ok: true,
      status: 200,
      data: {
        status: run.status,
        results: ((run.output?.results ?? []) as Array<Record<string, unknown>>),
        content: run.output?.content ?? null,
        completedAt: run.completedAt ?? null,
      },
      error: null,
    }
  } catch (err) {
    return mapError(err)
  }
}
