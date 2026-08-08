// app/api/cron/contact-enrichment/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SAFETY NET — and, until now, a cron that processed zero contacts on every
// run and reported success.
//
// ── WHAT WAS BROKEN ──────────────────────────────────────────────────────────
// It called `getUnenrichedContacts()` and `getContactsNeedingLifeChangeCheck()`
// from app/actions/contact-enrichment.ts. An earlier wave anchored both on the
// session — `const ctx = await getAgentContext(); if (!ctx.brokerageId) return
// { contacts: [], count: 0 }` — and left a comment recording the consequence:
// "the enrichment cron has no session; under RLS the anon client returned
// nothing anyway". A cron has no session, so both readers returned an empty list
// every night, the loops below iterated nothing, and the run reported
// `status: 'completed'` with `records_processed: 0`.
//
// ── THE FIX: AN UNATTENDED DOOR, NOT A FAKE IDENTITY ─────────────────────────
// Same shape as app/api/cron/sync-facebook-audiences, which stopped calling a
// session-gated server action with the literal string "system" and now calls the
// kernel command directly, reading `brokerage_id` off the row it is processing.
// Here the work lives in lib/enrichment/contact-enrichment-core.ts and takes
// `brokerageId` as an argument. This route iterates ACTIVE BROKERAGES and passes
// each id explicitly.
//
// It cannot take a tenant from a caller because it never reads one from the
// request: there is no body, no query parameter, and no header other than the
// CRON_SECRET bearer that verifyCronAuth checks. That is the property that
// matters — not "who does this cron claim to be", but "can an HTTP caller point
// it at a tenant". It cannot.
//
// ── WHY KEEP IT AT ALL ───────────────────────────────────────────────────────
// Because the event-driven lane does not cover every door. Nineteen distinct
// `contacts` INSERT sites exist in app/ + lib/ (enumerated in
// docs/wave3-enrichment.md); the kernel event bus reaches the ones that emit
// CONTACT_CREATED / CONTACT_CAPTURED, and the rest — the social webhooks, the
// ad-lead intake, the lead-magnet capture, the seller contact auto-created
// alongside a listing — insert a row and emit nothing. Retiring this cron would
// mean those contacts are never enriched at all. It is the net under the
// event-driven lane, not the lane.
//
// ── SPEND IS BOUNDED, THREE WAYS ─────────────────────────────────────────────
//   1. Per-brokerage caps (PER_BROKERAGE_ENRICH / PER_BROKERAGE_LIFE_CHECK).
//   2. A GLOBAL per-run ceiling (RUN_VENDOR_CALL_BUDGET) so a platform with a
//      thousand brokerages cannot turn one nightly tick into a five-figure
//      vendor bill. The run stops early and the next tick resumes where it left
//      off — the work list is derived from `enriched_at IS NULL`, so progress is
//      inherently resumable.
//   3. checkVendorBudget inside the core, per brokerage, before each contact.
// And the owner's suppression rule is applied to every contact before a cent is
// spent: no enrichment while a contact has an active listing or an active
// transaction.

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  enrichContactRecord,
  runLifeChangeCheck,
  listUnenrichedContacts,
  listContactsDueForLifeChangeCheck,
} from "@/lib/enrichment/contact-enrichment-core"
import { verifyCronAuth } from "@/lib/cron-auth"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 minutes

/** Contacts enriched per brokerage per run. */
const PER_BROKERAGE_ENRICH = 25
/** Life-change re-checks per brokerage per run. */
const PER_BROKERAGE_LIFE_CHECK = 25
/**
 * Hard ceiling on billable vendor operations for the WHOLE run, across every
 * tenant. One enrichment and one life-change check each count as one.
 */
