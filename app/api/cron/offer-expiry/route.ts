import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { sweepDueOfferExpirations } from "@/lib/buyer-offer/expire-offers"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

/**
 * OFFER EXPIRY SWEEP — hourly.
 *
 * `markOfferExpired` is session-gated (correctly — a prior wave closed the hole
 * where any caller could kill any live offer by posting a uuid), which left the
 * platform with **no way for an offer to expire on its own**. Deadlines passed
 * and offers stayed PENDING forever.
 *
 * This is the unattended caller's OWN door: a service credential behind
 * `verifyCronAuth`, calling the shared library core directly
 * (`lib/buyer-offer/expire-offers.ts`) rather than impersonating a user against
 * the session-gated action. No fake identity; the session gate is untouched.
 *
 * The actor on each expiry activity is the offer's own `agent_id` (already an
 * `agents.id` — verified live: `offers.agent_id` FKs `agents(id)`), because an
 * unattended sweep has no human actor to name.
 *
 * Schedule: registered in `lib/kernel/cron-dispatch.ts` (the per-minute
 * dispatcher is the only cron Vercel runs).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "offer-expiry",
    cron_path: "/app/api/cron/offer-expiry/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[cron/offer-expiry] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const svc = createServiceClient()
    const result = await sweepDueOfferExpirations(svc)

    // A skip is not a failure (most are "not PENDING"), but a skip caused by a
    // refused/blocked write must not vanish into a clean 200.
    if (result.skipped.length > 0) {
      console.warn("[cron/offer-expiry] skipped:", JSON.stringify(result.skipped.slice(0, 20)))
    }

    // records_processed counts offers actually moved to EXPIRED — proven by the
    // `.select()` inside expireOffer, not the number we intended to touch.
    await recordCronSuccessAction({ context_id: contextId, records_processed: result.expired })

    return NextResponse.json({
      ok: true,
      scanned: result.scanned,
      expired: result.expired,
      skipped: result.skipped.length,
    })
  } catch (err) {
    console.error("[cron/offer-expiry] Failed:", err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: "sweep" })
    return NextResponse.json({ ok: false, context_id: contextId }, { status: 500 })
  }
}
