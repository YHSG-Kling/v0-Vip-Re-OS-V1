import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformStaffAuth } from "@/lib/kernel/api-auth"
import { isRawProcessingStatus, RAW_PROCESSING_STATUSES } from "@/lib/lead-pipeline/processing-status"

/**
 * Raw scraped-lead state updates (the PATCH repair verb).
 *
 * ACCESS POLICY (owner): RAW LEADS = PLATFORM ONLY. The raw_scraped_leads
 * bench is platform-owned pre-promotion inventory (mirrors migration 035's
 * platform-only RLS): NO tenant surface or action reads raw records — the
 * promotion pipeline processes them server-side and tenants first see the
 * data as promoted `leads`.
 *
 * ─── TOMBSTONE: THE GET HALF IS DELETED (§1.1, 2026-09-03) ──────────────────
 *
 * `GET /api/leads/raw` listed raw_scraped_leads for platform staff, filtered by
 * `?source=`, `?status=` (default "pending"), `?brokerage_id=` and `?limit=`,
 * off a service client behind requirePlatformStaffAuth. It was a SECOND door
 * onto exactly the read that app/actions/lead-promotion/promote-lead.ts:
 * listRawLeadsForReview already served — the one the Lead Intake Cockpit
 * (app/dashboard/admin/lead-intake/page.tsx) actually renders, with the same
 * platform-staff gate and the same platform-only ruling in its header.
 *
 * SURVIVOR: app/actions/lead-promotion/promote-lead.ts:63
 * listRawLeadsForReview. Merged onto it FIRST, then this half was removed:
 *   · `source`           — the `?source=` filter (was :26 / :44-46 here).
 *   · `processingStatus` — the `?status=` filter (was :27 / :36 here), now
 *                          validated against lib/lead-pipeline/processing-status
 *                          so an impossible value refuses instead of reading as
 *                          "no data yet". The old default of "pending" was NOT
 *                          carried: the bench shows every state, un-promoted
 *                          first, and a caller who wants one state names it.
 *   · `brokerageId` / `limit` — the survivor already had both.
 * NO EXTERNAL CALLER CAN EXIST FOR IT: the handler authenticated on a Supabase
 * SESSION (never a bearer token or cron secret), so its only possible caller
 * was this app's own UI, which calls the server action. Nothing in the tree,
 * vercel.json, or lib/kernel/cron-dispatch.ts addressed the path.
 *
 * The PATCH below is LEFT STANDING: it is the only state-repair verb on raw rows
 * and has no sibling anywhere (the survivor is documented inspection-only and a
 * write verb there would contradict its own header and the round-37 ruling that
 * there is no manual door on raw records).
 */

export async function PATCH(request: NextRequest) {
  // ACCESS POLICY (owner): RAW LEADS = PLATFORM ONLY — see the header. State
  // updates on raw rows are a platform-staff repair verb, never a tenant one.
  const supabase = await createClient()
  const auth = await requirePlatformStaffAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const { id, processing_status, error_message } = body

    if (!id) {
      return NextResponse.json({ error: "Missing id parameter" }, { status: 400 })
    }
    // ONE vocabulary. A repair that writes a value the CHECK refuses is rejected
    // by the database entirely, and a value no reader knows loses the row in
    // silence (lib/lead-pipeline/processing-status.ts) — so refuse it here, out loud.
    if (processing_status !== undefined && !isRawProcessingStatus(processing_status)) {
      return NextResponse.json(
        { error: `Unknown processing_status "${String(processing_status)}" — admitted: ${RAW_PROCESSING_STATUSES.join(", ")}` },
        { status: 400 },
      )
    }

    const svc = createServiceClient()

    // The error is READ (CLAUDE.md §3): a refused read resolved as "no row" and
    // this answered 404 for an outage, which is the wrong answer for a repair verb.
    const { data: row, error: rowError } = await svc
      .from("raw_scraped_leads")
      .select("brokerage_id")
      .eq("id", id)
      .maybeSingle()
    if (rowError) {
      console.error("[leads/raw] Error reading raw lead:", rowError)
      return NextResponse.json({ error: rowError.message }, { status: 500 })
    }
    if (!row) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (processing_status) updates.processing_status = processing_status
    if (error_message !== undefined) updates.error_message = error_message

    // `.select().single()` COUNTS the update: an update that matched nothing
    // (row gone between the read and the write) surfaces as an error here
    // rather than resolving as success with no row.
    const { data, error } = await svc
      .from("raw_scraped_leads")
      .update(updates)
      .eq("id", id)
      .select()
      .single()

    if (error) {
      console.error("[leads/raw] Error updating raw lead:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error("[leads/raw] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
