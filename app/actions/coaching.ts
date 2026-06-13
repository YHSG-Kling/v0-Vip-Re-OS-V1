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

// getBuyerCoaching stays in coaching-engine — a DISTINCT buyer-facing feature
// (per-stage buyer playbooks), unrelated to the agent performance/weekly report.
import {
  getBuyerCoaching as _getBuyerCoaching,
  type BuyerCoachingContent,
  type BuyerPersona,
} from "@/lib/intelligence/coaching-engine"
// The agent weekly report is now sourced from the OUTCOME-BASED agent-coaching loop
// (the single source of truth). runAgentCoachingForAgent is the WRITE path behind the
// "Generate New Report" button; both map the brief into the dashboard's WeeklyCoachingReport shape.
import {
  runAgentCoachingForAgent,
  type WeeklyCoachingReport,
} from "@/lib/kernel/agent-coaching"

export async function generateWeeklyCoachingReport(
  agentId: string,
  brokerageId: string,
): Promise<WeeklyCoachingReport> {
  const report = await runAgentCoachingForAgent(agentId, brokerageId)
  // runAgentCoachingForAgent returns null only when the agent is unknown — surface a
  // safe, honest empty report rather than throwing (the dashboard renders its empty state).
  return (
    report ?? {
      overall_score: 70,
      headline: "Getting started",
      wins: [],
      gaps: [],
      top_recommendation:
        "Not enough activity on the board yet to coach on — let's get reps in.",
      recommended_actions: [
        "Book showings",
        "Log your conversations",
        "Build a real activity base to coach on",
      ],
      deal_focus:
        "Not enough activity on the board yet to coach on — let's get reps in.",
    }
  )
}

export async function getBuyerCoaching(
  buyerStage: string,
  persona: BuyerPersona,
  brokerageId: string,
): Promise<BuyerCoachingContent> {
  return _getBuyerCoaching(buyerStage, persona, brokerageId)
}
