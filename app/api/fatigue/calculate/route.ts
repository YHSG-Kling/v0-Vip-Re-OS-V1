import { NextRequest, NextResponse } from "next/server"
import { calculateAllBuyerFatigue }  from "@/lib/fatigue/fatigue-calculator"

export async function POST(req: NextRequest) {
  // Auth: CRON_SECRET header
  const secret = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace("Bearer ", "")
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const brokerageId: string | undefined = body.brokerageId

    const result = await calculateAllBuyerFatigue(brokerageId)

    return NextResponse.json({
      success:   true,
      processed: result.processed,
      errors:    result.errors,
      timestamp: new Date().toISOString(),
    })
  } catch (err: any) {
    console.error("[fatigue/calculate] Cron error:", err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
