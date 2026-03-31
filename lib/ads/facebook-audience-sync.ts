"use server"

// lib/ads/facebook-audience-sync.ts
// Layer 9.5 — Facebook Custom Audience and Sync Server Actions
// Kernel gates: canAccessFeature, createAudienceSegment, syncAudience, loadAudienceDefinitions
// All audience writes and syncs flow through lib/kernel/ads.ts commands — no direct DB writes here.

import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { createClient } from "@/lib/supabase/server"
import {
  loadAudienceDefinitions,
  syncAudience as kernelSyncAudience,
  createAudienceSegment,
  type AdsActorContext,
  type AudienceType,
  type SourceRule,
} from "@/lib/kernel/ads"

// Re-export types that ads-dashboard-client.tsx imports from this module
export type { AudienceType, SourceRule }

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface CreateAudienceParams {
  brokerageId: string
  agentId: string
  audienceName: string
  audienceType: AudienceType
  sourceRule: SourceRule
  consentBasis: string
  adCampaignId?: string
}

export interface SyncAudienceParams {
  brokerageId: string
  agentId: string
  audienceId: string
}

export interface LoadAudiencesParams {
  brokerageId: string
  agentId: string
  campaignId?: string
}

// ─── createFacebookAudience ───────────────────────────────────────────────────

