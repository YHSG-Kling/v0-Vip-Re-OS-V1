// lib/kernel/provider-adapters.ts
//
// THE PROVIDER ADAPTER CONTRACT (wave 137, lane 137C; OWNER LAW 3 "agents request capabilities, not
// vendors"). NOT a router and NOT a registry of its own: every adapter is DERIVED from the route
// tables the fabric already routes by —
//   · CONTACT_PROVIDER_ROUTES (lib/ai-isa/property-lookup-rail.ts) — the data capabilities, their
//     provider order (= the fallback) and their per-unit price;
//   · SYSTEM_DEFAULTS / SYSTEM_ONLY_TYPES (lib/kernel/providers.ts) — the channel provider types
//     (email, sms, esign, video, ai, …) and which tier pays;
//   · CONNECTED_CAPABILITY_REGISTRY (lib/agentic-os/connected-vendor-registry.ts) — every provider a
//     tenant capability routes to (wave 138, lane 138A);
//   · PROVIDER_CATALOG (lib/integrations/providers/catalog.ts) — the transaction / e-sign resolver's
//     providers (wave 138, lane 138A);
//   · CONNECTOR_REGISTRY (lib/agentic-os/connector-registry.ts) — endpoint, auth, docs, SDK, MCP;
//   · PROVIDER_TENANCY (lib/providers/tenancy-matrix.ts) — who owns the vendor relationship;
//   · PLATFORM_VENDOR_RATES / VENDOR_PRICING — the price the ledger books;
//   · PROVIDER_HEALTH_POLICY + PROBE_SPECS — the health a call is judged by.
// What none of them carried — the API VERSION the code speaks, the gateway service keys and the usage
// booking — is the only thing ADAPTER_FACTS adds. The KNOWN ALTERNATES (a newer version, a different
// endpoint, an MCP route; CONFIG or CODE level) and a declared deprecation live on the connector
// survivor (CONNECTOR_REGISTRY[*].alternates / deprecatedAfter), which the gateway reads at egress. A new provider plugs in through a route-table row + one facts row;
// validateAdapterSet refuses a routed provider without a declaration, a declaration nobody routes,
// and a platform-paid adapter with no usage booking (constitution: no unmetered paid capability).
//
// WAVE 138 (lane 138A) — EVERY PROVIDER IS A KERNEL CONNECTION. ADAPTER_FACTS now declares every
// provider the code references (scripts/provider-adapter-guard.ts derives the census from env keys,
// client modules, webhook routes and callConnector sites over runtimeFiles(), and refuses a signal no
// declaration accounts for). A provider is ROUTED when a route table names it, or when its egress
// is a callConnector site (`gateway: true` — the census proves the site exists). One reached outside
// every rail carries `exception` (a published reason) instead — never silently. Each declaration
// carries the docs / status / changelog roots the provider-setup research step (lane 138B) starts from.
//
// WAVE 139 (lane 139D) — URL INTEGRITY. Every docs / status / changelog URL below was re-verified on
// 2026-10-08 (Exa page fetch, or an indexed search result for crawler-blocked hosts — the list with
// each verdict is in the lane notes). A URL is either a page on the provider's OFFICIAL domain
// (OFFICIAL_URL_DOMAINS + the domain of its own endpoint) that is not a placeholder shape
// (urlPlaceholderProblem: a site homepage standing in for docs, a reserved host, a "status" page
// that is not one), or it is NULL with its published reason (`urlNote`) — never a guess. The
// wave-138 research roots (lofty.com, skyslope.com, my.brokermint.com, formsimplicity.com,
// showingtime.com, slybroadcast.com, arello.org, listhub.com, developer.lwolf.com) are replaced or
// nulled; validateProviderAdapter refuses a regression.
//
// The self-healing decision (owner, wave 137: "FIRST probe whether the provider is down; if it is
// UP, check whether its SDK / MCP / endpoint changed … apply the declared change, retry, record
// evidence; code-level changes become a connector healing proposal") is decideProviderHeal — PURE.
// The executor is lib/agentic-os/connector-healer.ts healProviderFailure; the config apply is
// lib/agentic-os/connector-auto-applier.ts applyDeclaredAlternate; the applied alternate reaches
// egress in lib/agentic-os/connector-gateway.ts callConnector (loadAppliedAlternate + applyAlternateToRequest
// there — the gateway reads the alternates from CONNECTOR_REGISTRY, a leaf, never this module's graph).

import { CONTACT_PROVIDER_ROUTES, routeCapability, type CapabilityRoute, type ProviderCapability } from "@/lib/ai-isa/property-lookup-rail"
import { SYSTEM_DEFAULTS, SYSTEM_ONLY_TYPES } from "@/lib/kernel/providers"
import { CONNECTOR_REGISTRY, QBO_MINOR_VERSION, type ConnectorAlternate } from "@/lib/agentic-os/connector-registry"
import { CONNECTED_CAPABILITY_REGISTRY } from "@/lib/agentic-os/connected-vendor-registry"
import { PROVIDER_CATALOG } from "@/lib/integrations/providers/catalog"
import { PROVIDER_TENANCY } from "@/lib/providers/tenancy-matrix"
import { PLATFORM_VENDOR_RATES, meterVendorSpend, type MeterVendorInput } from "@/lib/vendor-governance/meter-vendor"
import { VENDOR_PRICING, vendorPriceState, type PriceState } from "@/lib/vendor-governance/cost-normalizer"
import { PROVIDER_HEALTH_POLICY } from "@/lib/agentic-os/connector-gateway"
import { PROBE_SPECS } from "@/lib/agentic-os/connector-probe"
import { SIMLI_USD_PER_STREAMING_MINUTE } from "@/lib/video/realism-profile"

// ─── the declaration ──────────────────────────────────────────────────────────

type AdapterPayer = "platform" | "tenant"
/** "free" = a keyless / free public API (nothing to book; a price > 0 is refused). */
type UsageLedger = "vendor_usage_tracking" | "ai_tool_usage" | "tenant_account" | "free"
/** live = a client calls it · inbound_only = only its webhook is received · vocabulary_only = a route
 *  table names it but no client exists (a call to it fails closed) · unimplemented = env read, the
 *  path fails honestly (no third-party API offered). */
type AdapterLifecycle = "live" | "inbound_only" | "vocabulary_only" | "unimplemented"
/** The kernel connection path(s) a provider is reached through. */
type KernelRoutePath = "capability_router" | "provider_cascade" | "connected_capability" | "transaction_resolver" | "connector_registry" | "connector_gateway"

/** A KNOWN alternate — declared on the connector-registry survivor (CONNECTOR_REGISTRY[*].alternates). */
type AdapterAlternate = ConnectorAlternate

export interface ProviderAdapter {
  provider: string
  /** Every other spelling the route tables, the gateway, the env keys and the credential stores use. */
  aliases: string[]
  lifecycle: AdapterLifecycle
  /** Data capabilities (CONTACT_PROVIDER_ROUTES), channel provider types (SYSTEM_DEFAULTS), connected
   *  capabilities, catalog capabilities and declared capabilities. */
  capabilities: string[]
  inputs: string[]
  outputs: string
  /** priceState (wave 139, 139C): the price is a typed STATE (cost-normalizer.ts PriceState) —
   *  "tenant_account" = not the platform's price to know. An unknown price is declared, never $0-by-default. */
  cost: { payer: AdapterPayer; unitUsd: number; unit: string; priceSource: string; priceState: PriceState | "tenant_account"; ledger: UsageLedger; booking: string }
  health: { serviceKeys: string[]; liveProbe: string | null; derivedFrom: "api_response_logs"; failingStreak: number; cooldownMs: number }
  rateLimits: { state: "rate_limited"; note: string }
  credential: { survivor: "platform_env" | "tenant_connection" | "keyless"; envVars: string[] }
  eligibility: { tenancyModels: string[]; geography: "us_nationwide" | "global" }
  /** Per data capability: the providers asked after this one (route-table order). */
  fallback: Record<string, string[]>
  provenance: string[]
  route: { paths: KernelRoutePath[]; exception: string | null }
  api: {
    transport: "rest" | "sdk" | "mcp" | "gateway" | "in_process" | "browser"; version: string; baseUrl: string
    docsUrl: string | null; statusUrl: string | null; changelogUrl: string | null
    /** Wave 139 (139D): why a docs / status / changelog URL is NULL or withheld (unverifiable, none
     *  published) — a null docs root without one is refused. Optional for extension declarations. */
    urlNote?: string | null
    sdk: string | null; mcp: string | null; deprecatedAfter: string | null; alternates: AdapterAlternate[]
  }
}

/** The facts no route table carried. Keyed by the provider name the route tables use. */
interface AdapterFacts {
  serviceKeys: string[]
  outputs: string
  transport: ProviderAdapter["api"]["transport"]
  version: string
  /** Only when CONNECTOR_REGISTRY has no entry (one spelling of a base URL — the validator holds it). */
  baseUrl?: string
  /** null = no official docs page could be verified — `urlNote` then says why (never a guessed root). */
  docsUrl?: string | null
  statusUrl?: string
  changelogUrl?: string
  /** The published reason a docs / status / changelog URL is null or withheld (wave 139, 139D). */
  urlNote?: string
  registryKey?: string
  tenancyKey?: string
  /** VENDOR_PRICING / PLATFORM_VENDOR_RATES key when the price is not in CONTACT_PROVIDER_ROUTES. */
  priceKey?: string
  /** Declared only for a vendor no price table carries (one spelling — never a second copy). */
  unitUsd?: number
  unit?: string
  ledger: UsageLedger
  booking: string
  envVars?: string[]
  geography?: "us_nationwide" | "global"
  aliases?: string[]
  capabilities?: string[]
  payer?: AdapterPayer
  lifecycle?: AdapterLifecycle
  /** Egress is a callConnector site naming one of serviceKeys (the guard's census proves it). */
  gateway?: true
  /** Reached outside every kernel rail — the PUBLISHED reason (a declaration, never a silence). */
  exception?: string
}

