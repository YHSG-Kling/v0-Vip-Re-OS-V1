"use server"

// lib/repurpose/actions.ts
// Server actions for Layer 9.11 Omnipresence Repurposer Pipeline
// All async functions with full kernel wiring

import { bestEffort } from "@/lib/db/best-effort"
import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { evaluateKernelOutbound, isComplianceBlocked } from "@/lib/kernel/adapters/compliance"
import { applyKernelBrandVoice, isBrandVoiceBlocked } from "@/lib/kernel/adapters/brand-voice"
import { incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { mayUseFeature } from "@/lib/billing/billing-access"
import { decideClaimedTenant } from "@/lib/platform/acting-context"
import { generateAIResponse } from "@/lib/ai"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { scheduleSocialPost, getConnectedAccounts } from "@/app/actions/social-media-automation"
import { createVideoProject } from "@/app/actions/video/create-video-project"
import { generateBlogPost } from "@/app/actions/blog"
import { createPodcastEpisode, generatePodcastAudio } from "@/app/actions/podcast-generation"
import { transcribeFromUrl } from "@/lib/repurpose/transcribe"
import { DISTRIBUTABLE_PLATFORMS, extractHashtags, assessRefurbishSource } from "@/lib/repurpose/shared"
import { buildRefurbishIdeaBrief, labelCompetitorEvidence, carriesSourceMedia, refurbishPublicationVerdict, refurbishRetestDecision, refurbishTriggerVerdict, type LocalFact, type RefurbishIdeaBrief } from "@/lib/repurpose/refurbish-idea"
import { draftRefurbishOutput, abstractIdeaFromUntrusted, refurbishExcludeDefault, loadRefurbishVoiceFor } from "@/lib/repurpose/refurbish-run"
import type {
  SourceType,
  OutputFormat,
  PipelineConfig,
  RepurposedOutput,
  ExecutePipelineResult,
  SavePipelineResult
} from "@/lib/repurpose/types"
import { OUTPUT_FORMAT_CONFIG } from "@/lib/repurpose/types"

interface AgentBranding {
  agentName: string
  brokerageName: string
  publicSlug: string | null
}

async function loadAgentBranding(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  brokerageId: string,
): Promise<AgentBranding> {
  const [{ data: user }, { data: brokerage }, { data: agent }] = await Promise.all([
    supabase.from("users").select("first_name, last_name").eq("id", userId).maybeSingle(),
    supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle(),
    supabase.from("agents").select("public_slug").eq("user_id", userId).eq("brokerage_id", brokerageId).maybeSingle(),
  ])
  const agentName = `${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim() || "your agent"
  return { agentName, brokerageName: brokerage?.name ?? "", publicSlug: agent?.public_slug ?? null }
}

/**
 * Load the content the user actually picked on the Execute tab.
 *
 * WHY THIS EXISTS. The dashboard requires a source selection — the Execute
 * button is disabled without one, and the run summary shows its title — and then
 * never sent it to the server. executePipeline fell back to
 * pipeline.output_config.sourceId, which the Create-Pipeline dialog stores as ""
 * because that dialog collects a source TYPE and has no item picker. So every
 * run built its prompt from the phrase "this podcast episode" and nothing else:
 * the model was asked to repurpose a piece of content it had never been shown.
 * The outputs then went out through scheduleSocialPost to real connected
 * accounts, and the log recorded the PIPELINE id as source_id, so history could
 * not say what had been repurposed either.
 *
 * Every table and column below is confirmed against the live schema; these are
 * the same four source tables the Execute tab lists.
 */
async function loadRepurposeSource(
  supabase: Awaited<ReturnType<typeof createClient>>,
  brokerageId: string,
  sourceType: SourceType,
  sourceId: string,
): Promise<{ title: string | null; mediaUrl: string | null; body: string | null } | null> {
  const one = (table: string, cols: string) =>
    supabase.from(table).select(cols).eq("id", sourceId).eq("brokerage_id", brokerageId).maybeSingle()

  if (sourceType === "video_project") {
    const { data } = await one("ai_video_projects", "title, video_url, script_content")
    const r = data as any
    return r ? { title: r.title, mediaUrl: r.video_url, body: r.script_content } : null
  }
  if (sourceType === "podcast_episode") {
    const { data } = await one("podcast_episodes", "title, audio_url, script, description")
    const r = data as any
    return r ? { title: r.title, mediaUrl: r.audio_url, body: r.script ?? r.description } : null
  }
  if (sourceType === "blog_post") {
    const { data } = await one("blog_posts", "title, content, excerpt")
    const r = data as any
    return r ? { title: r.title, mediaUrl: null, body: r.content ?? r.excerpt } : null
  }
  if (sourceType === "script") {
    const { data } = await one("video_scripts_library", "title, script_content")
    const r = data as any
    return r ? { title: r.title, mediaUrl: null, body: r.script_content } : null
  }
  // newsletter / social_post / video_url have no picker on the Execute tab.
  return null
}

// ── WAVE 154 (lane 154D — directive D4 "BRAND VOICE FROM SETTINGS on the FIRST draft") ─────────────────────────────────
// Every repurpose / refurbish prompt used to carry only the agent's NAME (loadAgentBranding) and asked for "a warm,
// professional brand voice" — generic prose the user then had to rewrite. The ONE voice system is loadSenderVoiceBrief
// (lib/kernel/brand-voice.ts): tagline, approved phrases, tone, signature rule, their own approved sentences. It now leads
// every first draft here, and the reader's half is the them-first brief (lib/marketing/them-first-draft-brief.ts). Dynamic
// imports keep both off this server-action module's static graph.
async function loadRefurbishVoice(
  supabase: Awaited<ReturnType<typeof createClient>>,
  brokerageId: string,
  userId: string,
  audiencePersona: string | null = null,
): Promise<{ voiceBriefText: string; voiceVersion: string; themFirstText: string }> {
  // TOMBSTONE (wave 154, lane 154H2 — §1 one canonical path): the body moved to lib/repurpose/refurbish-run.ts loadRefurbishVoiceFor
  // so the sessionless topic creative step loads the SAME voice; this session wrapper only hands it the cookie client.
  return loadRefurbishVoiceFor(supabase, brokerageId, userId, audiencePersona)
}

/** The competitor post behind an idea-only refurbish, re-read under the SESSION tenant (a forged id reads nothing). */
async function loadCompetitorInspiration(
  supabase: Awaited<ReturnType<typeof createClient>>,
  brokerageId: string,
  competitorContentId: string,
): Promise<{ row: Record<string, any>; error: null } | { row: null; error: string }> {
  if (!isValidUUID(competitorContentId)) return { row: null, error: "That competitor post id is not valid." }
  const { data, error } = await supabase
    .from("competitor_content")
    .select("id, platform, content_type, caption, content_url, media_url, detected_topics, hook_type, likes_count, comments_count, shares_count, views_count, engagement_rate, raw_engagement_data, is_high_performing, competitor_id")
    .eq("id", competitorContentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (error) return { row: null, error: `The competitor post could not be read (${error.message}).` }
  if (!data) return { row: null, error: "That competitor post was not found in your brokerage." }
  return { row: data as Record<string, any>, error: null }
}

/**
 * The seven-question idea brief for one competitor post (D7), rebuilt at EXECUTION from the tenant-pinned row — never
 * trusted from a stored or client-supplied copy, so the exclusion gate (R9) cannot be bypassed by a forged brief.
 */
async function buildCompetitorIdeaBrief(
  supabase: Awaited<ReturnType<typeof createClient>>,
  brokerageId: string,
  row: Record<string, any>,
  opts: { audienceLabel: string | null; localFacts: LocalFact[]; formats: string[]; geoLabel: string | null },
): Promise<ReturnType<typeof buildRefurbishIdeaBrief>> {
  // D5: a competitor-watch signal starts a refurbish only for a competitor on THIS tenant's watchlist (the scan files every
  // watched competitor under a competitor_profiles twin; a row with no profile was not produced by an authorized watch).
  const trigger = refurbishTriggerVerdict({ kind: "competitor_watch", authorized: typeof row.competitor_id === "string" && row.competitor_id.length > 0 })
  if (!trigger.start) return { ok: false, refusal: "excluded", reason: "unauthorized_trigger", userMessage: `This post is not from a competitor on your watchlist (${trigger.reason}) — add the competitor to your watchlist first.` }
  const { data: own, error: ownErr } = await supabase
    .from("blog_posts")
    .select("id, title, share_count_total")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(50)
  if (ownErr) console.error("[refurbish] own assets unreadable — the brief cannot suggest one:", ownErr.message)
  const ownAssets = ((own ?? []) as Array<{ id: string; title: string | null; share_count_total: number | null }>).map((b) => ({
    id: b.id,
    title: b.title ?? "Untitled",
    topics: String(b.title ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3),
    measured: typeof b.share_count_total === "number" ? { interactions: b.share_count_total, rate: null } : null,
  }))
  return buildRefurbishIdeaBrief({ exclude: refurbishExcludeDefault }, {
    source: {
      kind: "competitor_post", url: row.content_url ?? null, platform: row.platform ?? null, contentType: row.content_type ?? null,
      untrustedText: row.caption ?? null, topics: Array.isArray(row.detected_topics) ? row.detected_topics : [], hookType: row.hook_type ?? null, geoLabel: opts.geoLabel,
    },
    evidence: labelCompetitorEvidence({
      likesCount: row.likes_count ?? null, commentsCount: row.comments_count ?? null, sharesCount: row.shares_count ?? null, viewsCount: row.views_count ?? null,
      engagementRate: row.engagement_rate ?? null, engagementSource: row.raw_engagement_data?.source ?? null, isHighPerforming: row.is_high_performing ?? null,
    }),
    rights: "idea_only",
    audience: { label: opts.audienceLabel },
    localFacts: opts.localFacts,
    ownAssets,
    availableFormats: opts.formats,
  })
}

/**
 * The idea-only path for an outside TRANSCRIPT (blog / podcast / branded-video doors): exclusion gate → the clean-room
 * topic read → the idea brief → an original first draft in the sender's voice → the originality gate against the transcript.
 * The transcript never reaches the composer.
 */
async function ideaOnlyDraftFromTranscript(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ctx: { userId: string; brokerageId: string },
  input: { transcript: string; url: string; format: string; maxLength?: number; feature: string },
): Promise<{ ok: true; draft: string; voiceVersion: string; frameRetention: number } | { ok: false; error: string }> {
  const ex = refurbishExcludeDefault({ title: input.transcript.slice(0, 200), text: input.transcript, sourceKind: "external_url" })
  if (ex.excluded) return { ok: false, error: ex.reason === "exclusion_gate_not_wired" ? "Idea-only refurbish is waiting on the topic exclusion check to be connected — nothing was generated." : `This source is excluded from content ideas (${ex.reason}).` }
  const generate = async (prompt: string) => (await generateAIResponse({ prompt, maxTokens: 900, metadata: { userId: ctx.userId, brokerageId: ctx.brokerageId, feature: input.feature } })).text ?? ""
  const idea = await abstractIdeaFromUntrusted({ generate }, input.transcript)
  if (!idea.ok) return { ok: false, error: idea.error }
  const brief = buildRefurbishIdeaBrief({ exclude: refurbishExcludeDefault }, {
    source: { kind: "external_url", url: input.url, platform: null, contentType: "video", untrustedText: input.transcript, topics: idea.topics, hookType: idea.hookType },
    evidence: labelCompetitorEvidence({ likesCount: null, commentsCount: null, sharesCount: null, viewsCount: null, engagementRate: null, engagementSource: null }),
    rights: "idea_only", audience: { label: null }, localFacts: [], ownAssets: [], availableFormats: [],
  })
  if (!brief.ok) return { ok: false, error: brief.userMessage }
  // WAVE 154 (154G1 request 2): the IDEA (the reworded consumer question, never the transcript) is filed into the one topic
  // pool so the same idea can feed other formats. A refusal is read and logged; it never blocks the draft.
  try {
    const ev = brief.brief.evidence
    const { intakeTopicIdeas } = await import("@/lib/content-intel/topic-intake")
    const filed = await intakeTopicIdeas(supabase as never, { brokerageId: ctx.brokerageId, ideas: [{
      sourceKind: "refurbish_competitor_post", title: brief.brief.consumerQuestion, angle: brief.brief.whyFormatMayHelp,
      sourceUrl: brief.brief.provenance.url, observedAt: new Date().toISOString(),
      evidence: ev?.kind === "measured" ? { kind: "measured", metric: "public_interactions", value: ev.interactionsTotal, unit: "count" }
        : ev?.kind === "proxy" ? { kind: "proxy", metric: ev.proxy?.metric ?? null, value: ev.proxy?.value ?? null, unit: "score_0_100" }
        : { kind: "unknown" },
      rights: "public_read_reworded",
    }] })
    if (!filed.ok) console.error("[refurbish] topic not filed:", filed.refused ?? "refused")
  } catch (e) { console.error("[refurbish] topic not filed:", e instanceof Error ? e.message : String(e)) }
  const voice = await loadRefurbishVoice(supabase, ctx.brokerageId, ctx.userId)
  const d = await draftRefurbishOutput({ generate }, { mode: "idea_only", format: input.format, maxLength: input.maxLength ?? null, voiceBriefText: voice.voiceBriefText, themFirstText: voice.themFirstText, brief: brief.brief, reusableSourceText: null, sourceLabel: "an outside source", untrustedSourceText: input.transcript })
  if (!d.ok) return { ok: false, error: d.message }
  return { ok: true, draft: d.draft, voiceVersion: voice.voiceVersion, frameRetention: d.originality.frameRetention }
}

function buildRepurposePrompt(args: {
  format: OutputFormat
  sourceUrl: string | null
  sourceLabel: string
  /** The real words of the source. Without it the model is guessing. */
  sourceText?: string | null
  branding: AgentBranding
  /** WAVE 154 (154D): renderSenderVoiceBrief — the sender's voice from settings, placed FIRST. */
  voiceBriefText?: string | null
}): string {
  const cfg = OUTPUT_FORMAT_CONFIG[args.format]
  const limit = cfg.maxLength ? `Keep it under ${cfg.maxLength} characters.` : "Keep it concise and platform-native."
  const aspect = cfg.aspectRatio ? ` The source video is intended for a ${cfg.aspectRatio} ${cfg.displayName} format.` : ""
  const source = args.sourceUrl ? `the video at ${args.sourceUrl}` : args.sourceLabel
  // Cap the excerpt: a long blog post would otherwise dominate the prompt and
  // push the format instructions out of the model's attention.
  const excerpt = args.sourceText?.trim()
    ? `Here is the source content to work from — base the caption on what it actually says, not on the topic in general:\n"""\n${args.sourceText.trim().slice(0, 6000)}\n"""`
    : ""
  return [
    args.voiceBriefText?.trim() ? `${args.voiceBriefText.trim()}\n\n` : "",
    `You are writing a ${cfg.displayName} caption for real estate agent ${args.branding.agentName}` +
      (args.branding.brokerageName ? ` of ${args.branding.brokerageName}` : "") + ".",
    `Repurpose ${source} into a platform-native ${cfg.displayName} caption.${aspect}`,
    excerpt,
    `Write in the agent's first-person voice, add a clear call to action, and include a few relevant, non-discriminatory hashtags.`,
    `Do NOT make claims about specific properties, prices, or guarantees. Follow fair-housing rules.`,
    limit,
  ].filter(Boolean).join(" ")
}

