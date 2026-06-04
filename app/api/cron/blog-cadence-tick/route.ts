/**
 * app/api/cron/blog-cadence-tick/route.ts
 *
 * Wave 29 — daily cadence tick for auto-blog generation. Walks the
 * blog_cadence_policy table; for each (scope_type, scope_id, cadence)
 * row where the cadence's fire_day matches today, dispatches
 * generateBlogPost() with pullFromTopicBank=true.
 *
 * Schedule (vercel.json): "0 7 * * *" — 07:00 UTC daily. The per-scope
 * fire_day filter ensures each subscriber fires on at most their
 * configured day-of-week (weekly/biweekly) or day-of-month (monthly).
 *
 * Idempotency: the generator inserts blog_posts with publish_status='draft'.
 * Same-day duplicate spawns would create duplicate drafts; we guard by
 * checking that no blog_post exists for this (scope_id, today) tuple
 * before dispatching. The check is per-scope so an agent and their
 * brokerage policy both firing today won't double-stage (brokerage scope
 * skips when the agent has already produced a draft today).
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateBlogPost } from "@/app/actions/blog"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface PolicyRow {
  scope_type:           "agent" | "team" | "brokerage"
  scope_id:             string
  cadence:              "weekly" | "biweekly" | "monthly" | "off"
  fire_day:             number | null
  preferred_categories: string[] | null
  preferred_persona:    string | null
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs       = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  const svc = createServiceClient()
  const now      = new Date()
  const dayOfWeek = (now.getUTCDay() + 6) % 7   // Monday = 0
  const dayOfMonth = now.getUTCDate()
  const todayIso = now.toISOString().slice(0, 10)

  const { data: policies, error } = await svc
    .from("blog_cadence_policy")
    .select("scope_type, scope_id, cadence, fire_day, preferred_categories, preferred_persona")
    .neq("cadence", "off")
    .limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ scope_type: string; scope_id: string; outcome: string; reason?: string }> = []
  for (const p of (policies ?? []) as PolicyRow[]) {
    // Wave 29 — biweekly fires on the configured day-of-week, but only on
    // even ISO weeks (offset can be added later if desired).
    let shouldFire = false
    if (p.cadence === "weekly" && p.fire_day === dayOfWeek) shouldFire = true
    else if (p.cadence === "biweekly" && p.fire_day === dayOfWeek) {
      const isoWeek = isoWeekNumber(now)
      shouldFire = isoWeek % 2 === 0
    }
    else if (p.cadence === "monthly" && p.fire_day === dayOfMonth) shouldFire = true
    if (!shouldFire) continue

    // Resolve the agent + brokerage + agent_user_id for the dispatch call.
    // Agent scope: scope_id is agents.id → we need users.id + brokerage_id.
    // Team scope:  scope_id is teams.id → defer to per-team-member spawn
    //              (TODO: team-fanout in Wave 30); for now skip with reason.
    // Brokerage scope: scope_id is brokerages.id → pick the broker user as
    //                  the agent_user_id (broker-led blog generation).
    let agentUserId: string | null = null
    let brokerageId: string | null = null
    if (p.scope_type === "agent") {
      const { data: a } = await svc.from("agents")
        .select("user_id, brokerage_id")
        .eq("id", p.scope_id)
        .maybeSingle()
      const ar = a as { user_id: string | null; brokerage_id: string | null } | null
      agentUserId = ar?.user_id ?? null
      brokerageId = ar?.brokerage_id ?? null
    } else if (p.scope_type === "brokerage") {
      brokerageId = p.scope_id
      // Pick the broker (oldest admin user on this brokerage) as the
      // agent_user_id. Future commit can let the brokerage policy name a
      // specific user explicitly.
      const { data: u } = await svc.from("users")
        .select("id")
        .eq("brokerage_id", p.scope_id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
      agentUserId = (u?.id as string | undefined) ?? null
    } else {
      results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: "skipped", reason: "team scope deferred to Wave 30" })
      continue
    }

    if (!agentUserId || !brokerageId) {
      results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: "skipped", reason: "agent_user_id or brokerage_id unresolved" })
      continue
    }

    // Idempotency: skip if a draft already exists today for this (scope, day).
    const todayStartIso = `${todayIso}T00:00:00.000Z`
    const { count } = await svc.from("blog_posts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("agent_user_id", agentUserId)
      .eq("is_ai_generated", true)
      .gte("created_at", todayStartIso)
    if ((count ?? 0) > 0) {
      results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: "skipped", reason: "draft_already_exists_today" })
      continue
    }

    try {
      const r = await generateBlogPost(agentUserId, {
        brokerageId,
        agentUserId,
        keywords:          p.preferred_categories ?? [],
        pullFromTopicBank: true,
        recipientPersona:  p.preferred_persona ?? undefined,
      })
      results.push({
        scope_type: p.scope_type,
        scope_id:   p.scope_id,
        outcome:    r.success ? `drafted:${r.postId ?? ""}` : "failed",
        reason:     r.error,
      })
    } catch (e) {
      results.push({ scope_type: p.scope_type, scope_id: p.scope_id, outcome: "exception", reason: (e as Error).message })
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    policies_evaluated: policies?.length ?? 0,
    dispatched:         results.length,
    results,
  })
}

/** ISO 8601 week number (Mon-Sun). Used for biweekly cadence even-week filter. */
function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
}
