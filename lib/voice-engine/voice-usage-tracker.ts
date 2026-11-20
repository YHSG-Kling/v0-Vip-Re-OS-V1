/**
 * VOICE ENGINE: USAGE & COST TRACKING
 * 
 * Tracks voice vendor costs via System 2.4.
 * Normalizes different billing models (per-minute, per-call, per-word).
 */

import { logVendorUsage, normalizeVendorCost, validateAttribution } from '@/lib/vendor-governance'

// TOMBSTONE (wave 145, lane 145D — owner ruling 13, 2026-10-27: "We no longer use vapi or retell"): the vendor union
// named two third-party AI-call vendors nothing in this repo ever called, and inferBillingModel below kept a branch for
// each. Every AI call runs on the Twilio-native lane (survivor: lib/voice/twilio-outbound.ts placeOutboundAiCall), whose
// minutes are booked by app/api/voice/twilio/status/route.ts. Both branches returned the default ('per_minute'), so the
// billing answer is unchanged for every vendor string. scripts/vendor-retirement-guard.ts keeps the names out of runtime code.
export interface VoiceUsageParams {
  vendor: 'twilio' | string
  callDurationSeconds: number
  transcriptionWordCount?: number
  contactId: string
  agentId?: string
  brokerageId: string
}

/**
 * TRACK VOICE CALL USAGE
 * 
 * Logs voice vendor costs to System 2.4.
 * Handles different vendor billing models automatically.
 */
export async function trackVoiceCallUsage(
  params: VoiceUsageParams
): Promise<{ success: boolean; error?: string }> {
  try {
    // Calculate billable units based on vendor
    const unitCount = calculateBillableUnits(
      params.vendor,
      params.callDurationSeconds,
      params.transcriptionWordCount
    )

    // Track via vendor-governance lib layer directly (no app/actions dependency)
    const estimatedCost = normalizeVendorCost(params.vendor, unitCount)
    const attribution = validateAttribution({ brokerageId: params.brokerageId, systemSource: 'voice_engine', agentId: params.agentId, contactId: params.contactId })
    const result = await logVendorUsage({
      vendorName: params.vendor,
      usageType: 'per_minute',
      unitCount,
      estimatedCost,
      systemSource: 'voice_engine',
      brokerageId: params.brokerageId,
      agentId: params.agentId,
      metadata: {
        callDurationSeconds: params.callDurationSeconds,
        transcriptionWordCount: params.transcriptionWordCount,
        billingModel: inferBillingModel(params.vendor),
        contactId: params.contactId,
        attribution: attribution.valid,
      },
      timestamp: new Date(),
    })

    if (!result.success) {
      console.error('[v0] [VOICE ENGINE] Failed to track usage:', result.error)
      return {
        success: false,
        error: result.error,
      }
    }

    console.log(`[v0] [VOICE ENGINE] Tracked ${unitCount} units for ${params.vendor}`)

    return { success: true }
  } catch (error: any) {
    console.error('[v0] [VOICE ENGINE] Error tracking voice usage:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

/**
 * Calculate billable units based on vendor billing model
 */
function calculateBillableUnits(
  vendor: string,
  durationSeconds: number,
  transcriptionWordCount?: number
): number {
  const billingModel = inferBillingModel(vendor)

  switch (billingModel) {
    case 'per_minute':
      // Round up to nearest minute
      return Math.ceil(durationSeconds / 60)

    case 'per_second':
      return durationSeconds

    case 'per_call':
      return 1

    case 'per_word':
      return transcriptionWordCount || 0

    default:
      // Default: per-minute billing
      return Math.ceil(durationSeconds / 60)
  }
}

/**
 * Infer billing model from vendor name
 */
function inferBillingModel(vendor: string): string {
  // Twilio: per-minute for calls (the only voice lane — retired vendors' branches removed, see the tombstone above)
  if (vendor.includes('twilio')) return 'per_minute'

  // Default
  return 'per_minute'
}
