// lib/kernel/ads.ts
// KERNEL OS — Ad Campaigns and Audiences Canonical Layer
// Ownership: Ads & Audiences domain — all ad campaign creation, audience building, sync status,
// creative approval, spend tracking, and ROI visibility flow through these commands.
//
// NO "use server" — this is kernel layer (Layer 1). Server actions wrap these at Layer 2.
// NO direct Supabase client imports from this file — use createServiceClient() passed in as ctx.
//
// Business rules:
//   1. Preview required before launch — no ad launches without at least one approved creative
//   2. Audience sync failures must be visible — audience_sync_runs.run_status records all outcomes
//   3. No fake live state without provider success — always check platform_credentials.is_active
//   4. Spend and ROI must reflect real data sources — ad_performance is single source of truth
//   5. All creatives must pass brand compliance before approval
//   6. Budget validation: daily_budget OR lifetime_budget required, not both null
//   7. Targeting must include at least one location
//   8. Consent basis required for all audience syncs (GDPR/CCPA compliance)
//   9. Provider account connection required before campaign launch
//   10. All ad content subject to real estate compliance gates

import { createServiceClient } from "@/lib/supabase/service"
import {
  CONNECTABLE_AD_PLATFORMS,
  AD_PLATFORMS_WITHOUT_CONNECTIONS,
  isConnectableAdPlatform,
} from "@/lib/integrations/ad-campaign-vocabulary"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import {
  listSocialBaselines,
  computeOrganicLift,
  type SocialBaseline,
} from "@/lib/marketing/social-baselines"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface AdsActorContext {
  brokerageId: string
  agentId: string
  userId: string
}

// Single consolidated audience_type vocabulary (m188). 'contact_list' was a
// duplicate of 'custom' and was merged away. Lookalike is a type AND a relationship
// (lookalike_seed_audience_id); the sync routing keys off the column, not this.
export type AudienceType =
  | "custom" | "lookalike" | "website_visitors" | "engagement"
  | "listing_visitors" | "video_viewers" | "newsletter_openers" | "portal_visitors" | "persona_segment"

export type AdPlatform = "facebook" | "instagram" | "google" | "linkedin" | "tiktok"

export type AdObjective = "awareness" | "traffic" | "leads" | "conversions"

export interface TargetingConfig {
  age_min?: number
  age_max?: number
  locations: Array<{
    city?: string
    state?: string
    radius_miles?: number
    zip?: string
  }>
  interests?: string[]
  custom_audience_ids?: string[]
  lookalike_source_audience_id?: string | null
  income_percentile?: "top_25" | "top_50" | "any"
  homeowner_status?: "renter" | "owner" | "any"
}

export interface SourceRule {
  type:
    | "website_visitors"
    | "contact_list"
    | "engagement"
    // ── Real-estate prebuilt source rules ─────────────────────────────────
    | "lifetime_customers"        // contacts with contact_type='lifetime_customer'
    | "qualified_leads"           // leads with lead_stage='qualified'
    | "active_buyers"             // contacts with contact_type='buyer' + active in last N days
    | "active_sellers"            // contacts with contact_type='seller' + listing in pre-listing/active
    | "consultations_completed"   // contacts who attended a consultation
    | "open_house_attendees"      // attendees from open_house_attendees table
    | "high_engagement_contacts"  // engagement_score >= threshold
    | "investor_contacts"         // contact_type='investor'
    | "in_pipeline"               // contacts with active_transaction
    | "lookalike_seed"            // a base audience for FB to lookalike from
    | "exclusion_active_pipeline" // ALL active contacts (use as exclusion to prevent re-targeting customers)
  filters: {
    days_lookback?: number
    contact_tags?: string[]
    engagement_type?: string
    url_pattern?: string
    // Prebuilt-rule filters
    min_engagement_score?: number
    min_purchase_age_months?: number  // for lifetime customers — minimum tenure
    zip_codes?: string[]              // narrow by service area
    seed_audience_id?: string         // for lookalike_seed
    seed_country?: string             // for lookalike (default 'US')
    seed_lookalike_size_pct?: number  // 1-10 (FB's lookalike size scale)
  }
}

