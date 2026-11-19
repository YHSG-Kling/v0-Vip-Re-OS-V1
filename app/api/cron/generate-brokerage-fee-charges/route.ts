import { NextRequest, NextResponse } from "next/server"
import { generatePeriodicCharges } from "@/lib/billing/brokerage-fee-charges"
import { verifyCronAuth } from "@/lib/cron-auth"
import { decideCronRun } from "@/lib/kernel/cron-logging"

/**
 * Cron route — runs daily; generatePeriodicCharges is idempotent via the
 * (agent_id, fee_type_id, period_start) UNIQUE constraint, so daily runs
 * are safe even though most fees are monthly.
 *
 * Configure in vercel.json:
 *   { "path": "/api/cron/generate-brokerage-fee-charges", "schedule": "0 6 * * *" }
 */
export async function GET(req: NextRequest) {
  // Fail-closed cron auth (the previous inline check skipped auth entirely when
  // CRON_SECRET was unset — fail-open — exposing financial charge generation).
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth
  const cronDoor = await decideCronRun({ cron_name: "generate-brokerage-fee-charges", cron_path: "/app/api/cron/generate-brokerage-fee-charges/route.ts" }) // cron decision door (155R1)
  if (cronDoor.held) return NextResponse.json({ success: true, held: true, decision: cronDoor.decision })

  const result = await generatePeriodicCharges()
  return NextResponse.json(result)
}
