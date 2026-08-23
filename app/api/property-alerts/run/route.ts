import { NextRequest, NextResponse } from "next/server"
import { runAllActiveAlerts } from "@/lib/property-alerts/alert-engine"

export async function POST(req: NextRequest) {
  // Auth: Bearer [CRON_SECRET]
  //
  // AN UNSET SECRET REFUSES. This read `if (cronSecret && authHeader !== …)`, so
  // when CRON_SECRET was absent from the environment the check did not run and the
  // request passed — and what it passes into is runAllActiveAlerts(frequency,
  // brokerageId) with brokerageId taken from the BODY, on the service client, whose
  // tenant predicate is conditional. Omit it and every tenant's property alerts are
  // swept; supply one and you pick a tenant you were never checked against.
  // CLAUDE.md §4: "a gate that cannot run must refuse, not pass." The 404-on-unset
  // rule is the one already in force at app/api/webhooks/sendgrid-events/route.ts
  // ("Unset secret = 404 — never a silently-open writer"); app/api/fatigue/
  // calculate/route.ts refuses on unset too. One vocabulary (§6).
  const authHeader = req.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let frequency = "daily"
  let brokerageId: string | undefined

  try {
    const body = await req.json().catch(() => ({}))
    if (body.frequency)   frequency   = body.frequency
    if (body.brokerageId) brokerageId = body.brokerageId
  } catch (_) {}

  // Also allow query param (Vercel cron GET → converted to POST by middleware)
  const url = new URL(req.url)
  if (url.searchParams.get("frequency"))   frequency   = url.searchParams.get("frequency")!
  if (url.searchParams.get("brokerageId")) brokerageId = url.searchParams.get("brokerageId")!

  const stats = await runAllActiveAlerts(frequency, brokerageId)

  return NextResponse.json({ ok: true, frequency, ...stats })
}

// Vercel cron invokes via GET
export async function GET(req: NextRequest) {
  return POST(req)
}
