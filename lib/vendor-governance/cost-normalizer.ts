/**
 * VENDOR GOVERNANCE SYSTEM 2.4
 * Cost Normalization Engine
 * 
 * WHY THIS EXISTS:
 * Different vendors charge using different units:
 * - AI providers: tokens
 * - Scrapers: API calls or records
 * - Email: emails sent
 * - Voice: minutes
 * - Direct mail: pieces mailed
 * 
 * This module normalizes all units into estimated USD cost.
 * Conversion logic is deterministic and documented.
 */

import { elevenLabsUsdForChars } from "@/lib/video/realism-profile"

export type UnitType = 'tokens' | 'api_calls' | 'emails' | 'minutes' | 'records' | 'pieces' | 'credits' | 'images'

/**
 * WAVE 139 (lane 139C) — A PRICE IS A TYPED STATE, NEVER A GUESS (owner: "unknown price stays
 * explicitly unknown, never fabricated; variable / plan-dependent pricing represented as such").
 *   fixed    — one published per-unit price (costPerUnit > 0).
 *   variable — plan / tier / volume-band dependent; costPerUnit is the PUBLISHED LIST rate we book
 *              as an estimate (the invoice reconciles it), priceSource names the band it came from.
 *   unknown  — no price we can verify from a primary source; costPerUnit is 0 and a booking carries
 *              price_state 'unknown' (units recorded, cost explicitly NOT asserted).
 *   free     — keyless / free public API; nothing is owed.
 * A row with no priceState reads as fixed when priced, free when $0 (vendorPriceState).
 */
export type PriceState = 'fixed' | 'variable' | 'unknown' | 'free'
/** estimated = our price table × units; final = the provider REPORTED the charge (Exa costDollars,
 *  gpt-image-1 usage tokens). Every ledger row this lane writes says which. */
export type CostBasis = 'estimated' | 'final'
/** Owner, wave 139: AI (Vercel AI Gateway), scraping, behaviour monitoring, social/brand listening and
 *  operational intelligence are PLATFORM-COVERED — booked on the platform ledger (tenant-attributed when
 *  a tenant exists), never billed to the tenant separately. tenant_paid only where the business process
 *  already says so (the tenant's own account / BYO key). AI's per-tier overage is a separate meter
 *  (ai_tool_usage → meter_readings) whose rate is administered in plan_limits, not here. */
export type CostCoverage = 'platform_covered' | 'tenant_paid'

export interface VendorPricing {
  vendorName: string
  unitType: UnitType
  costPerUnit: number
  notes?: string
  /** Absent = derived (fixed when costPerUnit > 0, free when 0) — see vendorPriceState. */
  priceState?: PriceState
  /** Where the number came from (a published page, a research doc, or "unknown — <why>"). */
  priceSource?: string
  /** Absent = platform_covered (every key in this table is a platform key). */
  coverage?: CostCoverage
}

/**
 * THE ONE LOB PRICE (wave 138, lane 138A — §6 one vocabulary). Three spellings of "what does a Lob
 * piece cost" existed: VENDOR_PRICING.lob $0.65, PLATFORM_VENDOR_RATES.lob $0.84 and the per-size
 * table lib/providers/dispatch.ts BOOKS (vendor_usage_tracking estimatedCost + the budget preflight's
 * addCost) — $0.78 postcard. The booked one is the true price source in code; it moved here, and the
 * other two now read it. Telemetry figures, reconciled against Lob's invoice.
 */
export const DIRECT_MAIL_PIECE_COST_USD = { letter: 1.2, postcard: 0.78, self_mailer: 1.05 } as const

// ── WAVE 139 (lane 139C) — the prices that lived in their clients, moved to the ONE table ──────────
// Each was a literal inside its client (zyte-client estimateZyteCost, tavily-client's 0.005/0.01,
// image-generation COST_PER_IMAGE) or nowhere at all (Maps, voice drops). The clients now read these.