async function logRepurpose(
  supabase: Awaited<ReturnType<typeof createClient>>,
  row: {
    brokerageId: string
    sourceType: string
    sourceId: string | null
    outputType: string
    outputRefTable: string | null
    outputRefId: string | null
    platformTarget: string
    status: string
    approvalStatus: string
    notes: string
    createdBy: string
  },
): Promise<void> {
  await bestEffort(supabase.from("repurposed_content_log").insert({
    brokerage_id: row.brokerageId,
    source_type: row.sourceType,
    source_id: row.sourceId,
    output_type: row.outputType,
    output_ref_table: row.outputRefTable,
    output_ref_id: row.outputRefId,
    platform_target: row.platformTarget,
    status: row.status,
    approval_status: row.approvalStatus,
    notes: row.notes.slice(0, 1000),
    created_by: row.createdBy,
    created_at: new Date().toISOString(),
  }), "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent")
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CREATE REPURPOSE PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * THE PIPELINE DEFINITION, TIED TO ITS DECLARED CONTRACT.
 *
 * `pipelineName`, `sourceType`, `outputFormats` and `autoApprove` are not
 * restated here — they are taken from `PipelineConfig`
 * (lib/repurpose/types.ts:27), which is the module's declared shape for a
 * pipeline definition. It had been written, exported, and then never referenced
 * by anything, while this signature spelled the same four fields out again; two
 * declarations of one contract drift the moment either is edited, which is what
 * CLAUDE.md §6 rules out.
 *
 * `id` is omitted because this call CREATES the row. `brandVoiceOverride` and
 * `hashtagPresets` are omitted deliberately and the omission is the finding, not
 * an oversight: the repurpose dashboard's `Pipeline.output_config` type declares
 * `brand_voice_override` and `hashtag_presets`, and NOTHING in this file writes
 * either — the insert below stores only `formats`, `sourceId`, `autoApprove` and
 * an optional `sourceUrl`. Accepting them here would fabricate a wire that ends
 * nowhere; naming them in the Omit records that the reader has no writer yet.
 *
 * On `autoApprove`: "Skip manual review for generated content" — the switch on
 * the Create Pipeline dialog. It was collected and never sent: repurpose_pipelines
 * has no such column (verified live), and the client did not pass it either, so
 * the toggle governed nothing and every output landed in pending_review
 * regardless. It is carried in output_config, which already holds the pipeline's
 * other settings, rather than growing the table for one boolean.
 */
export async function createRepurposePipeline(
  params: Omit<PipelineConfig, "id" | "brandVoiceOverride" | "hashtagPresets"> & {
    sourceId: string
    brokerageId: string
    agentUserId?: string
    teamId?: string
    /** External source video URL (used by the video_url source type). */
    sourceUrl?: string
    /** WAVE 153 (153P): the basis the person states for refurbishing an EXTERNAL source (own_content | licensed). */
    rightsBasis?: string
    /** WAVE 154 (154D): an idea-only refurbish of a competitor post — only the id is stored; the row and its brief are
     *  re-read under the session tenant at execution. */
    inspiration?: { competitorContentId: string; audienceLabel?: string | null; localFacts?: LocalFact[]; geoLabel?: string | null }
  },
): Promise<SavePipelineResult> {
  try {
    const agentContext = await getAgentContext()
    const { userId, brokerageId: contextBrokerageId } = agentContext

    // ── Kernel Gate: canAccessFeature ──
    const access = await mayUseFeature(userId, "omnipresence_repurposer")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const savedTenant = decideClaimedTenant({ actingBrokerageId: contextBrokerageId, claimedBrokerageId: params.brokerageId })
    if (!savedTenant.ok) return { success: false, error: savedTenant.reason === "tenant_mismatch" ? "Forbidden: that brokerage is not yours." : "Your account is not linked to a brokerage" }

    const supabase = await createClient()

    // WAVE 155 (155R17): the receipt — the SESSION's user and tenant (no session tenant → no valid row; runs unreceipted).
    const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
    const run = async (): Promise<SavePipelineResult> => {
    // Create pipeline record
    const { data: pipeline, error } = await supabase
      .from("repurpose_pipelines")
      .insert({
        // Tenant from the SESSION only (CLAUDE.md §4). The body value was a fallback; it is now only a CLAIM, refused above when it
        // names another brokerage (decideClaimedTenant) — and a session with no tenant is refused rather than given the body's.
        brokerage_id: savedTenant.brokerageId,
        agent_user_id: params.agentUserId || userId,
        team_id: params.teamId,
        pipeline_name: params.pipelineName,
        source_type: params.sourceType,
        output_config: {
          formats: params.outputFormats,
          sourceId: params.sourceId,
          autoApprove: params.autoApprove === true,
          ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
          ...(params.rightsBasis ? { rightsBasis: params.rightsBasis } : {}),
          ...(params.inspiration && isValidUUID(params.inspiration.competitorContentId)
            ? { inspiration: { table: "competitor_content", id: params.inspiration.competitorContentId, audienceLabel: params.inspiration.audienceLabel ?? null, localFacts: (params.inspiration.localFacts ?? []).slice(0, 8), geoLabel: params.inspiration.geoLabel ?? null } }
            : {}),
        },
        is_active: true,
        created_by: userId,
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    // ── Increment feature usage ──
    await incrementFeatureUsage(userId, "omnipresence_repurposer")

    revalidatePath("/dashboard/campaigns/repurpose")

    return { success: true, pipelineId: pipeline.id }
    }
    return contextBrokerageId ? await ledgerSessionAction({ brokerageId: contextBrokerageId, action: "marketing.repurpose_pipeline.create", actor: { type: "user", userId }, subject: { type: "repurpose_pipeline" }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { source_type: params.sourceType, formats: params.outputFormats } }, run) : await run()
  } catch (error: any) {
    console.error("[Pipeline] Create error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. EXECUTE REPURPOSE PIPELINE WITH KERNEL WIRING
// ═══════════════════════════════════════════════════════════════════════════════
export async function executePipeline(params: {
  pipelineId: string
  brokerageId: string
  /** The content the user picked on the Execute tab. Optional so a programmatic
   *  run can still fall back to the pipeline's stored source. */
  sourceType?: SourceType
  sourceId?: string
}): Promise<ExecutePipelineResult> {
  try {
    const agentContext = await getAgentContext()
    const { userId, brokerageId: contextBrokerageId } = agentContext

    // ── Kernel Gate: canAccessFeature ──
    const access = await mayUseFeature(userId, "omnipresence_repurposer")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available", blockedReason: "Access denied" }
    }

    // Tenant scope is the SESSION's (CLAUDE.md §4). The body value is only a claim: a different brokerage is refused, and a
    // session with no tenant is refused rather than handed the body's (it was a fallback before wave 155).
    const runTenant = decideClaimedTenant({ actingBrokerageId: contextBrokerageId, claimedBrokerageId: params.brokerageId })
    if (!runTenant.ok) {
      return { success: false, error: runTenant.reason === "tenant_mismatch" ? "Forbidden: that brokerage is not yours." : "No brokerage context" }
    }
    const brokerageId = runTenant.brokerageId

    const supabase = await createClient()

    // Get pipeline
    const { data: pipeline } = await supabase
      .from("repurpose_pipelines")
      .select("*")
      .eq("id", params.pipelineId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (!pipeline) {
      return { success: false, error: "Pipeline not found" }
    }

    await bestEffort(supabase
      .from("repurpose_pipelines")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", params.pipelineId), "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent")

    // ── Fire kernel event: OMNIPRESENCE_PIPELINE_STARTED ──
    await processKernelEvent({
      event: KernelEvent.OMNIPRESENCE_PIPELINE_STARTED,
      brokerageId,
      entityType: "repurpose_pipeline",
      entityId: params.pipelineId,
    }).catch(err => console.error("[Pipeline] Event failed:", err))

    // The user's selection wins; the pipeline's stored source is the fallback
    // for a programmatic run.
    const runSourceType: SourceType = (params.sourceType ?? pipeline.source_type) as SourceType
    // WAVE 154 (154D): an idea-only refurbish of a competitor post carries only the post's id; the row is re-read here.
    const inspirationRef = pipeline.output_config?.inspiration as { table?: string; id?: string; audienceLabel?: string | null; localFacts?: LocalFact[]; geoLabel?: string | null } | undefined
    const inspirationId: string | null = inspirationRef?.table === "competitor_content" && isValidUUID(String(inspirationRef.id ?? "")) ? String(inspirationRef.id) : null
    const storedUrl: string | null = pipeline.output_config?.sourceUrl ?? (inspirationId ? `competitor_content:${inspirationId}` : null)
    const rawSourceId: string = inspirationId ? "" : (params.sourceId ?? pipeline.output_config?.sourceId ?? "")

    // REFUSE rather than generate type-only filler. A run with no resolvable
    // source used to produce captions about nothing and schedule them to real
    // social accounts, reporting "Pipeline executed successfully!".
    if (!isValidUUID(rawSourceId) && !storedUrl) {
      return { success: false, error: "Pick the content to repurpose — this run had no source." }
    }

    const source = isValidUUID(rawSourceId)
      ? await loadRepurposeSource(supabase, brokerageId, runSourceType, rawSourceId)
      : null
    if (isValidUUID(rawSourceId) && !source) {
      return { success: false, error: "That source content was not found in your brokerage." }
    }

    // WAVE 153 (153P) → WAVE 154 (154D, owner R4): LINEAGE + RIGHTS MODE. An outside URL with no recorded basis is no longer
    // refused — it runs IDEA-ONLY: an original piece from an idea brief, no source media carried, every draft held to the
    // originality gate. Only literal reuse of the source needs own_content / licensed.
    // A competitor post is never the tenant's asset: it is idea-only whatever basis a pipeline row carries.
    const refurbishVerdict = inspirationId
      ? assessRefurbishSource({ sourceType: "competitor_content", ownedSourceId: null, sourceUrl: storedUrl, rightsBasis: null })
      : assessRefurbishSource({ sourceType: runSourceType, ownedSourceId: source && isValidUUID(rawSourceId) ? rawSourceId : null, sourceUrl: storedUrl, rightsBasis: pipeline.output_config?.rightsBasis ?? null })
    if (!refurbishVerdict.allowed) {
      return { success: false, error: refurbishVerdict.message, blockedReason: refurbishVerdict.reason }
    }
    const ideaOnly = refurbishVerdict.mode === "idea_only"
    let ideaBrief: RefurbishIdeaBrief | null = null
    let inspirationText: string | null = null
    let inspirationMediaUrl: string | null = null
    if (ideaOnly) {
      if (!inspirationId) {
        // An outside video URL with no basis and no idea brief: the only thing this door can do with it is re-post the
        // video under the tenant's brand — that is ASSET reuse, which needs own_content / licensed. Say so plainly.
        return { success: false, error: "This outside video can only be re-posted with your own-content or license basis. To use its IDEA, refurbish it from the transcript (blog, podcast or branded video) or from the competitor post.", blockedReason: "asset_reuse_needs_basis" }
      }
      const insp = await loadCompetitorInspiration(supabase, brokerageId, inspirationId)
      if (!insp.row) return { success: false, error: insp.error }
      const built = await buildCompetitorIdeaBrief(supabase, brokerageId, insp.row, {
        audienceLabel: inspirationRef?.audienceLabel ?? null, localFacts: Array.isArray(inspirationRef?.localFacts) ? inspirationRef!.localFacts! : [], geoLabel: inspirationRef?.geoLabel ?? null,
        formats: ((pipeline.output_config?.formats ?? []) as string[]),
      })
      if (!built.ok) return { success: false, error: built.userMessage, blockedReason: built.refusal }
      ideaBrief = built.brief
      inspirationText = insp.row.caption ?? null
      inspirationMediaUrl = insp.row.media_url ?? null
    }

    // Third-party media is NEVER carried in idea-only mode (D7): the source's media URL is not attached to any post.
    const sourceUrl: string | null = refurbishVerdict.mayReuseSourceMedia ? (source?.mediaUrl ?? storedUrl) : null
    const sourceText: string | null = source?.body ?? null
    // repurposed_content_log.source_id is NOT NULL. Use the original content row
    // id when present, otherwise the pipeline id (links the log back to this run).
    // A competitor idea logs under the competitor post's id, so a retry or a second run of the SAME idea is "already
    // carried" on each platform by the omnipresence planner below — no duplicate post, no second generation charge.
    const sourceId: string = inspirationId ?? (isValidUUID(rawSourceId) ? rawSourceId : params.pipelineId)
    const logSourceType: string = inspirationId ? "competitor_content" : runSourceType
    const sourceLabel = source?.title
      ? `"${source.title}"`
      : `this ${runSourceType.replace(/_/g, " ")}`

    // Load the agent's branding so the AI rewrites copy in their voice, and the
    // set of connected social accounts so each platform routes to a real channel.
    const [branding, voice, { data: accountRows }] = await Promise.all([
      loadAgentBranding(supabase, userId, brokerageId),
      loadRefurbishVoice(supabase, brokerageId, userId, null),
      supabase
        .from("social_media_accounts")
        .select("id, platform")
        .eq("brokerage_id", brokerageId)
        .eq("is_active", true),
    ])
    const accountByPlatform = new Map<string, string>()
    for (const a of accountRows ?? []) {
      if (!accountByPlatform.has(a.platform)) accountByPlatform.set(a.platform, a.id)
    }

    const outputs: RepurposedOutput[] = []

    // WAVE 153 (lane 153P — owner B9): OMNIPRESENCE IS COORDINATED, NEVER SIMULTANEOUS REPEATS. Every platform used to be
    // scheduled for `now`, and a re-run re-posted the same source everywhere. The ONE planner
    // (lib/repurpose/omnipresence-plan.ts) reads this source's LINEAGE (repurposed_content_log) and the tenant's own fatigue
    // floor (followup_policy.guardrails.minHoursBetweenTouches): a platform that already carried it is skipped, and each
    // further platform waits the floor after the previous one. An unreadable lineage REFUSES the run (unknown ≠ never posted).
    const { planOmnipresenceSchedule, omnipresenceSourceKey } = await import("@/lib/repurpose/omnipresence-plan")
    const sourceKey = omnipresenceSourceKey(logSourceType, sourceId)
    const { data: carriedRows, error: carriedErr } = await supabase
      .from("repurposed_content_log")
      .select("platform_target, source_type, source_id, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("source_id", sourceId)
      .eq("output_ref_table", "social_posts")
      .in("status", ["scheduled", "published"])
    if (carriedErr) {
      return { success: false, error: `This source's repurpose history could not be read (${carriedErr.message}) — not run, so nothing is posted twice.` }
    }
    const { loadFollowupPolicy } = await import("@/lib/ai-isa/followup-policy")
    const gapHours = (await loadFollowupPolicy(supabase as never, brokerageId)).policy.guardrails.minHoursBetweenTouches
    const distributablePlatforms = ((pipeline.output_config?.formats ?? []) as OutputFormat[])
      .map((f) => OUTPUT_FORMAT_CONFIG[f]?.platform)
      .filter((p): p is string => !!p && DISTRIBUTABLE_PLATFORMS.has(p) && accountByPlatform.has(p))
    const slots = new Map(planOmnipresenceSchedule({
      platforms: distributablePlatforms,
      sourceKey,
      carried: ((carriedRows ?? []) as Array<{ platform_target: string; source_type: string; source_id: string; created_at: string | null }>)
        .map((r) => ({ platform: r.platform_target, sourceKey: omnipresenceSourceKey(r.source_type, r.source_id), at: r.created_at })),
      now: new Date(),
      gapHours,
    }).map((s) => [s.platform, s]))
    const scheduledThisRun = new Set<string>()
    // 154D: every output records where its idea came from, under which rights mode, and which voice version wrote it.
    const provenanceLine = ideaOnly || refurbishVerdict.mode === "asset_reuse"
      ? `[refurbish ${refurbishVerdict.mode} · lineage ${refurbishVerdict.lineage} · license ${refurbishVerdict.license} · voice ${voice.voiceVersion}] `
      : ""

    // Generate platform-tailored copy for each output format, then distribute
    // the source video to every connected social channel (omnipresence).
    for (const format of (pipeline.output_config?.formats ?? [])) {
      try {
        const config = OUTPUT_FORMAT_CONFIG[format as OutputFormat]
        if (!config) continue

        // 153P: one post per platform per source; a platform that already carried this source is not posted again.
        const slot = slots.get(config.platform)
        if (DISTRIBUTABLE_PLATFORMS.has(config.platform) && accountByPlatform.has(config.platform)) {
          if (slot?.skip === "already_carried" || scheduledThisRun.has(config.platform)) {
            outputs.push({ outputType: format, outputRefTable: "social_posts", outputRefId: "", platform: config.platform, contentPreview: `Already carried on ${config.platform} — not posted twice`, status: "skipped" })
            continue
          }
        }

        // WAVE 154 (154D): the sender's voice leads every first draft; an idea-only refurbish is composed from the idea
        // brief alone (the competitor's caption never reaches the writer) and must pass the originality gate.
        let generatedContent = ""
        if (ideaOnly && ideaBrief) {
          const d = await draftRefurbishOutput(
            { generate: async (prompt) => (await generateAIResponse({ prompt, maxTokens: 500, metadata: { userId, brokerageId, feature: "video_script_generation" } })).text ?? "" },
            { mode: "idea_only", format: config.displayName, maxLength: config.maxLength ?? null, voiceBriefText: voice.voiceBriefText, themFirstText: voice.themFirstText, brief: ideaBrief, reusableSourceText: null, sourceLabel, untrustedSourceText: inspirationText },
          )
          if (!d.ok) {
            outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: d.message, status: d.reason === "near_copy" ? "rejected" : "failed" })
            await logRepurpose(supabase, { brokerageId, sourceType: logSourceType, sourceId, outputType: format, outputRefTable: null, outputRefId: null, platformTarget: config.platform, status: "failed", approvalStatus: "rejected", notes: `refurbish idea_only · lineage ${refurbishVerdict.lineage} · ${d.message}`, createdBy: userId })
            continue
          }
          generatedContent = d.draft
        } else {
          const aiResponse = await generateAIResponse({
            prompt: buildRepurposePrompt({ format: format as OutputFormat, sourceUrl, sourceLabel, sourceText, branding, voiceBriefText: voice.voiceBriefText }),
            maxTokens: 500,
            metadata: { userId, brokerageId, feature: "video_script_generation" },
          })
          generatedContent = (aiResponse.text ?? "").trim()
        }
        if (!generatedContent) {
          outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: "AI returned no content", status: "failed" })
          continue
        }

        const isDistributable = DISTRIBUTABLE_PLATFORMS.has(config.platform)

        if (isDistributable) {
          // Distribute via the canonical poster — it runs brand voice + compliance,
          // verifies account ownership, and schedules the real social_posts row.
          const accountId = accountByPlatform.get(config.platform)
          if (!accountId) {
            outputs.push({ outputType: format, outputRefTable: "social_posts", outputRefId: "", platform: config.platform, contentPreview: `No connected ${config.platform} account`, status: "skipped" })
            await logRepurpose(supabase, { brokerageId, sourceType: logSourceType, sourceId, outputType: format, outputRefTable: null, outputRefId: null, platformTarget: config.platform, status: "generated", approvalStatus: "draft", notes: `Generated but not distributed — no connected ${config.platform} account`, createdBy: userId })
            continue
          }

          const mediaUrls = refurbishVerdict.mayReuseSourceMedia && sourceUrl ? [sourceUrl] : undefined
          // 154D: never carry third-party media into an idea-only post — a second, independent check on the outgoing payload.
          if (ideaOnly && carriesSourceMedia(mediaUrls, { url: storedUrl, mediaUrl: inspirationMediaUrl })) {
            outputs.push({ outputType: format, outputRefTable: "social_posts", outputRefId: "", platform: config.platform, contentPreview: "Refused: the post would carry the source's media", status: "rejected" })
            continue
          }
          const scheduled = await scheduleSocialPost({
            platform: config.platform,
            postType: "custom",
            content: generatedContent,
            mediaUrls,
            hashtags: extractHashtags(generatedContent),
            scheduledFor: slot?.at ?? new Date().toISOString(),
            socialAccountId: accountId,
          })
          scheduledThisRun.add(config.platform)

          if (!scheduled.success || !scheduled.data?.id) {
            outputs.push({ outputType: format, outputRefTable: "social_posts", outputRefId: "", platform: config.platform, contentPreview: scheduled.error ?? "Failed to schedule", status: "failed" })
            await logRepurpose(supabase, { brokerageId, sourceType: logSourceType, sourceId, outputType: format, outputRefTable: null, outputRefId: null, platformTarget: config.platform, status: "failed", approvalStatus: "rejected", notes: scheduled.error ?? "Failed to schedule", createdBy: userId })
            continue
          }

          await logRepurpose(supabase, { brokerageId, sourceType: logSourceType, sourceId, outputType: format, outputRefTable: "social_posts", outputRefId: scheduled.data.id, platformTarget: config.platform, status: "scheduled", approvalStatus: "approved", notes: `${provenanceLine}${generatedContent}`, createdBy: userId })
          outputs.push({ outputType: format, outputRefTable: "social_posts", outputRefId: scheduled.data.id, platform: config.platform, contentPreview: generatedContent.substring(0, 100), status: "scheduled" })
          continue
        }

        // Non-distributable formats (email/blog/quote graphic): run the brand voice
        // + compliance gates and log the generated copy. No auto-distribution backend.
        const brandResult = await applyKernelBrandVoice({
          brokerageId, actorUserId: userId, actorRole: "agent",
          journeyType: "marketing", persona: "seller", messageType: "social", content: generatedContent,
        })
        if (isBrandVoiceBlocked(brandResult)) {
          outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: "Brand voice violation", status: "rejected" })
          continue
        }
        const complianceResult = await evaluateKernelOutbound({
          actorContext: { userId, role: "agent", brokerageId },
          journeyType: "marketing", persona: "seller", messageType: "social", content: generatedContent,
          contact: { id: userId, status: "active" },
        })
        if (isComplianceBlocked(complianceResult)) {
          outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: "Compliance violation", status: "rejected" })
          continue
        }
        // THE READ SIDE OF THE AUTO-APPROVE SWITCH. Both literals are in the
        // live approval_status CHECK — nothing is widened. Compliance still
        // gates above: auto-approve skips the human review queue, never the
        // compliance evaluation.
        const autoApprove = pipeline.output_config?.autoApprove === true
        await logRepurpose(supabase, { brokerageId, sourceType: logSourceType, sourceId, outputType: format, outputRefTable: config.outputTable, outputRefId: null, platformTarget: config.platform, status: "generated", approvalStatus: autoApprove ? "approved" : "pending_review", notes: `${provenanceLine}${generatedContent}`, createdBy: userId })
        outputs.push({ outputType: format, outputRefTable: config.outputTable, outputRefId: "", platform: config.platform, contentPreview: generatedContent.substring(0, 100), status: autoApprove ? "approved" : "pending" })
      } catch (err) {
        console.error(`[Pipeline] Error generating ${format}:`, err)
      }
    }

    await bestEffort(supabase
      .from("repurpose_pipelines")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", params.pipelineId), "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent")

    // ── Fire kernel event: OMNIPRESENCE_PIPELINE_COMPLETED ──
    await processKernelEvent({
      event: KernelEvent.OMNIPRESENCE_PIPELINE_COMPLETED,
      brokerageId,
      entityType: "repurpose_pipeline",
      entityId: params.pipelineId,
    }).catch(err => console.error("[Pipeline] Event failed:", err))

    // ── Increment feature usage ──
    await incrementFeatureUsage(userId, "omnipresence_repurposer")

    revalidatePath("/dashboard/campaigns/repurpose")

    return { success: true, pipelineId: params.pipelineId, outputs }
  } catch (error: any) {
    console.error("[Pipeline] Execute error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. GET PIPELINES
// ═══════════════════════════════════════════════════════════════════════════════
export async function getPipelines(brokerageId: string) {
  try {
    const agentContext = await getAgentContext()
    const supabase = await createClient()

    const { data: pipelines, error } = await supabase
      .from("repurpose_pipelines")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) throw error

    return { success: true, pipelines: pipelines || [] }
  } catch (error: any) {
    console.error("[Pipeline] Get error:", error)
    return { success: false, error: error.message, pipelines: [] }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. GET REPURPOSE HISTORY
// ═══════════════════════════════════════════════════════════════════════════════
export async function getRepurposeHistory(brokerageId: string) {
  try {
    const supabase = await createClient()

    const { data: history, error } = await supabase
      .from("repurposed_content_log")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(100)

    if (error) throw error

    return { success: true, history: history || [] }
  } catch (error: any) {
    console.error("[Pipeline] History error:", error)
    return { success: false, error: error.message, history: [] }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. TOGGLE PIPELINE ACTIVE STATUS
// ═══════════════════════════════════════════════════════════════════════════════
export async function togglePipelineActive(
  userId: string,
  pipelineId: string,
  brokerageId: string,
  isActive: boolean
) {
  try {
    // WAVE 155 (155R17 — CLAUDE.md §4): the owner and tenant are the SESSION's (the sibling createRepurposePipeline's
    // getAgentContext); the userId / brokerageId arguments stay for signature compatibility and are no longer trusted.
    const session = await getAgentContext()
    if (!session.isAuthenticated || !session.userId || !session.brokerageId) return { success: false, error: "Not authenticated" }
    void userId; void brokerageId
    const supabase = await createClient()
    const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
    return await ledgerSessionAction({ brokerageId: session.brokerageId, action: "marketing.repurpose_pipeline.toggle", actor: { type: "user", userId: session.userId }, subject: { type: "repurpose_pipeline", id: pipelineId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { is_active: isActive } }, async (): Promise<{ success: boolean; error?: string }> => {
    const { data: changed, error } = await supabase
      .from("repurpose_pipelines")
      .update({ is_active: isActive })
      .eq("id", pipelineId)
      .eq("agent_user_id", session.userId)
      .eq("brokerage_id", session.brokerageId as string)
      .select("id")

    if (error) throw error
    // §3: an UPDATE that matched nothing (another owner's pipeline, a deleted one) resolves — it is not a success.
    if (!changed || changed.length === 0) return { success: false, error: "Pipeline not found" }

    revalidatePath("/dashboard/campaigns/repurpose")

    return { success: true }
    })
  } catch (error: any) {
    console.error("[Pipeline] Toggle error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. DELETE PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════
export async function deletePipeline(userId: string, pipelineId: string, brokerageId: string) {
  try {
    // WAVE 155 (155R17 — CLAUDE.md §4): the owner and tenant are the SESSION's; the arguments are no longer trusted.
    const session = await getAgentContext()
    if (!session.isAuthenticated || !session.userId || !session.brokerageId) return { success: false, error: "Not authenticated" }
    void userId; void brokerageId
    const supabase = await createClient()
    const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
    return await ledgerSessionAction({ brokerageId: session.brokerageId, action: "marketing.repurpose_pipeline.delete", actor: { type: "user", userId: session.userId }, subject: { type: "repurpose_pipeline", id: pipelineId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async (): Promise<{ success: boolean; error?: string }> => {
    // repurposed_content_log entries are historical (and may reference live
    // scheduled posts), so they are intentionally retained — they are not keyed
    // to a pipeline. Delete only the pipeline definition.
    const { data: removed, error } = await supabase
      .from("repurpose_pipelines")
      .delete()
      .eq("id", pipelineId)
      .eq("agent_user_id", session.userId)
      .eq("brokerage_id", session.brokerageId as string)
      .select("id")

    if (error) throw error
    // §3: a DELETE that matched nothing resolves byte-identically to one that worked — count it.
    if (!removed || removed.length === 0) return { success: false, error: "Pipeline not found" }

    revalidatePath("/dashboard/campaigns/repurpose")

    return { success: true }
    })
  } catch (error: any) {
    console.error("[Pipeline] Delete error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. REPURPOSE A VIDEO URL (ad-hoc omnipresence run)
// ═══════════════════════════════════════════════════════════════════════════════
// Owner flow: paste a source video URL → AI rewrites platform-tailored copy in
// the agent's voice → the video is scheduled to each connected social channel.
// Reuses createRepurposePipeline + executePipeline so there is one engine.
export async function repurposeVideoUrl(params: {
  sourceUrl: string
  outputFormats: OutputFormat[]
  pipelineName?: string
  /** WAVE 153 (153P): own_content | licensed — an external source is not refurbished without one. */
  rightsBasis?: string
}): Promise<ExecutePipelineResult> {
  const url = params.sourceUrl?.trim()
  if (!url || !/^https?:\/\/\S+$/i.test(url)) {
    return { success: false, error: "Enter a valid http(s) video URL" }
  }
  const rights = assessRefurbishSource({ sourceType: "video_url", ownedSourceId: null, sourceUrl: url, rightsBasis: params.rightsBasis })
  if (!rights.allowed) return { success: false, error: rights.message, blockedReason: rights.reason }
  // 154D: this door RE-POSTS the video itself — literal asset reuse. Its idea (no basis needed) goes through the transcript
  // doors below, which compose an original piece and never carry the video.
  if (rights.mode === "idea_only") {
    return { success: false, error: "Re-posting this video needs your own-content or license basis. To use its idea instead, choose blog, podcast or branded video — an original piece is written from the idea and the video is not reused.", blockedReason: "asset_reuse_needs_basis" }
  }
  if (!params.outputFormats?.length) {
    return { success: false, error: "Select at least one channel" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const created = await createRepurposePipeline({
    pipelineName: params.pipelineName?.trim() || `Video URL repurpose ${new Date().toISOString().slice(0, 10)}`,
    sourceType: "video_url",
    sourceId: "",
    sourceUrl: url,
    rightsBasis: rights.mode === "asset_reuse" ? rights.license : undefined,
    outputFormats: params.outputFormats,
    brokerageId: ctx.brokerageId,
  })
  if (!created.success || !created.pipelineId) {
    return { success: false, error: created.error ?? "Could not create repurpose run" }
  }

  return executePipeline({ pipelineId: created.pipelineId, brokerageId: ctx.brokerageId })
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7b. REFURBISH A COMPETITOR'S IDEA (WAVE 154, lane 154D — owner R4, directive D7)
// ═══════════════════════════════════════════════════════════════════════════════
// The competitor-watch signal (competitor_content, written by lib/competitive-intel/content-intel-scan.ts and read by
// app/actions/marketing-intelligence.ts getCompetitorHighPerformers) → the SAME engine: a pipeline row that stores only the
// post's id, then executePipeline, which re-reads the row under the session tenant, rebuilds the seven-question idea brief
// behind the exclusion gate, writes an original first draft in the sender's voice, holds it to the originality gate, never
// carries the competitor's media, and distributes through the omnipresence planner + scheduleSocialPost (the existing
// approval rules). The post's id is the lineage source_id, so a retry or second run is "already carried" — no duplicate post
// and no second generation charge. Read-only preview first: previewCompetitorIdeaBrief.
export async function previewCompetitorIdeaBrief(input: { competitorContentId: string; audienceLabel?: string | null; geoLabel?: string | null; localFacts?: LocalFact[] }): Promise<
  { success: true; brief: RefurbishIdeaBrief } | { success: false; error: string; refusal?: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }
  const access = await mayUseFeature(ctx.userId, "omnipresence_repurposer")
  if (!access.allowed) return { success: false, error: access.reason ?? "Feature not available" }
  const supabase = await createClient()
  const insp = await loadCompetitorInspiration(supabase, ctx.brokerageId, input.competitorContentId)
  if (!insp.row) return { success: false, error: insp.error }
  const built = await buildCompetitorIdeaBrief(supabase, ctx.brokerageId, insp.row, { audienceLabel: input.audienceLabel ?? null, geoLabel: input.geoLabel ?? null, localFacts: input.localFacts ?? [], formats: [] })
  return built.ok ? { success: true, brief: built.brief } : { success: false, error: built.userMessage, refusal: built.refusal }
}

export async function refurbishCompetitorIdea(input: {
  competitorContentId: string
  outputFormats: OutputFormat[]
  audienceLabel?: string | null
  geoLabel?: string | null
  localFacts?: LocalFact[]
}): Promise<ExecutePipelineResult> {
  if (!isValidUUID(input.competitorContentId)) return { success: false, error: "That competitor post id is not valid." }
  if (!input.outputFormats?.length) return { success: false, error: "Select at least one channel" }
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }
  const created = await createRepurposePipeline({
    pipelineName: `Refurbished idea ${new Date().toISOString().slice(0, 10)}`,
    sourceType: "social_post",
    sourceId: "",
    outputFormats: input.outputFormats,
    brokerageId: ctx.brokerageId,
    inspiration: { competitorContentId: input.competitorContentId, audienceLabel: input.audienceLabel ?? null, geoLabel: input.geoLabel ?? null, localFacts: input.localFacts ?? [] },
  })
  if (!created.success || !created.pipelineId) return { success: false, error: created.error ?? "Could not create the refurbish run" }
  return executePipeline({ pipelineId: created.pipelineId, brokerageId: ctx.brokerageId })
}

/**
 * REFURBISH RESULTS (D4 "→ real provider acknowledgement → ROI → retest"). Every refurbished social output this tenant
 * scheduled, with the truth about it: PUBLISHED only when the publish cron recorded the provider's external id
 * (app/api/cron/publish-social-posts), a MEASURED rate only from social_engagement_tracking, and keep / retest only against
 * the tenant's own measured 28-day baseline (lib/marketing/social-baselines.ts). Unknown stays unknown.
 */
export async function getRefurbishResults(): Promise<{
  success: boolean
  error?: string
  results: Array<{ logId: string; postId: string; platform: string; state: string; why: string; measuredRate: number | null; baselineRate: number | null; decision: string; decisionWhy: string; createdAt: string | null }>
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated", results: [] }
  const supabase = await createClient()
  const { data: logs, error: logErr } = await supabase
    .from("repurposed_content_log")
    .select("id, output_ref_id, platform_target, created_at")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("output_ref_table", "social_posts")
    .like("notes", "[refurbish %")
    .order("created_at", { ascending: false })
    .limit(50)
  if (logErr) return { success: false, error: `Refurbish history could not be read (${logErr.message}).`, results: [] }
  const rows = ((logs ?? []) as Array<{ id: string; output_ref_id: string | null; platform_target: string; created_at: string | null }>).filter((r) => isValidUUID(String(r.output_ref_id ?? "")))
  if (!rows.length) return { success: true, results: [] }
  const ids = rows.map((r) => r.output_ref_id as string)
  const [{ data: posts, error: postErr }, { data: eng, error: engErr }] = await Promise.all([
    supabase.from("social_posts").select("id, platform, post_type, status, external_post_id, error_message").eq("brokerage_id", ctx.brokerageId).in("id", ids),
    supabase.from("social_engagement_tracking").select("social_post_id, likes_count, comments_count, shares_count, impressions_count").eq("brokerage_id", ctx.brokerageId).in("social_post_id", ids),
  ])
  if (postErr) return { success: false, error: `The scheduled posts could not be read (${postErr.message}).`, results: [] }
  if (engErr) console.error("[refurbish] engagement unreadable — every result reads unmeasured:", engErr.message)
  const { listSocialBaselines } = await import("@/lib/marketing/social-baselines")
  const baselines = await listSocialBaselines(ctx.brokerageId)
  const postById = new Map(((posts ?? []) as Array<{ id: string; platform: string; post_type: string; status: string | null; external_post_id: string | null; error_message: string | null }>).map((p) => [p.id, p]))
  const totals = new Map<string, { inter: number; imp: number }>()
  for (const e of (eng ?? []) as Array<{ social_post_id: string; likes_count: number | null; comments_count: number | null; shares_count: number | null; impressions_count: number | null }>) {
    const t = totals.get(e.social_post_id) ?? { inter: 0, imp: 0 }
    t.inter += (e.likes_count ?? 0) + (e.comments_count ?? 0) + (e.shares_count ?? 0)
    t.imp += e.impressions_count ?? 0
    totals.set(e.social_post_id, t)
  }
  return {
    success: true,
    results: rows.map((r) => {
      const post = postById.get(r.output_ref_id as string) ?? null
      const publication = refurbishPublicationVerdict(post)
      const t = totals.get(r.output_ref_id as string)
      const measuredRate = t && t.imp > 0 ? t.inter / t.imp : null
      const baselineRate = post ? (baselines.find((b) => b.platform === post.platform && b.postType === post.post_type)?.engagementRate ?? null) : null
      const decision = refurbishRetestDecision({ publication, measuredRate, baselineRate })
      return { logId: r.id, postId: r.output_ref_id as string, platform: post?.platform ?? r.platform_target, state: publication.state, why: publication.why, measuredRate, baselineRate, decision: decision.decision, decisionWhy: decision.why, createdAt: r.created_at }
    }),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. REPURPOSE A VIDEO URL INTO A NEW BRANDED VIDEO (omnipresence, async)
// ═══════════════════════════════════════════════════════════════════════════════
// Flow: paste video URL → transcript (Whisper on a direct media file, else a
// pasted transcript) → AI rewrites it into the agent's branded short script →
// create an ai_video_projects row → return the D-ID payload for the client to
// kick off generation. Generation is async; when the poll-did-videos cron sets
// video_url, the completion handler drafts per-channel social posts for review
// (see lib/repurpose/distribute.ts, wired in app/actions/video-content.ts).

function buildVideoScriptPrompt(args: { transcript: string; branding: AgentBranding }): string {
  return [
    `Rewrite the following transcript into a punchy ~150-word first-person video script for real estate agent ${args.branding.agentName}` +
      (args.branding.brokerageName ? ` of ${args.branding.brokerageName}` : "") + ".",
    `Match a warm, professional brand voice, open with a hook, and end with a clear call to action.`,
    `Do NOT invent specific properties, prices, or guarantees. Follow fair-housing rules (no language about protected classes).`,
    `Return ONLY the spoken script text, no headings or stage directions.`,
    `Transcript:\n${args.transcript.slice(0, 6000)}`,
  ].join(" ")
}

export interface RepurposeToVideoResult {
  success: boolean
  projectId?: string
  status?: "generating"
  /** Client posts this to /api/did/generate-video to start the render. */
  didPayload?: {
    video_project_id: string
    script: string
    elevenlabs_voice_id: string
    did_avatar_id?: string
    agent_photo_url?: string | null
    agent_video_url?: string | null
    intro_video_url?: string
    outro_video_url?: string
  }
  needsSetup?: "social" | "voice"
  needsTranscript?: boolean
  redirectTo?: string
  error?: string
}

export async function repurposeUrlToBrandedVideo(input: {
  sourceUrl: string
  transcript?: string
  channels: OutputFormat[]
  title?: string
  /** WAVE 153 (153P): own_content | licensed. */
  rightsBasis?: string
}): Promise<RepurposeToVideoResult> {
  const url = input.sourceUrl?.trim()
  if (!url || !/^https?:\/\/\S+$/i.test(url)) {
    return { success: false, error: "Enter a valid http(s) video URL" }
  }
  const rights = assessRefurbishSource({ sourceType: "video_url", ownedSourceId: null, sourceUrl: url, rightsBasis: input.rightsBasis })
  if (!rights.allowed) return { success: false, error: rights.message }
  if (!input.channels?.length) {
    return { success: false, error: "Select at least one channel" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.agentId) {
    return { success: false, error: "Not authenticated" }
  }

  const access = await mayUseFeature(ctx.userId, "omnipresence_repurposer")
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Feature not available" }
  }

  // Gate A — must have at least one connected social account.
  const accounts = await getConnectedAccounts(ctx.agentId)
  if (accounts.length === 0) {
    return { success: false, needsSetup: "social", redirectTo: "/settings/integrations", error: "Connect a social account before repurposing." }
  }

  const supabase = await createClient()

  // Gate B — must have a voice clone + an avatar source (D-ID hard-fails otherwise).
  const { data: voice } = await supabase
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_avatar_id, did_video_url, did_photo_url")
    .eq("agent_id", ctx.agentId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("is_default", { ascending: false })
    .limit(1)
    .maybeSingle()
  const avatarSource = voice?.did_avatar_id || voice?.did_video_url || voice?.did_photo_url
  if (!voice?.elevenlabs_voice_id || !avatarSource) {
    return { success: false, needsSetup: "voice", redirectTo: "/dashboard/videos/voice", error: "Set up your voice clone and avatar before generating videos." }
  }

  // Transcript: a pasted transcript wins; otherwise transcribe a direct media file.
  let transcript = input.transcript?.trim() ?? ""
  if (!transcript) {
    const t = await transcribeFromUrl(url)
    if (!t.success) {
      const hint = t.reason === "not_media"
        ? "Couldn't read that link automatically (e.g. a YouTube page). Paste the transcript to continue."
        : `Couldn't transcribe the video (${t.message}). Paste the transcript to continue.`
      return { success: false, needsTranscript: true, error: hint }
    }
    transcript = t.transcript
  }

  // Rewrite into a branded script, then run the brand-voice + compliance gates.
  // 154D: own / licensed content is rewritten from the transcript in the sender's voice; an outside source with no basis is
  // IDEA-ONLY — an original script from the idea brief, held to the originality gate against the transcript.
  let script = ""
  if (rights.mode === "idea_only") {
    const io = await ideaOnlyDraftFromTranscript(supabase, { userId: ctx.userId, brokerageId: ctx.brokerageId }, { transcript, url, format: "~150-word first-person short video script (spoken text only)", feature: "video_script_generation" })
    if (!io.ok) return { success: false, error: io.error }
    script = io.draft
  } else {
    const branding = await loadAgentBranding(supabase, ctx.userId, ctx.brokerageId)
    const voice = await loadRefurbishVoice(supabase, ctx.brokerageId, ctx.userId)
    const scriptResp = await generateAIResponse({
      prompt: `${voice.voiceBriefText}\n\n${buildVideoScriptPrompt({ transcript, branding })}`,
      maxTokens: 600,
      metadata: { userId: ctx.userId, brokerageId: ctx.brokerageId, feature: "video_script_generation" },
    })
    script = (scriptResp.text ?? "").trim()
  }
  if (!script) {
    return { success: false, error: "Could not generate a script from the transcript" }
  }

  const brand = await applyKernelBrandVoice({
    brokerageId: ctx.brokerageId, actorUserId: ctx.userId, actorRole: "agent",
    journeyType: "marketing", persona: "seller", messageType: "social", content: script,
  })
  if (isBrandVoiceBlocked(brand)) {
    return { success: false, error: "Generated script violates brand voice — try a different source." }
  }
  const comp = await evaluateKernelOutbound({
    actorContext: { userId: ctx.userId, role: "agent", brokerageId: ctx.brokerageId },
    journeyType: "marketing", persona: "seller", messageType: "social", content: script,
    contact: { id: ctx.userId, status: "active" },
  })
  if (isComplianceBlocked(comp)) {
    return { success: false, error: "Generated script failed a compliance check." }
  }

  // Create the video project (draft) — generation is kicked off client-side.
  // NOTE: ai_video_projects.agent_id FKs to users.id (not agents.id), matching
  // the existing create flow which passes the user id.
  const created = await createVideoProject({
    brokerageId: ctx.brokerageId,
    agentUserId: ctx.userId,
    title: input.title?.trim() || `Repurposed video ${new Date().toISOString().slice(0, 10)}`,
    script,
    videoType: "social_reel",
    backgroundType: "solid",
    backgroundColorHex: "#ffffff",
    format: "vertical",
    durationSeconds: 60,
    captionsEnabled: true,
  })
  if (!created.success || !created.project) {
    return { success: false, error: created.error ?? "Could not create the video project" }
  }
  const projectId = created.project.id

  // Persist the distribution intent so the completion hook drafts per-channel posts.
  const { error: intentErr } = await supabase
    .from("ai_video_projects")
    .update({
      video_metadata: {
        ...((created.project as { video_metadata?: Record<string, unknown> }).video_metadata ?? {}),
        repurpose: { channels: input.channels, source_url: url, distribute_as_draft: true, rights_basis: rights.license, rights_mode: rights.mode },
      },
    })
    .eq("id", projectId)
  if (intentErr) console.error("[repurpose] distribution intent not saved — per-channel drafts will not be made:", intentErr.message)

  // Intro/outro stock clips (applied by the poll cron via ffmpeg concat). Optional.
  const { data: clips } = await supabase
    .from("video_assets")
    .select("video_url, category")
    .eq("brokerage_id", ctx.brokerageId)
    .in("category", ["intro", "outro"])
    .order("created_at", { ascending: false })
    .limit(10)
  const introUrl = clips?.find((c) => c.category === "intro")?.video_url ?? null
  const outroUrl = clips?.find((c) => c.category === "outro")?.video_url ?? null

  return {
    success: true,
    projectId,
    status: "generating",
    didPayload: {
      video_project_id: projectId,
      script,
      elevenlabs_voice_id: voice.elevenlabs_voice_id,
      ...(voice.did_avatar_id ? { did_avatar_id: voice.did_avatar_id } : {}),
      agent_photo_url: voice.did_avatar_id ? null : voice.did_photo_url ?? null,
      agent_video_url: voice.did_avatar_id ? null : voice.did_video_url ?? null,
      ...(introUrl ? { intro_video_url: introUrl } : {}),
      ...(outroUrl ? { outro_video_url: outroUrl } : {}),
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. "NO VIDEO" OUTPUT MODES — repurpose a URL into a blog post or a podcast
// ═══════════════════════════════════════════════════════════════════════════════

// Shared: pasted transcript wins; otherwise transcribe a direct media file.
async function acquireTranscript(
  url: string,
  pasted?: string,
): Promise<{ ok: true; transcript: string } | { ok: false; error: string }> {
  const t = pasted?.trim()
  if (t) return { ok: true, transcript: t }
  const r = await transcribeFromUrl(url)
  if (!r.success) {
    const hint = r.reason === "not_media"
      ? "Couldn't read that link automatically (e.g. a YouTube page). Paste the transcript to continue."
      : `Couldn't transcribe the video (${r.message}). Paste the transcript to continue.`
    return { ok: false, error: hint }
  }
  return { ok: true, transcript: r.transcript }
}

export interface RepurposeBlogResult {
  success: boolean
  postId?: string
  needsTranscript?: boolean
  error?: string
}

export async function repurposeUrlToBlogPost(input: {
  sourceUrl: string
  transcript?: string
  title?: string
  /** WAVE 153 (153P): own_content | licensed. */
  rightsBasis?: string
}): Promise<RepurposeBlogResult> {
  const url = input.sourceUrl?.trim()
  if (!url || !/^https?:\/\/\S+$/i.test(url)) return { success: false, error: "Enter a valid http(s) video URL" }
  const rights = assessRefurbishSource({ sourceType: "video_url", ownedSourceId: null, sourceUrl: url, rightsBasis: input.rightsBasis })
  if (!rights.allowed) return { success: false, error: rights.message }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const tr = await acquireTranscript(url, input.transcript)
  if (!tr.ok) return { success: false, needsTranscript: true, error: tr.error }

  // 154D: an outside source with no basis is IDEA-ONLY — the blog writer receives an original draft composed from the idea
  // brief (originality-gated against the transcript), never the transcript itself.
  let writerSource = tr.transcript
  if (rights.mode === "idea_only") {
    const io = await ideaOnlyDraftFromTranscript(await createClient(), { userId: ctx.userId, brokerageId: ctx.brokerageId }, { transcript: tr.transcript, url, format: "blog post draft (headline, sections, a closing next step)", feature: "blog_post_generation" })
    if (!io.ok) return { success: false, error: io.error }
    writerSource = io.draft
  }

  // Derive a few SEO keywords from the transcript (blog generator needs them).
  let keywords: string[] = []
  try {
    const kw = await generateAIResponse({
      prompt: `Extract 3-5 concise SEO keywords (comma-separated, no # symbols) for a real estate blog post based on this text:\n${writerSource.slice(0, 3000)}`,
      maxTokens: 60,
      metadata: { userId: ctx.userId, brokerageId: ctx.brokerageId, feature: "blog_post_generation" },
    })
    keywords = Array.from(
      new Set((kw.text ?? "").split(",").map((s) => s.trim().replace(/^#+/, "")).filter(Boolean)),
    ).slice(0, 5)
  } catch {
    /* fall back below */
  }
  if (keywords.length === 0) keywords = ["real estate"]

  const res = await generateBlogPost(ctx.userId, {
    brokerageId: ctx.brokerageId,
    agentUserId: ctx.userId,
    title: input.title?.trim() || undefined,
    keywords,
    sourceContent: writerSource,
    generateCoverImage: true,
  })
  // WAVE 153 (153P): the refurbished post carries its LINEAGE (the original's URL) and its LICENSE (or idea_only).
  if (res.success && res.postId) {
    await logRepurpose(await createClient(), { brokerageId: ctx.brokerageId, sourceType: "video_url", sourceId: res.postId, outputType: "blog_excerpt", outputRefTable: "blog_posts", outputRefId: res.postId, platformTarget: "blog", status: "generated", approvalStatus: "pending_review", notes: `lineage ${rights.lineage} · license ${rights.license}`, createdBy: ctx.userId })
  }
  return { success: res.success, postId: res.postId, error: res.error }
}

export interface RepurposePodcastResult {
  success: boolean
  episodeId?: string
  needsTranscript?: boolean
  error?: string
}

export async function repurposeUrlToPodcast(input: {
  sourceUrl: string
  transcript?: string
  title?: string
  /** WAVE 153 (153P): own_content | licensed. */
  rightsBasis?: string
}): Promise<RepurposePodcastResult> {
  const url = input.sourceUrl?.trim()
  if (!url || !/^https?:\/\/\S+$/i.test(url)) return { success: false, error: "Enter a valid http(s) video URL" }
  const rights = assessRefurbishSource({ sourceType: "video_url", ownedSourceId: null, sourceUrl: url, rightsBasis: input.rightsBasis })
  if (!rights.allowed) return { success: false, error: rights.message }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const tr = await acquireTranscript(url, input.transcript)
  if (!tr.ok) return { success: false, needsTranscript: true, error: tr.error }

  // Rewrite the transcript into a branded first-person podcast monologue (own / licensed), or — IDEA-ONLY (154D) — compose
  // an original monologue from the idea brief in the sender's voice, originality-gated against the transcript.
  const supabase = await createClient()
  let script = ""
  if (rights.mode === "idea_only") {
    const io = await ideaOnlyDraftFromTranscript(supabase, { userId: ctx.userId, brokerageId: ctx.brokerageId }, { transcript: tr.transcript, url, format: "natural ~2-minute first-person podcast monologue (no stage directions or headings)", feature: "podcast_generation" })
    if (!io.ok) return { success: false, error: io.error }
    script = io.draft
  } else {
    const branding = await loadAgentBranding(supabase, ctx.userId, ctx.brokerageId)
    const voice = await loadRefurbishVoice(supabase, ctx.brokerageId, ctx.userId)
    const scriptResp = await generateAIResponse({
      prompt:
        `${voice.voiceBriefText}\n\n` +
        `Rewrite this transcript into a natural ~2-minute first-person podcast monologue script for real estate agent ${branding.agentName}` +
        (branding.brokerageName ? ` of ${branding.brokerageName}` : "") +
        `. Conversational and engaging, no stage directions or headings, fair-housing safe (no language about protected classes), and avoid inventing specific properties/prices.\nTranscript:\n${tr.transcript.slice(0, 6000)}`,
      maxTokens: 900,
      metadata: { userId: ctx.userId, brokerageId: ctx.brokerageId, feature: "podcast_generation" },
    })
    script = (scriptResp.text ?? "").trim()
  }
  if (!script) return { success: false, error: "Could not generate a podcast script" }

  const created = await createPodcastEpisode({
    title: input.title?.trim() || `Repurposed episode ${new Date().toISOString().slice(0, 10)}`,
    script,
    category: "market_update",
  })
  if (!created.success || !created.episode?.id) {
    return { success: false, error: created.error ?? "Could not create the podcast episode" }
  }

  // Render the audio (TTS → storage). The episode exists even if audio fails
  // (e.g. the agent hasn't set up a voice clone yet).
  // WAVE 153 (153P): the refurbished episode carries its LINEAGE (the original's URL) and its LICENSE (or idea_only).
  await logRepurpose(supabase, { brokerageId: ctx.brokerageId, sourceType: "video_url", sourceId: created.episode.id, outputType: "podcast_episode", outputRefTable: "podcast_episodes", outputRefId: created.episode.id, platformTarget: "podcast", status: "generated", approvalStatus: "pending_review", notes: `lineage ${rights.lineage} · license ${rights.license}`, createdBy: ctx.userId })
  const audio = await generatePodcastAudio(created.episode.id).catch(() => null)
  return {
    success: true,
    episodeId: created.episode.id,
    error: audio && !audio.success ? audio.error : undefined,
  }
}
