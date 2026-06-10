// lib/agentic-os/vendor-capability-registry.ts
// AI-API AGENT — the agentic-OS layer that controls EXTERNAL API/vendor connectivity.
// Parallels lib/intelligence/agent-registry.ts (which maps internal AI agents to
// business tasks); this maps BUSINESS DATA/SERVICE CAPABILITIES to the outside
// connectors that serve them, with the priority order, cost tier, and the context an
// AI agent needs to "find the answer to its question" without re-deriving vendor lore.
//
// One source of truth for: which vendor serves which capability, in what order, which
// are free vs paid, and the free fallback for the downgrade ladder. The live,
// budget-aware selection lives in resolve-vendor-capability.ts (server).
//
// Pure — no I/O — so the registry + provider selection are unit-tested deterministically.

import { resolveVendorAction, type VendorAction } from "@/lib/vendor-governance/vendor-policy"

export type VendorCapability =
  | "property_valuation"     // AVM — what is this home worth now?
  | "comparable_sales"       // recent comparable sales for a CMA
  | "market_stats"           // zip/territory market statistics
  | "lead_skip_trace"        // resolve a contact's phone/email (enrichment)
  | "buyer_seller_intent"    // discover online buyer/seller/investor intent (lead sourcing)
  | "motivated_seller_data"  // distressed/motivated-seller property + owner records
  | "web_research"           // open-web grounded research / Q&A
  | "voice_call"             // outbound AI voice conversation
  | "video_render"           // AI avatar / talking-head video
  | "tts"                    // text-to-speech narration

export type CapabilityDomain = "valuation" | "lead_generation" | "enrichment" | "communications" | "marketing"

export interface CapabilityProvider {
  vendor: string                 // canonical vendor name (matches vendor_usage_tracking + vendor-policy)
  tier: "free" | "paid"          // cost tier
  note: string                   // why/when this provider
}

export interface VendorCapabilityDef {
  capability: VendorCapability
  domain: CapabilityDomain
  /** Plain-language purpose — the CONTEXT an AI agent reads to know what this answers. */
  purpose: string
  /** Inputs the agent must supply to use this capability. */
  inputs: string[]
  /** Providers in PRIORITY order (primary first). Free tiers enable the downgrade ladder. */
  providers: CapabilityProvider[]
}

