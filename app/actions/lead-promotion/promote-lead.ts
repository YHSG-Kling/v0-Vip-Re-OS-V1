'use server'

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  evaluatePromotionEligibility,
  promoteRawRecordToLead,
  triggerInitialScoring,
} from '@/lib/lead-promotion'

const PROMOTE_ROLES = ["broker", "broker_owner", "broker_admin", "admin", "super_admin", "superadmin"]

interface PromotionResponse {
  success: boolean
  leadId?: string
  message: string
  stage: string
}

/**
 * Main orchestration function for lead promotion system.
 * 
 * This is the ONLY public entry point. It coordinates:
 * 1. Eligibility evaluation (reads existing dedup/enrichment)
 * 2. Promotion to leads table (if eligible)
 * 3. Initial scoring trigger (separate, non-blocking)
 * 4. Audit logging to activities table
 * 
 * NEVER:
 * - Contacts leads
 * - Assigns agents
 * - Sends SMS/calls
 * - Re-runs deduplication
 */
export async function promoteLead(
  rawRecordId: string,
  _brokerageId?: string,  // ignored — derived from session
  /**
   * Sessionless-caller overload (voice webhook): the caller supplies its OWN
   * verified client + the acting users.id, and the SAME role/brokerage guard
   * below runs against the DB through that client. The cookie path is the
   * default — every existing caller is untouched. A browser cannot spoof this
   * param: server-action deserialization cannot produce a functioning
   * Supabase client (functions don't cross the boundary), so a forged
   * `caller` fails closed at the guard query.
   */
  caller?: { client: ReturnType<typeof createServiceClient>; actorUserId: string },
): Promise<PromotionResponse> {
  // Auth gate — promotion writes a leads row + triggers downstream scoring +
  // platform distribution. Previously trusted caller-supplied brokerageId,
  // so any signed-in user could promote raw records into other brokerages.
  // ACCESS POLICY (owner): RAW LEADS = PLATFORM ONLY / LEADS = BROKERAGE +
  // PLATFORM. This is a promotion-pipeline TRIGGER: brokerage-level roles may
  // fire it for their own brokerage, but the raw record is processed
  // server-side and its content is never returned to the tenant.
  let actorId: string
  let guardClient: { from: (t: string) => any }
  if (caller) {
    if (typeof caller.client?.from !== "function" || typeof caller.actorUserId !== "string" || !caller.actorUserId) {
      return { success: false, message: "Unauthorized", stage: "auth" }
    }
    actorId = caller.actorUserId
    guardClient = caller.client
  } else {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) {
      return { success: false, message: "Unauthorized", stage: "auth" }
    }
    actorId = user.id
    guardClient = authClient
  }
  const { data: callerRow } = await guardClient
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", actorId)
    .maybeSingle()
  if (!callerRow?.brokerage_id) {
    return { success: false, message: "Unauthorized", stage: "auth" }
  }
  if (!PROMOTE_ROLES.includes(callerRow.user_type ?? "")) {
    return { success: false, message: "Only brokers and admins can promote leads", stage: "auth" }
  }
  const brokerageId = callerRow.brokerage_id

  const supabase = createServiceClient()

  try {
    // Verify the raw record belongs to caller's brokerage
    const { data: rawRow } = await supabase
      .from("raw_scraped_leads")
      .select("brokerage_id")
      .eq("id", rawRecordId)
      .maybeSingle()
    if (!rawRow) {
      return { success: false, message: "Raw record not found", stage: "auth" }
    }
    if (rawRow.brokerage_id !== brokerageId) {
      return { success: false, message: "Forbidden", stage: "auth" }
    }

    // Step 1: Evaluate eligibility (consumes existing dedup + enrichment outputs)
    const eligibility = await evaluatePromotionEligibility(rawRecordId)

    if (!eligibility.eligible) {
      // Log rejection to activities
      await supabase
        .from('activities')
        .insert({
          brokerage_id: brokerageId,
          activity_type: 'lead_promotion_rejected',
          title: 'Lead promotion rejected',
          description: eligibility.reason,
          notes: JSON.stringify({
            raw_record_id: rawRecordId,
            reason: eligibility.reason,
            dedup_log: eligibility.dedupLog,
          }),
          status: 'completed',
          created_at: new Date().toISOString(),
        })

      return {
        success: false,
        message: eligibility.reason,
        stage: 'eligibility_check',
      }
    }

    // Step 2: Promote to leads table
    const promotion = await promoteRawRecordToLead(
      rawRecordId,
      brokerageId,
      eligibility.rawRecord?.raw_data || {}
    )

    if (!promotion.success) {
      // Log promotion failure to automation_errors
      await supabase
        .from('automation_errors')
        .insert({
          workflow_name: 'lead_promotion',
          error_message: promotion.error || 'Unknown promotion error',
          context_json: JSON.stringify({ rawRecordId, brokerageId }),
          severity: 'high',
          status: 'open',
          created_at: new Date().toISOString(),
        })

      return {
        success: false,
        message: promotion.error || 'Promotion failed',
        stage: 'promotion',
      }
    }

    // Step 3: Log successful promotion to activities
    await supabase
      .from('activities')
      .insert({
        brokerage_id: brokerageId,
        activity_type: 'lead_promotion_success',
        title: 'Lead promoted from raw record',
        description: `Raw record ${rawRecordId} promoted to lead ${promotion.leadId}`,
        notes: JSON.stringify({
          raw_record_id: rawRecordId,
          lead_id: promotion.leadId,
          promoted_at: new Date().toISOString(),
        }),
        status: 'completed',
        created_at: new Date().toISOString(),
      })

    // Step 4: Trigger initial scoring (separate, non-blocking)
    // Scoring runs AFTER promotion, not inline
    // This separation ensures promotion isn't blocked by scoring failures
    if (promotion.leadId) {
      // Fire and forget - scoring errors are logged internally
      triggerInitialScoring(promotion.leadId).catch((err) => {
        console.error(`[v0] Scoring trigger failed for ${promotion.leadId}:`, err)
      })
    }

    // Step 5: Engine 1 — Platform Distribution
    // Only fires for platform-origin leads. Brokerage-scraped leads stay with
    // their owning brokerage and skip distribution. Awaits to ensure the lead
    // has a brokerage_id before any downstream ISA work attempts to read it.
    if (promotion.leadId) {
      try {
        const { distributePlatformLead } = await import('@/lib/platform/distribution-engine')
        const distResult = await distributePlatformLead({ leadId: promotion.leadId })
        if (!distResult.success && distResult.reason !== 'skip_non_platform_origin') {
          await supabase.from('activities').insert({
            brokerage_id: brokerageId,
            activity_type: 'lead_distribution_failed',
            title: 'Platform lead distribution failed',
            description: distResult.reason,
            notes: JSON.stringify({ lead_id: promotion.leadId, reason: distResult.reason }),
            status: 'completed',
            created_at: new Date().toISOString(),
          })
        }
      } catch (err: any) {
        console.error(`[v0] Distribution engine failed for ${promotion.leadId}:`, err)
      }
    }

    return {
      success: true,
      leadId: promotion.leadId,
      message: 'Lead promoted successfully',
      stage: 'completed',
    }
  } catch (error: any) {
    // Unexpected errors go to automation_errors
    await supabase
      .from('automation_errors')
      .insert({
        workflow_name: 'lead_promotion_orchestrator',
        error_message: error.message,
        context_json: JSON.stringify({ rawRecordId, brokerageId }),
        severity: 'critical',
        status: 'open',
        created_at: new Date().toISOString(),
      })

    return {
      success: false,
      message: `Unexpected error: ${error.message}`,
      stage: 'orchestration',
    }
  }
}

// ── Admin Raw Leads review list (brokerage-scoped) ──────────────────────────
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
 * Lists recent raw_scraped_leads for manual review / promotion (un-promoted first).
 *
 * ACCESS POLICY (owner): RAW LEADS = PLATFORM ONLY. Raw scraped records are
 * platform-owned pre-promotion inventory (mirrors migration 035's platform-only
 * RLS) — NO tenant surface or action reads raw record CONTENT; tenants first
 * see the data as promoted `leads`. This listing returns raw rows, so it is
 * platform staff (superadmin / support) only. Tenant brokers keep the
 * promotion TRIGGERS (promoteLead / process-pipeline), which process raw rows
 * server-side without returning their content.
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
