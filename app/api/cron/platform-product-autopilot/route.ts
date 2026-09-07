import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { runWeeklyProductAutopilot } from "@/lib/platform/product-content-autopilot"

/**
 * app/api/cron/platform-product-autopilot/route.ts
 *
 * Monday: the platform's own acquisition content for the week — the product
 * post calendar plus ONE ProductPromoReel video draft with its render queued
 * through the one registry — as GATED drafts a superadmin approves and posts
 * (app/dashboard/superadmin/growth). Registered in lib/kernel/cron-dispatch.ts;
 * owned by marketing_agent (lib/kernel/manager-registry.ts CRON_MANAGER).
 * Auth: CRON_SECRET.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const authError = verifyCronAuth(request)
  if (authError) return authError
  try {
    const svc = createServiceClient()
    const result = await runWeeklyProductAutopilot(svc)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