export interface KernelAdsResult {
  success: boolean
  error?: string
  /**
   * Why this failed, when it failed. A surface has to tell an entitlement
   * refusal ("your plan does not include this") apart from a read failure
   * ("we could not load it") apart from genuinely-empty — they are three
   * different states and rendering them alike is the defect this exists to
   * prevent. Only set on failure.
   */
  errorKind?: "input" | "entitlement" | "read"
  campaignId?: string
  campaign?: any
  creativeId?: string
  creatives?: any[]
  audienceId?: string
  audience?: any
  syncRunId?: string
  syncRun?: any
  /** loadAdsWorkspace: the whole workspace view (campaigns + audiences + performance). */
  workspace?: AdsWorkspaceData
  /** createAdCampaign: is the ad account connected and active right now? */
  accountConnected?: boolean
  /** createAdCampaign: does a credential path for this platform exist at all? */
  accountConnectable?: boolean
  performance?: any
  accountStatus?: "connected" | "disconnected" | "error"
  accountInfo?: any
}

export interface AdsWorkspaceData {
  /** ad_campaigns rows, each with its marketing campaign name and creative variations. */
  campaigns: any[]
  /** facebook_custom_audiences rows, each with its recent audience_sync_runs. */
  audiences: any[]
  /**
   * The ad_performance ROWS the summary below was computed from, newest
   * captured_at first. The summary is not a substitute: a surface needs the
   * rows to break spend/clicks down per campaign, and dropping them would
   * turn a populated Performance tab into an empty one.
   */
  performance: any[]
  performanceSummary: {
    totalSpend: number
    totalImpressions: number
    totalClicks: number
    totalLeads: number
    avgCtr: number
    avgCpl: number
  }
  accountConnections: Array<{
    platform: string
    is_active: boolean
    account_name: string | null
  }>
  /**
   * Ad platforms a campaign may target that have NO credential path in this
   * product today. Absent from accountConnections not because the brokerage has
   * not connected them, but because there is nothing to connect — a campaign can
   * be created for these and never launched from here. Named so the workspace
   * can say which it means.
   */
  unconnectableAdPlatforms: readonly string[]
  /**
   * The brokerage's ORGANIC social baselines over the trailing 28 days, one row
   * per (platform, post_type) with measurable activity — read from the
   * `social_post_baselines_28d` view (m167).
   *
   * This is the floor paid spend has to beat. Empty array is a real and common
   * answer ("no measurable organic activity yet"), NOT a failure: a brokerage
   * that has never posted organically has no floor, and the surface must say
   * that rather than render a zero.
   */
  organicBaselines: SocialBaseline[]
  /**
   * Paid-vs-organic click-through comparison, one entry per ad platform that
   * actually has `ad_performance` rows in this workspace.
   *
   * `paidCtr` is the fraction clicks/impressions for that platform's ad rows
   * (NOT the percentage in performanceSummary.avgCtr — the organic view stores a
   * fraction, and comparing a percentage against a fraction would report a 100x
   * lift). `liftRatio` is paid/organic, so 1.5 means paid beats organic by half
   * again. It is null when there is no baseline to divide by, or when the
   * organic rate is zero — a missing comparison is reported as missing, never as
   * a lift of zero or infinity.
   */
  organicLift: Array<{
    platform: string
    hasBaseline: boolean
    organicCtr: number | null
    paidCtr: number
    liftRatio: number | null
  }>
}

// Input types
export interface LoadAdsWorkspaceInput {
  ctx: AdsActorContext
}

export interface CreateAdCampaignInput {
  ctx: AdsActorContext
  campaignName: string
  platform: AdPlatform
  objective: AdObjective
  dailyBudget?: number
  lifetimeBudget?: number
  startDate?: string
  endDate?: string
  targetingConfig: TargetingConfig
  marketingCampaignId?: string
}

export interface UpdateAdCampaignInput {
  ctx: AdsActorContext
  campaignId: string
  updates: {
    campaignName?: string
    dailyBudget?: number
    lifetimeBudget?: number
    startDate?: string
    endDate?: string
    targetingConfig?: TargetingConfig
  }
}

export interface LoadAudienceDefinitionsInput {
  ctx: AdsActorContext
  campaignId?: string
}

export interface SyncAudienceInput {
  ctx: AdsActorContext
  audienceId: string
}

export interface CreateAudienceSegmentInput {
  ctx: AdsActorContext
  audienceName: string
  audienceType: AudienceType
  sourceRule: SourceRule
  consentBasis: string
  adCampaignId?: string
}

export interface PreviewAdCreativeInput {
  ctx: AdsActorContext
  campaignId: string
  creativeVariationId?: string
}

