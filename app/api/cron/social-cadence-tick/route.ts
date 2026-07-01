/**
 * app/api/cron/social-cadence-tick/route.ts
 *
 * Daily cadence tick for GENERAL/BRAND social — the non-listing social gap. Listing events
 * auto-produce social already (listing-promo-social-publish); this keeps the feed alive between
 * listings with brand/engagement posts (market updates, tips) on the agent's cadence, staged
 * GATED from the topics pool across the connected platforms. Managed by the Marketing Manager.
 * Idempotent per (agent, day). Reuses the shared shouldFireCadenceToday helper.
 */
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { shouldFireCadenceToday } from "@/lib/marketing/cadence-policy"
import { stageSocialFromCadence } from "@/lib/marketing/social-cadence"

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
  preferred_post_types: string[] | null
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
    .from("social_cadence_policy")
    .select("scope_type, scope_id, brokerage_id, cadence, fire_day, preferred_categories, preferred_persona, preferred_post_types, skipped_until")
    .neq("cadence", "off")
    .limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ scope_type: string; scope_id: string; outcome: string; reason?: string }> = []
  for (const p of (policies ?? []) as PolicyRow[]) {
    if (!shouldFireCadenceToday({ cadence: p.cadence, fireDay: p.fire_day, skippedUntil: p.skipped_until, now })) continue

    // Resolve agents.id (social_posts.agent_id) + the agent's users.id (social_posts.user_id).
    let agentsId: string | null = null
    let agentUserId: string | null = null
    const brokerageId = p.brokerage_id
    if (p.scope_type === "agent") {
      const { data: a } = await svc.from("agents").select("id, user_id").eq("id", p.scope_id).maybeSingle()
      const ar = a as { id: string; user_id: string | null } | null
      agentsId = ar?.id ?? null
      agentUserId = ar?.user_id ?? null
    } else if (p.scope_type === "brokerage") {
      const { data: a } = await svc.from("agents").select("id, user_id").eq("brokerage_id", p.scope_id).eq("is_active", true).order("created_at", { ascending: true }).limit(1).maybeSingle()
      const ar = a as { id: string; user_id: string | null } | null
      agentsId = ar?.id ?? null
      agentUserId = ar?.user_id ?? null
    } else {
      results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: "skipped", reason: "team_scope_deferred" })
      continue
    }

    if (!agentsId || !agentUserId) {
      results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: "skipped", reason: "agent_unresolved" })
      continue
    }

    const r = await stageSocialFromCadence(
      { brokerageId, agentsId, agentUserId, categories: p.preferred_categories, persona: p.preferred_persona, postTypes: p.preferred_post_types },
      svc,
      { now },
    )
    results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: r.staged ? `staged:${r.count}:${r.postType ?? ""}` : "skipped", reason: r.staged ? undefined : r.reason })
  }

  return NextResponse.json({ ok: true, fired: results.filter((r) => r.outcome.startsWith("staged")).length, results })
}
