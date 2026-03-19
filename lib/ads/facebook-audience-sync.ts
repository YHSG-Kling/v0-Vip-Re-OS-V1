"use server"

// lib/ads/facebook-audience-sync.ts
// Layer 9.5 — Facebook Custom Audiences Creation and Sync
// Kernel gates: consent_basis REQUIRED, kernel events for audience creation and sync

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type AudienceType = "website_visitors" | "contact_list" | "lookalike" | "engagement"

export interface SourceRule {
  type: "website_visitors" | "contact_list" | "engagement"
  filters?: {
    visited_pages?: string[]
    days_lookback?: number
    contact_tags?: string[]
    engagement_type?: string
  }
}

export interface CreateAudienceParams {
  brokerageId: string
  audienceName: string
  audienceType: AudienceType
  sourceRule: SourceRule
  consentBasis: string // REQUIRED - e.g., "GDPR Article 6(a) — explicit consent"
  adCampaignId?: string
}

export interface SyncAudienceResult {
  success: boolean
  runId?: string
  recordsAttempted?: number
  recordsSynced?: number
  recordsRejected?: number
  error?: string
}

// ─── createAudience ───────────────────────────────────────────────────────────

export async function createAudience(
  userId: string,
  params: CreateAudienceParams
): Promise<{ success: boolean; audienceId?: string; error?: string }> {
  const supabase = await createClient()

  // ── CRITICAL: consent_basis is REQUIRED ─────────────────────────────────────
  if (!params.consentBasis || params.consentBasis.trim() === "") {
    return {
      success: false,
      error:
        "consent_basis is REQUIRED for legal compliance. Please provide a valid consent basis (e.g., 'GDPR Article 6(a) — explicit consent').",
    }
  }

  // ── Insert audience ─────────────────────────────────────────────────────────
  const { data: audience, error } = await supabase
    .from("facebook_custom_audiences")
    .insert({
      brokerage_id: params.brokerageId,
      audience_name: params.audienceName,
      audience_type: params.audienceType,
      source_rule: params.sourceRule,
      consent_basis: params.consentBasis.trim(),
      ad_campaign_id: params.adCampaignId || null,
      status: "pending_review",
      external_audience_id: null, // Will be set after Facebook API call
    })
    .select("id")
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  // ── Lifecycle event ─────────────────────────────────────────────────────────
  await supabase.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type: "facebook_custom_audience",
    entity_id: audience.id,
    event_type: "retargeting_audience_created",
    actor_user_id: userId,
    metadata: {
      audience_name: params.audienceName,
      audience_type: params.audienceType,
      consent_basis: params.consentBasis,
    },
  })

  // ── Kernel event ────────────────────────────────────────────────────────────
  processKernelEvent({
    event: KernelEvent.RETARGETING_AUDIENCE_CREATED,
    brokerageId: params.brokerageId,
    entityType: "facebook_custom_audience",
    entityId: audience.id,
    actorUserId: userId,
    metadata: {
      audience_name: params.audienceName,
      audience_type: params.audienceType,
      consent_basis: params.consentBasis,
    },
  }).catch(console.error)

  return { success: true, audienceId: audience.id }
}

// ─── syncAudience ─────────────────────────────────────────────────────────────