export async function createFacebookAudience(
  userId: string,
  params: CreateAudienceParams
): Promise<{ success: boolean; audienceId?: string; error?: string }> {
  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const ctx: AdsActorContext = {
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    userId,
  }

  // ── 2. Delegate to kernel createAudienceSegment ──────────────────────────────
  const result = await createAudienceSegment({
    ctx,
    audienceName: params.audienceName,
    audienceType: params.audienceType,
    sourceRule: params.sourceRule,
    consentBasis: params.consentBasis,
    adCampaignId: params.adCampaignId,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  // ── 3. Increment usage ──────────────────────────────────────────────────────
  await incrementFeatureUsage(userId, "ads_audiences")

  return { success: true, audienceId: result.audienceId }
}

// ─── syncFacebookAudience ─────────────────────────────────────────────────────

export async function syncFacebookAudience(
  userId: string,
  params: SyncAudienceParams
): Promise<{
  success: boolean
  syncRunId?: string
  recordsSynced?: number
  recordsRejected?: number
  error?: string
}> {
  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const ctx: AdsActorContext = {
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    userId,
  }

  // ── 2. Delegate to kernel syncAudience ───────────────────────────────────────
  const result = await kernelSyncAudience({
    ctx,
    audienceId: params.audienceId,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  const syncRun = result.syncRun

  return {
    success: true,
    syncRunId: result.syncRunId,
    recordsSynced: syncRun?.records_synced ?? 0,
    recordsRejected: syncRun?.records_rejected ?? 0,
  }
}

// ─── loadFacebookAudiences ────────────────────────────────────────────────────

export async function loadFacebookAudiences(
  userId: string,
  params: LoadAudiencesParams
): Promise<{ success: boolean; audiences?: any[]; error?: string }> {
  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const ctx: AdsActorContext = {
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    userId,
  }

  // ── 2. Delegate to kernel loadAudienceDefinitions ────────────────────────────
  const result = await loadAudienceDefinitions({
    ctx,
    campaignId: params.campaignId,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  return { success: true, audiences: (result.audience as any[]) || [] }
}

// ─── CANONICAL NAMED EXPORTS (used by ads-dashboard-client.tsx) ──────────────
// These are the canonical function names the UI layer imports. They delegate
// directly to the underlying implementations above.

/**
 * createAudience — canonical alias for createFacebookAudience.
 * Input: userId string, params CreateAudienceParams
 * Output: { success, audienceId?, error? }
 * Table written: facebook_custom_audiences
 */
export async function createAudience(
  userId: string,
  params: CreateAudienceParams
): ReturnType<typeof createFacebookAudience> {
  return createFacebookAudience(userId, params)
}

/**
 * syncAudience — canonical alias for syncFacebookAudience.
 * Input: userId string, params SyncAudienceParams
 * Output: { success, syncRunId?, recordsSynced?, recordsRejected?, error? }
 * Tables written: audience_sync_runs
 */
export async function syncAudience(
  userId: string,
  params: SyncAudienceParams
): ReturnType<typeof syncFacebookAudience> {
  return syncFacebookAudience(userId, params)
}

/**
 * approveAudience — sets facebook_custom_audiences.status = 'active'.
 * Business rule: only audiences in 'pending_review' or 'draft' state can be approved.
 * Input: userId string, audienceId string, brokerageId string
 * Output: { success, error? }
 * Table written: facebook_custom_audiences
 */
export async function approveAudience(
  userId: string,
  audienceId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  // Feature gate
  const accessCheck = await canAccessFeature(userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const supabase = await createClient()

  // Verify audience exists for this brokerage
  const { data: audience, error: fetchError } = await supabase
    .from("facebook_custom_audiences")
    .select("id, status")
    .eq("id", audienceId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (fetchError || !audience) {
    return { success: false, error: "Audience not found" }
  }

  if (audience.status === "active") {
    return { success: true }
  }

  const { error: updateError } = await supabase
    .from("facebook_custom_audiences")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", audienceId)
    .eq("brokerage_id", brokerageId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  return { success: true }
}

/**
 * deleteAudience — marks facebook_custom_audiences.status = 'deleted' (soft delete).
 * Business rule: cannot delete audiences that are actively attached to live campaigns.
 * Input: userId string, audienceId string, brokerageId string
 * Output: { success, error? }
 * Table written: facebook_custom_audiences
 */
export async function deleteAudience(
  userId: string,
  audienceId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  // Feature gate
  const accessCheck = await canAccessFeature(userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const supabase = await createClient()

  // Verify audience exists for this brokerage
  const { data: audience, error: fetchError } = await supabase
    .from("facebook_custom_audiences")
    .select("id, status, ad_campaign_id")
    .eq("id", audienceId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (fetchError || !audience) {
    return { success: false, error: "Audience not found" }
  }

  // Guard: do not delete if audience is actively synced to a live campaign
  if (audience.status === "active" && audience.ad_campaign_id) {
    // Check if the linked campaign is live
    const { data: campaign } = await supabase
      .from("ad_campaigns")
      .select("status")
      .eq("id", audience.ad_campaign_id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (campaign && (campaign.status === "active" || campaign.status === "launching")) {
      return {
        success: false,
        error: "Cannot delete an audience attached to an active campaign. Pause the campaign first.",
      }
    }
  }

  // Soft delete — set status to 'deleted'
  const { error: updateError } = await supabase
    .from("facebook_custom_audiences")
    .update({ status: "deleted", updated_at: new Date().toISOString() })
    .eq("id", audienceId)
    .eq("brokerage_id", brokerageId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  return { success: true }
}

// ─── getAudienceSyncHistory ───────────────────────────────────────────────────
// Returns the sync run history for a specific audience. The sync runs are
// embedded in loadAudienceDefinitions results via the joined audience_sync_runs.

export async function getAudienceSyncHistory(
  userId: string,
  params: { brokerageId: string; agentId: string; audienceId: string }
): Promise<{ success: boolean; runs?: any[]; error?: string }> {
  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const ctx: AdsActorContext = {
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    userId,
  }

  // ── 2. Load all audiences (includes embedded sync_runs) ──────────────────────
  const result = await loadAudienceDefinitions({ ctx })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  const audiences = (result.audience as any[]) || []
  const target = audiences.find((a: any) => a.id === params.audienceId)

  if (!target) {
    return { success: false, error: "Audience not found" }
  }

  return { success: true, runs: target.audience_sync_runs || [] }
}
