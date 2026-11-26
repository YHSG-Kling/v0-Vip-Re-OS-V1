/**
 * POST /api/platform/live-agent/session — mint the PLATFORM's own D-ID live
 * agent session (lane 77B). The platform-facing sibling of
 * app/api/embed/session (tenant): the SAME ensureDIDAgent → issueClientKey →
 * startLiveAgentSession chain, on the platform's OWN presenter
 * (lib/did/platform-live-agent.ts), metered under the platform-owned showcase
 * tenant, keyed by a platformLiveSessionId marker on every custom-LLM turn.
 *
 * PUBLIC + UNAUTHENTICATED by design (a prospect has no account) — throttled
 * per caller IP through the SAME limiter the prospect chat uses. Nothing in
 * the body names a tenant or a presenter: the presenter is the brand kit's,
 * the brokerage is the platform's, both server-resolved.
 *
 * FAIL CLOSED with an honest fallback: every refusal carries `fallback:
 * { text: true }` so the widget mounts the EXISTING text prospect chat
 * (app/get-started/prospect-chat.tsx → /api/platform/prospect-chat), never a
 * dead avatar bubble.
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { issueClientKey } from "@/lib/did/agents"
import { ensurePlatformDIDAgent, resolvePlatformLiveAgentBrokerageId } from "@/lib/did/platform-live-agent"
import { startLiveAgentSession, recordLiveAgentInitFailure } from "@/lib/did/live-session-metering"
import { decidePublicDoor, publicCallerIp } from "@/lib/security/public-rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface Body { visitorId?: string; origin?: string | null; pageUrl?: string | null }

const FALLBACK = { text: true as const }

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Body | null
  const svc = createServiceClient()

  // WAVE 155 (lane 155R20, G10) — THE DECISION, BEFORE ANY SPEND (lib/security/public-rate-limit.ts decidePublicDoor): the SAME
  // per-IP cap as before, FIRST, then the opt-in — the platform's own seeded showcase tenant, under which these minutes are
  // metered (resolvePlatformLiveAgentBrokerageId). Not seeded → not available (operator action, never a tenant borrowed). The
  // session is opened under the tenant the decision proved. No login wall: a prospect has no account.
  const verdict = await decidePublicDoor({
    surface: "platform-live-agent",
    callerKey: await publicCallerIp(),
    cap: { limit: 10, windowMs: 10 * 60_000 },
    optIn: async () => {
      if (!body?.visitorId) return null
      const showcase = await resolvePlatformLiveAgentBrokerageId(svc)
      return showcase ? { brokerageId: showcase, basis: "the platform's own showcase tenant (findDemoBrokerage) — the platform live agent's metering tenant" } : null
    },
  })
  if (!verdict.allowed && verdict.reason === "rate_limited") {
    return NextResponse.json({ error: "Too many sessions — give it a moment.", fallback: FALLBACK }, { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } })
  }
  if (!body?.visitorId) return NextResponse.json({ error: "visitorId required", fallback: FALLBACK }, { status: 400 })

  const brokerageId = verdict.allowed ? verdict.brokerageId : null
  if (!brokerageId) {
    return NextResponse.json({
      error: "The live agent isn't set up yet.",
      operator_hint: "Seed the showcase tenant from the superadmin demo page — the platform's live-agent minutes are metered under it.",
      fallback: FALLBACK,
    }, { status: 503 })
  }

  const initStartedAt = Date.now()
  const ensured = await ensurePlatformDIDAgent(svc)
  if (!ensured.ok) {
    void recordLiveAgentInitFailure({ brokerageId, surface: "site", reason: ensured.error, latencyMs: Date.now() - initStartedAt })
    return NextResponse.json({ error: ensured.error, operator_hint: ensured.operatorHint, fallback: FALLBACK }, { status: 409 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return NextResponse.json({ error: "App URL not configured", fallback: FALLBACK }, { status: 503 })
  const allowedOrigins = [appUrl, ...(process.env.DID_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)]
  const keyResult = await issueClientKey({ didAgentId: ensured.didAgentId, allowedOrigins: Array.from(new Set(allowedOrigins)) })
  if (!keyResult.ok) {
    void recordLiveAgentInitFailure({ brokerageId, surface: "site", reason: keyResult.error, latencyMs: Date.now() - initStartedAt })
    return NextResponse.json({ error: keyResult.error, fallback: FALLBACK }, { status: 502 })
  }

  // THE METERING ROW — the SAME live_agent_sessions row every live door opens
  // (m624); its id IS the platform marker the widget prefixes on turn one and
  // the heartbeat/end beacons (/api/embed/session/heartbeat|end, id-keyed)
  // keep alive and close. surface 'site': this is the app's own origin.
  const liveSession = await startLiveAgentSession({ brokerageId, surface: "site", didAgentId: ensured.didAgentId }, svc)
  if (!liveSession.ok) {
    return NextResponse.json({ error: "Could not open the live session.", fallback: FALLBACK }, { status: 500 })
  }

  return NextResponse.json({
    didAgentId: ensured.didAgentId,
    clientKey: keyResult.clientKey,
    presenterType: ensured.presenterType,
    sessionId: liveSession.id,
    liveSessionId: liveSession.id,
    greeting: ensured.agent.greeting,
    agentName: ensured.agent.name,
    fallback: FALLBACK,
  })
}
