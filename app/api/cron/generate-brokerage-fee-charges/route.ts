import { NextRequest, NextResponse } from "next/server"
import { generatePeriodicCharges } from "@/app/actions/brokerage-fees"
import { verifyCronAuth } from "@/lib/cron-auth"

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

  const result = await generatePeriodicCharges()
  return NextResponse.json(result)
}
