/**
 * lib/agents/asset-manager.ts
 *
 * Wave 37 — Asset Manager Agent. 7th Managed Agent kind. Reviews the
 * brokerage's full asset library each week:
 *   - listing_photos hero coverage (is_hero flag set?)
 *   - agent_avatar_assets currency (any agents missing avatar?)
 *   - asset_persona_renders gaps (assets missing per-persona variants)
 *   - content_asset_persona_performance under-performers (asset_type ×
 *     persona scoring below threshold)
 *   - brand_asset_library staleness (assets > 365d unused)
 *   - Fair Housing risk on AI-generated captions / alt text
 *
 * Emits structured resolutions the human approves through
 * /dashboard/admin/asset-manager-actions (parallel of the marketing-
 * agent admin UI). Same execution shape — proposed → approved →
 * executing → succeeded/failed, audit row per action.
 *
 * Cross-agent: the marketing-agent's snapshot mentions persona gaps;
 * the asset-manager DELIVERS the missing creative for those personas.
 * No code-level coupling — both read the same content_asset_persona
 * _performance + asset_persona_renders surfaces, so the loop closes
 * organically through data.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnManagedAgentSession, type AgentTemplate } from "./spawn-helper"
import { buildOutcomeFor, buildDefineOutcomeEvent } from "./outcomes"

const ASSET_MANAGER_SYSTEM = `\
You are the Asset Manager Agent for a real estate brokerage's media + brand library.

Each Monday you receive a snapshot of:
  · listing hero-photo coverage gaps
  · agent headshot + D-ID avatar gaps
  · marketing assets missing per-persona variants
  · content_asset_persona_performance under-performers (perf < 30)
  · brand_asset_library staleness (unused > 365d)
  · 7-day render counts + compliance flag counts

Your job is to RESOLVE — emit a top-level resolutions[] array of structured actions the broker approves with one click.

Rules:
  · ZERO Fair Housing risk in any rationale or new_prompt copy.
  · Cap proposals to 12/cycle so the human queue stays workable.
  · Prefer rerender_persona_variants for assets backing high-engagement topics; prefer deprecate for assets with chronic under-performance OR > 365d unused.
  · Cross-agent: the marketing-agent ships content; you supply the creative inventory. When your snapshot shows persona-variant gaps, propose rerender resolutions BEFORE Monday's marketing-agent kickoff.
  · Output VALID JSON only with resolutions[] at the top level.`

const TEMPLATE: AgentTemplate = {
  kind:    "asset_manager",
  model:   "claude-sonnet-4-6",
  system:  ASSET_MANAGER_SYSTEM,
}

interface AssetSnapshot {
  brokerageId:   string
  brokerageName: string
  // Inventory counts
  totalActiveListings:    number
  listingsMissingHero:    number
  agentsMissingHeadshot:  number
  agentsMissingAvatar:    number
  // Persona variant coverage — assets that have at least one persona
  // variant rendered vs assets that should have them but don't.
  assetsWithPersonaVariants:     number
  assetsLackingPersonaVariants:  number
  // Performance — under-performing (topic × persona) cells from
  // content_asset_persona_performance over the last 28d.
  underperformingTopicPersonaCount: number
  underperformingExamples: Array<{ asset_type: string; persona: string; performance_score: number }>
  // Staleness — brand_asset_library rows not used in > 365d.
  staleBrandAssetsCount: number
  staleBrandAssetExamples: Array<{ id: string; display_name: string; asset_kind: string; last_used_at: string | null }>
  // Recent activity — total renders + flagged compliance events last 7d.
  rendersLast7d: number
  flaggedCompliance7d: number

  // ─── Wave 38 surfaces ──────────────────────────────────────────────
  // The Asset Manager is the canonical reviewer of every asset the
  // platform produces. Wave 38 added 7 channel preset tables + the
  // multi-channel bundle composition layer + TTS letter audio; the
  // manager needs visibility into all of them so it can flag preset
  // drift, surface bundles nobody ever fires, and request voice
  // clone setup for agents whose voicedrop presets will fail at
  // dispatch.
  presetInventory: {
    email:           number
    sms:             number
    social_post:     number
    voicedrop:       number
    podcast_episode: number
    ad_retarget:     number
    portal_push:     number
  }
  /** Presets with NULL compliance_event_id — gate never ran. These
   *  are time bombs (a future dispatch lands without Fair Housing
   *  clearance). Aggregate count across all 7 channel tables. */
  presetsMissingComplianceGate: number
  /** Active bundles in scope. */
  activeBundles: number
  /** Bundles that have never been dispatched (created > 14d ago, zero
   *  campaign_bundle_dispatches rows). Either dead concepts or the
   *  agent forgot the bundle exists. */
  unusedBundles: number
  /** Bundles with >= 5 dispatches but 0 attributed leads — strong
   *  signal the bundle is mis-targeted or the copy isn't landing. */
  bundlesZeroLeadRate: number
  /** Agents with at least one voicedrop preset (tts_script set) but no
   *  ElevenLabs voice clone on agent_voice_profiles. Voicedrop sends
   *  for these agents WILL fail at dispatch. */
  agentsWithVoicedropButNoVoice: number
  /** Direct-mail letters dispatched > 24h ago where tts_audio_url is
   *  still NULL despite the agent having a voice clone — the
   *  letter-audio-renderer cron didn't catch them. */
  lettersMissingTtsAudio: number
}