/** Zyte API is TIER-based (five tiers auto-assigned per DOMAIN after the first request, reviewed
 *  quarterly) — VARIABLE. The booked figure stays the Tier-3 PAYG estimate the client always booked
 *  (docs/lead-acquisition-coverage-2026-09.md: $4.02 / 1k browser-rendered, $0.44 / 1k HTTP). */
export const ZYTE_REQUEST_COST_USD = { browserHtml: 0.004, httpResponseBody: 0.00044 } as const

/** Tavily bills CREDITS: basic search = 1, advanced = 2 (docs.tavily.com/documentation/api-credits).
 *  The per-credit price is PLAN-dependent ($0.005 Growth … $0.008 pay-as-you-go, 1,000 free / month) —
 *  VARIABLE; we book the published pay-as-you-go list rate, the rate that applies past any plan. */
export const TAVILY_CREDITS_PER_SEARCH = { basic: 1, advanced: 2 } as const
export const TAVILY_CREDIT_USD = 0.008

/** Google Maps Platform Essentials SKUs, entry band (10,001–100,000 / month) per request —
 *  developers.google.com/maps/billing-and-pricing/pricing. VARIABLE: the first 10,000 / month per SKU
 *  are free and volume bands step the price down, so a booked mint is an UPPER-BOUND estimate. */
export const GOOGLE_MAPS_SKU_USD = { street_view_static: 0.007, static_map: 0.002 } as const
export type GoogleMapsSku = keyof typeof GOOGLE_MAPS_SKU_USD

/** OpenAI image models (platform.openai.com/docs/models/gpt-image-1, /dall-e-3). gpt-image-1 is
 *  TOKEN-priced ($5 / 1M text-in, $10 / 1M image-in, $40 / 1M image-out) — when the response carries
 *  usage the cost is FINAL; otherwise the published per-image figure is the estimate. DALL-E 3 is a
 *  fixed per-image price. Quality maps standard→medium, hd→high (lib/ai/image-generation.ts). */
const GPT_IMAGE_1_TOKEN_USD = { textInput: 5 / 1_000_000, imageInput: 10 / 1_000_000, imageOutput: 40 / 1_000_000 } as const
const GPT_IMAGE_1_PER_IMAGE_USD: Record<'medium' | 'high', { square: number; wide: number }> = {
  medium: { square: 0.042, wide: 0.063 },
  high: { square: 0.167, wide: 0.25 },
}
const DALL_E_3_PER_IMAGE_USD: Record<'standard' | 'hd', { square: number; wide: number }> = {
  standard: { square: 0.04, wide: 0.08 },
  hd: { square: 0.08, wide: 0.12 },
}

interface ImageUsageTokens { textInputTokens: number; imageInputTokens: number; outputTokens: number }

/** PURE — read gpt-image-1's `usage` block ({ input_tokens, output_tokens, input_tokens_details:
 *  { text_tokens, image_tokens } }); null when the provider reported none (then the cost is estimated). */
export function imageUsageFrom(raw: unknown): ImageUsageTokens | null {
  const u = (raw ?? null) as { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { text_tokens?: unknown; image_tokens?: unknown } } | null
  const out = Number(u?.output_tokens)
  if (!u || !Number.isFinite(out) || out <= 0) return null
  const text = Number(u.input_tokens_details?.text_tokens)
  const image = Number(u.input_tokens_details?.image_tokens)
  const input = Number(u.input_tokens)
  return {
    textInputTokens: Number.isFinite(text) ? text : Number.isFinite(input) ? input : 0,
    imageInputTokens: Number.isFinite(image) ? image : 0,
    outputTokens: out,
  }
}