export interface LoadAdPerformanceInput {
  ctx: AdsActorContext
  campaignId?: string
  dateFrom?: string
  dateTo?: string
}

// ─── COMMAND 1: loadAdsWorkspace ──────────────────────────────────────────────
// Loads all campaigns, audiences, performance summary, and account connection status
// for the ads dashboard. Returns unified workspace view.
//
// Tables read: ad_campaigns, facebook_custom_audiences, ad_performance, platform_credentials
// Tables written: none
// Returns: AdsWorkspaceData with campaigns, audiences, performance, account status

export async function loadAdsWorkspace(input: LoadAdsWorkspaceInput): Promise<KernelAdsResult> {
  const { ctx } = input

  if (!ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "brokerageId and userId required", errorKind: "input" }
  }

  // Feature access check.
  //
  // canAccessFeature THROWS on its own read failures (feature_flags, users,
  // overrides, usage) rather than returning allowed:false. An uncaught throw
  // here would take the whole surface down with a stack trace; worse, it is a
  // READ failure wearing an entitlement failure's clothes. Caught and labelled
  // for what it is, so the caller can say "we could not check" instead of
  // "your plan does not include this".
  let accessCheck
  try {
    accessCheck = await canAccessFeature(ctx.userId, "ads_campaigns")
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Could not check ads access",
      errorKind: "read",
    }
  }
  if (!accessCheck.allowed) {
    return {
      success: false,
      error: accessCheck.reason || accessCheck.disabled_reason || "Feature not available",
      errorKind: "entitlement",
    }
  }

  try {
    const supabase = createServiceClient()

    // Load campaigns.
    //
    // The nested marketing_campaigns / ad_creative_variations selects are not
    // decoration: the workspace surface renders each campaign's creative
    // variations and gates "Approve" on at least one approved creative. A bare
    // select('*') here loads campaigns that look like they have no creatives.
    //
    // NOTE ON TENANCY: this runs on the SERVICE client (RLS bypassed), so the
    // explicit brokerage_id filter below is the ONLY tenant boundary on this
    // read. It is not optional.
    const { data: campaigns, error: campaignsError } = await supabase
      .from("ad_campaigns")
      .select(`
        *,
        marketing_campaigns (campaign_name),
        ad_creative_variations (*)
      `)
      .eq("brokerage_id", ctx.brokerageId)
      .order("created_at", { ascending: false })
      .limit(50)

    if (campaignsError) throw campaignsError

    // Load audiences with their sync-run history. Business rule 2 — audience
    // sync failures must be VISIBLE — is only satisfiable if the runs come back
    // with the audience; without them the surface can only say "never synced".
    const { data: audiences, error: audiencesError } = await supabase
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
      .eq("brokerage_id", ctx.brokerageId)
      .order("created_at", { ascending: false })
      .limit(50)

    if (audiencesError) throw audiencesError

    // Load performance rows. Filtered by brokerage_id in its own right (the
    // table carries the column) AND by the brokerage-filtered campaign ids —
    // on the service client the explicit filter is the whole tenant boundary,
    // so it is stated rather than inherited. Ordered newest-first so the
    // surface's most-recent capture reads first.
    const campaignIds = campaigns?.map((c) => c.id) || []
    let performanceData: any[] = []

    if (campaignIds.length > 0) {
      const { data: performance, error: performanceError } = await supabase
        .from("ad_performance")
        .select("*")
        .eq("brokerage_id", ctx.brokerageId)
        .in("ad_campaign_id", campaignIds)
        .order("captured_at", { ascending: false })

      if (performanceError) throw performanceError

      performanceData = performance || []
    }

    const totalSpend = performanceData.reduce((sum, p) => sum + (p.spend || 0), 0)
    const totalImpressions = performanceData.reduce((sum, p) => sum + (p.impressions || 0), 0)
    const totalClicks = performanceData.reduce((sum, p) => sum + (p.clicks || 0), 0)
    const totalLeads = performanceData.reduce((sum, p) => sum + (p.leads || 0), 0)
    const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0
    const avgCpl = totalLeads > 0 ? totalSpend / totalLeads : 0

    // Load account connections.
    //
    // This asked platform_credentials for the ad_campaigns.platform vocabulary —
    // two different columns, two different sets. 'tiktok' is not a value
    // platform_credentials admits and, more to the point, nothing in this
    // codebase could ever write it: there is no TikTok OAuth provider and no
    // TikTok connect form. Querying it produced a permanently absent row that
    // rendered as "not connected", which is a different claim from "cannot be
    // connected here" — see lib/integrations/ad-campaign-vocabulary.ts.
    const { data: accountConnections } = await supabase
      .from("platform_credentials")
      .select("platform, is_active, account_name")
      .eq("brokerage_id", ctx.brokerageId)
      .in("platform", [...CONNECTABLE_AD_PLATFORMS])

    // ── Organic floor (Wave 38 → Wave 40) ────────────────────────────────────
    // Business rule 4 says ad_performance is the single source of truth for
    // spend and ROI. It is — but a CTR with nothing to compare it to is not
    // ROI visibility, it is a number. m167 built `social_post_baselines_28d`
    // precisely so paid could be measured against the brokerage's own free
    // result, and the helper over it had sat unreached since.
    //
    // Brokerage-scoped by construction: listSocialBaselines takes the
    // brokerage id and filters on it, the same explicit boundary every other
    // service-client read in this function states. It logs and returns [] on a
    // view error rather than throwing, so a missing baseline can never take
    // the campaigns tab down with it.
    const organicBaselines = await listSocialBaselines(ctx.brokerageId)

    // One comparison per platform that has paid rows. Campaign id → platform,
    // because ad_performance carries the campaign, not the platform.
    const platformByCampaign = new Map<string, string>(
      (campaigns || []).map((c): [string, string] => [c.id as string, c.platform as string]),
    )
    const paidByPlatform = new Map<string, { impressions: number; clicks: number }>()
    for (const row of performanceData) {
      const platform = platformByCampaign.get(row.ad_campaign_id)
      if (!platform) continue
      const acc = paidByPlatform.get(platform) ?? { impressions: 0, clicks: 0 }
      acc.impressions += row.impressions || 0
      acc.clicks += row.clicks || 0
      paidByPlatform.set(platform, acc)
    }

    const organicLift = [...paidByPlatform.entries()].map(([platform, paid]) => {
      // The organic view is keyed (platform, post_type); an ad has no
      // post_type, so the platform's whole organic volume is the floor. Summed
      // across post types rather than averaging the per-type rates, so a single
      // high-rate post with 12 impressions cannot outvote the real traffic.
      const cells = organicBaselines.filter((b) => b.platform === platform)
      const organicImpressions = cells.reduce((s, b) => s + b.totalImpressions, 0)
      const organicClicks = cells.reduce((s, b) => s + b.totalClicks, 0)
      const merged: SocialBaseline | null =
        cells.length === 0
          ? null
          : {
              ...cells[0],
              postType: "*",
              postsMeasured: cells.reduce((s, b) => s + b.postsMeasured, 0),
              totalImpressions: organicImpressions,
              totalEngagements: cells.reduce((s, b) => s + b.totalEngagements, 0),
              totalClicks: organicClicks,
              engagementRate:
                organicImpressions > 0
                  ? cells.reduce((s, b) => s + b.totalEngagements, 0) / organicImpressions
                  : null,
              clickThroughRate: organicImpressions > 0 ? organicClicks / organicImpressions : null,
            }
      const paidCtr = paid.impressions > 0 ? paid.clicks / paid.impressions : 0
      const lift = computeOrganicLift({
        baseline: merged,
        paidRate: paidCtr,
        metric: "click_through_rate",
      })
      return {
        platform,
        hasBaseline: lift.hasBaseline,
        organicCtr: lift.organicRate,
        paidCtr: lift.paidRate,
        liftRatio: lift.liftRatio,
      }
    })

    const workspaceData: AdsWorkspaceData = {
      campaigns: campaigns || [],
      audiences: audiences || [],
      performance: performanceData,
      performanceSummary: {
        totalSpend,
        totalImpressions,
        totalClicks,
        totalLeads,
        avgCtr,
        avgCpl,
      },
      accountConnections: accountConnections || [],
      unconnectableAdPlatforms: AD_PLATFORMS_WITHOUT_CONNECTIONS,
      organicBaselines,
      organicLift,
    }

    return { success: true, workspace: workspaceData }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "loadAdsWorkspace failed",
      errorKind: "read",
    }
  }
}

