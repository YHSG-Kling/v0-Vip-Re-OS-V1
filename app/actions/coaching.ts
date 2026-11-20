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
  // Tenant from the SESSION (CLAUDE.md §4): this public "use server" export took both ids from the
  // caller. The brokerage must be the caller's own; a mismatch or no session refuses (fail closed).
  const { requireCallerTenant } = await import("@/lib/auth/require-caller")
  const caller = await requireCallerTenant(brokerageId)
  if (!caller.ok) throw new Error(caller.error)
  const report = await runAgentCoachingForAgent(agentId, caller.brokerageId)
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

// TOMBSTONE (CLAUDE.md §1.1/§1.3, wave 100 lane 100C): `getBuyerCoaching(buyerStage, persona, brokerageId)`
// that stood here was a THIRD door onto buyer coaching — a "use server" export (a public endpoint, §4)
// that took brokerageId from the BODY, checked no session and, on a cache miss, ran a paid model call
// under whatever tenant the caller named. Nothing imported it (grep: app/dashboard/coaching/page.tsx
// imports the engine directly; the CRM card imports app/actions/buyer-coaching.ts). The capability lives
// at lib/intelligence/coaching-engine.ts::getBuyerCoaching, reached from a client only through the
// session-gated app/actions/buyer-coaching.ts::getBuyerCoaching.