const TENANT = (who: string) => `none — the tenant's own ${who}`

const ADAPTER_FACTS: Readonly<Record<string, AdapterFacts>> = {
  // ── data capabilities (CONTACT_PROVIDER_ROUTES) ──
  rentcast: { serviceKeys: ["rentcast"], outputs: "AVM point + range, property record", transport: "rest", version: "v1", ledger: "vendor_usage_tracking", booking: "meterCall (lib/property/rentcast.ts)", gateway: true },
  batchdata: { serviceKeys: ["batchdata", "batchdata_skip_trace", "batchdata_smart_search", "batchdata_wallet", "batchdata_batchrank", "batchdata_property_lookup"], outputs: "skip trace, DNC/TCPA, property facts, quicklists", transport: "rest", version: "v1", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/vendor-governance/meter-vendor.ts)", gateway: true },
  // Wave 138 (138A): ONE spelling — the tenancy matrix's "peoplesdata" is retired onto "peopledata".
  peopledata: { serviceKeys: ["peopledata"], aliases: ["pdl", "peopledatalabs"], outputs: "person profile, contact points, email validation", transport: "rest", version: "v5", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/vendor-governance/meter-vendor.ts)", gateway: true },
  // Versium is BOTH an identity provider (owner/reverse contact) AND, wave 138, a property-data
  // provider: property_facts routes to it BEHIND BatchData (equal unit price; owner order RentCast →
  // BatchData stands — see CONTACT_PROVIDER_ROUTES.property_facts).
  versium: { serviceKeys: ["versium"], outputs: "owner/person email + phone append, household financials + demographic/property append", transport: "rest", version: "v2", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/vendor-governance/meter-vendor.ts)", gateway: true },
  // ── platform channels (SYSTEM_ONLY_TYPES) ──
  anthropic: { serviceKeys: ["vercel-ai-gateway", "anthropic", "anthropic-managed-agents", "anthropic-status"], aliases: ["ai_gateway", "vercel_ai_gateway", "managed_agents"], outputs: "model completions", transport: "gateway", version: "AI Gateway OpenAI-compatible v1", tenancyKey: "ai_gateway", priceKey: "anthropic_claude", ledger: "ai_tool_usage", booking: "logAIUsage (lib/ai/cost-tracking.ts)", geography: "global", statusUrl: "https://www.vercel-status.com", changelogUrl: "https://docs.anthropic.com/en/release-notes/api", gateway: true, envVars: ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY"] },
  did: { serviceKeys: ["did"], registryKey: "d_id", aliases: ["d_id"], outputs: "avatar video render", transport: "rest", version: "unversioned", priceKey: "did", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/did/index.ts)", geography: "global", gateway: true },
  elevenlabs: { serviceKeys: ["elevenlabs"], outputs: "TTS audio, voice clone", transport: "rest", version: "v1", priceKey: "elevenlabs", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/voice/elevenlabs-tts.ts)", geography: "global", statusUrl: "https://status.elevenlabs.io", urlNote: "changelog: elevenlabs.io/docs/changelog answered Page Not Found on 2026-10-08 (dated entries live under /docs/changelog/YYYY/M/D) — not declared until a stable index is verified", gateway: true },
  twilio: { serviceKeys: ["twilio", "twilio-status"], outputs: "SMS, voice calls", transport: "rest", version: "2010-04-01", priceKey: "twilio_sms", ledger: "vendor_usage_tracking", booking: "logVendorUsage (lib/providers/dispatch.ts)", statusUrl: "https://status.twilio.com", changelogUrl: "https://www.twilio.com/en-us/changelog", gateway: true },
  lob: { serviceKeys: ["lob"], outputs: "printed + mailed piece, address verification", transport: "sdk", version: "v1", priceKey: "lob", ledger: "vendor_usage_tracking", booking: "logVendorUsage (lib/providers/dispatch.ts)", statusUrl: "https://status.lob.com", gateway: true },
  apify: { serviceKeys: ["apify"], aliases: ["apify_social"], outputs: "scraped lead records", transport: "rest", version: "v2", tenancyKey: "scrapers", priceKey: "apify", ledger: "vendor_usage_tracking", booking: "planSourceSpendBooking (lib/lead-pipeline/source-cost-ledger.ts)", geography: "global", gateway: true },
  // ── per-tenant channels (the cascade; BYO first) ──
  sendgrid: { serviceKeys: ["sendgrid", "sendgrid-status"], outputs: "email send, event + inbound webhooks", transport: "rest", version: "v3", baseUrl: "https://api.sendgrid.com/v3", docsUrl: "https://www.twilio.com/docs/sendgrid/api-reference", statusUrl: "https://status.sendgrid.com", priceKey: "sendgrid", ledger: "vendor_usage_tracking", booking: "logVendorUsage (lib/providers/dispatch.ts)", envVars: ["SENDGRID_API_KEY"], gateway: true },
  google: { serviceKeys: ["google_calendar", "gmail", "google-drive", "google-oauth", "google-userinfo"], aliases: ["google_esign", "google_workspace"], outputs: "calendar events, mail, Drive placement (Google eSignature hand-off)", transport: "rest", version: "v3", baseUrl: "https://www.googleapis.com/calendar/v3", docsUrl: "https://developers.google.com/calendar/api", statusUrl: "https://www.google.com/appsstatus/dashboard/", ledger: "tenant_account", booking: TENANT("OAuth account"), envVars: ["GOOGLE_OAUTH_CLIENT_ID"], geography: "global", gateway: true },
  docusign: { serviceKeys: ["docusign", "docusign-oauth"], outputs: "envelope send + completion", transport: "rest", version: "v2.1", baseUrl: "https://www.docusign.net/restapi", docsUrl: "https://developers.docusign.com/docs/esign-rest-api/", statusUrl: "https://status.docusign.com", ledger: "tenant_account", booking: TENANT("DocuSign account"), envVars: ["DOCUSIGN_OAUTH_HOST"], geography: "global", gateway: true },
  dotloop: { serviceKeys: ["dotloop"], outputs: "loop / transaction sync", transport: "rest", version: "v2", baseUrl: "https://api-gateway.dotloop.com/public/v2", docsUrl: "https://dotloop.github.io/public-api/", ledger: "tenant_account", booking: TENANT("dotloop account"), envVars: ["DOTLOOP_API_KEY"], gateway: true },
  follow_up_boss: { serviceKeys: ["followupboss"], aliases: ["fub"], outputs: "CRM people / events sync", transport: "rest", version: "v1", baseUrl: "https://api.followupboss.com/v1", docsUrl: "https://docs.followupboss.com/", ledger: "tenant_account", booking: TENANT("FUB key"), gateway: true },
  quickbooks: { serviceKeys: ["quickbooks"], aliases: ["qbo", "intuit"], outputs: "invoices, purchases, journal entries", transport: "rest", version: `v3 minorversion=${QBO_MINOR_VERSION}`, ledger: "tenant_account", booking: TENANT("QuickBooks company"), statusUrl: "https://status.developer.intuit.com", changelogUrl: "https://developer.intuit.com/app/developer/qbo/docs/release-notes", gateway: true },
  stripe: { serviceKeys: ["stripe"], outputs: "payments, transfers", transport: "sdk", version: "2026-02-25.clover", baseUrl: "https://api.stripe.com/v1", docsUrl: "https://docs.stripe.com/api", statusUrl: "https://status.stripe.com", changelogUrl: "https://docs.stripe.com/changelog", ledger: "tenant_account", booking: TENANT("Stripe account"), envVars: ["STRIPE_SECRET_KEY"], geography: "global", gateway: true },
  idxbroker: { serviceKeys: ["idxbroker"], aliases: ["idx_broker", "idx"], outputs: "MLS/IDX listing feed", transport: "rest", version: "unversioned", baseUrl: "https://api.idxbroker.com", docsUrl: "https://middleware.idxbroker.com/docs/api/overview.php", ledger: "tenant_account", booking: "none — the tenant's own IDX account (platform fallback is a free tier)", envVars: ["IDXBROKER_API_KEY"], gateway: true },
  buffer: { serviceKeys: ["buffer"], outputs: "social post scheduling", transport: "rest", version: "v1", baseUrl: "https://api.bufferapp.com/1", docsUrl: "https://buffer.com/developers/api", ledger: "tenant_account", booking: TENANT("Buffer account"), lifecycle: "vocabulary_only" },

  // ══ WAVE 138 (lane 138A) — the rest of the census ══
  // ── CRM (connected capability crm_contact_sync) ──
  gohighlevel: { serviceKeys: ["gohighlevel", "ghl"], aliases: ["leadconnector"], outputs: "CRM contact sync out, inbound webhooks", transport: "rest", version: "v2 (LeadConnector)", baseUrl: "https://services.leadconnectorhq.com", docsUrl: "https://marketplace.gohighlevel.com/docs/", ledger: "tenant_account", booking: TENANT("HighLevel account"), envVars: ["GHL_API_KEY"], gateway: true },
  lofty: { serviceKeys: ["lofty"], aliases: ["chime"], outputs: "CRM contact sync out", transport: "rest", version: "v1", baseUrl: "https://api.lofty.com/v1", docsUrl: "https://developer.lofty.com/", ledger: "tenant_account", booking: TENANT("Lofty account"), gateway: true },
  hubspot: { serviceKeys: ["hubspot"], outputs: "CRM contact sync out", transport: "sdk", version: "crm v3", baseUrl: "https://api.hubapi.com", docsUrl: "https://developers.hubspot.com/docs/api/overview", statusUrl: "https://status.hubspot.com", changelogUrl: "https://developers.hubspot.com/changelog", ledger: "tenant_account", booking: TENANT("HubSpot portal") },
  // ── email (connected capability email_send) ──
  outlook: { serviceKeys: ["outlook", "outlook_calendar", "microsoft-oauth", "microsoft-graph"], aliases: ["microsoft", "microsoft_graph", "office365"], outputs: "mail send, calendar events (Microsoft Graph)", transport: "rest", version: "v1.0", baseUrl: "https://graph.microsoft.com/v1.0", docsUrl: "https://learn.microsoft.com/en-us/graph/overview", statusUrl: "https://status.cloud.microsoft", changelogUrl: "https://developer.microsoft.com/en-us/graph/changelog", ledger: "tenant_account", booking: TENANT("Microsoft 365 account"), envVars: ["MICROSOFT_OAUTH_CLIENT_ID"], geography: "global", gateway: true },
  resend: { serviceKeys: ["resend"], outputs: "inbound mail webhook (signature-verified)", transport: "rest", version: "unversioned", baseUrl: "https://api.resend.com", docsUrl: "https://resend.com/docs", ledger: "tenant_account", booking: TENANT("Resend account"), lifecycle: "inbound_only", envVars: ["RESEND_WEBHOOK_SECRET"] },
  postmark: { serviceKeys: ["postmark"], outputs: "inbound mail webhook (signature-verified)", transport: "rest", version: "unversioned", baseUrl: "https://api.postmarkapp.com", docsUrl: "https://postmarkapp.com/developer", statusUrl: "https://status.postmarkapp.com", ledger: "tenant_account", booking: TENANT("Postmark server"), lifecycle: "inbound_only", envVars: ["POSTMARK_WEBHOOK_SECRET"] },
  mailgun: { serviceKeys: ["mailgun"], outputs: "inbound mail webhook (signature-verified)", transport: "rest", version: "v3", baseUrl: "https://api.mailgun.net/v3", docsUrl: "https://documentation.mailgun.com", ledger: "tenant_account", booking: TENANT("Mailgun domain"), lifecycle: "inbound_only", envVars: ["MAILGUN_WEBHOOK_SIGNING_KEY"] },
  // ── phone + SMS (connected capabilities sms_send / phone_call_place) ──
  telnyx: { serviceKeys: ["telnyx"], outputs: "SMS send (BYO number)", transport: "rest", version: "v2", baseUrl: "https://api.telnyx.com/v2", docsUrl: "https://developers.telnyx.com", statusUrl: "https://status.telnyx.com", ledger: "tenant_account", booking: TENANT("Telnyx account"), gateway: true },
  bandwidth: { serviceKeys: ["bandwidth"], outputs: "SMS send (BYO number)", transport: "rest", version: "v2", baseUrl: "https://messaging.bandwidth.com/api/v2", docsUrl: "https://dev.bandwidth.com", ledger: "tenant_account", booking: TENANT("Bandwidth account"), gateway: true },
  plivo: { serviceKeys: ["plivo"], outputs: "SMS / voice (no client — vocabulary only)", transport: "rest", version: "v1", baseUrl: "https://api.plivo.com/v1", docsUrl: "https://www.plivo.com/docs/", ledger: "tenant_account", booking: TENANT("Plivo account"), lifecycle: "vocabulary_only" },
  sinch: { serviceKeys: ["sinch"], outputs: "SMS / voice (no client — vocabulary only)", transport: "rest", version: "v1", baseUrl: "https://sms.api.sinch.com/xms/v1", docsUrl: "https://developers.sinch.com", ledger: "tenant_account", booking: TENANT("Sinch account"), lifecycle: "vocabulary_only" },
  // ── calendar ──
  nylas: { serviceKeys: ["nylas"], outputs: "calendar events (no client — vocabulary only)", transport: "rest", version: "v3", baseUrl: "https://api.us.nylas.com/v3", docsUrl: "https://developer.nylas.com", ledger: "tenant_account", booking: TENANT("Nylas account"), lifecycle: "vocabulary_only" },
  // ── transaction / e-sign (PROVIDER_CATALOG + connected esign_send / transaction_forms_open) ──
  skyslope: { serviceKeys: ["skyslope"], outputs: "transaction files + forms, e-sign, webhooks", transport: "rest", version: "unversioned", baseUrl: "https://api.skyslope.com", docsUrl: "https://forms.skyslope.com/partner/api/docs", ledger: "tenant_account", booking: TENANT("SkySlope account"), gateway: true },
  authentisign: { serviceKeys: ["authentisign"], aliases: ["lwolf", "lone_wolf"], outputs: "e-sign envelopes + completion webhook", transport: "rest", version: "unversioned", baseUrl: "https://api.lwolf.com", docsUrl: "https://apidocs.lwolf.com/doc/authentisign-api/topic/topic-getting-started", ledger: "tenant_account", booking: TENANT("Lone Wolf account"), gateway: true },
  brokermint: { serviceKeys: ["brokermint"], aliases: ["broker_mint"], outputs: "transactions / back-office sync", transport: "rest", version: "v1", baseUrl: "https://api.brokermint.com/v1", docsUrl: null, urlNote: "docs: brokermint.com/api is cited as the API reference only by third-party clients (pypi brokermint, brokermint-go) and could not be loaded on 2026-10-08 (non-HTML answer); Lone Wolf's apidocs.lwolf.com names no Brokermint API — unverified, so not declared", ledger: "tenant_account", booking: TENANT("Brokermint account"), gateway: true },
  formsimplicity: { serviceKeys: ["formsimplicity"], aliases: ["form_simplicity"], outputs: "state-association forms + e-sign", transport: "rest", version: "v1", baseUrl: "https://api.formsimplicity.com/v1", docsUrl: "https://api.formsimplicity.com/docs/intro", ledger: "tenant_account", booking: TENANT("Form Simplicity account"), gateway: true },
  // ── showings ──
  showingtime: { serviceKeys: ["showingtime"], outputs: "showing requests + webhook", transport: "rest", version: "v1", baseUrl: "https://api.showingtime.com/v1", docsUrl: null, urlNote: "docs: ShowingTime (Zillow ShowingTime+) publishes no public developer API documentation (2026-10-08 search: integration-partner pages only; access is partner-gated) — not declared", ledger: "tenant_account", booking: TENANT("ShowingTime account"), gateway: true },
  // ── social (connected capability social_account_publish) ──
  meta: { serviceKeys: ["meta"], aliases: ["facebook", "instagram", "whatsapp"], outputs: "lead ads, page/IG publish, DMs, WhatsApp, audiences", transport: "rest", version: "Graph API (versioned path)", baseUrl: "https://graph.facebook.com", docsUrl: "https://developers.facebook.com/docs/graph-api", statusUrl: "https://metastatus.com", changelogUrl: "https://developers.facebook.com/docs/graph-api/changelog", ledger: "tenant_account", booking: TENANT("Meta business account"), envVars: ["META_APP_SECRET"], geography: "global", gateway: true },
  linkedin: { serviceKeys: ["linkedin"], outputs: "post publish, analytics, webhook", transport: "rest", version: "v2", baseUrl: "https://api.linkedin.com", docsUrl: "https://learn.microsoft.com/en-us/linkedin/", ledger: "tenant_account", booking: TENANT("LinkedIn account"), envVars: ["LINKEDIN_CLIENT_ID"], geography: "global", gateway: true },
  twitter: { serviceKeys: ["twitter"], aliases: ["x"], outputs: "post publish, analytics, webhook", transport: "rest", version: "v2", baseUrl: "https://api.twitter.com", docsUrl: "https://docs.x.com/resources/platform-overview", ledger: "tenant_account", booking: TENANT("X account"), envVars: ["TWITTER_CLIENT_ID"], geography: "global", gateway: true },
  tiktok: { serviceKeys: ["tiktok"], outputs: "video publish", transport: "rest", version: "v2", baseUrl: "https://open.tiktokapis.com", docsUrl: "https://developers.tiktok.com/doc/", ledger: "tenant_account", booking: TENANT("TikTok account"), envVars: ["TIKTOK_CLIENT_KEY"], geography: "global", gateway: true },
  youtube: { serviceKeys: ["youtube"], outputs: "video publish", transport: "rest", version: "v3", baseUrl: "https://www.googleapis.com/youtube/v3", docsUrl: "https://developers.google.com/youtube/v3", ledger: "tenant_account", booking: TENANT("YouTube channel"), geography: "global", gateway: true },
  pinterest: { serviceKeys: ["pinterest"], outputs: "pin publish", transport: "rest", version: "v5", baseUrl: "https://api.pinterest.com/v5", docsUrl: "https://developers.pinterest.com/docs/api/v5/", ledger: "tenant_account", booking: TENANT("Pinterest account"), envVars: ["PINTEREST_APP_SECRET"], geography: "global" },
  transistor: { serviceKeys: ["transistor"], aliases: ["podcast_syndicator"], outputs: "podcast episode syndication", transport: "rest", version: "v1", baseUrl: "https://api.transistor.fm", docsUrl: "https://developers.transistor.fm", ledger: "tenant_account", booking: TENANT("Transistor show"), geography: "global", gateway: true },
  wordpress: { serviceKeys: ["wordpress"], outputs: "blog post publish", transport: "rest", version: "wp/v2", baseUrl: "https://public-api.wordpress.com", docsUrl: "https://developer.wordpress.org/rest-api/", ledger: "tenant_account", booking: TENANT("WordPress site"), geography: "global", gateway: true, capabilities: ["blog_publish"] },
  zoom: { serviceKeys: ["zoom", "zoom-oauth", "zoom-recording-download"], outputs: "meetings, recordings → transcripts", transport: "rest", version: "v2", baseUrl: "https://api.zoom.us/v2", docsUrl: "https://developers.zoom.us/docs/api/", statusUrl: "https://status.zoom.us", ledger: "tenant_account", booking: TENANT("Zoom account"), envVars: ["ZOOM_CLIENT_ID"], geography: "global", gateway: true, capabilities: ["meeting_transcript_ingest"] },
  xero: { serviceKeys: ["xero"], outputs: "accounting connection test", transport: "rest", version: "2.0", baseUrl: "https://api.xero.com/api.xro/2.0", docsUrl: "https://developer.xero.com/documentation/", statusUrl: "https://status.xero.com", ledger: "tenant_account", booking: TENANT("Xero organisation"), geography: "global", gateway: true, capabilities: ["accounting"] },
  newsapi_ai: { serviceKeys: ["newsapi_ai"], aliases: ["eventregistry"], outputs: "news articles + concepts/sentiment", transport: "rest", version: "v1", baseUrl: "https://eventregistry.org", docsUrl: "https://newsapi.ai/documentation", ledger: "tenant_account", booking: "none — the tenant's own key first; the platform NEWSAPI_AI_KEY fallback is not booked (published open item)", envVars: ["NEWSAPI_AI_KEY"], geography: "global", gateway: true, capabilities: ["news_intelligence"] },

  // ── platform-paid search / scraping / enrichment (CONNECTOR_REGISTRY) ──
  zenrows: { serviceKeys: ["zenrows"], aliases: ["osint"], outputs: "rendered page HTML (intent / OSINT records lane rides this key)", transport: "rest", version: "v1", priceKey: "zenrows", ledger: "vendor_usage_tracking", booking: "bookSourceSpend (lib/lead-pipeline/source-cost-ledger.ts)", geography: "global", gateway: true, payer: "platform", capabilities: ["web_scrape", "osint_records"] },
  zyte: { serviceKeys: ["zyte"], outputs: "rendered page HTML / extraction (ZenRows fallback)", transport: "rest", version: "v1", priceKey: "zyte", ledger: "vendor_usage_tracking", booking: "bookSourceSpend (lib/lead-pipeline/source-cost-ledger.ts)", statusUrl: "https://status.zyte.com", geography: "global", gateway: true, payer: "platform", capabilities: ["web_scrape"] },
  exa: { serviceKeys: ["exa"], outputs: "neural web search (exa-js SDK, lib/providers/exa/client.ts)", transport: "sdk", version: "unversioned", priceKey: "exa", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/providers/dispatch.ts)", geography: "global", payer: "platform", capabilities: ["web_search"] },
  tavily: { serviceKeys: ["tavily"], outputs: "web search + answer (healer research)", transport: "rest", version: "unversioned", priceKey: "tavily", ledger: "vendor_usage_tracking", booking: "bookSourceSpend (lib/lead-pipeline/source-cost-ledger.ts)", geography: "global", gateway: true, payer: "platform", capabilities: ["web_search", "provider_setup_research"] },
  google_ai: { serviceKeys: ["google_ai"], aliases: ["gemini"], outputs: "model completions (reached as a gateway model)", transport: "gateway", version: "v1beta", ledger: "ai_tool_usage", booking: "logAIUsage (lib/ai/cost-tracking.ts)", geography: "global", payer: "platform", capabilities: ["ai"] },
  openai: { serviceKeys: ["openai", "gpt-image-edit"], aliases: ["gpt"], outputs: "image generation + photo edit (direct key)", transport: "rest", version: "v1", baseUrl: "https://api.openai.com/v1", docsUrl: "https://platform.openai.com/docs/api-reference", statusUrl: "https://status.openai.com", changelogUrl: "https://platform.openai.com/docs/changelog", priceKey: "openai_image", ledger: "ai_tool_usage", booking: "logAIImageUsage (lib/ai/image-generation.ts) — generation; photo edits book the same primitive in lib/listings/photo-intelligence.ts (wave 139)", envVars: ["OPENAI_API_KEY"], geography: "global", gateway: true, payer: "platform", capabilities: ["image_generation"] },
  housecanary: { serviceKeys: ["housecanary"], outputs: "property valuation (staff connection test only)", transport: "rest", version: "v2", baseUrl: "https://api.housecanary.com/v2", docsUrl: "https://api-docs.housecanary.com", ledger: "tenant_account", booking: "none — reached only by the superadmin provider test; no production call path", envVars: ["HOUSECANARY_API_KEY"], gateway: true, capabilities: ["provider_connection_test"] },
  simli: { serviceKeys: ["simli"], outputs: "live face render (D-ID backup)", transport: "rest", version: "unversioned", baseUrl: "https://api.simli.ai", docsUrl: "https://docs.simli.com", ledger: "vendor_usage_tracking", booking: "logVendorUsage (lib/did/live-session-metering.ts)", envVars: ["SIMLI_API_KEY"], geography: "global", gateway: true, payer: "platform", unitUsd: SIMLI_USD_PER_STREAMING_MINUTE, unit: "streaming minute", capabilities: ["live_avatar"] },
  voicedrop: { serviceKeys: ["voicedrop"], aliases: ["slybroadcast"], outputs: "ringless voicemail drop", transport: "rest", version: "unversioned", baseUrl: "https://www.mobile-sphere.com", docsUrl: "https://www.slybroadcast.com/documentation", priceKey: "voicedrop", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/voicedrop/orchestrate-voicedrop-send.ts) — one unit per delivered drop, price explicitly UNKNOWN (wave 139)", envVars: ["VOICEDROP_API_KEY"], gateway: true, payer: "platform", capabilities: ["voicemail_drop"] },
  // ── keyless / free public data (nothing to book) ──
  // Wave 139 (139B): found by the RAW-FETCH census (no key, no client module — invisible to the 138
  // census) and moved onto the gateway. NOTE (owner): Open-Meteo's keyless tier is licensed for
  // NON-commercial use; a commercial SaaS needs its paid API key (customer-api.open-meteo.com) — no
  // price is declared here (unknown stays unknown).
  open_meteo: { serviceKeys: ["open_meteo"], aliases: ["openmeteo"], outputs: "daily forecast at a lat/lon (open-house weather)", transport: "rest", version: "v1", baseUrl: "https://api.open-meteo.com/v1", docsUrl: "https://open-meteo.com/en/docs", ledger: "free", booking: "none — keyless free API (commercial-use licence is an owner item)", geography: "global", gateway: true, payer: "platform", capabilities: ["weather_forecast"] },
  osint_free: { serviceKeys: ["nominatim", "overpass", "census"], aliases: ["osm"], outputs: "geocode, amenities, ACS median value", transport: "rest", version: "unversioned", baseUrl: "https://nominatim.openstreetmap.org", docsUrl: "https://nominatim.org/release-docs/latest/api/Overview/", priceKey: "osint_free", ledger: "free", booking: "none — keyless free tiers", gateway: true, payer: "platform", capabilities: ["geocode", "neighborhood_facts"] },
  socrata: { serviceKeys: ["socrata"], outputs: "permits / code violations / probate (public records)", transport: "rest", version: "SODA 2.1", ledger: "free", booking: "none — public open data (app token raises the rate limit only)", gateway: true, payer: "platform", capabilities: ["public_records"] },
  arcgis: { serviceKeys: ["arcgis"], outputs: "permit FeatureServer layers (public records)", transport: "rest", version: "FeatureServer query", ledger: "free", booking: "none — anonymous public layers", gateway: true, payer: "platform", capabilities: ["public_records"] },
  fred: { serviceKeys: ["fred"], outputs: "mortgage / market rate series", transport: "rest", version: "fredgraph.csv", baseUrl: "https://fred.stlouisfed.org", docsUrl: "https://fred.stlouisfed.org/docs/api/fred/", ledger: "free", booking: "none — public CSV", gateway: true, payer: "platform", capabilities: ["market_rates"] },
  reddit: { serviceKeys: ["reddit"], outputs: "public subreddit posts (content intel)", transport: "rest", version: "public JSON", baseUrl: "https://www.reddit.com", docsUrl: "https://www.reddit.com/dev/api/", ledger: "free", booking: "none — public JSON listing", gateway: true, payer: "platform", capabilities: ["content_intel"] },
  pexels: { serviceKeys: ["pexels"], outputs: "stock photos", transport: "rest", version: "v1", baseUrl: "https://api.pexels.com/v1", docsUrl: "https://www.pexels.com/api/documentation/", ledger: "free", booking: "none — free API (attribution)", envVars: ["PEXELS_API_KEY"], geography: "global", payer: "platform", capabilities: ["stock_media"], gateway: true },
  geoapify: { serviceKeys: ["geoapify"], outputs: "POI places near an address", transport: "rest", version: "v2", baseUrl: "https://api.geoapify.com/v2", docsUrl: "https://apidocs.geoapify.com", ledger: "free", booking: "none — free tier (3,000 credits/day); over-tier spend is NOT booked (published open item)", envVars: ["GEOAPIFY_API_KEY"], geography: "global", payer: "platform", capabilities: ["local_places"], gateway: true },
  // ── platform infrastructure + browser keys (outside the rails by nature — published) ──
  google_maps: { serviceKeys: ["google_maps"], outputs: "static map / street view images, browser maps", transport: "browser", version: "Maps JS + Static APIs", baseUrl: "https://maps.googleapis.com/maps/api", docsUrl: "https://developers.google.com/maps/documentation", statusUrl: "https://status.cloud.google.com/maps-platform/", priceKey: "google_maps", ledger: "vendor_usage_tracking", booking: "meterVendorSpend (lib/property/street-view.ts) — server-minted Street View / Static Map images (bookMapsImageSpend, wave 139); browser-only loads (team-heatmap Maps JS, the tour tab's client static map) have no server rail and reconcile against the platform Google Cloud invoice", envVars: ["GOOGLE_MAPS_API_KEY"], geography: "global", payer: "platform", capabilities: ["maps_render"],
    exception: "a browser-loaded key (NEXT_PUBLIC_*) and lib/property/street-view.ts image URLs — the browser calls Google directly, so no server rail can carry it" },
  // Wave 139 (139C) re-proven at HEAD: NO Mapbox request exists anywhere (no SDK, no api.mapbox.com
  // URL — scripts/cost-completeness-guard.ts proves the absence with a positive control). MAPBOX_TOKEN
  // is read ONLY by a key-presence check (app/dashboard/team-heatmap/page.tsx) whose map then loads
  // Google Maps JS — so there is no Mapbox spend to book. A future Mapbox client books through
  // meterVendorSpend and moves this row back to live.
  mapbox: { serviceKeys: ["mapbox"], outputs: "none — token read by a key-presence check only (no Mapbox call)", transport: "browser", version: "GL JS", baseUrl: "https://api.mapbox.com", docsUrl: "https://docs.mapbox.com", statusUrl: "https://status.mapbox.com", ledger: "free", booking: "none — no Mapbox request exists in code (nothing is spent)", lifecycle: "vocabulary_only", envVars: ["MAPBOX_TOKEN"], geography: "global", payer: "platform", capabilities: ["maps_render"],
    exception: "vocabulary only: MAPBOX_TOKEN is read by app/dashboard/team-heatmap/page.tsx's key-presence check, but no Mapbox request is made (the heatmap loads Google Maps JS)" },
  web_push: { serviceKeys: ["web_push"], aliases: ["vapid"], outputs: "browser push notifications", transport: "sdk", version: "RFC 8030 + VAPID", baseUrl: "https://fcm.googleapis.com", docsUrl: "https://web.dev/articles/push-notifications-overview", ledger: "free", booking: "none — browser push services are free", envVars: ["VAPID_PRIVATE_KEY"], geography: "global", payer: "platform", capabilities: ["push_notify"],
    exception: "the push endpoint is each subscription's own browser-vendor URL (lib/providers/web-push.ts) — not a fixed connector the gateway can name" },
  vercel: { serviceKeys: ["vercel"], outputs: "custom-domain attach / verify", transport: "rest", version: "v10 domains", baseUrl: "https://api.vercel.com", docsUrl: "https://vercel.com/docs/rest-api", statusUrl: "https://www.vercel-status.com", changelogUrl: "https://vercel.com/changelog", ledger: "free", booking: "none — platform hosting account (domain calls carry no per-call charge)", envVars: ["VERCEL_TOKEN"], geography: "global", payer: "platform", capabilities: ["custom_domain"], gateway: true },
  remotion: { serviceKeys: ["remotion"], outputs: "video render (in-process Chromium)", transport: "in_process", version: "@remotion/renderer (package.json)", baseUrl: "", docsUrl: "https://www.remotion.dev/docs", changelogUrl: "https://github.com/remotion-dev/remotion/releases", ledger: "free", booking: "none — renders on our own compute (no per-call vendor charge)", geography: "global", payer: "platform", capabilities: ["video_render"],
    exception: "an in-process render library (lib/remotion/**), not a network provider — there is no egress to route" },
  // ── ad platforms (wave 139, 139B: every egress now a callConnector site — the exceptions are gone) ──
  openai_ads: { serviceKeys: ["openai_ads"], aliases: ["chatgpt_ads"], outputs: "ChatGPT ad campaign launch", transport: "rest", version: "v1", baseUrl: "https://api.ads.openai.com/v1", docsUrl: "https://developers.openai.com/ads/api-quickstart", ledger: "tenant_account", booking: TENANT("OpenAI Ads account (ad spend is the tenant's)"), geography: "global", capabilities: ["ads_launch"], gateway: true },
  vibe: { serviceKeys: ["vibe"], outputs: "streaming-TV (CTV) ad campaign launch", transport: "rest", version: "X-Vibe-Revision", baseUrl: "https://api.vibe.co", docsUrl: "https://developers.vibe.co", ledger: "tenant_account", booking: TENANT("Vibe account (ad spend is the tenant's)"), capabilities: ["ads_launch"], gateway: true },
  google_ads: { serviceKeys: ["google_ads"], outputs: "ads account OAuth; campaign publish, Customer Match upload, searchStream reporting (lib/ads/connectors/google.ts)", transport: "rest", version: "v17", baseUrl: "https://googleads.googleapis.com", docsUrl: "https://developers.google.com/google-ads/api/docs/start", ledger: "tenant_account", booking: TENANT("Google Ads account"), envVars: ["GOOGLE_ADS_DEVELOPER_TOKEN"], geography: "global", capabilities: ["ads_connect", "ads_launch"], gateway: true },
  // ── inbound-only / unimplemented (published) ──
  ce_provider: { serviceKeys: ["ce_provider"], outputs: "accredited CE completion webhook (inbound)", transport: "rest", version: "HMAC-SHA256 webhook", baseUrl: "https://www.arello.org", docsUrl: null, urlNote: "docs: no single vendor — any accredited CE provider POSTs to OUR HMAC webhook (app/api/webhooks/ce-provider), so the contract is ours; ARELLO certifies distance-education courses and publishes no API (its homepage was a placeholder root)", ledger: "tenant_account", booking: "none — inbound only", lifecycle: "inbound_only", capabilities: ["ce_credit_ingest"],
    exception: "inbound-only: the accredited CE provider POSTs completions (app/api/webhooks/ce-provider) — there is no outbound call to route" },
  listing_portals: { serviceKeys: ["listing_portals"], aliases: ["zillow", "realtor", "realtor_com", "redfin", "trulia", "mls", "syndication"], outputs: "listing syndication (no partner feed — fails honestly)", transport: "rest", version: "none", baseUrl: "https://www.listhub.com", docsUrl: null, urlNote: "docs: no syndication partner feed is contracted (lifecycle unimplemented) — the ListHub homepage was a placeholder root, not API documentation; the partner's docs land with the feed", ledger: "tenant_account", booking: "none — no call is made", lifecycle: "unimplemented", capabilities: ["listing_syndication"],
    exception: "lib/platform-sync.ts reads ZILLOW/REALTOR/REDFIN/TRULIA/MLS keys but the portals offer no public listing API — syndication needs a ListHub/partner feed (vendor_connection_audit); every path fails honestly" },
}

// ─── URL integrity (wave 139, lane 139D) ──────────────────────────────────────

/**
 * The OFFICIAL domains a provider's docs / status / changelog pages live on, beyond the domain of its
 * own API endpoint (always official). Each extra names why — a parent company, a docs host, a status
 * host. Verified 2026-10-08 with the URLs themselves (lane notes). One row per provider whose pages
 * are not on its endpoint's domain; nothing else is accepted.
 */
const OFFICIAL_URL_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["vercel-status.com"],              // reached through the Vercel AI Gateway — its status page
  sendgrid: ["twilio.com"],                      // SendGrid is a Twilio company; its v3 reference lives there
  google: ["google.com"],                        // developers.google.com docs, Workspace status dashboard
  youtube: ["google.com"],
  google_maps: ["google.com"],
  google_ads: ["google.com"],
  google_ai: ["google.dev"],                     // ai.google.dev (Gemini API docs)
  web_push: ["web.dev"],                         // Google's web.dev — the Push API overview (a web standard)
  docusign: ["docusign.com"],                    // endpoint www.docusign.net; docs + status on docusign.com
  dotloop: ["dotloop.github.io"],                // dotloop's own public-api GitHub Pages
  buffer: ["buffer.com"],                        // endpoint api.bufferapp.com
  gohighlevel: ["gohighlevel.com"],              // endpoint services.leadconnectorhq.com
  hubspot: ["hubspot.com"],                      // endpoint api.hubapi.com
  outlook: ["cloud.microsoft"],                  // status.cloud.microsoft
  linkedin: ["microsoft.com"],                   // LinkedIn API docs live on Microsoft Learn
  twitter: ["x.com"],                            // endpoint api.twitter.com; docs.x.com
  tiktok: ["tiktok.com"],                        // endpoint open.tiktokapis.com
  meta: ["metastatus.com"],                      // Meta's business status page
  wordpress: ["wordpress.org"],                  // developer.wordpress.org REST handbook
  mailgun: ["mailgun.com"],                      // endpoint api.mailgun.net
  newsapi_ai: ["newsapi.ai"],                    // endpoint eventregistry.org (same company)
  voicedrop: ["slybroadcast.com"],               // endpoint www.mobile-sphere.com (Slybroadcast's gateway)
  osint_free: ["nominatim.org"],                 // endpoint nominatim.openstreetmap.org
  socrata: ["socrata.com"],                      // endpoint is per-city (example host)
  remotion: ["remotion.dev", "github.com"],      // in-process (no endpoint); changelog = the remotion-dev repo releases
  simli: ["simli.com"],                          // endpoint api.simli.ai; docs.simli.com
  vercel: ["vercel-status.com"],                 // Vercel's status page
}

