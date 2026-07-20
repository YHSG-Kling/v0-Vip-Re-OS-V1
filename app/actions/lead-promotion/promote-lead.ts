'use server'

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * CANONICAL LEAD BUSINESS PROCESS (owner, round 37):
 *
 *   "rawleads are platform only and can't be manually moved to leads (there is
 *    a full automatic promotion from rawleads to leads which are handled and
 *    qualified by the ai isa …)"
 *
 * The manual `promoteLead` server action that used to live here (the dashboard
 * "Promote" button + the round-36 voice promote_lead lane rode it) has been
 * REMOVED: raw_scraped_leads move to `leads` ONLY through the automatic
 * pipeline — lib/lead-pipeline/pipeline-processor.processRawRecord, driven by
 * the lead-scraping cron's promotion pass (+ its stranded-record re-enrich
 * sweep). There is no manual door, for any role. Platform staff may still
 * INSPECT the raw bench (round 33) via listRawLeadsForReview below — read-only.
 */

// ── Platform Raw Leads review list (INSPECTION ONLY — no promotion verb) ─────
export interface RawLeadReviewRow {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  city: string | null
  state: string | null
  source: string | null
  sourceFamily: string | null
  processingStatus: string | null
  dedupeStatus: string | null
  leadId: string | null
  promotionAttempts: number | null
  errorMessage: string | null
  createdAt: string
}

/**
 * Lists recent raw_scraped_leads for platform inspection (un-promoted first).
 *
 * ACCESS POLICY (owner): RAW LEADS = PLATFORM ONLY. Raw scraped records are
 * platform-owned pre-promotion inventory (mirrors migration 035's platform-only
 * RLS) — NO tenant surface or action reads raw record CONTENT; tenants first
 * see the data as promoted `leads`. This listing returns raw rows, so it is
 * platform staff (superadmin / support) only, and it is READ-ONLY: promotion
 * happens exclusively through the automatic pipeline (processRawRecord in the
 * lead-scraping cron) — platform staff inspect, they do not move records.
 */
export async function listRawLeadsForReview(opts?: {
  limit?: number
  /** Platform staff may narrow the bench to one brokerage. */
  brokerageId?: string
}): Promise<{ ok: true; rows: RawLeadReviewRow[] } | { ok: false; error: string }> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id, user_type, platform_role")
    .eq("id", user.id)
    .maybeSingle()
  const isPlatform =
    callerRow?.user_type === "superadmin" ||
    ["superadmin", "admin", "marketing", "support"].includes(String((callerRow as any)?.platform_role ?? ""))
  if (!isPlatform) {
    return { ok: false, error: "Raw leads are platform-only — tenants see promoted leads" }
  }

  const supabase = createServiceClient()
  let query = supabase
    .from("raw_scraped_leads")
    .select("id, first_name, last_name, email, phone, city, state, source, source_family, processing_status, dedupe_status, lead_id, promotion_attempts, error_message, created_at")
  if (opts?.brokerageId) query = query.eq("brokerage_id", opts.brokerageId)
  const { data, error } = await query
    // un-promoted first, then most recent
    .order("lead_id", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 100)
  if (error) return { ok: false, error: error.message }

  const rows: RawLeadReviewRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    sourceFamily: (r.source_family as string | null) ?? null,
    processingStatus: (r.processing_status as string | null) ?? null,
    dedupeStatus: (r.dedupe_status as string | null) ?? null,
    leadId: (r.lead_id as string | null) ?? null,
    promotionAttempts: (r.promotion_attempts as number | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    createdAt: r.created_at as string,
  }))
  return { ok: true, rows }
}
