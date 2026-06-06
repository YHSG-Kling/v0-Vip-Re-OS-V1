"use server"

/**
 * app/actions/coaching.ts — Server Action wrappers for the coaching engine.
 *
 * Mirrors the ai-generate.ts pattern: client components MUST import
 * coaching functions from here, not from "@/lib/intelligence/coaching-engine"
 * directly. The lib module imports from "@/lib/supabase/service" and the
 * kernel event surface — Turbopack walks that graph into Remotion /
 * @rspack/core / node:worker_threads and refuses to client-bundle.
 *
 * Server-side callers (other actions, route handlers, RSCs) should keep
 * importing the lib directly to avoid the Server Action POST round-trip.
 */

import {
  generateWeeklyCoachingReport as _generateWeeklyCoachingReport,
  getBuyerCoaching as _getBuyerCoaching,
  getLatestWeeklyReport as _getLatestWeeklyReport,
  type WeeklyCoachingReport,
  type BuyerCoachingContent,
  type BuyerPersona,
} from "@/lib/intelligence/coaching-engine"

export async function generateWeeklyCoachingReport(
  agentId: string,
  brokerageId: string,
): Promise<WeeklyCoachingReport> {
  return _generateWeeklyCoachingReport(agentId, brokerageId)
}

export async function getBuyerCoaching(
  buyerStage: string,
  persona: BuyerPersona,
  brokerageId: string,
): Promise<BuyerCoachingContent> {
  return _getBuyerCoaching(buyerStage, persona, brokerageId)
}

export async function getLatestWeeklyReport(agentId: string) {
  return _getLatestWeeklyReport(agentId)
}