/** PURE — the registrable domain of a host (last two labels; enough for every host declared here). */
function domainOf(host: string): string {
  return host.toLowerCase().split(".").slice(-2).join(".")
}

const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|localhost|invalid|test|local)$|placeholder|changeme|\btodo\b|your-?(company|domain|site)/i
/** First host labels that ARE a documentation site (so its bare root is a docs page, not a homepage). */
const DOCS_HOST_LABEL = /^(docs?|developers?|dev|api-?docs|api-documentation|documentation|learn|help|reference)$/i

/**
 * PURE — why a declared docs / status / changelog URL is a PLACEHOLDER (null = it is not): not https,
 * a reserved / placeholder host, a site HOMEPAGE standing in for a docs page (the wave-138 research
 * roots), a "status" URL that names no status page, a "changelog" URL that names no changelog.
 * In-file only: scripts/provider-adapter-guard.ts (section N) plants placeholders through
 * validateProviderAdapter, its one reader.
 */
function urlPlaceholderProblem(kind: "docs" | "status" | "changelog", url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return `${kind} URL is not a URL` }
  if (u.protocol !== "https:") return `${kind} URL is not https`
  const host = u.hostname.toLowerCase()
  if (PLACEHOLDER_HOST.test(host)) return `${kind} URL uses a placeholder host (${host})`
  const bareRoot = u.pathname === "/" || u.pathname === ""
  if (kind === "docs" && bareRoot && !DOCS_HOST_LABEL.test(host.split(".")[0])) return `docs URL ${url} is a site homepage, not a documentation page (a placeholder root)`
  if (kind === "status" && !/status/i.test(host + u.pathname)) return `status URL ${url} names no status page`
  if (kind === "changelog" && !/changelog|release|whats-?new/i.test(u.pathname)) return `changelog URL ${url} names no changelog / release notes`
  return null
}

