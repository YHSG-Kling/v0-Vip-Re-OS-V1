// app/api/cron/capability-radar/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CAPABILITY RADAR LOOP — weekly. Registered in lib/kernel/cron-dispatch.ts
// (Vercel's 40-cron cap means nothing runs from vercel.json directly).
//
// Owner, 2026-09-06: the OS "needs to consistantly check for any new ideas or
// capability out on the web … autonomously builds it in as a new capability
// annoucemtn to stay ahead of the curve. autonomous loops."
//
// Platform-level: no tenant. Findings land on feature_flags as disabled beta
// radar flags and platform staff are told once per run. See
// lib/kernel/capability-radar.ts for what is and is not claimed.
import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runCapabilityRadar } from "@/lib/kernel/capability-radar"

export const runtime = "nodejs"
export const maxDuration = 120

export async function GET(req: NextRequest): Promise<NextResponse> {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const svc = createServiceClient()
  const r = await runCapabilityRadar(svc as never, { maxPerQuery: 5 })
  return NextResponse.json({
    ok:        r.errors.length === 0,
    searched:  r.searched,
    hits:      r.hits,
    new_flags: r.newFlags,
    announced: r.announced,
    skipped:   r.skipped,
    errors:    r.errors,
    findings:  r.findings.map((f) => ({ capability: f.capability, have_it: f.haveIt, url: f.url, feature_key: f.featureKey })),
  })
}
