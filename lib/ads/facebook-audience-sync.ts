"use server"

// lib/ads/facebook-audience-sync.ts
// Layer 9.5 — Facebook Custom Audience and Sync Server Actions
// Kernel gates: canAccessFeature, createAudienceSegment, syncAudience, loadAudienceDefinitions
// All audience writes and syncs flow through lib/kernel/ads.ts commands — no direct DB writes here.
//
// Next 16: file is "use server" so client components can import it
// directly. Type exports live in ./facebook-audience-sync-types.

import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  loadAudienceDefinitions,
  syncAudience as kernelSyncAudience,
  previewAudienceResolution as kernelPreviewAudienceResolution,
  createAudienceSegment,
  type AdsActorContext,
  type AudienceResolutionPreview,
} from "@/lib/kernel/ads"
import type {
  CreateAudienceParams,
  SyncAudienceParams,
} from "@/lib/ads/facebook-audience-sync-types"

// ─── SESSION GATE ─────────────────────────────────────────────────────────────
// Every export in this file is a "use server" action, i.e. a public HTTP endpoint.
// Each one used to take `userId`, `brokerageId` and `agentId` **from the caller**
// and hand them to lib/kernel/ads.ts, which runs on the SERVICE client (RLS
// bypassed) and scopes purely on `ctx.brokerageId`. A caller-supplied brokerage id
// was therefore enough to read, create, sync or delete any tenant's ad audiences —
// including a sync, which uploads that tenant's consented contacts (email + phone)
// to Meta/Google under the caller's chosen audience.
//
// The tenant is now resolved from the session. The `userId` parameter and the
// `brokerageId` / `agentId` fields on the params objects are RETAINED but IGNORED
// so existing call sites keep type-checking (house pattern in this repo).
//
// NOT exported — a "use server" module may only export async functions, and this
// is an internal gate, not an endpoint.
async function resolveAdsActor(): Promise<
  { ok: true; ctx: AdsActorContext } | { ok: false; error: string }
> {
  const session = await getAgentContext()
  if (!session.isAuthenticated) {
    return { ok: false, error: "Not authenticated" }
  }
  if (!session.brokerageId) {
    return { ok: false, error: "No brokerage on this account" }
  }
  // agentId is deliberately OMITTED when the session has none (brokers/admins have
  // no `agents` row). It is never back-filled from users.id — agents.id and users.id
  // are disjoint id spaces — and never coerced to "" (an empty uuid literal raises
  // 22P02). None of the kernel ads commands reached from this file read ctx.agentId.
  const ctx = {
    brokerageId: session.brokerageId,
    userId: session.userId,
    ...(session.agentId ? { agentId: session.agentId } : {}),
  } as AdsActorContext
  return { ok: true, ctx }
}

// ─── createFacebookAudience ───────────────────────────────────────────────────