/** PURE — the domains a provider's pages may live on: its endpoint's domain + its declared extras. */
function officialDomains(a: Pick<ProviderAdapter, "provider" | "api">): Set<string> {
  const out = new Set<string>(OFFICIAL_URL_DOMAINS[a.provider] ?? [])
  try { if (a.api.baseUrl) out.add(domainOf(new URL(a.api.baseUrl).hostname)) } catch { /* no endpoint — extras only */ }
  return out
}

/** PURE — every URL fault of ONE declaration (placeholder shape, off-domain, a null docs root with no
 *  published reason). Read by validateProviderAdapter. */
function urlIntegrityFaults(a: ProviderAdapter): string[] {
  const errs: string[] = []
  const official = officialDomains(a)
  for (const [kind, url] of [["docs", a.api.docsUrl], ["status", a.api.statusUrl], ["changelog", a.api.changelogUrl]] as const) {
    if (!url) continue
    const shape = urlPlaceholderProblem(kind, url)
    if (shape) { errs.push(shape); continue }
    const host = new URL(url).hostname.toLowerCase()
    if (![...official].some((d) => host === d || host.endsWith(`.${d}`))) errs.push(`${kind} URL ${url} is not on an official ${a.provider} domain (${[...official].join(", ") || "none declared"}) — verify it or null it with a reason`)
  }
  if (!a.api.docsUrl && (a.api.urlNote ?? "").trim().length < 40) errs.push("no docs URL and no published reason (urlNote) — an unverifiable docs root is NULL WITH ITS REASON, never silent")
  return errs
}