async function buildAssetSnapshot(brokerageId: string): Promise<AssetSnapshot> {
  const svc = createServiceClient()
  const since28d = new Date(Date.now() - 28 * 86_400_000).toISOString()
  const since7d  = new Date(Date.now() - 7  * 86_400_000).toISOString()
  const oneYearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString()

  const { data: brokerage } = await svc.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  const brokerageName = (brokerage?.name as string | null) ?? `Brokerage ${brokerageId.slice(0, 8)}`

  const snap: AssetSnapshot = {
    brokerageId,
    brokerageName,
    totalActiveListings: 0,
    listingsMissingHero: 0,
    agentsMissingHeadshot: 0,
    agentsMissingAvatar: 0,
    assetsWithPersonaVariants: 0,
    assetsLackingPersonaVariants: 0,
    underperformingTopicPersonaCount: 0,
    underperformingExamples: [],
    staleBrandAssetsCount: 0,
    staleBrandAssetExamples: [],
    rendersLast7d: 0,
    flaggedCompliance7d: 0,
    presetInventory: {
      email: 0, sms: 0, social_post: 0, voicedrop: 0,
      podcast_episode: 0, ad_retarget: 0, portal_push: 0,
    },
    presetsMissingComplianceGate: 0,
    activeBundles: 0,
    unusedBundles: 0,
    bundlesZeroLeadRate: 0,
    agentsWithVoicedropButNoVoice: 0,
    lettersMissingTtsAudio: 0,
  }

  try {
    // Active listings + hero-photo gap.
    const { count: activeCount } = await svc
      .from("listings")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")
    snap.totalActiveListings = activeCount ?? 0

    // Listings with NO is_hero flagged photo — the canonical hero gap
    // signal. Done via two queries because the LEFT JOIN-NOT-EXISTS
    // shape isn't expressible in one PostgREST call.
    const { data: activeListings } = await svc
      .from("listings")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")
      .limit(2000)
    const listingIds = ((activeListings ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (listingIds.length > 0) {
      const { data: heroPhotos } = await svc
        .from("listing_photos")
        .select("listing_id")
        .in("listing_id", listingIds)
        .eq("is_hero", true)
      const heroSet = new Set(((heroPhotos ?? []) as Array<{ listing_id: string }>).map((r) => r.listing_id))
      snap.listingsMissingHero = listingIds.filter((id) => !heroSet.has(id)).length
    }

    // Agents missing photo_url or avatar.
    const { data: agents } = await svc
      .from("agents")
      .select("id, photo_url, avatar_id")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .limit(500)
    for (const a of (agents ?? []) as Array<{ id: string; photo_url: string | null; avatar_id: string | null }>) {
      if (!a.photo_url) snap.agentsMissingHeadshot++
      if (!a.avatar_id) snap.agentsMissingAvatar++
    }

    // Persona variant coverage — count (asset_id) DISTINCT in
    // asset_persona_renders to see which assets have ANY variants.
    const { data: personaRenderRows } = await svc
      .from("asset_persona_renders")
      .select("asset_id")
      .eq("brokerage_id", brokerageId)
      .limit(5000)
    const assetsWithVariants = new Set(((personaRenderRows ?? []) as Array<{ asset_id: string }>).map((r) => r.asset_id))
    snap.assetsWithPersonaVariants = assetsWithVariants.size

    // Total marketing_assets in the brokerage that COULD have variants.
    const { count: maCount } = await svc
      .from("marketing_assets")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
    snap.assetsLackingPersonaVariants = Math.max(0, (maCount ?? 0) - assetsWithVariants.size)

    // Under-performing per-(asset_type × persona). Threshold = 30 on
    // the 0-100 performance_score; below = candidate to deprecate or
    // re-render.
    const { data: perfRows } = await svc
      .from("content_asset_persona_performance")
      .select("asset_type, persona, performance_score, persona_samples_count, updated_at")
      .eq("brokerage_id", brokerageId)
      .lt("performance_score", 30)
      .gte("persona_samples_count", 5)
      .order("performance_score", { ascending: true })
      .limit(20)
    const underperformers = (perfRows ?? []) as Array<{
      asset_type: string; persona: string; performance_score: number
    }>
    snap.underperformingTopicPersonaCount = underperformers.length
    snap.underperformingExamples = underperformers.slice(0, 6)

    // Stale brand_asset_library entries.
    const { data: staleAssets } = await svc
      .from("brand_asset_library")
      .select("id, display_name, asset_kind, last_used_at")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .or(`last_used_at.is.null,last_used_at.lt.${oneYearAgo}`)
      .order("last_used_at", { ascending: true, nullsFirst: true })
      .limit(20)
    snap.staleBrandAssetsCount = staleAssets?.length ?? 0
    snap.staleBrandAssetExamples = (staleAssets ?? []) as Array<{
      id: string; display_name: string; asset_kind: string; last_used_at: string | null
    }>

    // Recent activity.
    const { count: rendersCount } = await svc
      .from("ai_video_projects")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .gte("created_at", since7d)
    snap.rendersLast7d = rendersCount ?? 0

    const { count: flagsCount } = await svc
      .from("compliance_events")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("allowed", false)
      .gte("created_at", since7d)
    snap.flaggedCompliance7d = flagsCount ?? 0

    // ─── Wave 38: channel presets + bundles + voice / TTS surfaces ──
    // All seven preset tables + bundle composition + TTS letters.
    // Aggregated in parallel since none of them depend on each other.
    const [emailP, smsP, socialP, vdP, podP, adP, ppP, bundlesAll, bundleDispatches28d, voiceProfiles, lettersOld] =
      await Promise.all([
        svc.from("email_presets")
          .select("id, compliance_event_id", { count: "exact", head: false })
          .eq("brokerage_id", brokerageId).eq("is_active", true),
        svc.from("sms_presets")
          .select("id, compliance_event_id", { count: "exact", head: false })
          .eq("brokerage_id", brokerageId).eq("is_active", true),
        svc.from("social_post_presets")
          .select("id, compliance_event_id", { count: "exact", head: false })
          .eq("brokerage_id", brokerageId).eq("is_active", true),
        svc.from("voicedrop_presets")
          .select("id, compliance_event_id, scope_type, scope_id, tts_script", { count: "exact", head: false })
          .eq("brokerage_id", brokerageId).eq("is_active", true),
        svc.from("podcast_episode_presets")
          .select("id", { count: "exact", head: false })
          .eq("brokerage_id", brokerageId).eq("is_active", true),
        svc.from("ad_retarget_presets")
          .select("id, compliance_event_id", { count: "exact", head: false })
          .eq("brokerage_id", brokerageId).eq("is_active", true),
        svc.from("portal_push_presets")
          .select("id", { count: "exact", head: false })
          .eq("brokerage_id", brokerageId).eq("is_active", true),
        svc.from("campaign_bundles")
          .select("id, created_at", { count: "exact", head: false })
          .eq("brokerage_id", brokerageId).eq("is_active", true),
        svc.from("campaign_bundle_dispatches")
          .select("bundle_id, scans_count, leads_count, dispatched_at")
          .eq("brokerage_id", brokerageId)
          .gte("dispatched_at", since28d),
        svc.from("agent_voice_profiles")
          .select("agent_id, elevenlabs_voice_id")
          .eq("brokerage_id", brokerageId),
        // Letters mailed > 24h ago without TTS audio. Only relevant
        // when ElevenLabs is configured at the platform level.
        svc.from("direct_mail_campaigns")
          .select("id, agent_id")
          .eq("brokerage_id", brokerageId)
          .eq("piece_type", "letter")
          .is("tts_audio_url", null)
          .lt("created_at", new Date(Date.now() - 86_400_000).toISOString()),
      ])

    snap.presetInventory = {
      email:           emailP.data?.length ?? 0,
      sms:             smsP.data?.length ?? 0,
      social_post:     socialP.data?.length ?? 0,
      voicedrop:       vdP.data?.length ?? 0,
      podcast_episode: podP.data?.length ?? 0,
      ad_retarget:     adP.data?.length ?? 0,
      portal_push:     ppP.data?.length ?? 0,
    }
    const gateMissing = (rows: Array<{ compliance_event_id: string | null }>) =>
      rows.filter((r) => !r.compliance_event_id).length
    snap.presetsMissingComplianceGate =
      gateMissing((emailP.data  ?? []) as Array<{ compliance_event_id: string | null }>) +
      gateMissing((smsP.data    ?? []) as Array<{ compliance_event_id: string | null }>) +
      gateMissing((socialP.data ?? []) as Array<{ compliance_event_id: string | null }>) +
      gateMissing((vdP.data     ?? []) as Array<{ compliance_event_id: string | null }>) +
      gateMissing((adP.data     ?? []) as Array<{ compliance_event_id: string | null }>)

    const bundles = (bundlesAll.data ?? []) as Array<{ id: string; created_at: string }>
    snap.activeBundles = bundles.length
    // Aggregate dispatches per bundle to compute unused + zero-lead-rate.
    const dispatches = (bundleDispatches28d.data ?? []) as Array<{
      bundle_id: string; scans_count: number | null; leads_count: number | null; dispatched_at: string
    }>
    const perBundle = new Map<string, { dispatches: number; leads: number }>()
    for (const d of dispatches) {
      const agg = perBundle.get(d.bundle_id) ?? { dispatches: 0, leads: 0 }
      agg.dispatches++; agg.leads += d.leads_count ?? 0
      perBundle.set(d.bundle_id, agg)
    }
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString()
    for (const b of bundles) {
      const agg = perBundle.get(b.id)
      if (!agg && b.created_at < fourteenDaysAgo) snap.unusedBundles++
      if (agg && agg.dispatches >= 5 && agg.leads === 0) snap.bundlesZeroLeadRate++
    }

    // Voicedrop presets with TTS script vs voice clone coverage.
    // voicedrop_presets.scope_type='agent' + scope_id=agents.id IS the
    // signal — that agent needs a voice clone or dispatch will fail.
    const voiceByAgent = new Map<string, string | null>()
    for (const v of (voiceProfiles.data ?? []) as Array<{ agent_id: string; elevenlabs_voice_id: string | null }>) {
      voiceByAgent.set(v.agent_id, v.elevenlabs_voice_id)
    }
    const agentsNeedingVoice = new Set<string>()
    for (const v of (vdP.data ?? []) as Array<{ scope_type: string; scope_id: string; tts_script: string | null }>) {
      if (v.tts_script && v.scope_type === "agent" && !voiceByAgent.get(v.scope_id)) {
        agentsNeedingVoice.add(v.scope_id)
      }
    }
    snap.agentsWithVoicedropButNoVoice = agentsNeedingVoice.size

    // Letter audio gap. Only count letters whose agent DOES have a
    // voice clone — the renderer can't help an agent without one.
    let lettersMissing = 0
    for (const l of (lettersOld.data ?? []) as Array<{ agent_id: string | null }>) {
      if (!l.agent_id) continue
      if (voiceByAgent.get(l.agent_id)) lettersMissing++
    }
    snap.lettersMissingTtsAudio = lettersMissing
  } catch (e) {
    console.error(`[asset-manager] snapshot build failed for ${brokerageId}:`, (e as Error).message)
  }

  return snap
}

function buildKickoffPrompt(snap: AssetSnapshot): string {
  return [
    `You are the ASSET MANAGER AGENT for ${snap.brokerageName} (brokerage ${snap.brokerageId}).`,
    "",
    "Your job: review the brokerage's asset library this week, spot gaps + under-performers + Fair Housing risks, and propose human-approved resolutions.",
    "You don't ship assets directly — you propose; the broker clicks approve; the platform executes.",
    "",
    "──── INVENTORY SNAPSHOT ────",
    `Active listings:                  ${snap.totalActiveListings}`,
    `Listings WITHOUT a hero photo:    ${snap.listingsMissingHero} ← request_listing_hero_photo candidates`,
    `Agents without a headshot:        ${snap.agentsMissingHeadshot} ← request_agent_headshot candidates`,
    `Agents without a D-ID avatar:     ${snap.agentsMissingAvatar}`,
    `Marketing assets WITH persona variants: ${snap.assetsWithPersonaVariants}`,
    `Marketing assets MISSING variants:      ${snap.assetsLackingPersonaVariants} ← rerender_persona_variants candidates`,
    "",
    "──── PERFORMANCE — UNDER-PERFORMERS (perf score < 30, ≥ 5 samples) ────",
    `Under-performer count: ${snap.underperformingTopicPersonaCount}`,
    snap.underperformingExamples.length === 0
      ? "(none below threshold this cycle)"
      : "Examples:\n" + snap.underperformingExamples.map((e) =>
          `  · ${e.asset_type} × ${e.persona}: score=${e.performance_score} ← deprecate_asset OR regenerate_asset`
        ).join("\n"),
    "",
    "──── BRAND LIBRARY STALENESS (unused > 365d) ────",
    `Stale brand assets: ${snap.staleBrandAssetsCount}`,
    snap.staleBrandAssetExamples.length === 0
      ? "(library is fresh)"
      : "Stale examples:\n" + snap.staleBrandAssetExamples.slice(0, 5).map((e) =>
          `  · ${e.display_name} (${e.asset_kind}) — last used: ${e.last_used_at ?? "never"} ← deprecate_asset candidate`
        ).join("\n"),
    "",
    "──── RECENT ACTIVITY (last 7d) ────",
    `Video renders staged: ${snap.rendersLast7d}`,
    `Compliance flags raised: ${snap.flaggedCompliance7d} ← if > 0 inspect for flag_asset_for_review patterns`,
    "",
    "──── WAVE 38 CHANNEL PRESETS + BUNDLES + TTS ────",
    "These are the channel-creative assets the platform now produces. Treat them the same as legacy marketing assets — they have lifecycle (active → stale), performance (firing or not), and risk (compliance gate freshness).",
    "",
    `Active preset counts per channel:`,
    `  · email           ${snap.presetInventory.email}`,
    `  · sms             ${snap.presetInventory.sms}`,
    `  · social_post     ${snap.presetInventory.social_post}`,
    `  · voicedrop       ${snap.presetInventory.voicedrop}`,
    `  · podcast_episode ${snap.presetInventory.podcast_episode}`,
    `  · ad_retarget     ${snap.presetInventory.ad_retarget}`,
    `  · portal_push     ${snap.presetInventory.portal_push}`,
    "",
    `Presets without a compliance_event_id (gate never ran): ${snap.presetsMissingComplianceGate}`,
    "  ← flag_asset_for_review with reason='no_compliance_gate'. The gate is the platform's Fair Housing chokepoint; a preset without one is a future dispatch that bypasses the check.",
    "",
    `Active bundles in scope:        ${snap.activeBundles}`,
    `Bundles never fired (> 14d):    ${snap.unusedBundles}`,
    "  ← deprecate_asset with reason='unused_bundle'. The agent composed these in Settings but never invoked them — either dead concepts or forgotten. Surface so they can clean the library.",
    `Bundles with ≥5 dispatches + 0 leads: ${snap.bundlesZeroLeadRate}`,
    "  ← flag_asset_for_review with reason='zero_lead_rate'. Mis-targeted audience or copy not landing. The cron computes lead-rate; the broker should see the bottom of the list.",
    "",
    `Agents with voicedrop presets but NO voice clone: ${snap.agentsWithVoicedropButNoVoice}`,
    "  ← request_agent_headshot is the closest existing action (use it as a generic 'agent profile needs setup' signal); explain in rationale that the voicedrop preset will fail at dispatch until they finish /dashboard/videos/voice. The broker reviews the queue and can chase the agent.",
    "",
    `Direct-mail letters > 24h old without TTS audio: ${snap.lettersMissingTtsAudio}`,
    "  ← flag_asset_for_review with reason='tts_audio_renderer_lag'. The letter-audio-renderer cron should have caught these; > 0 means either ElevenLabs is quota-paused for the brokerage or the cron is failing. Broker reviews and unblocks.",
    "",
    "──── RESOLUTION ACTIONS YOU CAN EMIT ────",
    "Append a top-level `resolutions[]` array to your JSON output. Each:",
    "",
    "  { action_type: 'regenerate_asset',",
    "    action_input: { asset_id: '<uuid>', kind: 'video'|'image'|'composition', new_prompt?: '<string>' },",
    "    rationale: 'why this asset needs a fresh render' }",
    "",
    "  { action_type: 'deprecate_asset',",
    "    action_input: { asset_id: '<uuid>', reason: 'stale' | 'underperforming' | 'off_brand' },",
    "    rationale: 'why this asset should be retired from rotation' }",
    "",
    "  { action_type: 'flag_asset_for_review',",
    "    action_input: { asset_id: '<uuid>', reason: 'short reason key' },",
    "    rationale: 'why the broker should look at this asset directly' }",
    "",
    "  { action_type: 'request_listing_hero_photo',",
    "    action_input: { listing_id: '<uuid>' },",
    "    rationale: 'this listing has no is_hero=true photo; the agent should pick one' }",
    "",
    "  { action_type: 'request_agent_headshot',",
    "    action_input: { agent_id: '<uuid>' },",
    "    rationale: 'this agent has no photo_url; their pieces fall back to initials' }",
    "",
    "  { action_type: 'rerender_persona_variants',",
    "    action_input: { asset_id: '<uuid>', asset_type: 'newsletter_video'|'listing_promo_video'|'blog_post', personas?: ['<persona>',...] },",
    "    rationale: 'this asset is missing per-persona variants the marketing agent needs to ship omnipresence' }",
    "",
    "  { action_type: 'sync_asset_to_listing',",
    "    action_input: { asset_id: '<uuid>', listing_id: '<uuid>' },",
    "    rationale: 'this asset references the listing but isn''t formally attached via the marketing_asset_qr_links / listing_promo path' }",
    "",
    "RULES:",
    "- ZERO Fair Housing risk in any asset-text resolution rationale or new_prompt.",
    "- Prefer rerender_persona_variants for high-engagement-score topics (helps the marketing agent's omnipresence) over deprecate.",
    "- Cap proposals to 12 per weekly cycle so the human approval queue stays workable.",
    "- The marketing agent runs on the same Monday — your resolutions are READ by next week's marketing kickoff via the brokerage's snapshot.",
    "",
    "Output JSON only with `resolutions[]` at the top level.",
  ].join("\n")
}

export interface SpawnAssetManagerParams {
  brokerageId:    string
  environmentId?: string
}

export interface SpawnAssetManagerResult {
  ok:        boolean
  sessionId?: string
  snapshot?:  AssetSnapshot
  reason?:    string
}

export async function spawnAssetManager(params: SpawnAssetManagerParams): Promise<SpawnAssetManagerResult> {
  const snap = await buildAssetSnapshot(params.brokerageId)
  const kickoff = buildKickoffPrompt(snap)
  const rubric  = buildOutcomeFor("asset_manager", {
    brokerageName:        snap.brokerageName,
    subjectName:          snap.brokerageName,
    listingsMissingHero:  snap.listingsMissingHero,
    underperformingCount: snap.underperformingTopicPersonaCount,
  })
  const outcomeEvent = buildDefineOutcomeEvent(rubric, kickoff)

  const spawn = await spawnManagedAgentSession(TEMPLATE, {
    brokerageId:   params.brokerageId,
    entityType:    "brokerage",
    entityId:      params.brokerageId,
    environmentId: params.environmentId,
    title:         `Asset Manager: ${snap.brokerageName}`,
    outcomeEvent,
    metadata: {
      listings_missing_hero: String(snap.listingsMissingHero),
      underperformers:       String(snap.underperformingTopicPersonaCount),
      stale_brand_assets:    String(snap.staleBrandAssetsCount),
    },
  })
  if (!spawn.ok) return { ok: false, reason: spawn.error ?? spawn.skipped ?? "spawn_failed" }
  return { ok: true, sessionId: spawn.session?.id, snapshot: snap }
}