/** PURE — the cost of ONE generated / edited image, with its state and basis (never a bare number). */
export function priceImageGeneration(i: {
  model: 'gpt-image-1' | 'dall-e-3'
  quality: 'standard' | 'hd'
  size: string
  usage?: ImageUsageTokens | null
}): { costUsd: number; priceState: PriceState; costBasis: CostBasis; priceSource: string } {
  const shape = i.size === '1024x1024' ? 'square' : 'wide'
  if (i.model === 'gpt-image-1') {
    if (i.usage) {
      const t = GPT_IMAGE_1_TOKEN_USD
      const cost = i.usage.textInputTokens * t.textInput + i.usage.imageInputTokens * t.imageInput + i.usage.outputTokens * t.imageOutput
      return { costUsd: Math.round(cost * 1e6) / 1e6, priceState: 'variable', costBasis: 'final', priceSource: 'gpt-image-1 usage tokens × published token rates' }
    }
    const q = i.quality === 'hd' ? 'high' : 'medium'
    return { costUsd: GPT_IMAGE_1_PER_IMAGE_USD[q][shape], priceState: 'variable', costBasis: 'estimated', priceSource: `gpt-image-1 published per-image (${q}, ${shape})` }
  }
  return { costUsd: DALL_E_3_PER_IMAGE_USD[i.quality][shape], priceState: 'fixed', costBasis: 'estimated', priceSource: `dall-e-3 published per-image (${i.quality}, ${shape})` }
}

/**
 * VENDOR PRICING TABLE
 * 
 * This is the single source of truth for vendor costs.
 * Update these values as vendor pricing changes.
 * 
 * All costs are in USD.
 */
