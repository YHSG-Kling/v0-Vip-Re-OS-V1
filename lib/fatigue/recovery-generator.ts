/**
 * System 5.8: Buyer Fatigue Predictor — Recovery Plan Generator
 *
 * Generates a personalized recovery plan for a fatigued buyer. Plans are stored
 * in fatigue_alerts.message as a JSON payload on the buyer's open alert.
 *
 * Wave 87 (lane 87A): routed + booked through generateTextRouted under
 * `buyer_fatigue_coaching` with the alert's brokerage (§5 — ai_tool_usage is the
 * cost ledger); it was a raw generateText pinned to claude-sonnet with no ledger
 * row. The sweep calls it once per NEW alert, never per run.
 *
 * Recovery plan shape:
 *   { pause_days, re_engagement_message, search_reset_suggestion, morale_boost }
 */

import { generateTextRouted } from "@/lib/ai/models"
import { createServiceClient } from "@/lib/supabase/service"
import type { FatigueResult } from "./fatigue-calculator"
import { describeFatigueFactors } from "./fatigue-display"

// Retyped off the surviving calculator. The fatigue-scorer this used to import
// spoke a risk vocabulary (watch/warning) the buyer_fatigue_scores CHECK rejects,
// so a plan generated from it described a score that had never persisted.

export interface RecoveryPlan {
  pause_days:              number          // suggested break (1–14 days)
  re_engagement_message:   string          // what to say when re-engaging
  search_reset_suggestion: string          // how to refine/reset the search
  morale_boost:            string          // empathy line for the buyer
}

export async function generateRecoveryPlan(
  score: FatigueResult
): Promise<{ success: boolean; plan?: RecoveryPlan; error?: string }> {
  const supabase = createServiceClient()

  try {
    const { text } = await generateTextRouted({
      feature: "buyer_fatigue_coaching",
      brokerageId: score.brokerage_id,
      maxTokens: 300,
      system:
        "You are a real estate agent coach specializing in buyer fatigue recovery. " +
        "Generate a short, empathetic recovery plan for a fatigued buyer. " +
        "Return ONLY valid JSON with keys: pause_days (integer 1-14), " +
        "re_engagement_message (string, 1-2 sentences), " +
        "search_reset_suggestion (string, 1 sentence), " +
        "morale_boost (string, 1 warm empathy sentence). No markdown.",
      prompt:
        `Buyer fatigue data:\n` +
        `- Score: ${score.score}/100 (${score.risk_level})\n` +
        `- Showings: ${score.factors.total_showings}\n` +
        `- Tour days: ${score.factors.total_tour_days}\n` +
        `- Days searching: ${score.factors.days_searching}\n` +
        `- Rejected offers: ${score.factors.offers_rejected}\n` +
        `- Engagement: ${score.factors.engagement_detail ?? score.factors.engagement_trend}\n` +
        // Wave 88 (lane 88A): follow-up responsiveness, missed appointments, unsigned sellers — the
        // same sentence the alert and the contact card carry (fatigue-display).
        `- Signals: ${describeFatigueFactors(score.factors)}\n` +
        `If follow-up is going unanswered, the plan must pause or slow outreach — never add more.\n` +
        `Generate a recovery plan.`,
    })

    const clean = text.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "")
    const plan  = JSON.parse(clean) as RecoveryPlan

    // Store recovery plan in fatigue_alerts for this contact (tenant-pinned; the
    // refusal is READ — a plan that did not land is not reported as attached).
    const { error: storeErr } = await supabase
      .from("fatigue_alerts")
      .update({
        message: JSON.stringify({
          score:    score.score,
          risk:     score.risk_level,
          recovery: plan,
        }),
      })
      .eq("contact_id", score.contact_id)
      .eq("brokerage_id", score.brokerage_id)
      .eq("dismissed", false)
    if (storeErr) return { success: false, plan, error: `recovery plan not stored: ${storeErr.message}` }

    return { success: true, plan }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)

    // Fallback plan — never return empty-handed
    const fallback: RecoveryPlan = {
      pause_days: score.risk_level === "critical" ? 7 : 3,
      re_engagement_message:
        "I know this search has been challenging. Let's take a short break and come back refreshed with a focused new strategy.",
      search_reset_suggestion:
        "Narrow the search to your top 2 must-have criteria and expand by one zip code.",
      morale_boost:
        "Finding the right home takes time — your patience is actually protecting you from a bad decision.",
    }

    // Lane 87A: the fallback is RETURNED but was never stored, yet this reported
    // success — so the sweep counted a plan as attached that no alert carries.
    // Honest now: success=false with the fallback in hand for the caller.
    return { success: false, plan: fallback, error: `recovery plan not generated (${message}) — fallback returned, not stored` }
  }
}