// ─── COMMAND 2: createAdCampaign ──────────────────────────────────────────────
// Creates a new ad campaign in draft status. Validates budget, targeting, and account connection.
//
// Tables read: platform_credentials
// Tables written: ad_campaigns
// Returns: campaignId

export async function createAdCampaign(input: CreateAdCampaignInput): Promise<KernelAdsResult> {
  const { ctx, campaignName, platform, objective, dailyBudget, lifetimeBudget, startDate, endDate, targetingConfig, marketingCampaignId } = input

  if (!ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "brokerageId and userId required" }
  }

  // Validation: budget required
  if (!dailyBudget && !lifetimeBudget) {
    return { success: false, error: "Either dailyBudget or lifetimeBudget required" }
  }

  // Validation: targeting must include at least one location
  if (!targetingConfig.locations || targetingConfig.locations.length === 0) {
    return { success: false, error: "At least one targeting location required" }
  }

  // Feature access check
  const accessCheck = await canAccessFeature(ctx.userId, "ads_campaigns")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature not available" }
  }

  try {
    const supabase = createServiceClient()

    // Check platform account connection.
    //
    // This result was FETCHED AND DISCARDED — the file header's rule 9
    // ("Provider account connection required before campaign launch") was
    // enforced nowhere, which is a large part of why nobody noticed the query
    // could not match for two of the five platforms it was asked about. A draft
    // legitimately does not require a live connection, so this does not block;
    // it now REPORTS, which is the honest version of what the query was for.
    const connectable = isConnectableAdPlatform(platform)
    const { data: platformCred } = connectable
      ? await supabase
          .from("platform_credentials")
          .select("is_active, platform")
          .eq("brokerage_id", ctx.brokerageId)
          .eq("platform", platform)
          .maybeSingle()
      : { data: null }

    // Create campaign in draft status
    const { data: campaign, error } = await supabase
      .from("ad_campaigns")
      .insert({
        brokerage_id: ctx.brokerageId,
        agent_user_id: ctx.agentId,
        team_id: null,
        marketing_campaign_id: marketingCampaignId || null,
        created_by: ctx.userId,
        campaign_name: campaignName,
        platform,
        objective,
        status: "draft",
        daily_budget: dailyBudget || null,
        lifetime_budget: lifetimeBudget || null,
        start_date: startDate || null,
        end_date: endDate || null,
        targeting_config: targetingConfig as any,
        visibility_scope: "agent",
      })
      .select("id, campaign_name, platform, status, created_at")
      .maybeSingle()

    if (error) throw error

    // Increment feature usage
    await incrementFeatureUsage(ctx.userId, "ads_campaigns")

    return {
      success: true,
      campaignId: campaign!.id,
      campaign,
      accountConnected: !!platformCred?.is_active,
      // Distinguishes "you have not connected this yet" from "this product has
      // no way to connect it" — a draft for the latter can never be launched
      // from here, and the caller should say so rather than show a connect
      // prompt that leads nowhere.
      accountConnectable: connectable,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "createAdCampaign failed",
    }
  }
}