export const VENDOR_PRICING: Record<string, VendorPricing> = {
  // AI / LLM Providers
  'openai_gpt4': {
    vendorName: 'OpenAI GPT-4',
    unitType: 'tokens',
    costPerUnit: 0.00003, // $0.03 per 1K tokens
    notes: 'Input + output tokens combined',
  },
  'openai_gpt35': {
    vendorName: 'OpenAI GPT-3.5',
    unitType: 'tokens',
    costPerUnit: 0.000002, // $0.002 per 1K tokens
  },
  'anthropic_claude': {
    vendorName: 'Anthropic Claude',
    unitType: 'tokens',
    costPerUnit: 0.00002, // $0.02 per 1K tokens
  },
  
  // Scraping Providers
  'zenrows': {
    vendorName: 'ZenRows',
    unitType: 'api_calls',
    costPerUnit: 0.01, // $0.01 per request
    notes: 'Property search and social scraping',
  },
  // Wave 82 lane A — Exa now books under its OWN name (it used to ride the composite
  // "apify_social" row). exa.ai/docs/reference/pricing (Exa 2026-09-25): /search $7 per 1k
  // requests (≤10 results), +$1/1k results above 10, +$1/1k pages per content type; $10/mo
  // free-tier credit. Callers book the SDK-reported `costDollars.total`; this row only prices a
  // unitCount booking so Exa can never fall to the unknown-vendor fallback.
  'exa': {
    vendorName: 'Exa',
    unitType: 'api_calls',
    costPerUnit: 0.007, // $7 per 1,000 /search requests
    notes: 'Neural web search — intent acquisition, permit/pre-listing, search enrichment',
  },
  // Wave 139 (139C) — the scraper fallback and the research search get their ONE price row.
  'zyte': {
    vendorName: 'Zyte API',
    unitType: 'api_calls',
    costPerUnit: ZYTE_REQUEST_COST_USD.browserHtml, // every production caller renders (jsRender: true)
    priceState: 'variable',
    priceSource: 'Zyte tier pricing (per-domain tier, Tier-3 PAYG estimate) — docs/lead-acquisition-coverage-2026-09.md; https://www.zyte.com/pricing/',
    notes: 'Rendered page fetch (ZenRows fallback / portal-first) — httpResponseBody books ZYTE_REQUEST_COST_USD.httpResponseBody',
  },
  'tavily': {
    vendorName: 'Tavily',
    unitType: 'credits',
    costPerUnit: TAVILY_CREDIT_USD,
    priceState: 'variable',
    priceSource: 'https://docs.tavily.com/documentation/api-credits — basic 1 credit, advanced 2; $0.008 / credit pay-as-you-go (plan rates $0.005–$0.0075)',
    notes: 'Web search + synthesized answer (research mode, intent fallback)',
  },
  'apify': {
    vendorName: 'Apify',
    unitType: 'credits',
    costPerUnit: 0.25, // $0.25 per compute unit
    notes: 'Social media scraping actors',
  },
  'batchdata': {
    vendorName: 'BatchData',
    unitType: 'records',
    costPerUnit: 0.50, // $0.50 per motivated seller record
  },
  'peopledata': {
    vendorName: 'PeopleData Labs',
    unitType: 'records',
    // MUST EQUAL lib/external/peopledata-client.ts::PEOPLEDATA_MATCH_COST_USD
    // (scripts/provider-cost-routing-guard.ts holds the two in agreement). Was
    // 0.10 — a unitCount:1 booking through trackVendorUsageService priced a
    // $0.25 match at $0.10 in the SAME ledger checkVendorBudget reads. Callers
    // that know the real per-call outcome book through meterVendorSpend with
    // the matched/no-match constant instead of a unit count (lane 81B).
    costPerUnit: 0.25,
    notes: 'Per SUCCESSFUL match (PDL bills nothing on a 404 no-match) — lib/external/peopledata-client.ts',
  },
  // Lane 85C — the ONLY rung that sells a (modeled) credit band. MUST EQUAL
  // lib/external/versium-client.ts::VERSIUM_FINANCIAL_MATCH_COST_USD (one match credit, credit-package
  // ceiling; versium.com/pricing, Exa 2026-09-26). Asked only for a lead/contact still missing a
  // household financial after BatchData's already-bought demographic dataset.
  'versium': {
    vendorName: 'Versium REACH',
    unitType: 'records',
    costPerUnit: 0.05,
    notes: 'Financial append (Household Income / Estimated Net Worth / Credit Rating) — per MATCH, no-match free — lib/external/versium-client.ts',
  },

  // KEYLESS / FREE LANES — rated at exactly $0 ON PURPOSE.
  //
  // normalizeVendorCost() below falls back to $0.01/unit for an UNKNOWN vendor
  // key. Without these rows, metering the free OSINT lane (Nominatim + Overpass
  // + US Census, the `osint_free` posture row in lib/platform/provider-posture.ts)
  // would INVENT a cent of spend per call and inflate the same
  // vendor_usage_tracking ledger checkVendorBudget reads to decide whether a
  // brokerage may spend. A free call must be recorded as free, or not at all —
  // it must never be priced by the unknown-vendor default. The lane IS recorded
  // (rather than skipped) so the ledger shows the work that was done for $0.
  'osint_free': {
    vendorName: 'OSINT Free (OSM + Census)',
    unitType: 'api_calls',
    costPerUnit: 0, // keyless free tiers — Nominatim, Overpass, US Census ACS
    notes: 'Keyless lane. Zero cost by construction; the row exists so free calls are never priced by the unknown-vendor fallback.',
  },

  // Email Providers
  'sendgrid': {
    vendorName: 'SendGrid',
    unitType: 'emails',
    costPerUnit: 0.001, // $0.001 per email
  },
  'resend': {
    vendorName: 'Resend',
    unitType: 'emails',
    costPerUnit: 0.001,
  },
  
  // Voice Providers
  'twilio_voice': {
    vendorName: 'Twilio Voice',
    unitType: 'minutes',
    costPerUnit: 0.0140, // $0.014 per minute
  },

  // SMS Providers
  'twilio_sms': {
    vendorName: 'Twilio SMS',
    unitType: 'api_calls',
    costPerUnit: 0.0075, // $0.0075 per outbound segment
    notes: 'Per SMS segment — keep in lockstep with the figure metered in lib/providers/dispatch.ts',
  },
  'elevenlabs': {
    vendorName: 'ElevenLabs',
    unitType: 'tokens',
    // lane 92A: THE ONE voice price (lib/video/realism-profile.ts elevenLabsUsdForChars,
    // $0.10/1K). Was a private $0.30/1K copy — 3x the billed rate, written into the slideshow
    // voiceover's video_render_log.cost_usd (app/api/videos/listing-voiceover/route.ts).
    costPerUnit: elevenLabsUsdForChars(1), // per CHARACTER
    notes: 'AI voice generation — per character',
  },
  
  // Direct Mail
  'lob': {
    vendorName: 'Lob',
    unitType: 'pieces',
    costPerUnit: DIRECT_MAIL_PIECE_COST_USD.postcard, // the ONE Lob price (above) — was a second spelling, $0.65
    notes: 'Includes printing and postage',
  },
  
  // Wave 139 (139C) — Ringless voicemail. The ONLY prices found are third-party listings
  // (Slybroadcast $0.04–$0.10 per delivery by bundle / plan) — no primary-source API price, so the
  // price is UNKNOWN on purpose: each drop books its unit with price_state 'unknown', never a guess.
  'voicedrop': {
    vendorName: 'Voice drop (Slybroadcast)',
    unitType: 'api_calls',
    costPerUnit: 0,
    priceState: 'unknown',
    priceSource: 'unknown — Slybroadcast publishes no API price on a primary source (third-party: $0.04–$0.10 per delivery, plan-dependent); reconcile against the invoice',
    notes: 'One delivered ringless voicemail per unit',
  },

  // Maps (platform Google Cloud key) — server-minted Street View / Static Map images.
  'google_maps': {
    vendorName: 'Google Maps Platform',
    unitType: 'api_calls',
    costPerUnit: GOOGLE_MAPS_SKU_USD.street_view_static,
    priceState: 'variable',
    priceSource: 'https://developers.google.com/maps/billing-and-pricing/pricing — Essentials: 10,000 free / SKU / month, then $7 / 1k Static Street View, $2 / 1k Static Maps (volume bands lower)',
    notes: 'Per image minted; the static-map SKU books GOOGLE_MAPS_SKU_USD.static_map',
  },

  // Image generation (OpenAI via the AI Gateway first, direct key fallback) — books ai_tool_usage.
  'openai_image': {
    vendorName: 'OpenAI images (gpt-image-1 / dall-e-3)',
    unitType: 'images',
    costPerUnit: 0.042, // gpt-image-1 medium 1024² — the primary path's default; priceImageGeneration prices each call
    priceState: 'variable',
    priceSource: 'https://platform.openai.com/docs/models/gpt-image-1 (token-priced; per-image by quality × size) + /dall-e-3 (fixed per image)',
    notes: 'Generation + photo edit; final when the response reports usage tokens',
  },

  // Video Generation
  'heygen': {
    vendorName: 'HeyGen',
    unitType: 'credits',
    costPerUnit: 1.00, // $1.00 per video credit
    notes: 'AI avatar video generation',
  },
}

