/**
 * app/api/cron/newsletter-cadence-tick/route.ts
 *
 * Daily cadence tick for AUTO-NEWSLETTER generation — the last standalone marketing type that
 * had no auto-cadence (blog has blog-cadence-tick, direct-mail has farm-mail-weekly, ads has
 * ads-manager-sweep). Walks newsletter_cadence_policy; for each (scope, cadence) that fires
 * today, stages a GATED newsletter draft from the topics pool (stageNewsletterFromCadence).
 * The agent never has to build a newsletter every cycle — the AI studio produces it and the
 * human just approves. Idempotent per (agent, day). Managed by the Campaign Orchestrator.
 */
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { shouldFireCadenceToday } from "@/lib/marketing/cadence-policy"
import { stageNewsletterFromCadence } from "@/lib/marketing/newsletter-cadence"

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 })
}

interface PolicyRow {
  scope_type: "agent" | "team" | "brokerage"
  scope_id: string
  brokerage_id: string
  cadence: string
  fire_day: number | null
  preferred_categories: string[] | null
  preferred_persona: string | null
  skipped_until: string | null
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  const svc = createServiceClient()
  const now = new Date()

  const { data: policies, error } = await svc
    .from("newsletter_cadence_policy")
    .select("scope_type, scope_id, brokerage_id, cadence, fire_day, preferred_categories, preferred_persona, skipped_until")
    .neq("cadence", "off")
    .limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ scope_type: string; scope_id: string; outcome: string; reason?: string }> = []
  for (const p of (policies ?? []) as PolicyRow[]) {
    if (!shouldFireCadenceToday({ cadence: p.cadence, fireDay: p.fire_day, skippedUntil: p.skipped_until, now })) continue

    // Resolve the agents.id (newsletter_campaigns.agent_id FK → agents.id) + brokerage.
    // Agent scope: scope_id IS the agents.id. Brokerage scope: pick the brokerage's oldest
    // active agent as the author. Team scope deferred (skip with reason).
    let agentsId: string | null = null
    let brokerageId: string | null = p.brokerage_id ?? null
    if (p.scope_type === "agent") {
      const { data: a } = await svc.from("agents").select("id, brokerage_id").eq("id", p.scope_id).maybeSingle()
      const ar = a as { id: string; brokerage_id: string | null } | null
      agentsId = ar?.id ?? null
      brokerageId = brokerageId ?? ar?.brokerage_id ?? null
    } else if (p.scope_type === "brokerage") {
      const { data: a } = await svc.from("agents").select("id").eq("brokerage_id", p.scope_id).eq("is_active", true).order("created_at", { ascending: true }).limit(1).maybeSingle()
      agentsId = (a as { id?: string } | null)?.id ?? null
      brokerageId = brokerageId ?? p.scope_id
    } else {
      results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: "skipped", reason: "team_scope_deferred" })
      continue
    }

    if (!agentsId || !brokerageId) {
      results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: "skipped", reason: "agent_or_brokerage_unresolved" })
      continue
    }

    const r = await stageNewsletterFromCadence(
      { brokerageId, agentsId, categories: p.preferred_categories, persona: p.preferred_persona },
      svc,
      { now },
    )
    results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: r.staged ? `staged:${r.campaignId ?? ""}` : "skipped", reason: r.staged ? undefined : r.reason })
  }

  return NextResponse.json({ ok: true, fired: results.filter((r) => r.outcome.startsWith("staged")).length, results })
}