export const VENDOR_CAPABILITY_REGISTRY: Record<VendorCapability, VendorCapabilityDef> = {
  property_valuation: {
    capability: "property_valuation",
    domain: "valuation",
    purpose: "Estimate a property's current market value (AVM) with a confidence range.",
    inputs: ["address", "zipCode?"],
    providers: [
      { vendor: "perplexity", tier: "free", note: "Web-grounded AI AVM — default, ~$0.01" },
      { vendor: "osint", tier: "free", note: "Public sale-record derived value" },
      { vendor: "rentcast", tier: "paid", note: "Licensed AVM /avm/value — premium accuracy" },
    ],
  },
  comparable_sales: {
    capability: "comparable_sales",
    domain: "valuation",
    purpose: "Recent comparable sold properties near a subject for a CMA, with adjustments.",
    inputs: ["address", "city", "state", "zip?", "bedrooms", "bathrooms", "squareFeet"],
    providers: [
      { vendor: "perplexity", tier: "free", note: "AI comp finder — default for standard CMA" },
      { vendor: "rentcast", tier: "paid", note: "Licensed comparables — premium CMA" },
    ],
  },
  market_stats: {
    capability: "market_stats",
    domain: "valuation",
    purpose: "Zip/territory market statistics: median price, days-on-market, inventory, trend.",
    inputs: ["zipCode", "city?", "state?"],
    providers: [
      { vendor: "rentcast", tier: "paid", note: "RentCast /markets — primary" },
      { vendor: "osint", tier: "free", note: "ZenRows/Zillow scrape fallback" },
      { vendor: "cma_aggregate", tier: "free", note: "Aggregate of the brokerage's own CMAs" },
    ],
  },
  lead_skip_trace: {
    capability: "lead_skip_trace",
    domain: "enrichment",
    purpose: "Resolve a lead's missing phone/email/identity from name + location.",
    inputs: ["firstName", "lastName", "city?", "state?", "email?", "phone?"],
    providers: [
      { vendor: "peopledata", tier: "paid", note: "PeopleData skip-trace — primary enrichment" },
      { vendor: "perplexity", tier: "free", note: "Cost-gated web gap-fill when skip-trace is thin" },
    ],
  },
  buyer_seller_intent: {
    capability: "buyer_seller_intent",
    domain: "lead_generation",
    purpose: "Discover people expressing online buyer/seller/investor intent in a territory.",
    inputs: ["city", "state", "zipCodes?"],
    providers: [
      { vendor: "exa", tier: "paid", note: "Neural search — AI-native behavior discovery (primary)" },
      { vendor: "tavily", tier: "paid", note: "Agentic search — buyer/seller/investor intent" },
      { vendor: "apify_social", tier: "paid", note: "Facebook/Reddit/Instagram/Craigslist/Google/LinkedIn" },
      { vendor: "osint", tier: "free", note: "Public records: life events + distress signals" },
    ],
  },
  motivated_seller_data: {
    capability: "motivated_seller_data",
    domain: "lead_generation",
    purpose: "Distressed/motivated-seller property + owner records (probate, foreclosure, etc.).",
    inputs: ["state", "city?", "motivationTypes?"],
    providers: [
      { vendor: "batchdata", tier: "paid", note: "Comprehensive motivated-seller property data (primary)" },
      { vendor: "osint", tier: "free", note: "Court/public-records distress filings" },
    ],
  },
  web_research: {
    capability: "web_research",
    domain: "lead_generation",
    purpose: "Open-web grounded research / Q&A to enrich sales, leads, or AI chats.",
    inputs: ["query"],
    providers: [
      { vendor: "tavily", tier: "paid", note: "Synthesized answer + ranked sources (research mode)" },
      { vendor: "exa", tier: "paid", note: "Neural search fallback" },
    ],
  },
  voice_call: {
    capability: "voice_call",
    domain: "communications",
    purpose: "Place an outbound AI voice conversation (TCPA-gated).",
    inputs: ["phoneNumber", "brokerageId", "assistantConfig"],
    providers: [
      { vendor: "vapi", tier: "paid", note: "AI voice agent — no free equivalent" },
    ],
  },
  video_render: {
    capability: "video_render",
    domain: "marketing",
    purpose: "Render an AI avatar / talking-head marketing video.",
    inputs: ["script", "brokerageId", "avatar/voice assets"],
    providers: [
      { vendor: "did", tier: "paid", note: "D-ID talking-head — the platform video engine (voice via ElevenLabs)" },
    ],
  },
  tts: {
    capability: "tts",
    domain: "communications",
    purpose: "Synthesize speech narration (briefs, assistant voice).",
    inputs: ["text", "voiceId?", "brokerageId?"],
    providers: [
      { vendor: "elevenlabs", tier: "paid", note: "High-quality cloned/professional voice" },
      { vendor: "browser_tts", tier: "free", note: "On-device SpeechSynthesis fallback" },
    ],
  },
}

export function getVendorCapability(capability: VendorCapability): VendorCapabilityDef {
  return VENDOR_CAPABILITY_REGISTRY[capability]
}

// ─── Agentic API layer (agenticapi.com methodology) ──────────────────────────
// Capabilities are exposed to external AI agents as semantic INTENT verbs (AGIS
// vocabulary) — operations against intents, not resources — discoverable via a
// machine-readable action manifest and gated by granular scopes. The manifest is
// deliberately VENDOR-ANONYMOUS: it describes WHAT the action does + the scope it
// needs, never WHICH connector serves it (vendor selection stays platform-internal).

/** AGIS semantic verb vocabulary — what the agent is trying to DO (intent-oriented).
 *  Read verbs: FIND/ANALYZE/ENRICH/GET/DISCOVER/DESCRIBE. Side-effecting verbs:
 *  RENDER/NOTIFY/DELEGATE/ESCALATE/CREATE/UPDATE/BOOK/ADVANCE/PUBLISH. */
export const AGIS_VERBS = [
  "FIND", "ANALYZE", "ENRICH", "GET", "DISCOVER", "DESCRIBE",
  "RENDER", "NOTIFY", "DELEGATE", "ESCALATE", "CREATE", "UPDATE", "BOOK", "ADVANCE", "PUBLISH",
] as const
export type AgisVerb = (typeof AGIS_VERBS)[number]

