/**
 * VOICE ENGINE: USAGE & COST TRACKING
 * 
 * Tracks voice vendor costs via System 2.4.
 * Normalizes different billing models (per-minute, per-call, per-word).
 */

import { trackVendorUsage } from '@/app/actions/vendor-governance/track-usage'

export interface VoiceUsageParams {
  vendor: 'twilio' | 'bland_ai' | 'retell_ai' | 'vapi' | string
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

    // Track via System 2.4
    const result = await trackVendorUsage({
      vendor: params.vendor,
      unitCount,
      systemSource: 'voice_engine',
      brokerageId: params.brokerageId,
      agentId: params.agentId,
      contactId: params.contactId,
      metadata: {
        callDurationSeconds: params.callDurationSeconds,
        transcriptionWordCount: params.transcriptionWordCount,
        billingModel: inferBillingModel(params.vendor),
      },
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
  // Twilio: per-minute for calls
  if (vendor.includes('twilio')) return 'per_minute'

  // Bland AI: per-minute
  if (vendor.includes('bland')) return 'per_minute'

  // Retell AI: per-minute
  if (vendor.includes('retell')) return 'per_minute'

  // Vapi: per-minute
  if (vendor.includes('vapi')) return 'per_minute'

  // Default
  return 'per_minute'
}
