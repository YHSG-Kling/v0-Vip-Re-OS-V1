/**
 * lib/vendor-governance/track-vendor-usage.ts
 * Canonical lib-layer implementation of vendor usage tracking.
 * app/actions/vendor-governance/track-usage.ts re-exports from here.
 */

import { logVendorUsage, VendorUsageEvent } from './usage-logger'
import { normalizeVendorCost } from './cost-normalizer'
import { validateAttribution, inferAttribution, AttributionContext } from './attribution'

export interface TrackUsageParams {
  vendor: string
  unitCount: number
  systemSource: string
  brokerageId?: string
  agentId?: string
  leadId?: string
  contactId?: string
  transactionId?: string
  metadata?: Record<string, any>
}

export interface TrackUsageResult {
  success: boolean
  usageId?: string
  estimatedCost?: number
  error?: string
  warning?: string
}

function inferUsageType(vendorKey: string): string {
  if (vendorKey.includes('gpt') || vendorKey.includes('claude')) return 'tokens'
  if (vendorKey.includes('zenrows') || vendorKey.includes('apify')) return 'api_calls'
  if (vendorKey.includes('sendgrid') || vendorKey.includes('resend')) return 'emails'
  if (vendorKey.includes('twilio')) return 'minutes'
  if (vendorKey.includes('lob')) return 'pieces'
  if (vendorKey.includes('data')) return 'records'
  return 'credits'
}

export async function trackVendorUsageService(
  params: TrackUsageParams
): Promise<TrackUsageResult> {
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

    // STEP 3: Infer missing attribution
    if (!attribution.brokerageId || !attribution.systemSource) {
      const inferred = await inferAttribution(attribution)
      if (inferred) attribution = inferred
    }

    // STEP 4: Validate attribution
    const validation = validateAttribution(attribution)
    if (!validation.valid) {
      console.error('[vendor-governance] Invalid attribution:', validation.errors)
      return {
        success: false,
        error: `Attribution validation failed: ${validation.errors.join(', ')}`,
      }
    }

    // STEP 5: Build and log usage event
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

    const result = await logVendorUsage(usageEvent)

    return {
      success: result.success,
      usageId: result.usageId,
      estimatedCost,
      error: result.error,
      warning: validation.warnings.join(', ') || undefined,
    }
  } catch (error: any) {
    console.error('[vendor-governance] Unexpected error tracking usage:', error)
    return { success: false, error: error.message }
  }
}
