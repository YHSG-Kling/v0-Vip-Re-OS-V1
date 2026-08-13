/**
 * app/api/admin/deconflict/route.ts
 *
 * Broker-cockpit feed for the De-Conflict Engine. Returns recent decisions
 * scoped to the caller's brokerage (platform admins see all). The cockpit
 * surfaces:
 *
 *   - suppressed:  outbounds that got deferred this week (and why)
 *   - allowed:     outbounds that passed but pinged the engine (volume signal)
 *   - by_channel:  rollup so the broker can see lane saturation at a glance
 *
 * GET  /api/admin/deconflict?since=24h        — default: last 7 days
 * GET  /api/admin/deconflict?outcome=suppressed_over_touch
 * GET  /api/admin/deconflict?channel=email
 */
import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

function parseSince(input: string | null): string {
  // Supports '24h', '7d', '30d', or an ISO8601 timestamp.
  if (!input) return new Date(Date.now() - 7 * 86_400_000).toISOString()
  const m = input.match(/^(\d+)([hd])$/)
  if (m) {
    const n = parseInt(m[1], 10)
    const ms = m[2] === "h" ? n * 3_600_000 : n * 86_400_000
    return new Date(Date.now() - ms).toISOString()
  }
  const t = Date.parse(input)
  if (!isNaN(t)) return new Date(t).toISOString()
  return new Date(Date.now() - 7 * 86_400_000).toISOString()
}

export async function GET(req: NextRequest) {
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

  const since   = parseSince(req.nextUrl.searchParams.get("since"))
  const outcome = req.nextUrl.searchParams.get("outcome")
  const channel = req.nextUrl.searchParams.get("channel")

  let q = svc.from("deconflict_suppression_log")
    .select("id, brokerage_id, contact_id, recipient_email, recipient_phone, channel, system_source, outcome, reason, touches_in_window, window_days, policy_max, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500)
  if (!isPlatform) q = q.eq("brokerage_id", callerBrokerage!)
  if (outcome)     q = q.eq("outcome", outcome)
  if (channel)     q = q.eq("channel", channel)

  const { data: rows, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Channel + outcome rollup for the cockpit summary tiles.
  const byChannel: Record<string, { allowed: number; suppressed: number }> = {}
  for (const r of rows ?? []) {
    const c = r.channel as string
    byChannel[c] ??= { allowed: 0, suppressed: 0 }
    if (r.outcome === "allowed") byChannel[c].allowed++
    else byChannel[c].suppressed++
  }

  return NextResponse.json({
    since,
    count: rows?.length ?? 0,
    by_channel: byChannel,
    decisions: rows ?? [],
  })
}
