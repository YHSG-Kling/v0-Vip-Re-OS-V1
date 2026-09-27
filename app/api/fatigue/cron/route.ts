/**
 * System 5.8: Buyer Fatigue Predictor — Cron Runner
 *
 * Dispatched every 12 hours by lib/kernel/cron-dispatch.ts (one Vercel heartbeat,
 * /api/cron/dispatch). Scores every active buyer on the platform and attaches a
 * recovery plan to any at high/critical risk (score >= 50).
 *
 * THE ONE SCHEDULED FATIGUE SWEEP (lane 86G2).
 * TOMBSTONE: app/api/fatigue/calculate/route.ts POST was a DUPLICATE sweep
 * (daily, POST-only — the dispatcher's GET got 405 every run) and is deleted,
 * with its registry entry. Its body and this route's inlined loop were merged
 * onto ONE core, carrying what each lacked.
 * Survivor: lib/fatigue/fatigue-calculator.ts calculateAllBuyerFatigue. The
 * dashboard's "Recalculate" button now calls the session-gated door
 * app/actions/buyer-fatigue.ts recalculateBrokerageFatigue on the same core.
 * TOMBSTONE: the local TERMINAL_STAGES list (a second spelling of "active buyer",
 * §6) — survivor lib/contacts/buyer-stage.ts BUYER_ACTIVE_STAGES, via the core.
 *
 * Auth: lib/cron-auth.ts verifyCronAuth (Bearer or x-cron-secret; fail closed).
 */

import { NextRequest, NextResponse } from "next/server"
import { calculateAllBuyerFatigue }   from "@/lib/fatigue/fatigue-calculator"
import { platformScope }              from "@/lib/kernel/tenant-scope"
import { verifyCronAuth }             from "@/lib/cron-auth"

export const runtime  = "nodejs"
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Auth via the ONE helper (lane 86G). This read `x-cron-secret ?? ?secret=`
  // compared raw against process.env.CRON_SECRET: no 500 when the secret is
  // unset, and it never read `Authorization: Bearer` — the header the only
  // caller sends (lib/kernel/cron-dispatch.ts dispatchDueCrons), so every
  // dispatched run was refused 401.
  // TOMBSTONE: the `?secret=` query credential is DROPPED — no caller sends it
  // (vercel.json schedules only /api/cron/dispatch; no source file names
  // `fatigue/cron?secret`), and a secret in a URL lands in access logs.
  // Survivor: lib/cron-auth.ts verifyCronAuth (Bearer, or x-cron-secret by opt-in).
  const denied = verifyCronAuth(req, { acceptCronSecretHeader: true })
  if (denied) return denied

  try {
    const results = await calculateAllBuyerFatigue(
      platformScope("CRON_SECRET-verified fatigue sweep — every tenant's active buyers, by design (app/api/fatigue/cron)"),
    )
    console.log("[fatigue-cron] Complete:", results)
    return NextResponse.json({ ok: true, ...results })
  } catch (err) {
    console.error("[fatigue-cron] sweep failed:", err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
