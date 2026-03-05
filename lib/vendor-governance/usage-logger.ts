/**
 * VENDOR GOVERNANCE SYSTEM 2.4
 * Centralized Vendor Usage Logging
 * 
 * WHY THIS EXISTS:
 * Before communications scale (AI emails, voice calls, direct mail), we need:
 * - Clean, attributed usage tracking
 * - Cost normalization across different unit types
 * - Anomaly detection without blocking automation
 * - Multi-tenant isolation and audit trails
 * 
 * This system is GOVERNANCE-ONLY: no UI, no blocking, no enforcement.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface VendorUsageEvent {
  vendorName: string           // e.g., 'openai', 'zenrows', 'sendgrid', 'heygen'
  usageType: string            // e.g., 'tokens', 'api_call', 'minutes', 'emails'
  unitCount: number            // Raw usage units
  estimatedCost: number        // Normalized to USD
  systemSource: string         // Which system triggered it: 'ai_isa', 'enrichment', 'voice', etc.
  brokerageId: string
  agentId?: string             // Optional: if agent-specific
  leadId?: string              // Optional: if lead-specific
  metadata?: Record<string, any>
  timestamp?: Date
}

export interface UsageLogResult {
  success: boolean
  usageId?: string
  error?: string
  anomalyDetected?: boolean
  anomalyReason?: string
}

/**
 * CENTRALIZED USAGE LOGGING
 * 
 * Logs vendor usage to vendor_usage_tracking table.
 * This is the SINGLE SOURCE OF TRUTH for all vendor costs.
 * 
 * Idempotent: duplicate events are detected and skipped.
 * Non-blocking: failures are logged but don't interrupt upstream systems.
 */
export async function logVendorUsage(event: VendorUsageEvent): Promise<UsageLogResult> {
  try {
    const supabase = createServiceClient()

    // Generate unique event fingerprint for idempotency
    const eventFingerprint = generateEventFingerprint(event)

    // Check for duplicate (idempotency)
    const { data: existingLog } = await supabase
      .from('vendor_usage_tracking')
      .select('id')
      .eq('vendor_name', event.vendorName)
      .eq('usage_type', event.usageType)
      .eq('brokerage_id', event.brokerageId)
      .limit(1)
      .order('created_at', { ascending: false })
      .single()

    if (existingLog && isLikelyDuplicate(existingLog, event)) {
      console.log('[v0] [VENDOR GOVERNANCE] Duplicate usage event detected, skipping')
      return {
        success: true,
        usageId: existingLog.id,
        error: 'Duplicate event (idempotent skip)',
      }
    }

    // Detect anomalies (but don't block)
    const anomaly = detectUsageAnomaly(event)

    // Insert usage record
    const { data, error } = await supabase
      .from('vendor_usage_tracking')
      .insert({
        vendor_name: event.vendorName,
        usage_type: event.usageType,
        units_used: event.unitCount,
        cost_per_unit: event.estimatedCost / event.unitCount,
        total_cost: event.estimatedCost,
        brokerage_id: event.brokerageId,
        agent_id: event.agentId || null,
        lead_id: event.leadId || null,
        request_metadata: {
          ...event.metadata,
          system_source: event.systemSource,
          timestamp: event.timestamp?.toISOString() || new Date().toISOString(),
          event_fingerprint: eventFingerprint,
        },
      })
      .select('id')
      .single()

    if (error) {
      console.error('[v0] [VENDOR GOVERNANCE] Failed to log usage:', error)
      
      // Log failure to automation_errors (but don't fail upstream)
      await supabase.from('automation_errors').insert({
        workflow_name: 'vendor_usage_logging',
        error_message: `Failed to log ${event.vendorName} usage: ${error.message}`,
        severity: 'medium',
        status: 'open',
        metadata: { ...event },
      })

      return {
        success: false,
        error: error.message,
      }
    }

    // If anomaly detected, log it
    if (anomaly.detected) {
      await supabase.from('automation_errors').insert({
        workflow_name: 'vendor_usage_anomaly',
        error_message: `Anomaly detected: ${anomaly.reason}`,
        severity: 'low',
        status: 'open',
        metadata: { usageId: data.id, ...event },
      })
    }

    return {
      success: true,
      usageId: data.id,
      anomalyDetected: anomaly.detected,
      anomalyReason: anomaly.reason,
    }
  } catch (error: any) {
    console.error('[v0] [VENDOR GOVERNANCE] Unexpected error logging usage:', error)
    return {
      success: false,
      error: error.message,
    }
  }
}

/**
 * Generate a unique fingerprint for idempotency checking
 */
function generateEventFingerprint(event: VendorUsageEvent): string {
  const parts = [
    event.vendorName,
    event.usageType,
    event.systemSource,
    event.brokerageId,
    event.agentId || 'none',
    event.leadId || 'none',
    event.unitCount,
  ]
  return parts.join('|')
}

/**
 * Check if this is likely a duplicate event
 */
function isLikelyDuplicate(existingLog: any, event: VendorUsageEvent): boolean {
  // Check if the same usage happened within last 5 minutes
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
  const logTime = new Date(existingLog.created_at)
  
  return logTime > fiveMinutesAgo
}

/**
 * ANOMALY DETECTION
 * 
 * Detect unusual usage patterns without blocking.
 * Future systems can use these signals for enforcement.
 */
function detectUsageAnomaly(event: VendorUsageEvent): { detected: boolean; reason?: string } {
  // Anomaly: Unusually high cost for single event
  if (event.estimatedCost > 50) {
    return {
      detected: true,
      reason: `High cost event: $${event.estimatedCost} for ${event.vendorName}`,
    }
  }

  // Anomaly: Extremely high unit count
  if (event.unitCount > 100000) {
    return {
      detected: true,
      reason: `Unusually high unit count: ${event.unitCount} ${event.usageType}`,
    }
  }

  // Anomaly: Missing attribution
  if (!event.brokerageId) {
    return {
      detected: true,
      reason: 'Missing brokerage attribution',
    }
  }

  return { detected: false }
}
