'use server'

/**
 * VENDOR GOVERNANCE SYSTEM 2.4
 * Main Orchestrator Action
 * 
 * This is the PUBLIC API for all systems to track vendor usage.
 * All vendor costs should flow through this function.
 * 
 * USAGE EXAMPLE:
 * 
 * ```typescript
 * import { trackVendorUsage } from '@/app/actions/vendor-governance/track-usage'
 * 
 * // After calling OpenAI API
 * await trackVendorUsage({
 *   vendor: 'openai_gpt4',
 *   unitCount: 1250, // tokens used
 *   systemSource: 'ai_isa',
 *   brokerageId: lead.brokerage_id,
 *   leadId: lead.id,
 *   metadata: { prompt: 'email_generation', model: 'gpt-4-turbo' }
 * })
 * ```
 */

import { logVendorUsage, VendorUsageEvent } from '@/lib/vendor-governance/usage-logger'
import { normalizeVendorCost } from '@/lib/vendor-governance/cost-normalizer'
import { validateAttribution, inferAttribution, AttributionContext } from '@/lib/vendor-governance/attribution'

export interface TrackUsageParams {
  vendor: string               // Vendor key from VENDOR_PRICING table
  unitCount: number            // Raw units consumed
  systemSource: string         // Which system made the call
  brokerageId?: string         // Brokerage ID (will infer if missing)
  agentId?: string            // Agent ID (optional)
  leadId?: string             // Lead ID (optional)
  contactId?: string          // Contact ID (optional)
  transactionId?: string      // Transaction ID (optional)
  metadata?: Record<string, any>
}

export interface TrackUsageResult {
  success: boolean
  usageId?: string
  estimatedCost?: number
  error?: string
  warning?: string
}

/**
 * TRACK VENDOR USAGE (PUBLIC API)
 * 
 * This is the ONLY way systems should track vendor costs.
 * Provides:
 * - Cost normalization
 * - Attribution validation
 * - Anomaly detection
 * - Idempotent logging
 */
export async function trackVendorUsage(params: TrackUsageParams): Promise<TrackUsageResult> {
  try {
    // STEP 1: Normalize cost
    const estimatedCost = normalizeVendorCost(params.vendor, params.unitCount)

    // STEP 2: Build attribution context
    let attribution: AttributionContext = {
      brokerageId: params.brokerageId || '',
      agentId: params.agentId,
      systemSource: params.systemSource,
      leadId: params.leadId,
      contactId: params.contactId,
      transactionId: params.transactionId,
    }

    // STEP 3: If attribution is incomplete, try to infer
    if (!attribution.brokerageId || !attribution.systemSource) {
      const inferred = await inferAttribution(attribution)
      if (inferred) {
        attribution = inferred
      }
    }

    // STEP 4: Validate attribution
    const validation = validateAttribution(attribution)
    
    if (!validation.valid) {
      console.error('[v0] [VENDOR GOVERNANCE] Invalid attribution:', validation.errors)
      return {
        success: false,
        error: `Attribution validation failed: ${validation.errors.join(', ')}`,
      }
    }

    // STEP 5: Build usage event
    const usageEvent: VendorUsageEvent = {
      vendorName: params.vendor,
      usageType: inferUsageType(params.vendor),
      unitCount: params.unitCount,
      estimatedCost,
      systemSource: attribution.systemSource,
      brokerageId: attribution.brokerageId,
      agentId: attribution.agentId,
      leadId: attribution.leadId,
      metadata: {
        ...params.metadata,
        contactId: attribution.contactId,
        transactionId: attribution.transactionId,
      },
      timestamp: new Date(),
    }

    // STEP 6: Log usage (idempotent)
    const result = await logVendorUsage(usageEvent)

    return {
      success: result.success,
      usageId: result.usageId,
      estimatedCost,
      error: result.error,
      warning: validation.warnings.join(', ') || undefined,
    }
  } catch (error: any) {
    console.error('[v0] [VENDOR GOVERNANCE] Unexpected error tracking usage:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

/**
 * Helper: Infer usage type from vendor key
 */
function inferUsageType(vendorKey: string): string {
  if (vendorKey.includes('gpt') || vendorKey.includes('claude')) return 'tokens'
  if (vendorKey.includes('zenrows') || vendorKey.includes('apify')) return 'api_calls'
  if (vendorKey.includes('sendgrid') || vendorKey.includes('resend')) return 'emails'
  if (vendorKey.includes('twilio')) return 'minutes'
  if (vendorKey.includes('lob')) return 'pieces'
  if (vendorKey.includes('data')) return 'records'
  return 'credits'
}
