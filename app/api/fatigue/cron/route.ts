/**
 * System 5.8: Buyer Fatigue Predictor — Cron Runner
 *
 * Called by Vercel Cron every 12 hours.
 * Scores all active buyers (buyer_stage NOT IN terminal states).
 * Generates recovery plans for any contact at high/critical risk (score >= 50).
 *
 * Auth: CRON_SECRET header guard.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient }        from "@/lib/supabase/service"
import { calculateFatigue }           from "@/lib/fatigue/fatigue-calculator"
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
    // calculateFatigue resolves the owning agent itself (contacts.agent_id is an
    // agents.id; the alert's agent_user_id is a users.id). The retired scorer took
    // an actor argument this loop supplied as `contact.agent_id ?? contact.brokerage_id`
    // — a BROKERAGE id passed as a user id whenever the contact had no agent.
    let scored
    try {
      scored = await calculateFatigue(contact.id, contact.brokerage_id)
    } catch (err) {
      console.error("[fatigue-cron] score failed for", contact.id, err)
      results.errors++
      continue
    }

    results.scored++

    // Recovery plan for the bands that actually raise an alert (high >= 50).
    if (scored.risk_level === "high" || scored.risk_level === "critical") {
      const recovery = await generateRecoveryPlan(scored)
      if (recovery.success) results.recovered++
    }
  }

  console.log("[fatigue-cron] Complete:", results)
  return NextResponse.json({ ok: true, ...results })
}