// ─── COMMAND 3: updateAdCampaign ──────────────────────────────────────────────
// Updates an existing ad campaign. Only drafts and paused campaigns can be updated.
//
// Tables read: ad_campaigns
// Tables written: ad_campaigns
// Returns: campaign

export async function updateAdCampaign(input: UpdateAdCampaignInput): Promise<KernelAdsResult> {
  const { ctx, campaignId, updates } = input

  if (!ctx.brokerageId || !campaignId) {
    return { success: false, error: "brokerageId and campaignId required" }
  }

  try {
    const supabase = createServiceClient()

    // Check campaign exists and is editable.
    // `error` is destructured and checked: a supabase-js query RESOLVES on a
    // permission denial with data === null, so `if (!existing)` alone reports an
    // RLS refusal to the caller as "Campaign not found" — a different claim.
    const { data: existing, error: existingError } = await supabase
      .from("ad_campaigns")
      .select("status")
      .eq("id", campaignId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (existingError) throw existingError

    if (!existing) {
      return { success: false, error: "Campaign not found" }
    }

    // SCHEMA DRIFT (same defect lib/ads/ad-creator.ts:updateCampaignStatus already
    // records): the guard used to read `status === "active"`, but
    // ad_campaigns_status_check is CHECK (status IN ('draft','pending_review',
    // 'approved','launching','live','paused','ended','failed')) — there is no
    // 'active'. That branch was false for every row that will ever exist, so a
    // campaign that was already SPENDING ('live') passed straight through and had
    // its budget and targeting rewritten underneath it. 'live' is the real
    // vocabulary for the state the guard was written to protect.
    if (existing.status === "live" || existing.status === "launching") {
      return { success: false, error: "Cannot update live or launching campaigns" }
    }

    // Build update object
    const updateObj: any = { updated_at: new Date().toISOString() }
    if (updates.campaignName) updateObj.campaign_name = updates.campaignName
    if (updates.dailyBudget !== undefined) updateObj.daily_budget = updates.dailyBudget
    if (updates.lifetimeBudget !== undefined) updateObj.lifetime_budget = updates.lifetimeBudget
    if (updates.startDate) updateObj.start_date = updates.startDate
    if (updates.endDate) updateObj.end_date = updates.endDate
    if (updates.targetingConfig) updateObj.targeting_config = updates.targetingConfig

    const { data: campaign, error } = await supabase
      .from("ad_campaigns")
      .update(updateObj)
      .eq("id", campaignId)
      .select()
      .maybeSingle()

    if (error) throw error

    return { success: true, campaign }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "updateAdCampaign failed",
    }
  }
}

