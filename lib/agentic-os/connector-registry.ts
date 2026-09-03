/**
 * lib/agentic-os/connector-registry.ts
 *
 * Single source of truth for every external connector this codebase uses — vendor docs URL, official
 * GitHub repo, auth shape, and the live base URL. Read by:
 *   - The AI connector healer (lib/agentic-os/connector-healer): when a connector starts failing,
 *     the healer fetches the docs URL via Exa/Tavily, feeds the current code's request shape +
 *     fresh docs to an LLM, and proposes a corrective fix (endpoint change, param rename, new auth
 *     style, etc.) into `connector_healing_proposals`.
 *   - The developer ergonomics layer (future): generating typed clients / request shapes / response
 *     schemas from each vendor's official spec / GitHub examples.
 *
 * NOT used as the runtime config — runtime keys + URLs still flow through environment variables and
 * the existing connector-gateway. This is metadata + docs pointers.
 */
export type AuthStyle = "bearer" | "basic" | "header" | "query" | "none"

export interface ConnectorSpec {
  /** Stable internal name (must match the `connector` field in callConnector requests). */
  connector:  string
  /** Human-readable category — drives docs-search query weighting. */
  category:   "scraper" | "enrichment" | "mls" | "comms" | "ai" | "letters" | "osint" | "other"
  /** Live API base URL. */
  baseUrl:    string
  /** Auth style used by the gateway. */
  auth:       AuthStyle
  /** Environment variable holding the credential. */
  envKey?:    string
  /** Canonical docs URL (the page Exa/Tavily searches start from when healing). */
  docsUrl:    string
  /** Official GitHub repo (when published) — preferred over docs for typed examples. */
  githubUrl?: string
  /** Official npm SDK package name (when published). Set per the vendor GitHub audit so future
   *  tooling can see which vendors have typed clients to consider adopting. ABSENCE means there is
   *  no published TS/Node SDK and we should keep our fetch-via-gateway client. */
  npmSdk?:    string
  /** URL to the vendor's OpenAPI / Swagger spec when published — the healer can reference this
   *  directly for typed shapes instead of free-form doc text. */
  openapiSpec?: string
  /** Set when the vendor publishes a Model Context Protocol server we can call from agentic
   *  contexts (some vendors expose richer / cheaper data through MCP than their REST API). */
  mcpServer?: { url?: string; githubUrl?: string }
  /** Free-form tags for downstream filtering / scoring (`buyer-intent`, `seller-intent`, `mls`, …). */
  tags?:      string[]
}

