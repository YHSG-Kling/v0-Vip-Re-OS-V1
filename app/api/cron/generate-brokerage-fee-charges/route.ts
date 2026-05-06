import { NextRequest, NextResponse } from "next/server"
import { generatePeriodicCharges } from "@/app/actions/brokerage-fees"

/**
 * Cron route — runs daily; generatePeriodicCharges is idempotent via the
 * (agent_id, fee_type_id, period_start) UNIQUE constraint, so daily runs
 * are safe even though most fees are monthly.
 *
 * Configure in vercel.json:
 *   { "path": "/api/cron/generate-brokerage-fee-charges", "schedule": "0 6 * * *" }
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`
  if (process.env.CRON_SECRET && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const result = await generatePeriodicCharges()
  return NextResponse.json(result)
}