// ─── COMMAND 4: pauseAdCampaign — DELETED (orphan burn-down w44) ──────────────
//
// REPLACED BY: lib/ads/ad-creator.ts:updateCampaignStatus(userId, campaignId,
// brokerageId, "paused") — session-gated, tenant-predicated on the WRITE, and
// zero-row-checked.
//
// This was not merely unwired, it could never have worked. It computed
// `existing.status === "active" ? "paused" : "active"`, but ad_campaigns_status_check
// is CHECK (status IN ('draft','pending_review','approved','launching','live',
// 'paused','ended','failed')) — there is no 'active'. The left branch was false for
// every row that will ever exist, so the function's only reachable behaviour was to
// write 'active' and take a guaranteed 23514. Nothing is lost: the survivor writes
// the real vocabulary and the toggle direction belongs to the caller, which knows
// whether the agent pressed Pause or Resume.

// ─── COMMAND 5: loadAudienceDefinitions ───────────────────────────────────────
// Loads all audience definitions for the brokerage, optionally filtered by campaign.
//
// Tables read: facebook_custom_audiences, audience_sync_runs
// Tables written: none
// Returns: audiences array with sync run history

export async function loadAudienceDefinitions(input: LoadAudienceDefinitionsInput): Promise<KernelAdsResult> {
  const { ctx, campaignId } = input

  if (!ctx.brokerageId) {
    return { success: false, error: "brokerageId required" }
  }

  try {
    const supabase = createServiceClient()

    let query = supabase
      .from("facebook_custom_audiences")
      .select(`
        *,
        audience_sync_runs (
          id,
          run_status,
          records_synced,
          records_rejected,
          error_message,
          completed_at
        )
      `)
      .eq("brokerage_id", ctx.brokerageId)

    if (campaignId) {
      query = query.eq("ad_campaign_id", campaignId)
    }

    const { data: audiences, error } = await query.order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, audience: audiences }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "loadAudienceDefinitions failed",
    }
  }
}

// ─── COMMAND 6: syncAudience ──────────────────────────────────────────────────
// Syncs an audience to the ad platform. Creates audience_sync_runs record with real status.
// NO fake success — always records actual sync outcome.
//
// Tables read: facebook_custom_audiences, contacts
// Tables written: audience_sync_runs
// Returns: syncRunId, syncRun