const RUN_VENDOR_CALL_BUDGET = 500
/** Politeness delay between vendor calls. */
const RATE_LIMIT_MS = 1000

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "contact-enrichment",
    cron_path: "/app/api/cron/contact-enrichment/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[ContactEnrichment] Failed to record cron start:", startRecordResult.error)
  }

  const supabase = createServiceClient()
  const startTime = Date.now()
  const results = {
    brokerages: 0,
    newEnrichments: { success: 0, failed: 0, skipped: 0 },
    lifeChangeChecks: { success: 0, changesFound: 0, skipped: 0 },
    /** Contacts held back because they are in a live listing/transaction. */
    suppressedByLiveDeal: 0,
    budgetExhausted: false,
  }

  try {
    // The tenant list is read from the database, never from the request.
    const { data: brokerages, error: brokerageError } = await supabase
      .from("brokerages")
      .select("id")
      .eq("is_active", true)

    if (brokerageError) {
      await recordCronFailureAction({ context_id: contextId, error: brokerageError, stage: "brokerage-fetch" })
      return NextResponse.json({ error: brokerageError.message, context_id: contextId }, { status: 500 })
    }

    let vendorCalls = 0

    for (const brokerage of brokerages ?? []) {
      if (vendorCalls >= RUN_VENDOR_CALL_BUDGET) {
        results.budgetExhausted = true
        break
      }
      const brokerageId = brokerage.id as string
      results.brokerages++

      // ── 1. Contacts that have never been enriched ─────────────────────────
      // Covers every create door, including the ones that emit no kernel event
      // and therefore never reach the event-driven lane. The reader already
      // excludes contacts in a live deal; enrichContactRecord re-checks per
      // contact in case a stage changed while this run was in flight.
      const unenriched = await listUnenrichedContacts({
        brokerageId,
        limit: PER_BROKERAGE_ENRICH,
        supabase,
      })
      results.suppressedByLiveDeal += unenriched.suppressed
      if (unenriched.error) {
        console.error(`[ContactEnrichmentCron] ${brokerageId} unenriched read failed:`, unenriched.error)
      }

      for (const contact of unenriched.contacts) {
        if (vendorCalls >= RUN_VENDOR_CALL_BUDGET) {
          results.budgetExhausted = true
          break
        }
        const result = await enrichContactRecord({
          contactId: contact.id,
          brokerageId,
          source: "auto",
          supabase,
        })
        if (result.enriched) {
          results.newEnrichments.success++
          vendorCalls++
        } else if (result.success) {
          results.newEnrichments.skipped++
          if (result.skipped === "live_deal") results.suppressedByLiveDeal++
        } else {
          results.newEnrichments.failed++
        }

        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS))
      }

      // ── 2. Life-change re-check on already-enriched contacts ──────────────
      // Criterion 2 of the ruling, on a schedule. The event-driven half of the
      // same criterion runs when a deal ENDS (see lib/kernel/event-reactor.ts) —
      // that is the "just after" the owner asked for; this is the periodic sweep
      // for contacts with no deal activity at all.
      if (vendorCalls >= RUN_VENDOR_CALL_BUDGET) {
        results.budgetExhausted = true
        break
      }

      const due = await listContactsDueForLifeChangeCheck({
        brokerageId,
        limit: PER_BROKERAGE_LIFE_CHECK,
        supabase,
      })
      results.suppressedByLiveDeal += due.suppressed
      if (due.error) {
        console.error(`[ContactEnrichmentCron] ${brokerageId} life-check read failed:`, due.error)
      }

      for (const contact of due.contacts) {
        if (vendorCalls >= RUN_VENDOR_CALL_BUDGET) {
          results.budgetExhausted = true
          break
        }
        const result = await runLifeChangeCheck({
          contactId: contact.id,
          brokerageId,
          supabase,
          trigger: "scheduled_sweep",
        })
        if (result.success && !result.skipped) {
          results.lifeChangeChecks.success++
          results.lifeChangeChecks.changesFound += result.changesFound
          vendorCalls++
        } else if (result.skipped) {
          results.lifeChangeChecks.skipped++
          if (result.skipped === "live_deal") results.suppressedByLiveDeal++
        }

        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS))
      }
    }

    // The GHL branch this route used to run as a third pass — contacts with a
    // non-null ghl_contact_id and a null enriched_at — is a strict SUBSET of
    // pass 1 (`enriched_at IS NULL`), so it re-enriched nothing pass 1 had not
    // already taken. It also queried without a brokerage filter and therefore
    // could not be suppressed or budgeted per tenant. Folded into pass 1.

    // cron_execution_logs is the purpose-built sink for cron telemetry (the
    // generic audit_log table is user_id/entity_type/entity_id/action/before/
    // after — the wrong shape).
    const totalProcessed = results.newEnrichments.success + results.lifeChangeChecks.success
    const { error: logError } = await supabase.from("cron_execution_logs").insert({
      cron_path: "contact-enrichment",
      cron_name: "Contact enrichment",
      status: "completed",
      duration_ms: Date.now() - startTime,
      records_processed: totalProcessed,
      metadata: results,
      completed_at: new Date().toISOString(),
    })
    if (logError) {
      console.error("[ContactEnrichmentCron] Error logging results:", logError)
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: totalProcessed,
      metadata: { ...results, duration_ms: Date.now() - startTime },
    })

    console.log("[ContactEnrichmentCron] Completed:", results)
    return NextResponse.json({ success: true, results, duration_ms: Date.now() - startTime })
  } catch (error) {
    console.error("[ContactEnrichmentCron] Error:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json({ error: String(error), context_id: contextId }, { status: 500 })
  }
}