// ─── route tables → routed names ──────────────────────────────────────────────

/** ONE normalization for every provider spelling (route tables, gateway keys, env prefixes). */
function norm(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^next_public_/, "")
}

/** Every name a kernel route table routes to, with the path(s) that reach it. */
function routedNames(): Map<string, Set<KernelRoutePath>> {
  const out = new Map<string, Set<KernelRoutePath>>()
  const add = (name: string, path: KernelRoutePath) => { const k = norm(name); if (!k) return; (out.get(k) ?? out.set(k, new Set()).get(k)!).add(path) }
  for (const entries of Object.values(CONTACT_PROVIDER_ROUTES)) for (const e of entries) add(e.provider, "capability_router")
  for (const v of Object.values(SYSTEM_DEFAULTS)) add(v, "provider_cascade")
  for (const def of Object.values(CONNECTED_CAPABILITY_REGISTRY)) for (const c of def.connections) add(c, "connected_capability")
  for (const name of Object.keys(PROVIDER_CATALOG)) add(name, "transaction_resolver")
  for (const name of Object.keys(CONNECTOR_REGISTRY)) add(name, "connector_registry")
  return out
}

/** Every provider name the kernel route tables route to (normalized, sorted).
 *  @proofSeam scripts/provider-adapter-guard.ts compares it to the derived adapters; the production
 *  reader is deriveProviderAdapters in this file. */