export async function syncAudience(input: SyncAudienceInput): Promise<KernelAdsResult> {
  const { ctx, audienceId } = input

  if (!ctx.brokerageId || !audienceId) {
    return { success: false, error: "brokerageId and audienceId required" }
  }

  try {
    const supabase = createServiceClient()

    // Load audience definition
    const { data: audience } = await supabase
      .from("facebook_custom_audiences")
      .select("*")
      .eq("id", audienceId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (!audience) {
      return { success: false, error: "Audience not found" }
    }

    // Validate consent basis present
    if (!audience.consent_basis) {
      return { success: false, error: "Consent basis required for audience sync (GDPR/CCPA compliance)" }
    }

    // Build contact query based on source_rule
    const sourceRule = audience.source_rule as SourceRule | null
    let contactsQuery = supabase
      .from("contacts")
      .select("id, email, phone, first_name, last_name")
      .eq("brokerage_id", ctx.brokerageId)
      .not("email", "is", null)
      // CONSENT GATE: an ad-platform custom audience may only contain contacts who
      // gave marketing consent (e.g. via an ad lead form). m165 already blocks
      // unconsented leads; this is the per-contact enforcement the policy requires.
      .eq("tcpa_consent", true)

    if (sourceRule?.type === "contact_list" && sourceRule.filters.contact_tags) {
      // Filter by tags if specified
      contactsQuery = contactsQuery.contains("tags", sourceRule.filters.contact_tags)
    }

    const { data: contacts, error: contactsError } = await contactsQuery.limit(10000)

    if (contactsError) throw contactsError

    const recordsAttempted = contacts?.length || 0

    // ── REAL provider sync via the connector for this audience's platform ──────
    // Routes by audience_type: custom/Customer-Match (upload hashed consented
    // contacts), lookalike (seed from a synced custom audience), or platform-native
    // (website_visitors/engagement — created on-platform, no CRM upload). Raw PII is
    // SHA-256 hashed before it leaves our server.
    const platform = (audience.target_platform as string) ?? "facebook"
    const audienceType = (audience.audience_type as string) ?? "custom"
    const { getConnector, loadConnectorCredential } = await import("@/lib/ads/connectors/registry")
    const { hashAudienceMembers } = await import("@/lib/ads/connectors/pii")
    const connector = getConnector(platform)

    let syncStatus: "success" | "error" = "error"
    let recordsSynced = 0
    let recordsRejected = 0
    let providerResponse: Record<string, unknown> = {}
    let errorMessage: string | null = null
    let externalAudienceId: string | null = (audience.external_audience_id as string | null) ?? null

    if (!connector) {
      errorMessage = `No connector for platform '${platform}'`
    } else {
      const cred = await loadConnectorCredential(ctx.brokerageId, platform, supabase)
      if (!cred) {
        errorMessage = `${platform} account not connected`
        providerResponse = { not_connected: true, contacts_found: recordsAttempted }
      } else if (audience.lookalike_seed_audience_id) {
        // LOOKALIKE / similar (cold prospecting) — seeded from a synced custom audience.
        const { data: seed } = await supabase.from("facebook_custom_audiences")
          .select("external_audience_id").eq("id", audience.lookalike_seed_audience_id).maybeSingle()
        const seedExternalId = (seed as { external_audience_id?: string | null } | null)?.external_audience_id ?? null
        if (!seedExternalId) {
          errorMessage = "lookalike seed audience has not synced yet"
        } else {
          const res = await connector.createLookalike({
            audienceName: audience.audience_name, seedExternalId,
            country: sourceRule?.filters?.seed_country ?? "US", sizePct: sourceRule?.filters?.seed_lookalike_size_pct ?? 1, cred,
          })
          syncStatus = res.ok ? "success" : "error"
          externalAudienceId = res.externalAudienceId ?? externalAudienceId
          errorMessage = res.error ?? null
          providerResponse = { type: "lookalike", ...res }
        }
      } else {
        // CUSTOM / Customer Match — every live audience_type (listing_visitors,
        // video_viewers, persona_segment, custom, …) is a CRM segment, uploaded as
        // hashed consented contacts.
        const { hashed, rejected } = hashAudienceMembers((contacts ?? []).map((c: any) => ({ email: c.email, phone: c.phone })))
        const res = await connector.pushCustomAudience({ audienceName: audience.audience_name, externalAudienceId, members: hashed, cred })
        syncStatus = res.ok ? "success" : "error"
        recordsSynced = res.recordsSynced
        recordsRejected = res.recordsRejected + rejected
        externalAudienceId = res.externalAudienceId ?? externalAudienceId
        errorMessage = res.error ?? null
        providerResponse = { type: "custom", platform, audience_type: audienceType, ...res }
      }
    }

    const { data: syncRun, error: syncError } = await supabase
      .from("audience_sync_runs")
      .insert({
        brokerage_id: ctx.brokerageId,
        audience_id: audienceId,
        run_status: syncStatus,
        records_attempted: recordsAttempted,
        records_synced: recordsSynced,
        records_rejected: recordsRejected,
        provider_response: providerResponse,
        error_message: errorMessage,
        completed_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (syncError) throw syncError

    // Persist the provider audience id + status so retargeting/lookalike can reference it.
    await supabase
      .from("facebook_custom_audiences")
      .update({
        last_synced_at: new Date().toISOString(),
        status: syncStatus === "success" ? "synced" : "error",
        ...(externalAudienceId ? { external_audience_id: externalAudienceId } : {}),
      })
      .eq("id", audienceId)

    return { success: true, syncRunId: syncRun!.id, syncRun }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "syncAudience failed",
    }
  }
}

// ─── COMMAND 7: createAudienceSegment ─────────────────────────────────────────
// Creates a new audience segment with source rules. Validates consent basis.
//
// Tables read: none
// Tables written: facebook_custom_audiences
// Returns: audienceId, audience

export async function createAudienceSegment(input: CreateAudienceSegmentInput): Promise<KernelAdsResult> {
  const { ctx, audienceName, audienceType, sourceRule, consentBasis, adCampaignId } = input

  if (!ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "brokerageId and userId required" }
  }

  if (!consentBasis || !consentBasis.trim()) {
    return { success: false, error: "Consent basis required for legal compliance (GDPR/CCPA)" }
  }

  try {
    const supabase = createServiceClient()

    const { data: audience, error } = await supabase
      .from("facebook_custom_audiences")
      .insert({
        brokerage_id: ctx.brokerageId,
        ad_campaign_id: adCampaignId || null,
        audience_name: audienceName,
        audience_type: audienceType,
        source_rule: sourceRule as any,
        consent_basis: consentBasis,
        status: "draft",
      })
      .select()
      .maybeSingle()

    if (error) throw error

    return { success: true, audienceId: audience!.id, audience }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "createAudienceSegment failed",
    }
  }
}

