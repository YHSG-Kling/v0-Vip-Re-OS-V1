// app/api/cron/carrier-registration-tick/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Hourly (lib/kernel/cron-dispatch.ts). The autonomous half of business
// registration (wave 83D): polls open number ports and lands completed numbers,
// then walks each tenant's A2P 10DLC / toll-free registration forward through
// Twilio's asynchronous reviews — no human button. See
// lib/voice/carrier-registration-loop.ts for the whole loop.

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runCarrierRegistrationTick } from "@/lib/voice/carrier-registration-loop"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(req: Request) {
  const denied = verifyCronAuth(req)
  if (denied) return denied
  const svc = createServiceClient()
  const r = await runCarrierRegistrationTick(svc, { limit: 50 })
  return NextResponse.json({
    tenants: r.tenants,
    advanced: r.results.length,
    ported: r.results.flatMap((x) => x.ported),
    approved: r.results.filter((x) => x.after === "approved" && x.before !== "approved").map((x) => x.brokerageId),
    needsInput: r.results.filter((x) => x.after === "needs_input" || x.after === "rejected").map((x) => ({ brokerageId: x.brokerageId, needs: x.needs })),
    errors: [...r.errors, ...r.results.filter((x) => x.error).map((x) => `${x.brokerageId}: ${x.error}`)],
  }, { status: r.errors.length && !r.results.length ? 500 : 200 })
}