/**
 * NORMALIZE VENDOR COST
 * 
 * Converts raw usage units into estimated USD cost.
 * This is deterministic and documented for audit purposes.
 * 
 * @param vendorKey - Key in VENDOR_PRICING table
 * @param unitCount - Number of units consumed
 * @returns Estimated cost in USD
 */
export function normalizeVendorCost(vendorKey: string, unitCount: number): number {
  const pricing = VENDOR_PRICING[vendorKey]

  if (!pricing) {
    // Wave 139 (139C): was `return unitCount * 0.01` — a FABRICATED cent per unit for any vendor the
    // table does not know, written into the same ledger checkVendorBudget gates on. An unknown vendor's
    // price is UNKNOWN: $0 here, and priceVendorUsage / the ledger row say price_state 'unknown'.
    console.warn(`[v0] [VENDOR GOVERNANCE] Unknown vendor: ${vendorKey} — price UNKNOWN (booked $0 with price_state 'unknown', never a guessed rate)`)
    return 0
  }

  return unitCount * pricing.costPerUnit
}

/**
 * The typed price state of a vendor key (an absent key is UNKNOWN, never a default rate). FAIL CLOSED:
 * a row that breaks the table's honesty rules (pricingFaults — a $0 "variable", a priced "unknown", an
 * unsourced band) reads as UNKNOWN, so a dishonest number can never be booked as a known price.
 * `table` is injectable for the proof (scripts/cost-completeness-guard.ts forges each defect).
 */