export function routedProviders(): string[] {
  return [...routedNames().keys()].sort()
}

/** name → facts key over the provider key, its gateway service keys, aliases, registry + tenancy keys. */
function nameIndex(facts: Readonly<Record<string, AdapterFacts>>): Map<string, string> {
  const idx = new Map<string, string>()
  for (const [key, f] of Object.entries(facts)) {
    for (const n of [key, ...f.serviceKeys, ...(f.aliases ?? []), f.registryKey ?? "", f.tenancyKey ?? ""]) {
      const k = norm(n)
      if (k && !idx.has(k)) idx.set(k, key)
    }
  }
  return idx
}

/**
 * The declared provider a name resolves to (exact, after normalization) — or, with `prefix`, the
 * longest leading run of `_`-tokens that resolves (BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET → batchdata,
 * twilio-sms-status → twilio). null = no declaration accounts for it.
 * @proofSeam the guard's census resolves every derived signal through it; production reader: adapterFor.
 */
export function resolveAdapterKey(name: string, opts: { prefix?: boolean } = {}, facts: Readonly<Record<string, AdapterFacts>> = ADAPTER_FACTS): string | null {
  const idx = nameIndex(facts)
  const n = norm(name)
  if (idx.has(n)) return idx.get(n)!
  if (!opts.prefix) return null
  const tokens = n.split("_")
  for (let i = tokens.length - 1; i >= 1; i--) {
    const hit = idx.get(tokens.slice(0, i).join("_"))
    if (hit) return hit
  }
  return null
}

// ─── derivation ────────────────────────────────────────────────────────────────

function priceFor(names: Set<string>, facts: AdapterFacts): { unitUsd: number; unit: string; priceSource: string; priceState: PriceState | "tenant_account" } {
  const routed = Object.values(CONTACT_PROVIDER_ROUTES).flat().filter((e) => names.has(norm(e.provider)))
  if (routed.length) return { unitUsd: Math.min(...routed.map((e) => e.unitCostUsd)), unit: "call/match", priceSource: "CONTACT_PROVIDER_ROUTES", priceState: "fixed" }
  const k = facts.priceKey
  const platform = k ? (PLATFORM_VENDOR_RATES as Record<string, { perUnit: number; unit: string }>)[k] : undefined
  if (platform) return { unitUsd: platform.perUnit, unit: platform.unit, priceSource: `PLATFORM_VENDOR_RATES.${k}`, priceState: "fixed" }
  const vp = k ? VENDOR_PRICING[k] : undefined
  // Wave 139 (139C): the row's own STATE rides along (variable / unknown are declarations, not gaps).
  if (vp) return { unitUsd: vp.costPerUnit, unit: vp.unitType, priceSource: `VENDOR_PRICING.${k}${vp.priceSource ? ` — ${vp.priceSource}` : ""}`, priceState: vendorPriceState(k as string) }
  if (typeof facts.unitUsd === "number") return { unitUsd: facts.unitUsd, unit: facts.unit ?? "call", priceSource: "ADAPTER_FACTS (declared — no price table carries it)", priceState: facts.unitUsd > 0 ? "fixed" : "free" }
  // A model reached through the gateway is priced PER MODEL in tokens by the AI ledger's own table.
  if (facts.ledger === "ai_tool_usage") return { unitUsd: 0, unit: "tokens", priceSource: "per-model token pricing — getModelPricing (lib/ai/cost-tracking.ts)", priceState: "variable" }
  return facts.ledger === "free"
    ? { unitUsd: 0, unit: "n/a", priceSource: "free / keyless", priceState: "free" }
    : { unitUsd: 0, unit: "n/a", priceSource: "tenant account (no platform price)", priceState: "tenant_account" }
}

