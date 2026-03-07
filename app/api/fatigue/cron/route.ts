/**
 * System 5.8: Buyer Fatigue Predictor — Cron Runner
 *
 * Called by Vercel Cron every 12 hours.
 * Scores all active buyers (buyer_stage NOT IN terminal states).
 * Generates recovery plans for any contact whose score >= 60.
 *
 * Auth: CRON_SECRET header guard.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient }        from "@/lib/supabase/service"
import { calculateBuyerFatigue }      from "@/lib/fatigue/fatigue-scorer"
import { generateRecoveryPlan }       from "@/lib/fatigue/recovery-generator"

const TERMINAL_STAGES = [
  "BUYER_UNDER_CONTRACT",
  "BUYER_CLOSED",
  "BUYER_LIFETIME",
  "BUYER_DISENGAGED",
]

export const runtime  = "nodejs"
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret")
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Fetch all active buyers with their assigned agent
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id, brokerage_id, agent_id, buyer_stage, first_name, last_name")
    .not("buyer_stage", "in", `(${TERMINAL_STAGES.map(s => `"${s}"`).join(",")})`)
    .not("brokerage_id", "is", null)
    .eq("contact_type", "buyer")

  if (error) {
    console.error("[fatigue-cron] Failed to fetch contacts:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const results = {
    total:     contacts?.length ?? 0,
    scored:    0,
    recovered: 0,
    errors:    0,
  }

  for (const contact of contacts ?? []) {
    const agentId = contact.agent_id ?? contact.brokerage_id // fallback to brokerage as actor

    const scored = await calculateBuyerFatigue(
      contact.id,
      contact.brokerage_id,
      agentId
    )

    if (!scored.success || !scored.score) {
      results.errors++
      continue
    }

    results.scored++

    // Generate recovery plan for warning/critical buyers
    if (scored.score.fatigueScore >= 60) {
      const recovery = await generateRecoveryPlan(scored.score)
      if (recovery.success) results.recovered++
    }
  }

  console.log("[fatigue-cron] Complete:", results)
  return NextResponse.json({ ok: true, ...results })
}
