import { NextRequest, NextResponse } from "next/server"
import { runAllActiveAlerts } from "@/lib/property-alerts/alert-engine"

export async function POST(req: NextRequest) {
  // Auth: Bearer [CRON_SECRET]
  const authHeader = req.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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
