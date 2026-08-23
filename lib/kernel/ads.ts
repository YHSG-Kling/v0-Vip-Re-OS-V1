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
//   11. FAIR HOUSING — an ad audience may not be SEGMENTED by a protected class,
//       refused at DEFINE time (createAudienceSegment) and again at POPULATE time
//       (syncAudience). See the block comment above COMMAND 7 for the scope
//       boundary: this gate covers ad TARGETING only. Scraping, enrichment,
//       signals, scoring, sourcing and buyer property search are EXEMPT by owner
//       ruling and nothing here reaches them.

import { createServiceClient } from "@/lib/supabase/service"
// THE canonical ad-audience fair-housing refusal (CLAUDE.md §6 — one vocabulary
// per function). NOT a second classifier: lib/lead-governance/protected-class-signals.ts
// is the single protected-class vocabulary in this repo, and this is its one
// remaining REFUSING arm. Its other arms (defineSellerSignalSources,
// labelProtectedClassFields) are LABELLERS by owner ruling and are deliberately
// not imported here — importing the assertion cannot make an exempt caller refuse,
// because the refusal is a call, not an import.
import { assertAudienceSegmentationAllowed } from "@/lib/lead-governance/protected-class-signals"
// THE POSITIVE HALF (owner ruling: "audience should be segmented on persona").
// The import above says what an audience may NOT be; this one says what it must
// BE. They are deliberately two calls in the same place rather than one merged
// gate: the protected-class refusal must keep refusing rules that declare no
// persona at all (a `contact_tags: ["seniors-55plus"]` rule is still refused),
// and the persona rule must keep refusing an UNRESOLVABLE basis that names no
// protected class (an empty persona list). Neither subsumes the other.
import { assertAudiencePersonaBasis, declaresPersonaBasis, resolveAudiencePersonaBasis } from "@/lib/ads/audience-persona-basis"
// THE OTHER MISSING HALF — what each of the fifteen source-rule types actually
// RESOLVES TO, and a refusal for every one that has no honest definition. See
// that file's header for the defect: fifteen declared types, two narrowed, and
// thirteen silently uploading the whole consented book to Meta/Google. It is
// imported here rather than inlined so the resolution can be proven on FIXTURES
// (the live tenant holds four contacts, at which size a filter that returns
// everyone is indistinguishable from no filter).
import {
  resolveSourceRuleNarrowing,
  type SourceRuleType,
  type NarrowPredicate,
  type SourceRuleNarrowing,
  type SourceRuleNarrowingOk,
} from "@/lib/ads/audience-source-rules"
// THE EXCLUSION SLOT (owner: "capability is vital to this os to have not
// exclude"). `TargetingConfig.excluded_audience_ids` lets an operator DECLARE a
// suppression list in the product instead of performing it invisibly in Meta's
// UI, and this is the gate that makes that declaration governable: every
// audience in the slot is run through the persona gate's EXCLUSION arm and the
// token gate before a campaign may carry it. Not a second classifier — it calls
// both existing ones (CLAUDE.md §6).
import {
  verifyExclusionSlot,
  recordSuppressionUse,
  type GovernedExclusion,
} from "@/lib/ads/audience-exclusion"
import { rawSpellingsForPersona } from "@/lib/campaigns/contact-sources"
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
  /**
   * The audiences this campaign TARGETS — `facebook_custom_audiences.id` values.
   *
   * Had NO READER anywhere for its whole life while three writers emitted `[]`
   * (CLAUDE.md §1). The reader is lib/ads/launch-assembler.ts, which resolves
   * these to their platform ids and hands them to the Meta payload as
   * `custom_audiences`.
   */
  custom_audience_ids?: string[]
  /**
   * The audiences this campaign SUBTRACTS — `facebook_custom_audiences.id`
   * values, read through `excludedAudienceIdsIn` (lib/ads/audience-exclusion.ts).
   *
   * ── WHY THIS FIELD EXISTS AT ALL (owner: "capability is vital to this os to
   * have not exclude") ─────────────────────────────────────────────────────
   * It is NOT here to make exclusion easier. It is here so exclusion is
   * VISIBLE. Until this field existed the product governed exclusion only as
   * DECLARED in an audience's own source rule, so an operator who exported a
   * persona audience and pasted it into Meta's "Exclude" box performed a
   * suppression this system could not see, could not gate and could not audit.
   *
   * EVERY ID PLACED HERE IS GATED, at all four doors that can write or act on
   * it (lib/kernel/ads.ts createAdCampaign + updateAdCampaign,
   * lib/ads/ad-creator.ts createAdCampaign, lib/ads/launch-assembler.ts). A
   * protected-characteristic persona audience in this slot is REFUSED —
   * `personaAdsEligibility(persona, "exclusion")`, the arm the owner's
   * 2026-08-23 ruling left in force: a situation persona may TAILOR an ad and
   * may not SUPPRESS one (Fair Housing Act, 42 U.S.C. § 3604(c); HUD v. Meta).
   */
  excluded_audience_ids?: string[]
  lookalike_source_audience_id?: string | null
  income_percentile?: "top_25" | "top_50" | "any"
  homeowner_status?: "renter" | "owner" | "any"
}

