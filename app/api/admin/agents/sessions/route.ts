/**
 * app/api/admin/agents/sessions/route.ts
 *
 * Admin observability for Managed Agent sessions — the minimum surface needed to
 * see what the four agent kinds are doing across all running sessions:
 *
 *   - GET /api/admin/agents/sessions
 *       List running / idle sessions, scoped to caller's brokerage (platform admins
 *       see all). Returns last_agent_message preview, rubric progress (latest
 *       outcome evaluation), entity context.
 *
 *   - GET /api/admin/agents/sessions?session_id=...
 *       Single session detail including every outcome_evaluation row.
 *
 * Auth: requires a logged-in user; platform admins see all brokerages, brokerage
 * staff see only their own brokerage's sessions. Same gate the rest of the admin
 * surface uses (assertCanActOnContact pattern — but applied at brokerage scope).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────
  const auth = await createClient()
  const { data: { user } } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const svc = createServiceClient()
  const { data: profile } = await svc.from("users")
    .select("user_type, platform_role, brokerage_id").eq("id", user.id).maybeSingle()
  const isPlatform = isPlatformStaffIdentity(profile?.user_type, profile?.platform_role)
  const callerBrokerage = (profile?.brokerage_id as string | null) ?? null
  if (!isPlatform && !callerBrokerage) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const sessionId = req.nextUrl.searchParams.get("session_id")

  // ── Single-session detail ──────────────────────────────────────────────
  if (sessionId) {
    let q = svc.from("managed_agent_sessions")
      .select("id, anthropic_session_id, brokerage_id, entity_type, entity_id, status, stop_reason, last_agent_message, last_event_at, created_at, ended_at, managed_agent_id")
      .eq("id", sessionId)
    if (!isPlatform) q = q.eq("brokerage_id", callerBrokerage!)
    const { data: session } = await q.maybeSingle()
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 })

    // Resolve the agent kind from managed_agents.
    const { data: agent } = await svc.from("managed_agents")
      .select("agent_kind, anthropic_agent_id, model")
      .eq("id", session.managed_agent_id as string)
      .maybeSingle()

    // Every rubric evaluation for this session, newest first.
    const { data: evals } = await svc.from("agent_outcome_evaluations")
      .select("iteration, result, explanation, input_tokens, output_tokens, cache_read_input_tokens, evaluated_at")
      .eq("managed_agent_session_id", session.id as string)
      .order("iteration", { ascending: false })

    return NextResponse.json({
      session,
      agent_kind: agent?.agent_kind ?? null,
      model:      agent?.model      ?? null,
      anthropic_agent_id: agent?.anthropic_agent_id ?? null,
      evaluations: evals ?? [],
    })
  }

  // ── List sessions ──────────────────────────────────────────────────────
  let q = svc.from("managed_agent_sessions")
    .select("id, anthropic_session_id, brokerage_id, entity_type, entity_id, status, last_agent_message, last_event_at, created_at, managed_agent_id")
    .order("last_event_at", { ascending: false, nullsFirst: false })
    .limit(200)
  if (!isPlatform) q = q.eq("brokerage_id", callerBrokerage!)

  // Status filter: default to running+idle (the actionable cases). Use ?status=all to see everything.
  const statusFilter = req.nextUrl.searchParams.get("status") ?? "active"
  if (statusFilter === "active") q = q.in("status", ["running", "idle"])
  else if (statusFilter !== "all") q = q.eq("status", statusFilter)

  const { data: sessions, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Hydrate each session with its agent_kind + latest rubric result (so the caller
  // doesn't need a second round-trip per row). Best-effort batch lookup.
  const agentIds = Array.from(new Set((sessions ?? []).map(s => s.managed_agent_id as string).filter(Boolean)))
  const { data: agents } = agentIds.length > 0
    ? await svc.from("managed_agents").select("id, agent_kind").in("id", agentIds)
    : { data: [] }
  const agentKindById = new Map<string, string>()
  for (const a of agents ?? []) agentKindById.set(a.id as string, a.agent_kind as string)

  // Latest rubric eval per session in one query.
  const sessionIds = (sessions ?? []).map(s => s.id as string)
  const { data: latestEvals } = sessionIds.length > 0
    ? await svc.from("agent_outcome_evaluations")
        .select("managed_agent_session_id, iteration, result")
        .in("managed_agent_session_id", sessionIds)
    : { data: [] }
  const latestEvalBySession = new Map<string, { iteration: number; result: string }>()
  for (const e of latestEvals ?? []) {
    const k = e.managed_agent_session_id as string
    const cur = latestEvalBySession.get(k)
    const it  = e.iteration as number
    if (!cur || it > cur.iteration) latestEvalBySession.set(k, { iteration: it, result: e.result as string })
  }

  const hydrated = (sessions ?? []).map(s => ({
    ...s,
    agent_kind:           agentKindById.get(s.managed_agent_id as string) ?? null,
    last_evaluation:      latestEvalBySession.get(s.id as string) ?? null,
    last_agent_message:   typeof s.last_agent_message === "string"
      ? (s.last_agent_message as string).slice(0, 240)
      : null,
  }))

  return NextResponse.json({
    count: hydrated.length,
    sessions: hydrated,
  })
}