export function vendorPriceState(vendorKey: string, table: Readonly<Record<string, VendorPricing>> = VENDOR_PRICING): PriceState {
  const p = table[vendorKey]
  if (!p) return 'unknown'
  if (pricingFaults(vendorKey, p).length > 0) return 'unknown'
  return p.priceState ?? (p.costPerUnit > 0 ? 'fixed' : 'free')
}

/**
 * PRICE A USAGE, HONESTLY — the cost WITH its state. `costUsd` is null when the price is unknown (an
 * unknown vendor key, or a row declared unknown), so a caller cannot mistake "we don't know" for $0.
 * Reader: lib/vendor-governance/track-vendor-usage.ts (stamps price_state on the ledger row).
 */
export function priceVendorUsage(vendorKey: string, unitCount: number): {
  costUsd: number | null
  priceState: PriceState
  costBasis: CostBasis
  priceSource: string
} {
  const state = vendorPriceState(vendorKey)
  const p = VENDOR_PRICING[vendorKey]
  if (state === 'unknown') return { costUsd: null, priceState: 'unknown', costBasis: 'estimated', priceSource: p?.priceSource ?? `unknown — no VENDOR_PRICING row for "${vendorKey}"` }
  return { costUsd: unitCount * (p?.costPerUnit ?? 0), priceState: state, costBasis: 'estimated', priceSource: p?.priceSource ?? `VENDOR_PRICING.${vendorKey}` }
}

/**
 * PURE — what is wrong with ONE price row ([] = honest). A variable / fixed row must carry a price, an
 * unknown or free row must carry none, and a variable / unknown row must say WHERE (or why not).
 * Reader: vendorPriceState above (a faulty row reads as unknown — fail closed).
 */
function pricingFaults(k: string, p: VendorPricing): string[] {
  const errs: string[] = []
  const state = p.priceState ?? (p.costPerUnit > 0 ? 'fixed' : 'free')
  if (!Number.isFinite(p.costPerUnit) || p.costPerUnit < 0) errs.push(`${k}: price is not a finite non-negative number`)
  if ((state === 'fixed' || state === 'variable') && !(p.costPerUnit > 0)) errs.push(`${k}: ${state} price with no rate — declare it 'unknown' instead of $0`)
  if ((state === 'unknown' || state === 'free') && p.costPerUnit !== 0) errs.push(`${k}: ${state} price carries a rate — a guessed number is not unknown`)
  if ((state === 'variable' || state === 'unknown') && !(p.priceSource ?? '').trim()) errs.push(`${k}: ${state} price with no priceSource — say where the band came from, or why it is unknown`)
  if (state === 'unknown' && !/^unknown\b/.test(p.priceSource ?? '')) errs.push(`${k}: unknown price whose priceSource does not start "unknown —"`)
  return errs
}

/**
 * GET VENDOR PRICING INFO
 * 
 * Returns pricing details for a specific vendor.
 * Useful for cost estimation before making API calls.
 */
export function getVendorPricing(vendorKey: string): VendorPricing | null {
  return VENDOR_PRICING[vendorKey] || null
}

/**
 * ESTIMATE COST BEFORE USAGE
 * 
 * Use this to estimate cost before making a vendor API call.
 * Helps systems make cost-aware decisions.
 */
export function estimateCost(vendorKey: string, estimatedUnits: number): {
  estimatedCost: number
  costPerUnit: number
  unitType: UnitType
  vendorName: string
} | null {
  const pricing = getVendorPricing(vendorKey)
  
  if (!pricing) {
    return null
  }

  return {
    estimatedCost: normalizeVendorCost(vendorKey, estimatedUnits),
    costPerUnit: pricing.costPerUnit,
    unitType: pricing.unitType,
    vendorName: pricing.vendorName,
  }
}
