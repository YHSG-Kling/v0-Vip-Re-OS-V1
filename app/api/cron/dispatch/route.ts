import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { dispatchDueCrons, CRON_REGISTRY } from "@/lib/kernel/cron-dispatch"

/**
 * THE CRON DISPATCHER — the only cron Vercel runs (per-minute). Computes which of the
 * 100+ registered schedules (lib/kernel/cron-dispatch.ts — single source of truth,
 * preserved verbatim from the old vercel.json) are due this minute and fans out
 * internal calls with the same Bearer CRON_SECRET header Vercel would send. Target
 * routes run completely unchanged, behind their own verifyCronAuth.
 *
 * Why: Vercel caps platform crons at 40/project; 105 individual entries made every
 * deployment fail at config validation before the build started.
 */
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  try {
    const r = await dispatchDueCrons()
    if (r.failures.length > 0) {
      console.error("[cron-dispatch] failures:", JSON.stringify(r.failures.slice(0, 20)))
    }
    return NextResponse.json({
      ok: true, registered: CRON_REGISTRY.length,
      due: r.due, dispatched: r.dispatched, failures: r.failures.slice(0, 20),
    })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
  }
}
