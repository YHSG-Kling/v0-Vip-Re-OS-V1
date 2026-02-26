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

/**
 * VENDOR GOVERNANCE SYSTEM 2.4 — Server Action entry point.
 * Core logic lives in lib/vendor-governance/track-vendor-usage.ts.
 * This file exists only to attach the "use server" directive for Next.js.
 */

export {
  trackVendorUsageService as trackVendorUsage,
  type TrackUsageParams,
  type TrackUsageResult,
} from '@/lib/vendor-governance/track-vendor-usage'