function deriveOne(provider: string, facts: AdapterFacts, names: Set<string>, paths: Set<KernelRoutePath>): ProviderAdapter {
  const dataCaps = (Object.keys(CONTACT_PROVIDER_ROUTES) as ProviderCapability[]).filter((c) => CONTACT_PROVIDER_ROUTES[c].some((e) => names.has(norm(e.provider))))
  const channelTypes = Object.entries(SYSTEM_DEFAULTS).filter(([, v]) => names.has(norm(v))).map(([t]) => t)
  const connectedCaps = Object.values(CONNECTED_CAPABILITY_REGISTRY).filter((d) => d.connections.some((c) => names.has(norm(c)))).map((d) => d.capability as string)
  const catalogCaps = Object.values(PROVIDER_CATALOG).filter((p) => names.has(norm(p.name)))
    .flatMap((p) => [...(p.capabilities.esign ? ["esign"] : []), ...(p.capabilities.transactionForms ? ["transaction_forms"] : [])])
  const reg = CONNECTOR_REGISTRY[facts.registryKey ?? provider]
  const tenancy = PROVIDER_TENANCY.find((t) => t.provider === (facts.tenancyKey ?? provider)) ?? null
  const primaryModel = tenancy?.models[0] ?? null
  const payer: AdapterPayer = facts.payer ?? (channelTypes.some((t) => SYSTEM_ONLY_TYPES.has(t)) || primaryModel === "platform_metered" || primaryModel === "platform_subaccount" || (dataCaps.length > 0 && !channelTypes.length)
    ? "platform" : "tenant")
  const fallback: Record<string, string[]> = {}
  for (const c of dataCaps) {
    const order = CONTACT_PROVIDER_ROUTES[c].map((e) => e.provider)
    fallback[c] = order.filter((p) => !names.has(norm(p)))
  }
  const envVars = facts.envVars ?? (reg?.envKey ? [reg.envKey] : tenancy?.envVars ?? [])
  return {
    provider,
    aliases: [...new Set([...facts.serviceKeys, ...(facts.aliases ?? []), ...(facts.registryKey ? [facts.registryKey] : [])])].filter((a) => a !== provider),
    lifecycle: facts.lifecycle ?? "live",
    capabilities: [...new Set([...dataCaps, ...channelTypes, ...connectedCaps, ...catalogCaps, ...(facts.capabilities ?? [])])],
    inputs: dataCaps.length ? [...new Set(dataCaps.flatMap((c) => CONTACT_PROVIDER_ROUTES[c].filter((e) => names.has(norm(e.provider))).map((e) => e.keyedBy)))] : [...channelTypes, ...connectedCaps].map((t) => `${t} request`),
    outputs: facts.outputs,
    cost: { payer, ...priceFor(names, facts), ledger: facts.ledger, booking: facts.booking },
    health: { serviceKeys: facts.serviceKeys, liveProbe: facts.serviceKeys.find((k) => !!PROBE_SPECS[k]) ?? (PROBE_SPECS[provider] ? provider : null), derivedFrom: "api_response_logs", failingStreak: PROVIDER_HEALTH_POLICY.failingStreak, cooldownMs: PROVIDER_HEALTH_POLICY.cooldownMs },
    rateLimits: { state: "rate_limited", note: "a 429 is the gateway's rate_limited outcome (deriveProviderHealth); GET retries once, a write never" },
    credential: { survivor: payer === "platform" ? (facts.ledger === "free" && !envVars.length ? "keyless" : "platform_env") : "tenant_connection", envVars },
    eligibility: { tenancyModels: tenancy?.models ?? [], geography: facts.geography ?? "us_nationwide" },
    fallback,
    provenance: [
      ...(dataCaps.length ? ["CONTACT_PROVIDER_ROUTES"] : []),
      ...(channelTypes.length ? ["SYSTEM_DEFAULTS"] : []),
      ...(connectedCaps.length ? ["CONNECTED_CAPABILITY_REGISTRY"] : []),
      ...(catalogCaps.length ? ["PROVIDER_CATALOG"] : []),
      ...(reg ? ["CONNECTOR_REGISTRY"] : []),
      ...(tenancy ? ["PROVIDER_TENANCY"] : []),
      "ADAPTER_FACTS",
    ],
    route: { paths: [...paths].sort(), exception: facts.exception ?? null },
    api: {
      transport: facts.transport, version: facts.version,
      baseUrl: reg?.baseUrl ?? facts.baseUrl ?? "",
      docsUrl: reg?.docsUrl ?? facts.docsUrl ?? null,
      statusUrl: facts.statusUrl ?? null,
      changelogUrl: facts.changelogUrl ?? null,
      urlNote: facts.urlNote ?? null,
      sdk: reg?.npmSdk ?? null,
      mcp: reg?.mcpServer?.url ?? reg?.mcpServer?.githubUrl ?? null,
      deprecatedAfter: reg?.deprecatedAfter ?? null,
      alternates: reg?.alternates ?? [],
    },
  }
}

/** Derive one adapter per declared provider a kernel path reaches (or that publishes its exception).
 *  `missing` = a routed name no declaration accounts for; `unrouted` = a declaration no path reaches
 *  and no exception explains (both refusals).
 *  @proofSeam scripts/provider-adapter-guard.ts runs it over edited facts (the positive controls); the
 *  production reader is adapterFor in this file. */
export function deriveProviderAdapters(facts: Readonly<Record<string, AdapterFacts>> = ADAPTER_FACTS): { adapters: ProviderAdapter[]; missing: string[]; unrouted: string[] } {
  const idx = nameIndex(facts)
  const pathsByKey = new Map<string, Set<KernelRoutePath>>()
  const namesByKey = new Map<string, Set<string>>()
  for (const [n, k] of idx) (namesByKey.get(k) ?? namesByKey.set(k, new Set()).get(k)!).add(n)
  const missing: string[] = []
  for (const [name, paths] of routedNames()) {
    const k = idx.get(name)
    if (!k) { missing.push(name); continue }
    const set = pathsByKey.get(k) ?? pathsByKey.set(k, new Set()).get(k)!
    for (const p of paths) set.add(p)
  }
  for (const [k, f] of Object.entries(facts)) if (f.gateway) (pathsByKey.get(k) ?? pathsByKey.set(k, new Set()).get(k)!).add("connector_gateway")
  const adapters: ProviderAdapter[] = []
  const unrouted: string[] = []
  for (const [k, f] of Object.entries(facts)) {
    const paths = pathsByKey.get(k)
    if (!paths?.size && !f.exception) { unrouted.push(k); continue }
    adapters.push(deriveOne(k, f, namesByKey.get(k) ?? new Set([norm(k)]), paths ?? new Set()))
  }
  return { adapters, missing: missing.sort(), unrouted }
}

let cached: ProviderAdapter[] | null = null
/** The VALID adapter declared for a provider name, alias OR a gateway service key (api_response_logs.service_key).
 *  An invalid declaration is not served (fail closed): the healer then only proposes, never applies. */
export function adapterFor(providerOrServiceKey: string): ProviderAdapter | null {
  if (!cached) {
    const derived = deriveProviderAdapters()
    const errs = validateAdapterSet(derived)
    if (errs.length) console.error(`[provider-adapters] ${errs.length} declaration fault(s) — those adapters are not served:`, errs.slice(0, 5).join(" | "))
    cached = derived.adapters.filter((a) => validateProviderAdapter(a).length === 0)
  }
  const key = resolveAdapterKey(providerOrServiceKey)
  return cached.find((a) => a.provider === key) ?? null
}

/** The CONFIG-level alternate a provider declares under this id (never a code-level one). */
export function declaredConfigAlternate(providerOrServiceKey: string, alternateId: string): { adapter: ProviderAdapter; alternate: AdapterAlternate } | null {
  const adapter = adapterFor(providerOrServiceKey)
  const alternate = adapter?.api.alternates.find((a) => a.id === alternateId && a.level === "config") ?? null
  return adapter && alternate ? { adapter, alternate } : null
}

// ─── validation ────────────────────────────────────────────────────────────────

const HTTPS = /^https:\/\//

/** PURE — what is wrong with ONE declaration ([] = valid).
 *  @proofSeam the guard refuses a forged unmetered adapter through it; production reader: adapterFor. */
