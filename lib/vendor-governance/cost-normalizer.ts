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

export type UnitType = 'tokens' | 'api_calls' | 'emails' | 'minutes' | 'records' | 'pieces' | 'credits'

export interface VendorPricing {
  vendorName: string
  unitType: UnitType
  costPerUnit: number
  notes?: string
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
    costPerUnit: 0.10, // $0.10 per enrichment
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
    costPerUnit: 0.00030, // $0.30 per 1K characters
    notes: 'AI voice generation',
  },
  
  // Direct Mail
  'lob': {
    vendorName: 'Lob',
    unitType: 'pieces',
    costPerUnit: 0.65, // $0.65 per postcard
    notes: 'Includes printing and postage',
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
    console.warn(`[v0] [VENDOR GOVERNANCE] Unknown vendor: ${vendorKey}, assuming $0.01/unit`)
    return unitCount * 0.01 // Default fallback
  }

  return unitCount * pricing.costPerUnit
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