export async function syncAudience(
  userId: string,
  audienceId: string,
  brokerageId: string
): Promise<SyncAudienceResult> {
  const supabase = await createClient()

  // ── 1. Get audience details ─────────────────────────────────────────────────
  const { data: audience, error: fetchError } = await supabase
    .from("facebook_custom_audiences")
    .select("*")
    .eq("id", audienceId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (fetchError || !audience) {
    return { success: false, error: "Audience not found" }
  }

  // ── 2. Create sync run ──────────────────────────────────────────────────────
  const { data: syncRun, error: runError } = await supabase
    .from("audience_sync_runs")
    .insert({
      audience_id: audienceId,
      brokerage_id: brokerageId,
      run_status: "running",
      records_attempted: 0,
      records_synced: 0,
      records_rejected: 0,
    })
    .select("id")
    .single()

  if (runError || !syncRun) {
    return { success: false, error: "Failed to create sync run" }
  }

  // ── 3. Apply source_rule to find matching records ───────────────────────────
  let recordsToSync: any[] = []
  const sourceRule = audience.source_rule as SourceRule

  try {
    if (sourceRule.type === "contact_list") {
      // Query contacts based on tags or other filters
      let query = supabase
        .from("contacts")
        .select("id, email, phone, first_name, last_name")
        .eq("brokerage_id", brokerageId)
        .eq("tcpa_consent", true) // Only consented contacts

      if (sourceRule.filters?.contact_tags && sourceRule.filters.contact_tags.length > 0) {
        // Filter by tags if specified
        query = query.contains("tags", sourceRule.filters.contact_tags)
      }

      const { data: contacts } = await query.limit(10000)
      recordsToSync = contacts || []
    } else if (sourceRule.type === "website_visitors") {
      // Query website visitors
      const daysLookback = sourceRule.filters?.days_lookback || 30
      const lookbackDate = new Date()
      lookbackDate.setDate(lookbackDate.getDate() - daysLookback)

      const { data: visitors } = await supabase
        .from("website_visitors")
        .select("id, contact_id, lead_id")
        .eq("brokerage_id", brokerageId)
        .gte("last_seen_at", lookbackDate.toISOString())
        .limit(10000)

      recordsToSync = visitors || []
    } else if (sourceRule.type === "engagement") {
      // Query engaged contacts
      const { data: engaged } = await supabase
        .from("contacts")
        .select("id, email, phone, first_name, last_name")
        .eq("brokerage_id", brokerageId)
        .eq("tcpa_consent", true)
        .gt("engagement_score", 50) // High engagement
        .limit(10000)

      recordsToSync = engaged || []
    }
  } catch (err: any) {
    await supabase
      .from("audience_sync_runs")
      .update({
        run_status: "failed",
        error_message: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", syncRun.id)

    return { success: false, error: err.message, runId: syncRun.id }
  }

  // ── 4. Simulate Facebook sync (in production, call Facebook Marketing API) ──
  const recordsAttempted = recordsToSync.length
  let recordsSynced = 0
  let recordsRejected = 0

  // In production, this would batch upload hashed emails/phones to Facebook
  // For now, we simulate the sync
  for (const record of recordsToSync) {
    // Validate record has required data
    if (record.email || record.phone) {
      recordsSynced++
    } else {
      recordsRejected++
    }
  }

  // ── 5. Update sync run ──────────────────────────────────────────────────────
  await supabase
    .from("audience_sync_runs")
    .update({
      run_status: "completed",
      records_attempted: recordsAttempted,
      records_synced: recordsSynced,
      records_rejected: recordsRejected,
      completed_at: new Date().toISOString(),
      provider_response: {
        simulated: true,
        timestamp: new Date().toISOString(),
      },
    })
    .eq("id", syncRun.id)

  // ── 6. Update audience ──────────────────────────────────────────────────────
  await supabase
    .from("facebook_custom_audiences")
    .update({
      status: "synced",
      last_synced_at: new Date().toISOString(),
    })
    .eq("id", audienceId)

  // ── 7. Lifecycle event ──────────────────────────────────────────────────────
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "facebook_custom_audience",
    entity_id: audienceId,
    event_type: "retargeting_audience_synced",
    actor_user_id: userId,
    metadata: {
      records_attempted: recordsAttempted,
      records_synced: recordsSynced,
      records_rejected: recordsRejected,
      run_id: syncRun.id,
    },
  })

  // ── 8. Kernel event ─────────────────────────────────────────────────────────
  processKernelEvent({
    event: KernelEvent.RETARGETING_AUDIENCE_SYNCED,
    brokerageId,
    entityType: "facebook_custom_audience",
    entityId: audienceId,
    actorUserId: userId,
    metadata: {
      audience_name: audience.audience_name,
      records_synced: recordsSynced,
      records_rejected: recordsRejected,
    },
  }).catch(console.error)

  return {
    success: true,
    runId: syncRun.id,
    recordsAttempted,
    recordsSynced,
    recordsRejected,
  }
}

// ─── getAudiences ─────────────────────────────────────────────────────────────

export async function getAudiences(
  brokerageId: string
): Promise<{ success: boolean; audiences?: any[]; error?: string }> {
  const supabase = await createClient()

  const { data: audiences, error } = await supabase
    .from("facebook_custom_audiences")
    .select(`
      *,
      audience_sync_runs (
        id,
        run_status,
        records_synced,
        records_rejected,
        completed_at
      )
    `)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, audiences: audiences || [] }
}

// ─── getAudienceSyncRuns ──────────────────────────────────────────────────────

export async function getAudienceSyncRuns(
  audienceId: string,
  brokerageId: string
): Promise<{ success: boolean; runs?: any[]; error?: string }> {
  const supabase = await createClient()

  const { data: runs, error } = await supabase
    .from("audience_sync_runs")
    .select("*")
    .eq("audience_id", audienceId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(20)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true, runs: runs || [] }
}

// ─── approveAudience ──────────────────────────────────────────────────────────

export async function approveAudience(
  userId: string,
  audienceId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { error } = await supabase
    .from("facebook_custom_audiences")
    .update({ status: "approved" })
    .eq("id", audienceId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── deleteAudience ───────────────────────────────────────────────────────────

export async function deleteAudience(
  userId: string,
  audienceId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  // First delete sync runs
  await supabase
    .from("audience_sync_runs")
    .delete()
    .eq("audience_id", audienceId)
    .eq("brokerage_id", brokerageId)

  // Then delete audience
  const { error } = await supabase
    .from("facebook_custom_audiences")
    .delete()
    .eq("id", audienceId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}