export function validateProviderAdapter(a: ProviderAdapter): string[] {
  const errs: string[] = []
  if (!a.capabilities.length) errs.push("no capability — a provider no capability routes to is not an adapter")
  if (!a.api.version.trim()) errs.push("no API version declared")
  if (a.api.transport !== "in_process" && !HTTPS.test(a.api.baseUrl)) errs.push("no https endpoint declared")
  // Wave 139 (139D): a docs root is either a verified official page or NULL WITH ITS REASON (urlNote);
  // a placeholder / off-domain / non-https URL is refused (urlIntegrityFaults — it covers status +
  // changelog too). A null docs root leaves the research step to search by provider name.
  errs.push(...urlIntegrityFaults(a))
  if (!a.health.serviceKeys.length) errs.push("no health service key — its outcomes cannot be judged")
  if (a.credential.survivor === "platform_env" && !a.credential.envVars.length) errs.push("platform credential with no env var named")
  if (!a.route.paths.length && (a.route.exception ?? "").trim().length < 20) errs.push("reached through no kernel path and publishes no exception reason")
  // Wave 138: an UNPRICED platform-paid adapter is no less paid — any platform payer outside the free
  // ledger must name a real booking (a priced one is the 137 rule; an unpriced one used to slip past).
  const paid = a.cost.payer === "platform" && (a.cost.unitUsd > 0 || a.cost.ledger !== "free")
  if (paid && (a.cost.ledger === "tenant_account" || a.cost.ledger === "free" || !a.cost.booking.trim() || /^none\b/.test(a.cost.booking))) errs.push("UNMETERED PAID adapter — a platform-paid call must name its usage booking")
  // Wave 139 (139C): an EXPLICITLY UNKNOWN price (VENDOR_PRICING priceState 'unknown', with its reason)
  // is a declaration — the booking records units with price_state 'unknown' — not a missing price.
  if (a.cost.payer === "platform" && a.cost.unitUsd <= 0 && a.cost.ledger !== "ai_tool_usage" && a.cost.ledger !== "free" && a.cost.priceState !== "unknown") errs.push("platform-paid adapter with no declared price")
  if (a.cost.ledger === "free" && a.cost.unitUsd > 0) errs.push("a FREE ledger cannot carry a price — a priced call books to vendor_usage_tracking")
  const ids = new Set<string>()
  for (const alt of a.api.alternates) {
    if (ids.has(alt.id)) errs.push(`duplicate alternate ${alt.id}`)
    ids.add(alt.id)
    if (alt.level === "config" && !alt.version && !alt.baseUrl && !alt.query && !alt.headers) errs.push(`config alternate ${alt.id} changes nothing`)
    if (alt.baseUrl && !HTTPS.test(alt.baseUrl)) errs.push(`alternate ${alt.id} endpoint is not https`)
    if (alt.level === "code" && !alt.route) errs.push(`code alternate ${alt.id} names no route module`)
  }
  return errs
}

/** PURE — the whole set against the routed providers.
 *  @proofSeam the guard asserts it clean + its positive controls; production reader: adapterFor. */
export function validateAdapterSet(derived: { adapters: ProviderAdapter[]; missing: string[]; unrouted: string[] }): string[] {
  const errs: string[] = []
  for (const p of derived.missing) errs.push(`${p}: ROUTED but no adapter declaration`)
  for (const p of derived.unrouted) errs.push(`${p}: declared but nothing routes to it — a provider plugs in through the route table (or publishes its exception)`)
  for (const a of derived.adapters) for (const e of validateProviderAdapter(a)) errs.push(`${a.provider}: ${e}`)
  for (const a of derived.adapters) for (const [cap, next] of Object.entries(a.fallback)) for (const p of next) if (!derived.adapters.some((x) => x.provider === p)) errs.push(`${a.provider}: fallback ${p} for ${cap} has no adapter`)
  return errs
}

// ─── usage booking ─────────────────────────────────────────────────────────────

/**
 * ONE booking per EXECUTED adapter call; a refused/failed call books nothing (§: "a refused call books
 * none"). Platform-paid vendor adapters book through meterVendorSpend (vendor_usage_tracking); an AI
 * adapter books through logAIUsage at the gateway (not here); a tenant-account adapter books nothing.
 */
export async function bookAdapterUsage(
  adapter: ProviderAdapter,
  call: { brokerageId: string | null; executed: boolean; units?: number; systemSource: string; usageType: string },
  deps: { meter?: (input: MeterVendorInput) => Promise<boolean> } = {},
): Promise<boolean> {
  if (!call.executed) return false
  // Wave 139 (139C): an explicitly UNKNOWN price still books the units ($0 with price_state 'unknown').
  const unknown = adapter.cost.priceState === "unknown"
  if (adapter.cost.ledger !== "vendor_usage_tracking" || (adapter.cost.unitUsd <= 0 && !unknown)) return false
  const units = call.units && call.units > 0 ? call.units : 1
  return (deps.meter ?? meterVendorSpend)({
    vendorName: adapter.provider, usageType: call.usageType, unitCount: units,
    cost: unknown ? 0 : Math.round(adapter.cost.unitUsd * units * 10000) / 10000,
    ...(unknown || adapter.cost.priceState === "variable" ? { priceState: adapter.cost.priceState as PriceState } : {}),
    costBasis: "estimated",
    brokerageId: call.brokerageId, systemSource: call.systemSource,
    metadata: { adapter_version: adapter.api.version, price_source: adapter.cost.priceSource },
  })
}

// ─── self-healing decision (PURE) ─────────────────────────────────────────────

export type ProbeVerdict = "ok" | "shape_drift" | "auth_failed" | "unreachable" | "not_configured" | null

export interface HealSignals {
  probe: ProbeVerdict
  derived: { state: string; routeAround: boolean; reason: string } | null
  /** connector_shape_memory diff (lib/kernel/schema-memory.ts loadRecentShapeChanges) for this connector. */
  shapeChange: { addedKeys: string[]; removedKeys: string[] } | null
  /** The declared alternate already applied (connector_healing_proposals declared_alternate, applied). */
  appliedAlternateId: string | null
  now: Date
}

export type HealDecision =
  | { step: "failover"; reason: string; routes: CapabilityRoute[] }
  | { step: "apply_declared"; reason: string; alternate: AdapterAlternate }
  | { step: "propose"; reason: string; proposalKind: "shape_update" | "endpoint_change" | "rotate_key" | "no_evidence" }
  | { step: "escalate"; reason: string }
  | { step: "none"; reason: string }

/**
 * PURE — the owner's order. 1) DOWN (the probe could not reach it, or its derived health is in a
 * `failing` cool-down) → FAILOVER through routeCapability; with no healthy alternate for any of its
 * capabilities → escalate (wave 137 approve-all: failover first, escalate only without one).
 * 2) UP: bad credentials → a rotate_key proposal (never auto). 3) UP + drift (probe shape drift, a
 * dropped key in shape memory, the declared version past its deprecation, or a declared alternate
 * that supersedes the current one) → APPLY the first config-level declared alternate not already
 * applied; with only code-level alternates (or none) → a proposal for platform staff. 4) UP, no drift
 * → nothing to heal (the gateway's own transient retry owns a blip).
 */
export function decideProviderHeal(adapter: ProviderAdapter, s: HealSignals): HealDecision {
  const down = s.probe === "unreachable" || !!s.derived?.routeAround
  if (down) {
    const dataCaps = adapter.capabilities.filter((c): c is ProviderCapability => c in CONTACT_PROVIDER_ROUTES)
    const health = { [adapter.provider]: { state: "failing", routeAround: true, reason: s.derived?.reason ?? `probe: ${s.probe}` } } as Parameters<typeof routeCapability>[1]
    const routes = dataCaps.map((c) => routeCapability(c, health))
    const served = routes.filter((r) => r.providers.length > 0)
    if (served.length) return { step: "failover", routes, reason: `${adapter.provider} is DOWN (${s.probe === "unreachable" ? "probe unreachable" : s.derived?.reason}) — routed around to ${served.map((r) => `${r.capability}→${r.providers[0]}`).join(", ")}` }
    return { step: "escalate", reason: `${adapter.provider} is DOWN and no capability it serves has a healthy alternate provider — a human decides` }
  }
  if (s.probe === "auth_failed") return { step: "propose", proposalKind: "rotate_key", reason: `${adapter.provider} is UP but refused the credential — a key rotation is never applied automatically` }
  // An applied alternate that supersedes the current declaration HAS answered the deprecation — not drift again.
  const answered = adapter.api.alternates.some((a) => a.id === s.appliedAlternateId && a.supersedesCurrent)
  const deprecated = !answered && !!adapter.api.deprecatedAfter && s.now.getTime() >= new Date(adapter.api.deprecatedAfter).getTime()
  const shapeDrift = s.probe === "shape_drift" || (s.shapeChange?.removedKeys.length ?? 0) > 0
  const superseding = adapter.api.alternates.filter((a) => a.supersedesCurrent && a.id !== s.appliedAlternateId)
  const drift = deprecated || shapeDrift || superseding.length > 0
  if (!drift) return { step: "none", reason: `${adapter.provider} is UP with no version/endpoint/shape drift — a transient fault; the gateway retry owns it` }
  const why = [deprecated && `declared version ${adapter.api.version} deprecated after ${adapter.api.deprecatedAfter}`, shapeDrift && "response shape drift", superseding.length > 0 && `declared alternate ${superseding[0].id} supersedes it`].filter(Boolean).join("; ")
  const configAlt = adapter.api.alternates.find((a) => a.level === "config" && a.id !== s.appliedAlternateId && (a.supersedesCurrent || deprecated || shapeDrift))
  if (configAlt) return { step: "apply_declared", alternate: configAlt, reason: `${adapter.provider} is UP but drifted (${why}) — applying declared config alternate ${configAlt.id}` }
  return { step: "propose", proposalKind: shapeDrift ? "shape_update" : "endpoint_change", reason: `${adapter.provider} is UP but drifted (${why}) and no config-level alternate is declared — a code-level change goes to platform staff` }
}
