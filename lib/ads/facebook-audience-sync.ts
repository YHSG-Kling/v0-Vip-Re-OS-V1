"use server"

// lib/ads/facebook-audience-sync.ts
// Layer 9.5 — Facebook Custom Audience and Sync Server Actions
// Kernel gates: canAccessFeature, createAudienceSegment, syncAudience, loadAudienceDefinitions
// All audience writes and syncs flow through lib/kernel/ads.ts commands — no direct DB writes here.

import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import {
  loadAudienceDefinitions,
  syncAudience as kernelSyncAudience,
  createAudienceSegment,
  type AdsActorContext,
  type AudienceType,
  type SourceRule,
} from "@/lib/kernel/ads"

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