// ─── COMMAND 8: previewAdCreative ─────────────────────────────────────────────
// Generates preview of ad creative before approval. Returns creative with performance prediction.
//
// Tables read: ad_campaigns, ad_creative_variations
// Tables written: none
// Returns: creative preview data

export async function previewAdCreative(input: PreviewAdCreativeInput): Promise<KernelAdsResult> {
  const { ctx, campaignId, creativeVariationId } = input

  if (!ctx.brokerageId || !campaignId) {
    return { success: false, error: "brokerageId and campaignId required" }
  }

  try {
    const supabase = createServiceClient()

    // Load campaign
    const { data: campaign } = await supabase
      .from("ad_campaigns")
      .select("*")
      .eq("id", campaignId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (!campaign) {
      return { success: false, error: "Campaign not found" }
    }

    // Load creative variations.
    // `.order("created_at")` merged from lib/ads/ad-creator.ts:getCampaignCreatives
    // (orphan burn-down w2s2). Without it Postgres returns A/B variations in no
    // guaranteed order, so the same campaign could render its variations in a
    // different sequence on each load — the one capability the orphan had that
    // this survivor lacked. Generation order is the meaningful order for A/B
    // variants: "variation 1" is the first thing the model produced.
    let query = supabase
      .from("ad_creative_variations")
      .select("*")
      .eq("ad_campaign_id", campaignId)
      .eq("brokerage_id", ctx.brokerageId)
      .order("created_at", { ascending: true })

    if (creativeVariationId) {
      query = query.eq("id", creativeVariationId)
    }

    const { data: creatives, error } = await query

    if (error) throw error

    return { success: true, creatives: creatives || [], campaign }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "previewAdCreative failed",
    }
  }
}

// ─── COMMAND 9: approveAdCreative — MERGED-THEN-DELETED (orphan burn-down w44) ─
//
// SURVIVOR: lib/ads/ad-creator.ts:approveCreativeVariation — the surface the ads
// dashboard actually calls (app/dashboard/campaigns/ads/ads-dashboard-client.tsx).
// It is strictly stronger on every axis this one had, so NOTHING was merged
// forward; the list below is what the survivor already did that this did not:
//   · resolves the actor from the SESSION (resolveAdActor) instead of trusting a
//     caller-supplied ctx.brokerageId — the identity rule, not an option;
//   · idempotent: an already-approved variation returns success instead of
//     re-running the compliance gate;
//   · ledgers a compliance_events row AND flips approval_status to "rejected" on
//     a failed gate, so the refusal is visible on the screen and in the audit
//     trail — this one returned an error string and left the row untouched;
//   · `.update(...).eq("brokerage_id", …).select("id")` with a zero-row check, so
//     an RLS-hidden row reports failure instead of a silent success;
//   · messageType "social" (an ad IS social) and a real broadcastAdContact(),
//     where this one passed messageType "email" and a FABRICATED contact literal
//     with `tcpa_consent: true` and an empty id — inventing consent to get past
//     the gate is the one thing the compliance layer must never be handed.
