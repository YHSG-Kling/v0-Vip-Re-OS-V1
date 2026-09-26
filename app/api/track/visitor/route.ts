"use server"
// POST /api/track/visitor
//
// BUILT (orphan doctrine §1.2, wave 64C — lead-scraping audit lane).
// app/actions/lead-intelligence.ts::trackBehavior is the file's own documented
// "legitimate public visitor-tracking pixel" (see that file's header, ~L54-58)
// — it writes behavioral_signals/site_activity for an ANONYMOUS visitor on the
// brokerage's OWN website (pages viewed, calculators used, time on page) and
// deliberately takes `brokerage_id` as a plain field rather than from a
// session, because a public pixel has no session. It had ZERO callers anywhere
// in the repo (orphan-export-guard category A) — no route ever reached it.
// This route is the missing HTTP door.
//
// TENANT RESOLUTION reuses lib/widget/resolve-widget-tenant.ts — the same
// brokerage_slug → brokerageId resolver the chat widget's own public session
// mint uses, for the same reason: a public caller must never hand us a
// brokerage_id directly (CLAUDE.md §4 body-supplied-tenant IDOR shape) and get
// it trusted. Reusing it here is a deliberate widening of its use (this is
// SITE ANALYTICS, not the chat widget), not a new tenant-resolution surface —
// stated so the next reader does not mistake it for scope creep. Its
// `widget_enabled` gate doubles, imperfectly, as a general "this brokerage's
// public JS surfaces are on" switch; a brokerage that wants tracking without
// chat is a real future gap, flagged rather than solved here.
//
// No auth beyond that — same posture as /api/widget/session: public-surface
// rate limit + same-origin-when-a-browser-states-it. trackBehavior itself
// still runs its own tenant validation (isValidUUID(brokerage_id)) as a second
// gate — this route just refuses to let that value come from the caller.

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { checkPublicRateLimit } from "@/lib/security/public-rate-limit"
import { resolveWidgetTenant, widgetCallOriginAllowed } from "@/lib/widget/resolve-widget-tenant"
import { trackBehavior } from "@/app/actions/lead-intelligence"

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown"
    const verdict = checkPublicRateLimit("track-visitor", ip, { limit: 60, windowMs: 60_000 })
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: "Too many events from this connection — try again shortly." },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
      )
    }

    if (!widgetCallOriginAllowed(req)) {
      return NextResponse.json({ error: "This event cannot be recorded from here." }, { status: 403 })
    }

    const body = await req.json()
    const {
      brokerage_slug,
      visitor_id,
      page_visited,
      time_spent,
      action_taken,
      search_terms,
      calculator_inputs,
    }: {
      brokerage_slug: string
      visitor_id: string
      page_visited: string
      time_spent: number
      action_taken?: string
      search_terms?: string[]
      calculator_inputs?: unknown
    } = body

    if (!visitor_id || !page_visited) {
      return NextResponse.json({ error: "visitor_id and page_visited are required" }, { status: 400 })
    }

    const supabase = createServiceClient()
    // THE ONLY place brokerage_id comes from for this route — resolved from a
    // public slug, never accepted from the body.
    const resolution = await resolveWidgetTenant(supabase, { brokerageSlug: brokerage_slug })
    if (!resolution.ok) {
      return NextResponse.json({ error: resolution.error }, { status: resolution.status })
    }

    const result = await trackBehavior({
      visitor_id,
      page_visited,
      time_spent: Number(time_spent) || 0,
      action_taken,
      search_terms,
      calculator_inputs,
      ip_address: ip,
      user_agent: req.headers.get("user-agent") ?? undefined,
      brokerage_id: resolution.tenant.brokerageId,
    })

    if (!result.success) {
      return NextResponse.json({ error: (result as { error?: string }).error ?? "not recorded" }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[track/visitor] unexpected failure:", error)
    return NextResponse.json({ error: "internal error" }, { status: 500 })
  }
}
