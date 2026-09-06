import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { coordinateDualTransaction } from "@/lib/intelligence/dual-transaction-timing-runner"

/**
 * DUAL-TRANSACTION TIMING sweep — every 6 hours
 * (schedule registered in lib/kernel/cron-dispatch.ts — minute 28, every 6th
 * hour; the cron expression is not spelled here because its slash-star would
 * close this block comment).
 *
 * WHY (wave 26). lib/intelligence/dual-transaction-timing-runner.ts:27
 * coordinateDualTransaction had no caller. The move-up choreography that keeps
 * the Listing Concierge and the Shopping Agent from drifting out of sync had
 * never coordinated a real contact.
 *
 * POPULATION: contacts with contact_type = 'both' — a live CHECK value
 * (scripts/check-vocabularies.ts → contacts.contact_type), and the marker
 * dual-intent-linker sets on a move-up client. `contacts` has TWO uuid columns,
 * `id` (PK) and `contact_id` (§3); the runner filters listings.seller_contact_id
 * and showings.contact_id, both of which FK the PK, so `id` is what is passed.
 *
 * CADENCE: six-hourly. The play turns on a listing STAGE and a close date, which
 * move on the order of days — but a stage change that lands in the morning
 * should not wait until tomorrow to re-time the buyer side.
 *
 * IDEMPOTENCY IS ALREADY INSIDE THE RUNNER — dual-transaction-timing-runner.ts:
 * 61-65 refuses a second coordination for the same (contact, play) inside 14
 * days. This route deliberately adds none of its own: a second, differently
 * shaped window here would only disagree with it.
 *
 * Tenant: platform cron on the service client, gated by the cron secret; the
 * brokerage id passed to the runner is the CONTACT's own (§4).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const TENANT_CAP = 500
const CONTACTS_PER_TENANT = 500

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "dual-transaction-timing",
    cron_path: "/app/api/cron/dual-transaction-timing/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[DualTransactionTiming] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()

    const { data: brokerages, error: brokeragesError } = await supabase
      .from("brokerages")
      .select("id")
      .eq("is_active", true)
      .is("deleted_at", null)
      .limit(TENANT_CAP)
    if (brokeragesError) throw new Error(`brokerages read refused: ${brokeragesError.message}`)

    let tenantsScanned = 0
    let contactsScanned = 0
    let coordinated = 0
    let notDual = 0
    const plays: Record<string, number> = {}
    const errors: Array<{ brokerageId: string; error: string }> = []

    for (const b of (brokerages ?? []) as Array<{ id: string }>) {
      try {
        const { data: contacts, error: contactsError } = await supabase
          .from("contacts")
          .select("id")
          .eq("brokerage_id", b.id)
          .eq("contact_type", "both")
          .is("deleted_at", null)
          .limit(CONTACTS_PER_TENANT)
        if (contactsError) throw new Error(`contacts read refused: ${contactsError.message}`)
        tenantsScanned += 1

        for (const c of (contacts ?? []) as Array<{ id: string }>) {
          contactsScanned += 1
          const r = await coordinateDualTransaction(
            { brokerageId: b.id, contactId: c.id },
            supabase,
          )
          if (r.play) plays[r.play] = (plays[r.play] ?? 0) + 1
          if (r.coordinated) coordinated += 1
          else if (!r.play) notDual += 1
        }
      } catch (e) {
        errors.push({ brokerageId: b.id, error: e instanceof Error ? e.message : String(e) })
      }
    }

    const payload = {
      tenants_scanned: tenantsScanned,
      tenant_cap: TENANT_CAP,
      tenant_capped: (brokerages?.length ?? 0) >= TENANT_CAP,
      contacts_scanned: contactsScanned,
      contacts_per_tenant_cap: CONTACTS_PER_TENANT,
      coordinated,
      // A move-up contact with no live listing has no dual timing to coordinate
      // yet — counted, not treated as a failure.
      not_yet_dual: notDual,
      plays,
      errors: errors.slice(0, 20),
      error_count: errors.length,
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: contactsScanned,
      output_count: coordinated,
      metadata: payload,
    })
    return NextResponse.json({ success: true, ...payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[DualTransactionTiming] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