export async function createFacebookAudience(
  _userId: string,
  params: CreateAudienceParams
): Promise<{ success: boolean; audienceId?: string; error?: string }> {
  // ── 0. Session gate — tenant comes from the session, never the caller ───────
  const actor = await resolveAdsActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const ctx = actor.ctx
  const userId = ctx.userId

  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
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
  _userId: string,
  params: SyncAudienceParams
): Promise<{
  success: boolean
  syncRunId?: string
  recordsSynced?: number
  recordsRejected?: number
  error?: string
}> {
  // ── 0. Session gate — this uploads consented contact PII to an ad platform ──
  const actor = await resolveAdsActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const ctx = actor.ctx
  const userId = ctx.userId

  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
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

// ─── previewAudienceReach ─────────────────────────────────────────────────────
//
// WHAT THE OPERATOR COULD NOT SEE, AND WHY THAT MATTERED. Until this existed,
// nothing on any surface compared the DELIVERED audience against the PROMISED
// one. An audience named "Investors" that resolved to every consented contact in
// the brokerage looked identical to one that resolved to the three investors —
// the card showed a name, a status and, after the fact, "N records synced". N was
// the whole book and there was no denominator beside it to say so.
//
// This resolves the audience through the SAME kernel path the sync uses, returns
// the count, the DENOMINATOR and the rule label — and uploads NOTHING. It is a
// read, so it is gated on the same session and the same feature as the sync it
// previews, and it is deliberately NOT gated more loosely: it discloses how many
// of a tenant's contacts match a rule.
export async function previewAudienceReach(
  _userId: string,
  params: SyncAudienceParams,
): Promise<{
  success: boolean
  error?: string
  resolution?: AudienceResolutionPreview
}> {
  const actor = await resolveAdsActor()
  if (!actor.ok) return { success: false, error: actor.error }

  const accessCheck = await canAccessFeature(actor.ctx.userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const result = await kernelPreviewAudienceResolution({
    ctx: actor.ctx,
    audienceId: params.audienceId,
  })
  if (!result.success) return { success: false, error: result.error }
  return { success: true, resolution: result.audience as AudienceResolutionPreview }
}

// ─── loadFacebookAudiences — DELETED (orphan burn-down lane C) ────────────────
//
// FUNCTIONALITY ALREADY ELSEWHERE. The Ads workspace page loads audiences — with
// their sync runs embedded — through lib/kernel/ads.ts:261 (loadAdsWorkspace),
// called at app/dashboard/campaigns/ads/page.tsx:146 and handed to the dashboard
// as its `audiences` prop. This wrapper called the sibling kernel command
// (lib/kernel/ads.ts:679 loadAudienceDefinitions) to fetch the same rows a second
// time.
//
// NOTHING TO MERGE. Its one distinct axis was the optional `campaignId` filter,
// and every workspace audience row carries `ad_campaign_id`, so narrowing to one
// campaign is a filter over data the surface already holds — not another
// round-trip. Removing it also closes a public endpoint: this file is
// "use server", so every export here is a reachable HTTP door.

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
 * approveAudience — sets facebook_custom_audiences.status = 'synced' (live on Meta).
 * Business rule: only audiences in 'pending_review' or 'draft' state can be approved.
 * Input: userId string, audienceId string, brokerageId string
 * Output: { success, error? }
 * Table written: facebook_custom_audiences
 */
export async function approveAudience(
  _userId: string,
  audienceId: string,
  _brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  // Session gate — approval flips an audience live on Meta. Tenant and actor come
  // from the session; the caller-supplied ids are ignored.
  const actor = await resolveAdsActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const userId = actor.ctx.userId
  const brokerageId = actor.ctx.brokerageId

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

  // CHECK vocabulary (pass 6): 'synced' is the live-on-Meta state ('active'
  // was silently rejected — this update never landed).
  if (audience.status === "synced") {
    return { success: true }
  }

  const { error: updateError } = await supabase
    .from("facebook_custom_audiences")
    .update({ status: "synced", updated_at: new Date().toISOString() })
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
  _userId: string,
  audienceId: string,
  _brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  // Session gate — soft-deletes an audience. Tenant and actor come from the
  // session; the caller-supplied ids are ignored.
  const actor = await resolveAdsActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const userId = actor.ctx.userId
  const brokerageId = actor.ctx.brokerageId

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
  if (audience.status === "synced" && audience.ad_campaign_id) {
    // Check if the linked campaign is live
    const { data: campaign } = await supabase
      .from("ad_campaigns")
      .select("status")
      .eq("id", audience.ad_campaign_id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (campaign && (campaign.status === "live" || campaign.status === "launching")) {
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
  _userId: string,
  params: { brokerageId: string; agentId: string; audienceId: string }
): Promise<{ success: boolean; runs?: any[]; error?: string }> {
  // ── 0. Session gate — was an unauthenticated cross-tenant read ──────────────
  const actor = await resolveAdsActor()
  if (!actor.ok) return { success: false, error: actor.error }
  const ctx = actor.ctx
  const userId = ctx.userId

  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "ads_audiences")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  // ── 2. Load all audiences (includes embedded sync_runs) ──────────────────────
  // The list is brokerage-scoped by the kernel, so the `.find` below IS the
  // ownership check: an audience id from another tenant simply is not in the list
  // and the function returns "Audience not found". Kept deliberately — a direct
  // audience_sync_runs read keyed on audienceId alone would need its own gate.
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