export interface SourceRule {
  /**
   * DERIVED, NOT RESTATED (CLAUDE.md §6). The fifteen members and the narrowing
   * each one resolves to live together in `lib/ads/audience-source-rules.ts`,
   * because they must never be able to disagree: for most of this file's life the
   * union here declared FIFTEEN types and `syncAudience` narrowed for TWO, and the
   * other thirteen fell through to "every consented contact in the tenant" —
   * hashed and uploaded to Meta/Google under a name promising a narrow slice.
   *
   * `SOURCE_RULE_TYPES` is now the single roster, and `NARROWERS` over there is a
   * `Record` keyed by it, so adding a type without a definition is a COMPILE
   * error rather than a silent, unnarrowed upload.
   *
   * `persona_segment` is the persona lane's member (owner ruling: "audience should
   * be segmented on persona") and is narrowed by that lane's gate, not re-derived.
   */
  type: SourceRuleType
  filters: {
    days_lookback?: number
    contact_tags?: string[]
    /**
     * THE AUDIENCE'S DECLARED BASIS — canonical `Persona` values only
     * (lib/campaigns/contact-sources.ts CAMPAIGN_PERSONAS, mirroring the union at
     * lib/kernel/types.ts and the live campaign_sequences_persona_check).
     *
     * TYPED AS string[] ON PURPOSE. The compiler cannot see what an operator POSTs
     * or what an old row holds, so narrowing this to `CampaignPersona[]` would buy
     * a false sense of a check that only ever ran on our own literals. The real
     * check is `resolveAudiencePersonaBasis`, which runs at DEFINE time and again
     * at POPULATE time and refuses anything it cannot resolve.
     *
     * Personas that are a PROTECTED CHARACTERISTIC rather than a transaction
     * situation (senior, probate, divorce, military) are REFUSED here and remain
     * fully valid on the data/education lanes — see lib/ads/audience-persona-basis.ts.
     */
    personas?: string[]
    engagement_type?: string
    url_pattern?: string
    // Prebuilt-rule filters
    min_engagement_score?: number
    /**
     * For lifetime customers — minimum OWNERSHIP TENURE in months.
     *
     * RENAMED from `min_purchase_age_months` (CLAUDE.md §6). Two spellings of
     * "elapsed time" existed and one of them was the word "age", which is the
     * protected-class vocabulary: `tokenizeFieldPath("min_purchase_age_months")`
     * yields ["min","purchase","age","months"], so the fair-housing audience gate
     * added below refused the product's OWN `lifetime_customers` template. The
     * "age" there is the age of a PURCHASE, not of a person — but a gate that has
     * to special-case our own key is a gate the next author weakens. The key is
     * renamed instead, so the token vocabulary stays clean and the gate stays
     * uncarved. Live rows carrying the old key: ZERO (facebook_custom_audiences
     * was empty on 2026-08-22), so no backfill migration is owed.
     */
    min_tenure_months?: number
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
  /**
   * createAdCampaign / updateAdCampaign: the campaign WAS created and its
   * exclusion slot WAS gated, but the m538 suppression-use audit stamp did not
   * land (most likely because m538 is not applied yet). Set only when the audit
   * write refused — a swallowed refusal is the trap CLAUDE.md §3 names.
   */
  suppressionAuditWarning?: string
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
      // MERGED from previewAdCreative (see its tombstone at COMMAND 8): the
      // nested variations are ordered oldest-first so A/B variants render in
      // GENERATION order — "variation 1" is the first thing the model produced.
      // Without it Postgres returns them in no guaranteed order and the same
      // campaign can list its variants differently on each load.
      .order("created_at", { referencedTable: "ad_creative_variations", ascending: true })
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

    // ── THE EXCLUSION SLOT IS GATED BEFORE THE ROW EXISTS ────────────────────
    // DEFINE-SIDE, for the same reason the protected-class refusal was moved to
    // the define side (finding #298): a suppression list that is only checked at
    // launch PERSISTS in targeting_config in the meantime, and the launch path is
    // not the only thing that reads it. Tenant comes from `ctx`, which is
    // session-derived — never from the targeting config (CLAUDE.md §4).
    const exclusionVerdict = await verifyExclusionSlot({
      supabase,
      brokerageId: ctx.brokerageId,
      targeting: targetingConfig,
      campaignLabel: campaignName,
    })
    if (!exclusionVerdict.ok) {
      return { success: false, error: exclusionVerdict.refusal, errorKind: "input" }
    }

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

    // ── THE AUDIT RECORD (m538) ──────────────────────────────────────────────
    // The fact that an audience was used as a suppression list is now recorded
    // ON THE AUDIENCE, so it is auditable after the campaign is gone. The write
    // is best-effort and its refusal is SURFACED, never swallowed: until the
    // integrator applies m538 these columns do not exist and PostgREST refuses
    // the update entirely (PGRST204). That means "not yet auditable", not "not
    // checked" — the gate above already ran and already refused what it must.
    const suppressionAudit = await recordSuppressionUse({
      supabase,
      brokerageId: ctx.brokerageId,
      campaignId: campaign!.id,
      governed: exclusionVerdict.governed,
    })

    // Increment feature usage
    await incrementFeatureUsage(ctx.userId, "ads_campaigns")

    return {
      success: true,
      campaignId: campaign!.id,
      campaign,
      suppressionAuditWarning: suppressionAudit.error ?? undefined,
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

    // ── THE EXCLUSION SLOT IS GATED ON EVERY REWRITE TOO ─────────────────────
    // The define-side gate is worth nothing if a second command can swap a clean
    // targeting config for one carrying a protected-characteristic suppression
    // list. This is that second command, and it is the one the ads dashboard's
    // edit dialog calls.
    let suppressionGoverned: GovernedExclusion[] = []
    if (updates.targetingConfig) {
      const exclusionVerdict = await verifyExclusionSlot({
        supabase,
        brokerageId: ctx.brokerageId,
        targeting: updates.targetingConfig,
        campaignLabel: updates.campaignName ?? campaignId,
      })
      if (!exclusionVerdict.ok) {
        return { success: false, error: exclusionVerdict.refusal, errorKind: "input" }
      }
      suppressionGoverned = exclusionVerdict.governed
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

    // Same audit stamp, same honesty about it, as the create door (m538).
    const suppressionAudit = await recordSuppressionUse({
      supabase,
      brokerageId: ctx.brokerageId,
      campaignId,
      governed: suppressionGoverned,
    })

    return { success: true, campaign, suppressionAuditWarning: suppressionAudit.error ?? undefined }
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

// ─── THE ONE PLACE A SOURCE RULE BECOMES A CONTACT LIST ───────────────────────
//
// Shared by COMMAND 6 (syncAudience — the path that actually uploads) and
// COMMAND 6b (previewAudienceResolution — the path that lets an operator SEE the
// answer before it leaves). One implementation on purpose (CLAUDE.md §6): a
// preview that resolved differently from the sync would be worse than no preview,
// because it would be a reassurance about a set that was never delivered.
//
// EVERY EXIT IS A DEFINITION OR A REFUSAL. There is no arm that returns the base
// query unnarrowed — that arm is what uploaded thirteen rule types' worth of
// "everybody" to Meta and Google, and its absence is the fix.

/** What one contact contributes to a hashed Customer-Match upload. */
interface AudienceContactRow {
  id: string
  email: string | null
  phone: string | null
  first_name: string | null
  last_name: string | null
}

type AudiencePopulation =
  | {
      ok: true
      narrowing: SourceRuleNarrowingOk
      /** null ONLY when the rule uploads no CRM contacts (`lookalike_seed`). */
      contacts: AudienceContactRow[] | null
      /** The persona spellings the persona gate narrowed on, when it did. */
      personaSpellings: string[] | null
    }
  | { ok: false; error: string; errorKind: "input" | "read"; narrowing: SourceRuleNarrowing }

/** Apply one declarative predicate to a PostgREST query builder. */
function applyPredicate<Q extends { [k: string]: any }>(query: Q, p: NarrowPredicate): Q {
  switch (p.op) {
    case "eq":
      return query.eq(p.column, p.value)
    case "in":
      return query.in(p.column, p.value as unknown[])
    case "not_in": {
      // PostgREST has no "not in OR null" primitive. Written as an explicit OR so
      // a row whose stage was never set is INCLUDED — a buyer with a null
      // buyer_stage has not gone under contract, and dropping them would make
      // "active buyers" quietly exclude every contact the buyer pipeline has not
      // touched yet. `rowMatchesPredicates` in the pure module implements the
      // identical rule, so the fixture evaluator and this query cannot disagree.
      const list = (p.value as unknown[]).map((v) => String(v)).join(",")
      return query.or(`${p.column}.is.null,${p.column}.not.in.(${list})`)
    }
    case "gte":
      return query.gte(p.column, p.value)
    case "lte":
      return query.lte(p.column, p.value)
    case "contains":
      return query.contains(p.column, p.value as unknown[])
    case "not_null":
      return query.not(p.column, "is", null)
  }
}

async function resolveAudiencePopulation(args: {
  supabase: ReturnType<typeof createServiceClient>
  brokerageId: string
  sourceRule: SourceRule | null
  audienceLabel: string
  now?: Date
}): Promise<AudiencePopulation> {
  const { supabase, brokerageId, sourceRule, audienceLabel } = args

  const narrowing = resolveSourceRuleNarrowing(sourceRule, args.now ?? new Date())
  if (!narrowing.ok) {
    return {
      ok: false,
      narrowing,
      errorKind: "input",
      error: `[audience-source-rule] REFUSED: audience "${audienceLabel}" ${narrowing.refusal}`,
    }
  }

  // A rule that uploads no CRM contacts resolves to no contact list at all. Null,
  // not []: "this rule does not produce a list" and "this rule produced an empty
  // list" are different answers and the caller routes on the difference.
  if (!narrowing.uploadsContacts) {
    return { ok: true, narrowing, contacts: null, personaSpellings: null }
  }

  let contactsQuery = supabase
    .from("contacts")
    .select("id, email, phone, first_name, last_name")
    .eq("brokerage_id", brokerageId)
    .not("email", "is", null)
    // CONSENT GATE: an ad-platform custom audience may only contain contacts who
    // gave marketing consent (e.g. via an ad lead form). m165 already blocks
    // unconsented leads; this is the per-contact enforcement the policy requires.
    //
    // A FLOOR, NEVER A DEFINITION. This was the ONLY filter on thirteen of the
    // fifteen rule types, and consent to be contacted BY THE BROKERAGE is not
    // consent to be uploaded to Meta. It stays, underneath the narrowing.
    .eq("tcpa_consent", true)

  // ── The id-set prefetch, when the rule is true of a contact because of a row
  //    in ANOTHER table (a qualified lead, an open-house check-in, a live deal) ─
  if (narrowing.join) {
    const j = narrowing.join
    let joinQuery = supabase
      .from(j.table)
      .select(j.contactIdColumns.join(", "))
      // TENANCY (CLAUDE.md §4). This runs on the SERVICE client, so the explicit
      // brokerage filter is the whole boundary — and it is on the JOIN table too,
      // not merely on `contacts`. Without it a foreign tenant's transaction ids
      // would be collected and then intersected away silently, which works today
      // and stops working the moment two tenants share a contact id.
      .eq("brokerage_id", brokerageId)
    for (const p of j.predicates) joinQuery = applyPredicate(joinQuery, p)

    const { data: joinRows, error: joinError } = await joinQuery.limit(20000)
    // READ THE ERROR (CLAUDE.md §3 — supabase-js RESOLVES refusals). A swallowed
    // refusal here would leave `ids` empty; an empty id set must never be allowed
    // to mean "skip the filter", and it must not be reported as a legitimately
    // empty audience either.
    if (joinError) {
      return {
        ok: false,
        narrowing,
        errorKind: "read",
        error:
          `[audience-source-rule] could not resolve audience "${audienceLabel}": reading ${j.table} ` +
          `failed (${joinError.message}). Refusing rather than syncing an audience we could not resolve.`,
      }
    }

    const ids = new Set<string>()
    // `as unknown as` because the column list is built at runtime from the
    // narrowing, so supabase-js cannot type the row shape and falls back to its
    // GenericStringError union. The values are read defensively below (a
    // non-string id is skipped), which is the check the cast gives up.
    for (const row of (joinRows ?? []) as unknown as Array<Record<string, unknown>>) {
      for (const col of j.contactIdColumns) {
        const v = row[col]
        if (typeof v === "string" && v.length > 0) ids.add(v)
      }
    }
    // AN EMPTY PREFETCH IS AN EMPTY AUDIENCE. Returning early rather than skipping
    // `.in("id", [])` — the original defect in miniature: "I found nothing to
    // filter on, so I will not filter".
    if (ids.size === 0) {
      return { ok: true, narrowing, contacts: [], personaSpellings: null }
    }
    // `contacts.id` is the PK. NOT `contacts.contact_id`, which is a SECOND uuid
    // column on this table and is what every FK above points at — no: verified on
    // the live schema, leads.contact_id / transactions.*_contact_id / listings.
    // seller_contact_id all reference `contacts.id`. Picking the other one
    // produces a query that always returns nothing (CLAUDE.md §3).
    contactsQuery = contactsQuery.in("id", [...ids])
  }

  for (const p of narrowing.predicates) contactsQuery = applyPredicate(contactsQuery, p)

  // ── THE PERSONA BASIS ACTUALLY NARROWS ────────────────────────────────────
  // Unchanged from the persona lane and deliberately NOT re-implemented in the
  // source-rule module (CLAUDE.md §6). The define-time and populate-time
  // assertions above prove the basis is resolvable and ads-eligible; this is the
  // query that makes the declaration true.
  //
  // WHY RAW SPELLINGS AND NOT THE CANONICAL VALUE. `contacts.contact_persona` is
  // free text with no CHECK and has drifted — every live row on 2026-08-22 held
  // a non-canonical spelling (first_time_buyer, luxury_buyer, listing_seller,
  // past_client). Querying the canonical value alone would return zero rows and
  // report drift as "you have no first-time buyers". `rawSpellingsForPersona`
  // inverts the ONE existing alias map (lib/campaigns/contact-sources.ts), so the
  // reader and this query can never disagree. m531 (written, NOT applied)
  // normalises the column and puts a CHECK on it; until it is applied this
  // widening is what makes the audience non-empty.
  //
  // Runs for ANY rule that declares a persona filter, not only `persona_segment` —
  // a persona smuggled onto another type is still a persona basis, and the type
  // string is not an opt-out.
  let personaSpellings: string[] | null = null
  if (declaresPersonaBasis(sourceRule)) {
    const basis = resolveAudiencePersonaBasis(sourceRule)
    if (!basis.ok) {
      // Reached only if the assertion and the resolver ever disagree. The answer
      // is a refusal, never an unnarrowed upload of the whole roster.
      return {
        ok: false,
        narrowing,
        errorKind: "input",
        error: `[audience-persona-basis] REFUSED: ${basis.refusal}`,
      }
    }
    // Local `spellings` deliberately, and the call written out in full: the
    // persona lane's simulator pins this exact call shape
    // (scripts/audience-persona-basis-simulator.ts — ".in on contact_persona"),
    // and that assertion is how it proves the persona gate is not theatre. Moving
    // the query into this shared helper must not cost that proof.
    const spellings = basis.personas.flatMap((p) => rawSpellingsForPersona(p))
    personaSpellings = spellings
    contactsQuery = contactsQuery.in("contact_persona", spellings)
  } else if (narrowing.narrowedByPersonaGate) {
    // `type: "persona_segment"` with no persona filter at all. The persona gate
    // keys on `declaresPersonaBasis`, which is true for that type — so this is
    // belt-and-braces rather than a live hole. It is here because the ONE thing
    // this whole change exists to prevent is a rule type reaching the query with
    // nothing narrowing it.
    return {
      ok: false,
      narrowing,
      errorKind: "input",
      error:
        `[audience-source-rule] REFUSED: audience "${audienceLabel}" is a persona segment but declares ` +
        `no persona basis, so nothing would narrow it.`,
    }
  }

  const { data: contacts, error: contactsError } = await contactsQuery.limit(10000)
  if (contactsError) {
    return {
      ok: false,
      narrowing,
      errorKind: "read",
      error:
        `[audience-source-rule] could not resolve audience "${audienceLabel}": reading contacts failed ` +
        `(${contactsError.message}). Refusing rather than syncing an audience we could not resolve.`,
    }
  }

  return {
    ok: true,
    narrowing,
    contacts: (contacts ?? []) as unknown as AudienceContactRow[],
    personaSpellings,
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

    // FAIR HOUSING — the POPULATE side, on the path that actually uploads.
    //
    // This is the second populate path the define-side finding (#298) named. The
    // four staging sites in lib/audiences/audience-sync.ts guard the drip that
    // fills audience_members; THIS command reads source_rule directly, builds the
    // contact query below from it, and hands the result to a Meta/Google
    // connector. A row defined before this gate existed, or defined by any writer
    // that bypasses createAudienceSegment (app/actions/campaign-presets.ts writes
    // this same column), reaches Meta through here and nowhere else.
    //
    // Sits BESIDE the consent-basis refusal, in the same shape and the same
    // place, for the same reason: both are compliance refusals of the audience
    // DEFINITION, both must happen before a single contact is read, and both are
    // returned as an error the caller surfaces. FAILS CLOSED — any throw out of
    // the assertion, including a classifier that cannot walk the rule, refuses.
    const fairHousingRefusal = ((): string | null => {
      try {
        assertAudienceSegmentationAllowed(
          audience.source_rule,
          (audience.audience_name as string) || audienceId,
        )
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    })()
    if (fairHousingRefusal) {
      return { success: false, error: fairHousingRefusal }
    }

    // THE PERSONA BASIS — the POPULATE side (owner ruling: "audience should be
    // segmented on persona"). Runs BESIDE the fair-housing refusal above, before a
    // single contact is read, for the same reason both of those do.
    //
    // THIS IS THE HALF THAT WAS ACTUALLY DANGEROUS. `persona_segment` has been a
    // live `audience_type` CHECK value with no populate branch, so an audience
    // named "First-Time Buyers" fell straight through the query below — which
    // narrows for `contact_list` and NOTHING else — and uploaded EVERY consented
    // contact in the brokerage to Meta under a name promising a narrow slice.
    // FAILS CLOSED (CLAUDE.md §4): a basis that cannot be resolved refuses here
    // rather than populating with everyone.
    const personaBasisRefusal = ((): string | null => {
      try {
        assertAudiencePersonaBasis(
          audience.source_rule,
          (audience.audience_name as string) || audienceId,
        )
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    })()
    if (personaBasisRefusal) {
      return { success: false, error: personaBasisRefusal }
    }

    // ── WHO THIS AUDIENCE ACTUALLY RESOLVES TO ────────────────────────────────
    // THE fix for the thirteen unnarrowed rule types. `resolveAudiencePopulation`
    // is the ONE place a source rule becomes a contact list, and it has no
    // permissive default: a rule it cannot resolve REFUSES here, before a single
    // row is read and long before anything is hashed and handed to Meta/Google.
    //
    // Refusal is returned as an ordinary command error so every existing caller
    // surfaces it (lib/ads/facebook-audience-sync.ts → the ads dashboard's
    // toast.error, and the six-hourly cron's per-audience result line).
    const sourceRule = audience.source_rule as SourceRule | null
    const population = await resolveAudiencePopulation({
      supabase,
      brokerageId: ctx.brokerageId,
      sourceRule,
      audienceLabel: (audience.audience_name as string) || audienceId,
    })
    if (!population.ok) {
      return { success: false, error: population.error, errorKind: population.errorKind }
    }

    const contacts = population.contacts
    const recordsAttempted = contacts?.length ?? 0

    // A SEED RULE WITH NO SEED IS NOT A CUSTOM AUDIENCE. `lookalike_seed` uploads
    // no CRM contacts at all — the connector seeds from an already-synced
    // audience's EXTERNAL id. Routing below keys off `lookalike_seed_audience_id`,
    // so before this refusal a `lookalike_seed` rule on a row where that column is
    // null missed the lookalike branch and fell into the Customer-Match branch,
    // which uploaded every consented contact as the "seed". Refuse instead: this
    // is a broken definition, and the fail-closed answer to a broken definition is
    // never a wider audience.
    if (!population.narrowing.uploadsContacts && !audience.lookalike_seed_audience_id) {
      return {
        success: false,
        errorKind: "input",
        error:
          `[audience-source-rule] REFUSED: audience "${(audience.audience_name as string) || audienceId}" ` +
          `${population.narrowing.label} — but no seed audience is linked ` +
          `(facebook_custom_audiences.lookalike_seed_audience_id is null). Link a synced audience to seed ` +
          `from; this refuses rather than uploading your whole consented contact list in its place.`,
      }
    }

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

    // CHECK VOCABULARY (live-verified, lane C): audience_sync_runs_run_status_check
    // is CHECK (run_status IN ('queued','running','completed','failed')) — it admits
    // NEITHER 'success' NOR 'error', which is what this variable used to hold and
    // what was written straight into the insert below. Every sync run INSERT was
    // therefore refused with 23514, and because that insert IS error-checked
    // (`if (syncError) throw syncError`) the whole command returned "syncAudience
    // failed" — AFTER the connector had already uploaded the tenant's consented
    // contacts to Meta/Google. So the upload happened, the ledger row that is the
    // only record of it did not, and business rule 2 ("audience sync failures must
    // be visible") could never hold. The real vocabulary is used now.
    let syncStatus: "completed" | "failed" = "failed"
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
          syncStatus = res.ok ? "completed" : "failed"
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
        syncStatus = res.ok ? "completed" : "failed"
        recordsSynced = res.recordsSynced
        recordsRejected = res.recordsRejected + rejected
        externalAudienceId = res.externalAudienceId ?? externalAudienceId
        errorMessage = res.error ?? null
        providerResponse = { type: "custom", platform, audience_type: audienceType, ...res }
      }
    }

    // THE DELIVERED SET, RECORDED BESIDE THE PROMISE. `records_attempted` alone
    // is a number with no denominator — it says 4 went, never that the rule that
    // produced the 4 was "every consented contact". The resolved rule type and its
    // operator-facing label go into the run ledger so an audit after the fact can
    // read what the audience MEANT, not merely how many rows left.
    providerResponse = {
      ...providerResponse,
      resolved_rule_type: population.narrowing.ruleType,
      resolved_rule_label: population.narrowing.label,
      resolved_records: recordsAttempted,
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
        // facebook_custom_audiences_status_check admits
        // draft|pending_review|approved|synced|failed|deleted — 'error' was in
        // none of them, and this update's error is not destructured, so a failed
        // sync silently left the audience sitting at its previous status.
        status: syncStatus === "completed" ? "synced" : "failed",
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

// ─── COMMAND 6b: previewAudienceResolution ────────────────────────────────────
// THE REASON THIS DEFECT SURVIVED IN ONE COMMAND.
//
// Nothing ever showed the DELIVERED count against the PROMISED one. An operator
// picked "Investors", the sync reported "4 records synced", and 4 was in fact the
// entire consented contact book — the two numbers are identical and the surface
// had no way to say so. `records_attempted` after the fact is not the same thing:
// by then the rows have left, and this is an egress path with no undo.
//
// So: resolve the audience through the SAME code path the sync uses, count it,
// name the rule that produced the count, and upload NOTHING. Cheap enough to sit
// behind a button on the audience card, and it answers the one question the
// surface could not: "is this actually a slice, or is this everybody?"
//
// Tables read: facebook_custom_audiences, contacts (+ the rule's join table)
// Tables written: none
// Returns: resolution { ruleType, ruleLabel, resolvedCount, totalConsented, uploadsContacts }

export interface PreviewAudienceResolutionInput {
  ctx: AdsActorContext
  audienceId: string
}

export interface AudienceResolutionPreview {
  audienceId: string
  audienceName: string
  /** The resolved `SourceRule.type`, or null when the rule was refused. */
  ruleType: SourceRuleType | null
  /** The operator-facing sentence: what this audience actually selects. */
  ruleLabel: string
  /** How many contacts would be uploaded RIGHT NOW. Null when the rule refuses. */
  resolvedCount: number | null
  /**
   * Every consented, emailable contact in the brokerage — the DENOMINATOR
   * (CLAUDE.md §2: a count without its denominator is not a measurement). When
   * `resolvedCount === totalConsented` the audience is not a slice, whatever its
   * name says, and the surface says so in those words.
   */
  totalConsented: number | null
  /** False for `lookalike_seed`: no CRM contacts are uploaded by that rule. */
  uploadsContacts: boolean
  /** Set iff the rule was refused. The same sentence the sync would refuse with. */
  refusal: string | null
}

export async function previewAudienceResolution(
  input: PreviewAudienceResolutionInput,
): Promise<KernelAdsResult> {
  const { ctx, audienceId } = input

  if (!ctx.brokerageId || !audienceId) {
    return { success: false, error: "brokerageId and audienceId required", errorKind: "input" }
  }

  try {
    const supabase = createServiceClient()

    // TENANCY on the READ, not on a parameter (CLAUDE.md §4). The brokerage comes
    // from ctx and is applied here; an audience id belonging to another tenant is
    // simply not in the result.
    const { data: audience, error: audienceError } = await supabase
      .from("facebook_custom_audiences")
      .select("id, audience_name, source_rule")
      .eq("id", audienceId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (audienceError) throw audienceError
    if (!audience) return { success: false, error: "Audience not found", errorKind: "input" }

    const audienceName = (audience.audience_name as string) || audienceId
    const population = await resolveAudiencePopulation({
      supabase,
      brokerageId: ctx.brokerageId,
      sourceRule: audience.source_rule as SourceRule | null,
      audienceLabel: audienceName,
    })

    // THE DENOMINATOR. Counted with the same floor the population starts from, so
    // "resolved 4 of 4 consented" is a true statement about the same base set.
    // head:true → the rows are counted server-side and never travel.
    const { count: totalConsented } = await supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", ctx.brokerageId)
      .not("email", "is", null)
      .eq("tcpa_consent", true)

    if (!population.ok) {
      const resolution: AudienceResolutionPreview = {
        audienceId,
        audienceName,
        ruleType: population.narrowing.ok ? population.narrowing.ruleType : null,
        ruleLabel: population.narrowing.ok
          ? population.narrowing.label
          : `refused — ${population.narrowing.refusalKind}`,
        resolvedCount: null,
        totalConsented: totalConsented ?? null,
        uploadsContacts: population.narrowing.ok ? population.narrowing.uploadsContacts : false,
        refusal: population.error,
      }
      // success:true — the PREVIEW succeeded. It successfully determined that this
      // audience would refuse, which is exactly what an operator asked it to find
      // out. Reporting a working preview as a failed command would push the
      // surface into rendering "we could not check" over "we checked, and this
      // will not sync" — the confusion `errorKind` exists to prevent.
      return { success: true, audience: resolution }
    }

    const resolution: AudienceResolutionPreview = {
      audienceId,
      audienceName,
      ruleType: population.narrowing.ruleType,
      ruleLabel: population.narrowing.label,
      resolvedCount: population.contacts?.length ?? 0,
      totalConsented: totalConsented ?? null,
      uploadsContacts: population.narrowing.uploadsContacts,
      refusal: null,
    }
    return { success: true, audience: resolution }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "previewAudienceResolution failed",
      errorKind: "read",
    }
  }
}

// ─── COMMAND 7: createAudienceSegment ─────────────────────────────────────────
// Creates a new audience segment with source rules. Validates consent basis AND
// fair-housing segmentation.
//
// Tables read: none
// Tables written: facebook_custom_audiences
// Returns: audienceId, audience
//
// ── THE DEFINE-SIDE FAIR-HOUSING REFUSAL (finding #298) ──────────────────────
// The refusal used to sit ONLY on the populate side
// (lib/audiences/audience-sync.ts, four staging sites). That is the wrong half to
// guard alone, and the asymmetry was recorded as open in that file's header and
// in lib/kernel/manager-registry.ts (compliance_scope_boundary) — both of which
// now record the closure instead. Three concrete costs it carried:
//   · the refusal was discoverable only at populate time, so an operator got a
//     saved audience that later came back empty — an audience that silently
//     fails to fill is its own defect;
//   · the offending definition PERSISTED in facebook_custom_audiences.source_rule,
//     which is the record a Meta-side or manual sync reads;
//   · a SECOND populate path existed and was ungated — syncAudience, right above
//     this, reads source_rule and uploads the resulting contact list to
//     Meta/Google. It is gated now too.
//
// ── SCOPE: WHAT THIS GATE DOES NOT TOUCH (owner ruling, wave 15) ─────────────
// Verbatim: "do not run the compliance or fair housing on scrapping, enrichment,
// scoring, sourcing because we determine the kind of education in channels by the
// age group". This gate reads ONE input — `sourceRule`, the ad-audience
// segmentation rule — and it is reached only from the two ad-audience commands in
// this file. Lead scraping, enrichment, signal scoring, sourcing and buyer
// property search never call it and never can: they do not build a SourceRule.
// The classifier itself stays a CLASSIFIER for those lanes (it labels, it does
// not refuse); only the ads path calls the asserting arm.

export async function createAudienceSegment(input: CreateAudienceSegmentInput): Promise<KernelAdsResult> {
  const { ctx, audienceName, audienceType, sourceRule, consentBasis, adCampaignId } = input

  if (!ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "brokerageId and userId required" }
  }

  if (!consentBasis || !consentBasis.trim()) {
    return { success: false, error: "Consent basis required for legal compliance (GDPR/CCPA)" }
  }

  // FAIR HOUSING — refuse BEFORE the row exists. Deliberately outside the try
  // below so the refusal cannot be relabelled as an insert failure.
  //
  // FAILS CLOSED (CLAUDE.md §4): the catch takes ANY throw out of the assertion,
  // not only the refusal it raises itself. A classifier that cannot walk this
  // rule — a shape nobody anticipated, a getter that throws — refuses too.
  // "Nobody checked" must never render as "checked and fine".
  //
  // LEGIBLE: the thrown message names the audience and the exact offending
  // attributes, and it is returned as `error`, which every caller already
  // surfaces (lib/ads/facebook-audience-sync.ts:92-94 →
  // app/dashboard/campaigns/ads/ads-dashboard-client.tsx:614 `toast.error`). The
  // operator is told which attribute to remove, not merely that something failed.
  const segmentationRefusal = ((): string | null => {
    try {
      assertAudienceSegmentationAllowed(sourceRule, audienceName || "(unnamed audience)")
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })()
  if (segmentationRefusal) {
    // errorKind "input" — this is a refusal of what was SENT, not an entitlement
    // problem and not a read failure. The three are different states and the
    // surface renders them differently (see KernelAdsResult.errorKind).
    return { success: false, error: segmentationRefusal, errorKind: "input" }
  }

  // THE PERSONA BASIS — the DEFINE side (owner ruling: "audience should be
  // segmented on persona"). Same fail-closed shape as the refusal above and in the
  // same place, for the reason finding #298 established: refusing only at populate
  // time leaves the offending definition PERSISTED in `source_rule`, which is the
  // row a Meta-side or manual sync reads, and the operator discovers it as an
  // audience that mysteriously comes back empty.
  //
  // Runs AFTER the protected-class assertion deliberately. When an operator names
  // `personas: ["senior"]` both would refuse, and the protected-class message is
  // the one that should be quoted first: it is the statutory refusal, and this
  // module must never be able to become the place that answer gets softened.
  const personaBasisRefusal = ((): string | null => {
    try {
      assertAudiencePersonaBasis(sourceRule, audienceName || "(unnamed audience)")
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })()
  if (personaBasisRefusal) {
    return { success: false, error: personaBasisRefusal, errorKind: "input" }
  }

  // THE SOURCE RULE MUST RESOLVE — refused at DEFINE time for the reason finding
  // #298 established, now for the third rule in this file. Refusing only at
  // populate time leaves the unresolvable definition PERSISTED in `source_rule`,
  // which is the row a Meta-side or manual sync reads, and the operator meets it
  // as an audience that mysteriously errors months later.
  //
  // This is a PURE shape check — `resolveSourceRuleNarrowing` touches no database
  // — so it can run before the insert without a read. FAILS CLOSED: any throw out
  // of the resolver is a refusal, like the two gates above it.
  const sourceRuleRefusal = ((): string | null => {
    try {
      const narrowing = resolveSourceRuleNarrowing(sourceRule)
      return narrowing.ok
        ? null
        : `[audience-source-rule] REFUSED: audience "${audienceName || "(unnamed audience)"}" ${narrowing.refusal}`
    } catch (err) {
      return `[audience-source-rule] REFUSED (unevaluable): ${err instanceof Error ? err.message : String(err)}`
    }
  })()
  if (sourceRuleRefusal) {
    return { success: false, error: sourceRuleRefusal, errorKind: "input" }
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

// ─── COMMAND 8: previewAdCreative — MERGED-THEN-DELETED (orphan burn-down lane C)
//
// SURVIVOR: lib/kernel/ads.ts:261 (loadAdsWorkspace) — the ONE read behind the ads
// dashboard (app/dashboard/campaigns/ads/page.tsx:146). It already nests
// `ad_creative_variations (*)` under every campaign for the caller's brokerage, so
// the surface holds each campaign's variations before anything is clicked; this
// command re-fetched, per campaign, rows the page had already loaded.
//
// MERGED FIRST, then deleted. The one capability this had that the workspace read
// lacked was the deterministic `.order("created_at", { ascending: true })` on the
// variations — the ordering that w2s2 moved here from
// lib/ads/ad-creator.ts:getCampaignCreatives and recorded as the precondition for
// deleting that one. It is NOT dropped: loadAdsWorkspace now orders the nested
// embed with `referencedTable: "ad_creative_variations"`, so generation order
// survives on the read the dashboard actually performs. The w2s2 precondition is
// still met.
//
// Its other axis — refusing a campaign id that is not the caller's before returning
// creatives — is structural in the survivor: the workspace only ever selects rows
// under `.eq("brokerage_id", ctx.brokerageId)`, so a foreign campaign id is not in
// the result to begin with. There is no id to probe with.

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
