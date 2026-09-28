/**
 * System 5.8: Buyer Fatigue Predictor — Cron Runner
 *
 * Dispatched every 12 hours by lib/kernel/cron-dispatch.ts (one Vercel heartbeat,
 * /api/cron/dispatch). THE PLATFORM SCOPE of the one fatigue sweep (wave 87, lane
 * 87A; owner: "fatigue sweeps run for the platform on tenants and brokerage on
 * leads and contacts which is user run. should be run on how the fatigue
 * calculation is derived."): across EVERY tenant, it scores every person the
 * calculation's inputs name (completed showings / tours, rejected offers,
 * buyer_behavior_log — lib/fatigue/fatigue-calculator.ts FATIGUE_INPUT_SOURCES),
 * including contacts that are a lead's conversion, and counts the leads with
 * nothing to derive from. A recovery plan attaches once per NEW high/critical
 * alert (score >= 50). The brokerage scope is the tenant admin's "Recalculate"
 * (app/actions/buyer-fatigue.ts recalculateBrokerageFatigue) on the SAME core.
 *
 * THE ONE SCHEDULED FATIGUE SWEEP (lane 86G2).
 * TOMBSTONE: app/api/fatigue/calculate/route.ts POST was a DUPLICATE sweep
 * (daily, POST-only — the dispatcher's GET got 405 every run) and is deleted,
 * with its registry entry. Its body and this route's inlined loop were merged
 * onto ONE core, carrying what each lacked.
 * Survivor: lib/fatigue/fatigue-calculator.ts runFatigueSweep (lane 87A renamed
 * 86G2's calculateAllBuyerFatigue when its population moved from a stage list to
 * the calculation's inputs). The dashboard's "Recalculate" button calls the
 * session-gated door app/actions/buyer-fatigue.ts recalculateBrokerageFatigue on
 * the same core.
 * TOMBSTONE: the local TERMINAL_STAGES list (a second spelling of "active buyer",
 * §6). No stage list decides the population any more; the only stage exclusion is
 * a concluded search — survivor lib/contacts/buyer-stage.ts BUYER_CONCLUDED_STAGES,
 * via the core.
 *
 * Auth: lib/cron-auth.ts verifyCronAuth (Bearer or x-cron-secret; fail closed).
 */

import { NextRequest, NextResponse } from "next/server"
import { runFatigueSweep }            from "@/lib/fatigue/fatigue-calculator"
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
    const results = await runFatigueSweep(
      platformScope("CRON_SECRET-verified fatigue sweep — every tenant's people with fatigue inputs, by design (app/api/fatigue/cron)"),
    )
    console.log("[fatigue-cron] Complete:", results)
    return NextResponse.json({ ok: true, ...results })
  } catch (err) {
    console.error("[fatigue-cron] sweep failed:", err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
