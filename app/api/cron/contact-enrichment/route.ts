import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  enrichContact,
  checkContactLifeChanges,
  getUnenrichedContacts,
  getContactsNeedingLifeChangeCheck,
} from "@/app/actions/contact-enrichment"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // 5 minutes

/**
 * Cron job to enrich contacts and check for life changes
 * Runs every 6 hours
 */
export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

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
    newEnrichments: { success: 0, failed: 0 },
    lifeChangeChecks: { success: 0, changesFound: 0 },
    ghlSyncEnrichments: { success: 0, failed: 0 },
  }

  try {
    // 1. Enrich new contacts (not yet enriched)
    console.log("[ContactEnrichmentCron] Starting new contact enrichment...")
    const { contacts: unenrichedContacts } = await getUnenrichedContacts(25)

    for (const contact of unenrichedContacts) {
      const result = await enrichContact(contact.id, { source: "auto" })
      if (result.success && result.enriched) {
        results.newEnrichments.success++
      } else if (!result.success) {
        results.newEnrichments.failed++
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    // 2. Check life changes on existing contacts
    console.log("[ContactEnrichmentCron] Starting life change checks...")
    const { contacts: contactsForLifeCheck } = await getContactsNeedingLifeChangeCheck(25)

    for (const contact of contactsForLifeCheck) {
      const result = await checkContactLifeChanges(contact.id)
      if (result.success) {
        results.lifeChangeChecks.success++
        results.lifeChangeChecks.changesFound += result.changesFound
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    // 3. Enrich contacts synced from GHL that haven't been enriched
    console.log("[ContactEnrichmentCron] Starting GHL sync enrichment...")
    const { data: ghlContacts } = await supabase
      .from("contacts")
      .select("id")
      .not("ghl_contact_id", "is", null)
      .is("enriched_at", null)
      .limit(25)

    for (const contact of ghlContacts || []) {
      const result = await enrichContact(contact.id, { source: "ghl_sync" })
      if (result.success && result.enriched) {
        results.ghlSyncEnrichments.success++
      } else if (!result.success) {
        results.ghlSyncEnrichments.failed++
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    // Log results
    const { error: logError } = await supabase.from("audit_log").insert({
      log_type: "cron_job",
      source: "contact-enrichment",
      message: "Contact enrichment cron completed",
      metadata: {
        ...results,
        duration_ms: Date.now() - startTime,
      },
    })

    if (logError) {
      console.error("[ContactEnrichmentCron] Error logging results:", logError)
    }

    const totalSuccess = results.newEnrichments.success + results.lifeChangeChecks.success + results.ghlSyncEnrichments.success

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: totalSuccess,
      metadata: { ...results, duration_ms: Date.now() - startTime },
    })

    console.log("[ContactEnrichmentCron] Completed:", results)
    return NextResponse.json({
      success: true,
      results,
      duration_ms: Date.now() - startTime,
    })
  } catch (error) {
    console.error("[ContactEnrichmentCron] Error:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json({ error: String(error), context_id: contextId }, { status: 500 })
  }
}
