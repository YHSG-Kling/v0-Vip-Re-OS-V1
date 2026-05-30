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
    tags:      ["property", "motivated-seller", "off-market", "skip-trace"],
  },
  // ── Web scrapers + AI search ───────────────────────────────────────────
  zenrows: {
    connector: "zenrows",
    category:  "scraper",
    baseUrl:   "https://api.zenrows.com/v1",
    auth:      "query",
    envKey:    "ZENROWS_API_KEY",
    docsUrl:   "https://docs.zenrows.com/",
    // ZenRows does NOT extract MLS listings (use RentCast). It is used for buyer-intent profile
    // pages on forums / social / personal sites that surface property-alert criteria.
    tags:      ["buyer-intent", "social", "forum", "no-mls"],
  },
  apify: {
    connector: "apify",
    category:  "scraper",
    baseUrl:   "https://api.apify.com/v2",
    auth:      "bearer",
    envKey:    "APIFY_API_TOKEN",
    docsUrl:   "https://docs.apify.com/",
    githubUrl: "https://github.com/apify",
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
})

export function getConnectorSpec(name: string): ConnectorSpec | null {
  return (CONNECTOR_REGISTRY as Record<string, ConnectorSpec>)[name] ?? null
}

export function listConnectorsByCategory(category: ConnectorSpec["category"]): ConnectorSpec[] {
  return Object.values(CONNECTOR_REGISTRY).filter(c => c.category === category)
}