export interface CapabilityAgis {
  /** Intent verb the agent invokes. */
  verb: AgisVerb
  /** OAuth-style granular scope an agent must hold to invoke this action. */
  scope: string
  /** Intent weight 0..1 — how consequential/expensive the action is (planning hint). */
  intentWeight: number
}

export const CAPABILITY_AGIS: Record<VendorCapability, CapabilityAgis> = {
  property_valuation:    { verb: "ANALYZE", scope: "valuation:read",  intentWeight: 0.8 },
  comparable_sales:      { verb: "ANALYZE", scope: "valuation:read",  intentWeight: 0.8 },
  market_stats:          { verb: "FIND",    scope: "market:read",     intentWeight: 0.6 },
  lead_skip_trace:       { verb: "ENRICH",  scope: "lead:enrich",     intentWeight: 0.7 },
  buyer_seller_intent:   { verb: "FIND",    scope: "lead:source",     intentWeight: 0.9 },
  motivated_seller_data: { verb: "FIND",    scope: "lead:source",     intentWeight: 0.9 },
  web_research:          { verb: "FIND",    scope: "research:read",   intentWeight: 0.5 },
  voice_call:            { verb: "NOTIFY",  scope: "comms:voice",     intentWeight: 0.95 },
  video_render:          { verb: "RENDER",  scope: "marketing:video", intentWeight: 0.7 },
  tts:                   { verb: "RENDER",  scope: "comms:tts",       intentWeight: 0.4 },
}

/** The scope an agent must hold to invoke a capability. */
export function requiredScope(capability: VendorCapability): string {
  return CAPABILITY_AGIS[capability].scope
}

export interface AgenticAction {
  /** AGIS verb + capability form the action id, e.g. "ANALYZE property_valuation". */
  action: string
  verb: AgisVerb
  capability: VendorCapability
  category: CapabilityDomain
  scope: string
  purpose: string
  inputs: string[]
  intentWeight: number
}

/**
 * Pure: the machine-readable DISCOVER /actions manifest. VENDOR-ANONYMOUS — describes
 * intent, scope, and inputs so an external AI agent can plan + request access, with no
 * connector names. This is the app's agentic-API surface (agenticapi.com ACTION model).
 */
export function buildActionManifest(): AgenticAction[] {
  return (Object.keys(VENDOR_CAPABILITY_REGISTRY) as VendorCapability[]).map((cap) => {
    const def = VENDOR_CAPABILITY_REGISTRY[cap]
    const agis = CAPABILITY_AGIS[cap]
    return {
      action: `${agis.verb} ${cap}`,
      verb: agis.verb,
      capability: cap,
      category: def.domain,
      scope: agis.scope,
      purpose: def.purpose,
      inputs: def.inputs,
      intentWeight: agis.intentWeight,
    }
  }).sort((a, b) => b.intentWeight - a.intentWeight)
}

export interface ProviderSelection {
  provider: string
  tier: "free" | "paid"
  action: VendorAction
  usingFreeFallback: boolean
  reason: string
}

/**
 * Pure: choose the provider for a capability given whether the brokerage is over
 * budget. Under budget → the primary (priority-first) provider. Over budget → the
 * first FREE provider for the capability (degrade) if one exists, else the primary
 * with action "block". This is the capability-level view of the downgrade ladder.
 */
export function selectProvider(capability: VendorCapability, opts: { overBudget: boolean }): ProviderSelection {
  const def = VENDOR_CAPABILITY_REGISTRY[capability]
  const primary = def.providers[0]
  if (!opts.overBudget) {
    return { provider: primary.vendor, tier: primary.tier, action: "allow", usingFreeFallback: false, reason: "within budget" }
  }
  // Over budget: if the primary is free, it still runs. Otherwise look for a free tier.
  if (primary.tier === "free") {
    return { provider: primary.vendor, tier: "free", action: "allow", usingFreeFallback: false, reason: "primary is free" }
  }
  const free = def.providers.find((p) => p.tier === "free")
  if (free) {
    return { provider: free.vendor, tier: "free", action: "degrade", usingFreeFallback: true, reason: "over budget — degraded to free tier" }
  }
  // No free path for this capability — defer to vendor policy (block).
  const action = resolveVendorAction(primary.vendor, true)
  return { provider: primary.vendor, tier: primary.tier, action, usingFreeFallback: false, reason: "over budget — no free alternative" }
}