export const CONNECTOR_REGISTRY: Readonly<Record<string, ConnectorSpec>> = Object.freeze({
  // ── Enrichment ─────────────────────────────────────────────────────────
  peopledata: {
    connector: "peopledata",
    category:  "enrichment",
    baseUrl:   "https://api.peopledatalabs.com/v5",
    auth:      "header",
    envKey:    "PEOPLEDATA_API_KEY",
    docsUrl:   "https://docs.peopledatalabs.com/",
    githubUrl: "https://github.com/peopledatalabs/peopledatalabs-js",
    npmSdk:    "peopledatalabs",
    tags:      ["person-enrich", "email-validate", "skip-trace"],
  },
  // ── Real-estate listings (MLS-grade default) ───────────────────────────
  rentcast: {
    connector: "rentcast",
    category:  "mls",
    baseUrl:   "https://api.rentcast.io/v1",
    auth:      "header",
    envKey:    "RENTCAST_API_KEY",
    docsUrl:   "https://developers.rentcast.io/",
    githubUrl: "https://github.com/RentCast",
    // OpenAPI spec — typed shapes the healer can read directly + the source for any future
    // codegen swap (e.g. openapi-typescript) when we want compile-time guarantees.
    openapiSpec: "https://raw.githubusercontent.com/RentCast/api-resources/main/openapi-spec/rentcast_api_openapi_spec_v1.json",
    tags:      ["mls", "listings", "sales", "rentals"],
  },
  // ── Property data / motivated-seller ───────────────────────────────────
  batchdata: {
    connector: "batchdata",
    category:  "scraper",
    baseUrl:   "https://api.batchdata.com/api/v1",
    auth:      "bearer",
    envKey:    "BATCHDATA_API_KEY",
    docsUrl:   "https://docs.batchdata.com/",
    githubUrl: "https://github.com/batchdataco",
    // BatchData publishes an MCP server (also a Vercel AI SDK demo) — agentic callers can use the
    // MCP for richer tool surfaces than the raw REST API. Recorded so the healer can suggest
    // routing through MCP when REST endpoints drift. Implementation in lib/external/batchdata-mcp.ts;
    // configuration via the BATCHDATA_MCP_URL env var (with optional BATCHDATA_MCP_AUTH bearer).
    mcpServer: { githubUrl: "https://github.com/batchdataco/batchdata-mcp-server" },
    tags:      ["property", "motivated-seller", "off-market", "skip-trace", "has-mcp"],
  },
  // ── Web scrapers + AI search ───────────────────────────────────────────
  zenrows: {
    connector: "zenrows",
    category:  "scraper",
    baseUrl:   "https://api.zenrows.com/v1",
    auth:      "query",
    envKey:    "ZENROWS_API_KEY",
    docsUrl:   "https://docs.zenrows.com/",
    // ZenRows is for BOTH buyer-intent profile pages (saved-search / property-alert) AND
    // seller-intent pages (FSBO posts, motivated-seller forums) on forums / social / personal
    // sites — NOT MLS listings (RentCast is the canonical MLS source for actual listing data).
    tags:      ["buyer-intent", "seller-intent", "social", "forum", "no-mls"],
  },
  apify: {
    connector: "apify",
    category:  "scraper",
    baseUrl:   "https://api.apify.com/v2",
    auth:      "bearer",
    envKey:    "APIFY_API_TOKEN",
    docsUrl:   "https://docs.apify.com/",
    githubUrl: "https://github.com/apify",
    npmSdk:    "apify-client",  // HIGH-ROI swap when we touch this area — typed actors/runs/datasets
    tags:      ["scraper", "actor", "social", "search"],
  },
  exa: {
    connector: "exa",
    category:  "ai",
    baseUrl:   "https://api.exa.ai",
    auth:      "header",
    envKey:    "EXA_API_KEY",
    docsUrl:   "https://docs.exa.ai/",
    githubUrl: "https://github.com/exa-labs",
    npmSdk:    "exa-js",
    tags:      ["neural-search", "buyer-intent", "natural-language"],
  },
  tavily: {
    connector: "tavily",
    category:  "ai",
    baseUrl:   "https://api.tavily.com",
    auth:      "bearer",
    envKey:    "TAVILY_API_KEY",
    docsUrl:   "https://docs.tavily.com/",
    tags:      ["web-search", "answer", "intent"],
  },
  // ── Direct mail ────────────────────────────────────────────────────────
  lob: {
    connector: "lob",
    category:  "letters",
    baseUrl:   "https://api.lob.com/v1",
    auth:      "basic",
    envKey:    "LOB_API_KEY",
    docsUrl:   "https://docs.lob.com/",
    githubUrl: "https://github.com/lob",
    npmSdk:    "@lob/lob-typescript-sdk",  // ADOPT when direct-mail ships (money-moving + many models)
    tags:      ["direct-mail", "postcard", "letter", "address-verify"],
  },
  // ── AI media (video / voice) ───────────────────────────────────────────
  d_id: {
    connector: "d_id",
    category:  "ai",
    baseUrl:   "https://api.d-id.com",
    auth:      "basic",
    envKey:    "D_ID_API_KEY",
    docsUrl:   "https://docs.d-id.com/",
    githubUrl: "https://github.com/de-id",
    // Typed agents SDK — adopt when we ship the live-avatar conversational surface (browser);
    // the core REST video-generation API can keep the gateway client for batch renders.
    npmSdk:    "@d-id/agents-sdk",
    tags:      ["video", "avatar", "lip-sync"],
  },
  elevenlabs: {
    connector: "elevenlabs",
    category:  "ai",
    baseUrl:   "https://api.elevenlabs.io/v1",
    auth:      "header",
    envKey:    "ELEVENLABS_API_KEY",
    docsUrl:   "https://elevenlabs.io/docs",
    githubUrl: "https://github.com/elevenlabs",
    npmSdk:    "elevenlabs",  // HIGH-ROI when TTS lands — streaming + typed voices
    tags:      ["tts", "voice-clone"],
  },
  // ── Anthropic / OpenAI / Google AI are routed via the AI gateway; listed here for healer ─
  anthropic: {
    connector: "anthropic",
    category:  "ai",
    baseUrl:   "https://api.anthropic.com/v1",
    auth:      "header",
    envKey:    "ANTHROPIC_API_KEY",
    docsUrl:   "https://docs.anthropic.com/",
    tags:      ["llm", "claude"],
  },
  google_ai: {
    connector: "google_ai",
    category:  "ai",
    baseUrl:   "https://generativelanguage.googleapis.com",
    auth:      "query",
    envKey:    "GOOGLE_AI_API_KEY",
    docsUrl:   "https://ai.google.dev/docs",
    githubUrl: "https://github.com/google",
    tags:      ["llm", "gemini"],
  },
  // ── Public city / county open data (Socrata) — permits, code violations, probate filings ──
  socrata: {
    connector: "socrata",
    category:  "scraper",
    baseUrl:   "https://data.austintexas.gov",  // example host; real host is per-call
    auth:      "header",
    envKey:    "SOCRATA_APP_TOKEN",
    docsUrl:   "https://dev.socrata.com/",
    tags:      ["public-records", "permits", "code-violations", "probate", "open-data"],
  },
  // ── Public city / county open data (ArcGIS FeatureServer) — the SECOND permit provider ──
  // Registered 2026-08-20 alongside `socrata`, because a great many county permit and code
  // systems publish an ArcGIS FeatureServer and NOT a Socrata portal — including three markets
  // socrata-market-registry.ts had marked dead for exactly that reason. Read by
  // lib/external/arcgis-permits.ts; first live market is Miami-Dade County.
  //
  // NO envKey, and that is a fact rather than an omission: these are anonymous public layers and
  // there is no token to supply. The healer should not go looking for a credential to rotate.
  //
  // HEALER NOTE — this connector fails UNLIKE every other one in this registry. A FeatureServer
  // answers its own errors with HTTP 200 and an `error` object in the body, so status-code health
  // checks read a deleted layer as a successful empty response. arcgis-permits.ts::readArcgisError
  // is the check that makes a failure legible; anything else probing this connector needs it too.
  arcgis: {
    connector: "arcgis",
    category:  "scraper",
    baseUrl:   "https://services.arcgis.com",  // example host; real layer URL is per-call
    auth:      "none",
    docsUrl:   "https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/",
    tags:      ["public-records", "permits", "code-violations", "open-data", "gis"],
  },
})

export function getConnectorSpec(name: string): ConnectorSpec | null {
  return (CONNECTOR_REGISTRY as Record<string, ConnectorSpec>)[name] ?? null
}

/** CENSUS NOTE: proof-only by design — scripts/connector-healer-simulator.ts:55-58 pins the
 *  category contract (≥3 ai, ≥1 mls, lob=letters, peopledata=enrichment). No product surface
 *  lists by category (provider-posture groups its OWN rows via resolveCategory). */
export function listConnectorsByCategory(category: ConnectorSpec["category"]): ConnectorSpec[] {
  return Object.values(CONNECTOR_REGISTRY).filter(c => c.category === category)
}
