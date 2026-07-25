/**
 * lib/video/avatar-explainer.ts
 *
 * TEAMMATE VIDEO lane — avatar/explainer videos for real-estate marketing.
 * Remotion + D-ID avatars + ElevenLabs voice clones ONLY (no HeyGen — that
 * provider is decommissioned platform-wide; see provider-posture
 * DECOMMISSIONED_PROVIDERS).
 *
 * This module COMMISSIONS a teammate explainer video and hands it to the
 * EXISTING Director rail — it deliberately owns no parallel pipeline:
 *
 *   commissionAvatarExplainer (here)
 *     → ai_video_projects row  (video_type='avatar_explainer',
 *                               status='remotion_pending',
 *                               approval_status='pending_review')
 *     → director-reel-render cron   (D-ID submit with the tenant's ElevenLabs
 *                                    voice — submitOnly; graceful park when the
 *                                    agent has no avatar configured)
 *     → poll-did-videos cron        (completion + avatar→composition handoff
 *                                    via lib/video/avatar-render-orchestrator)
 *     → composition-render-queue    (Remotion render of the brand-kit frames:
 *                                    TeammateExplainerReel / AgentExplainerReel)
 *     → render-composition          (flips the project to 'completed' with the
 *                                    branded composite URL)
 *     → unified approval queue      (approval_status='pending_review' — the
 *                                    SAME human gate every commissioned video
 *                                    rides; publish refuses anything else)
 *
 * HONESTY RULES (owner directives):
 *   · The narration + on-screen copy are AI-AUTHORED per tenant in the brand
 *     voice (generateClientMessage idiom: AI gateway + resolveBrandContext +
 *     compliance redraft). There is NO canned script fallback — if authoring
 *     or the compliance gate fails, the commission is BLOCKED, not faked.
 *   · Provider acceptance is the only "rendering/done" truth. No D-ID key →
 *     the job lands at status='awaiting_provider' (never a fake success);
 *     resumeAwaitingProviderExplainers() un-parks it once the key exists.
 *   · Voice: the agent's ElevenLabs clone when configured; else the brokerage
 *     assistant voice; else a STOCK ElevenLabs voice labeled as such; else
 *     (no ElevenLabs at all) D-ID's default TTS, labeled as such.
 *
 * Top-level imports are type-only / pure so the preset list is importable
 * from client components; all server work happens behind dynamic imports
 * (same pattern as lib/video/video-director.ts).
 */

// ─── Topic presets — TOPICS ONLY (client-safe module; re-exported here) ──────

import {
  AVATAR_EXPLAINER_PRESETS,
  type AvatarExplainerPreset,
  type ExplainerVoiceSource,
} from "@/lib/video/avatar-explainer-presets"

export { AVATAR_EXPLAINER_PRESETS }
export type { AvatarExplainerPreset, ExplainerVoiceSource }

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExplainerContent {
  eyebrow: string
  title: string
  bullets: [string, string, string]
  ctaLabel: string
  /** The narration the avatar speaks (D-ID + ElevenLabs). ~55-75 words. */
  narration: string
}

export type AuthorExplainerResult =
  | { ok: true; content: ExplainerContent }
  | { ok: false; reason: string; violations?: string[] }

export interface AvatarExplainerReadiness {
  /** DID_API_KEY present — without it a commission parks at 'awaiting_provider'. */
  didConfigured: boolean
  /** ELEVENLABS_API_KEY present (voice-clone / stock-voice lane). */
  elevenlabsConfigured: boolean
  /** The agent has a D-ID avatar source (actor id or photo/video). */
  presenterReady: boolean
  /** True when a REAL talking-head AVATAR (D-ID actor id) is on file — the
   *  explainer animates the avatar (/expressives). When false, only a still
   *  photo exists and D-ID animates the photo (/talks); set up the Twin Studio
   *  avatar for a true talking head. */
  hasAvatar: boolean
  /** Where the narration voice will come from — labeled honestly. */
  voiceSource: ExplainerVoiceSource
  voiceId: string | null
  /** Agent photo used by the composition's PIP/fallback frames. */
  agentPhotoUrl: string | null
  /** True when a commission would start rendering immediately. */
  canRenderNow: boolean
}

export interface CommissionAvatarExplainerParams {
  brokerageId: string
  /** users.id of the agent (ai_video_projects.agent_id FK → users.id). */
  agentUserId: string
  /** Plain-language topic (from a preset seed or typed by the agent). */
  topic: string
  /** Who the video is for (e.g. "first-time buyers"). */
  audience: string
  /** Optional preset id — recorded for analytics; content is AI-authored. */
  presetId?: AvatarExplainerPreset["id"] | null
  listingId?: string | null
}

export type CommissionAvatarExplainerResult =
  | {
      ok: true
      /** 'staged' → the Director rail picks it up on the next cron tick.
       *  'awaiting_provider' → honest park (no D-ID key configured). */
      status: "staged" | "awaiting_provider"
      videoProjectId: string
      compositionId: string
      voiceSource: ExplainerVoiceSource
      warnings: string[]
    }
  | { ok: false; status: "blocked" | "failed"; reason: string; violations?: string[] }

// ─── Provider / voice readiness ──────────────────────────────────────────────

function didKeyConfigured(): boolean {
  return !!process.env.DID_API_KEY
}
function elevenlabsKeyConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY
}

/**
 * Resolve provider + presenter + voice readiness for the teammate lane.
 * Voice cascade (labeled, never silent): agent clone → brokerage assistant →
 * stock ElevenLabs (labeled) → D-ID default TTS (labeled). This mirrors what
 * the render cron will actually do (lib/video/module-voice.resolveVideoVoiceId
 * applies the same stock fallback), so the label always matches the render.
 */
export async function getAvatarExplainerReadiness(
  args: { brokerageId: string; agentUserId: string },
): Promise<AvatarExplainerReadiness> {
  const { resolveAgentPresenterMedia } = await import("@/lib/video/presenter-media")
  const { resolveAssistantVoiceId, STOCK_VIDEO_VOICE_ID } = await import("@/lib/video/module-voice")

  const presenter = await resolveAgentPresenterMedia(args)

  let voiceSource: ExplainerVoiceSource
  let voiceId: string | null
  if (presenter.voiceId) {
    voiceSource = "agent_clone"
    voiceId = presenter.voiceId
  } else {
    const assistant = await resolveAssistantVoiceId(args.brokerageId).catch(() => null)
    if (assistant) {
      voiceSource = "brokerage_assistant"
      voiceId = assistant
    } else if (elevenlabsKeyConfigured()) {
      voiceSource = "stock_elevenlabs"
      voiceId = STOCK_VIDEO_VOICE_ID
    } else {
      voiceSource = "did_default"
      voiceId = null
    }
  }

  const didConfigured = didKeyConfigured()
  return {
    didConfigured,
    elevenlabsConfigured: elevenlabsKeyConfigured(),
    presenterReady: presenter.canRender,
    // A real avatar (actor id) → talking head; only a photo → animated photo.
    hasAvatar: !!presenter.actorId,
    voiceSource,
    voiceId,
    agentPhotoUrl: presenter.avatarImageUrl,
    canRenderNow: didConfigured && presenter.canRender,
  }
}

// ─── AI-authored content (brand voice, compliance-gated, never canned) ───────

function parseExplainerJson(text: string): ExplainerContent | null {
  try {
    let s = text.trim()
    if (s.startsWith("```json")) s = s.slice(7)
    if (s.startsWith("```")) s = s.slice(3)
    if (s.endsWith("```")) s = s.slice(0, -3)
    const obj = JSON.parse(s.trim()) as Record<string, unknown>
    const eyebrow = typeof obj.eyebrow === "string" ? obj.eyebrow.trim() : ""
    const title = typeof obj.title === "string" ? obj.title.trim() : ""
    const ctaLabel = typeof obj.cta === "string" ? obj.cta.trim() : ""
    const narration = typeof obj.narration === "string" ? obj.narration.trim() : ""
    const rawBullets = Array.isArray(obj.bullets) ? obj.bullets : []
    const bullets = rawBullets.filter((b): b is string => typeof b === "string" && !!b.trim()).map((b) => b.trim())
    if (!eyebrow || !title || !ctaLabel || !narration || bullets.length !== 3) return null
    return { eyebrow, title, bullets: [bullets[0], bullets[1], bullets[2]], ctaLabel, narration }
  } catch {
    return null
  }
}

const PRICE_FIGURE = /\$\s?\d|\b\d{3,}\s?(?:k|grand)\b/i

/**
 * Author the full explainer content (eyebrow / title / 3 bullets / CTA /
 * narration) via the AI gateway in the tenant's brand voice. Reuses the
 * generateClientMessage family: resolveBrandContext for identity + tone,
 * brand_voice_profile guidelines, runWithComplianceRedraft with the shared
 * Fair-Housing guard. NO canned fallback — a failed draft blocks the
 * commission instead of shipping something the tenant never wrote.
 */
export async function authorExplainerContent(args: {
  brokerageId: string
  agentUserId?: string | null
  topic: string
  audience: string
  eyebrowHint?: string | null
}): Promise<AuthorExplainerResult> {
  try {
    const [{ resolveBrandContext }, { runWithComplianceRedraft }, { hasFairHousingViolation, sanitizeProperNoun }, { generateTextRouted }, { createServiceClient }] =
      await Promise.all([
        import("@/lib/branding/resolve-brand-context"),
        import("@/lib/kernel/compliance-redraft"),
        import("@/lib/compliance/client-text-guard"),
        import("@/lib/ai/models"),
        import("@/lib/supabase/service"),
      ])

    const brand = await resolveBrandContext({
      brokerageId: args.brokerageId,
      agentUserId: args.agentUserId ?? null,
    }).catch(() => null)
    const agentName = sanitizeProperNoun(brand?.agentName ?? brand?.displayName, 60) ?? "Your Agent"

    // Brand voice guidelines — the same brand_voice_profile block the video
    // script generator injects (loadBrandVoicePrompt idiom).
    let brandVoiceBlock = ""
    try {
      const svc = createServiceClient()
      const { data: bvp } = await svc
        .from("brand_voice_profile")
        .select("tone, formality_level, key_brand_messages, preferred_words, prohibited_words, tagline")
        .eq("brokerage_id", args.brokerageId)
        .eq("is_active", true)
        .maybeSingle()
      if (bvp) {
        brandVoiceBlock = `
Brand voice guidelines (follow strictly):
- Tone: ${(bvp as any).tone ?? "professional"}
- Formality: ${(bvp as any).formality_level ?? "moderate"}
${(bvp as any).key_brand_messages?.length ? `- Key messages to reinforce: ${(bvp as any).key_brand_messages.join("; ")}` : ""}
${(bvp as any).preferred_words?.length ? `- Preferred words/phrases: ${(bvp as any).preferred_words.join(", ")}` : ""}
${(bvp as any).prohibited_words?.length ? `- NEVER use these words/phrases: ${(bvp as any).prohibited_words.join(", ")}` : ""}
${(bvp as any).tagline ? `- Brand tagline (may reference): ${(bvp as any).tagline}` : ""}`
      }
    } catch { /* best-effort — brand context still applies */ }

    const basePrompt = `You are ${agentName}, a real estate professional, creating a short explainer video for ${args.audience}.

TOPIC: ${args.topic}

Return ONLY valid JSON (no markdown, no extra text):
{"eyebrow": "...", "title": "...", "bullets": ["...", "...", "..."], "cta": "...", "narration": "..."}

Field rules:
- eyebrow: 1-3 words, uppercase-friendly category label${args.eyebrowHint ? ` (suggested: "${args.eyebrowHint}")` : ""}.
- title: 4-8 words — the "what you'll learn" hook.
- bullets: EXACTLY three, each 6-14 words — the three concrete takeaways.
- cta: 2-4 words (e.g. "Book a consult").
- narration: 55-75 words the presenter speaks on camera — conversational,
  first person, covers the three takeaways in order, ends by inviting the CTA.
  No stage directions, no emojis, plain spoken sentences only.

Non-negotiable rules:
- THEM-FIRST: 60%+ "you/your" vs "I/we/our". Warm, specific, conversational.
- ZERO Fair Housing risk: never reference or imply race, color, religion, sex,
  familial status (kids/families), national origin, disability, age, or sexual
  orientation; never "perfect for", "great for families", "safe neighborhood",
  "good schools", "quiet neighborhood".
- ZERO pushy phrasing: no "act now", "limited time", "don't miss out".
- NEVER guarantee a price, appraisal, ROI, or sale outcome.
- NEVER state a specific price, dollar amount, or rate — the agent adds
  figures during review if needed.${brandVoiceBlock}

Return the JSON now.`

    const result = await runWithComplianceRedraft({
      draft: async ({ violations }) => {
        const fb = violations.length
          ? `\n\nYour previous draft violated these — fix EACH: ${violations.join("; ")}`
          : ""
        const { text } = await generateTextRouted({
          feature: "video_script_generation",
          brokerageId: args.brokerageId,
          prompt: basePrompt + fb,
          temperature: violations.length ? 0.4 : 0.7,
          maxTokens: 700,
        } as Parameters<typeof generateTextRouted>[0])
        return text
      },
      gate: async (text) => {
        const v: string[] = []
        const parsed = parseExplainerJson(text)
        if (!parsed) v.push("output was not the required JSON shape (eyebrow/title/3 bullets/cta/narration)")
        const flat = parsed
          ? [parsed.eyebrow, parsed.title, ...parsed.bullets, parsed.ctaLabel, parsed.narration].join("\n")
          : text
        if (hasFairHousingViolation(flat)) v.push("protected-class / steering language")
        if (PRICE_FIGURE.test(flat)) v.push("stated a specific price/number — remove all figures")
        return { allowed: v.length === 0, violations: v }
      },
    })

    if (!result.ok) {
      return {
        ok: false,
        reason: "AI authoring failed the compliance gate — nothing canned is ever substituted; adjust the topic and try again",
        violations: result.violations,
      }
    }
    const content = parseExplainerJson(result.script)
    if (!content) {
      return { ok: false, reason: "AI authoring returned an unusable draft — try again" }
    }
    return { ok: true, content }
  } catch (e) {
    return { ok: false, reason: `AI authoring unavailable: ${(e as Error).message}` }
  }
}

// ─── Commission — stage onto the EXISTING Director rail ──────────────────────

/** Preferred brand-kit frame composition; falls back to the registered
 *  AgentExplainerReel when the m274 registry row hasn't been applied yet. */
export const TEAMMATE_EXPLAINER_COMPOSITION_ID = "TeammateExplainerReel"
const FALLBACK_COMPOSITION_ID = "AgentExplainerReel"

async function pickCompositionId(): Promise<string> {
  try {
    const { getComposition } = await import("@/lib/remotion/registry")
    const row = await getComposition(TEAMMATE_EXPLAINER_COMPOSITION_ID)
    if (row && row.is_active) return TEAMMATE_EXPLAINER_COMPOSITION_ID
  } catch { /* registry unreachable — fall back */ }
  return FALLBACK_COMPOSITION_ID
}

export async function commissionAvatarExplainer(
  params: CommissionAvatarExplainerParams,
): Promise<CommissionAvatarExplainerResult> {
  if (!params.brokerageId || !params.agentUserId) {
    return { ok: false, status: "failed", reason: "brokerageId + agentUserId required" }
  }
  const topic = (params.topic ?? "").trim()
  const audience = (params.audience ?? "").trim() || "your clients"
  if (topic.length < 3) {
    return { ok: false, status: "failed", reason: "a topic is required" }
  }

  const warnings: string[] = []
  const readiness = await getAvatarExplainerReadiness({
    brokerageId: params.brokerageId,
    agentUserId: params.agentUserId,
  })

  // 1. AI-author the content (brand voice + compliance gate). Blocking — no
  //    canned fallback ever ships.
  const preset = AVATAR_EXPLAINER_PRESETS.find((p) => p.id === params.presetId) ?? null
  const authored = await authorExplainerContent({
    brokerageId: params.brokerageId,
    agentUserId: params.agentUserId,
    topic,
    audience,
    eyebrowHint: preset?.eyebrow ?? null,
  })
  if (!authored.ok) {
    return { ok: false, status: "blocked", reason: authored.reason, violations: authored.violations }
  }
  const content = authored.content

  // 2. Brand kit for the Remotion frames (live tenant tables — never presets).
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { resolveReelBrand } = await import("@/lib/video/reel-brand")
  const brand = await resolveReelBrand(svc, params.brokerageId)

  const { resolveBrandContext } = await import("@/lib/branding/resolve-brand-context")
  const brandCtx = await resolveBrandContext({
    brokerageId: params.brokerageId,
    agentUserId: params.agentUserId,
  }).catch(() => null)
  const agentName = brandCtx?.agentName ?? brandCtx?.displayName ?? "Your Agent"

  const compositionId = await pickCompositionId()
  if (compositionId === FALLBACK_COMPOSITION_ID) {
    warnings.push("TeammateExplainerReel is not registered yet (migration m274 pending) — using AgentExplainerReel frames")
  }

  // 3. Input props — the union both compositions understand. avatarVideoUrl is
  //    wired in by the avatar-render-orchestrator when the D-ID clip completes.
  const inputProps: Record<string, unknown> = {
    eyebrow: content.eyebrow,
    title: content.title,
    bullets: content.bullets,
    ctaLabel: content.ctaLabel,
    agentName,
    agentPhotoUrl: readiness.agentPhotoUrl,
    avatarVideoUrl: null,
    // Sound-off captions from the narration (word-accurate cues arrive only
    // when the alignment pass ran; the script fallback is honest estimation).
    captionScript: content.narration,
    brand: {
      primaryColor: brand.primaryColor,
      accentColor: brand.accentColor,
      logoUrl: brand.logoUrl ?? undefined,
      brokerageName: brand.brokerageName,
      showEhoMark: brand.showEhoMark,
    },
  }

  // 4. Honest provider gate — no D-ID key means the job PARKS, visibly.
  const status = readiness.didConfigured ? "remotion_pending" : "awaiting_provider"
  if (!readiness.didConfigured) {
    warnings.push("D-ID is not configured — the job is parked at 'awaiting provider' and will start once the platform D-ID key is set")
  }
  if (!readiness.presenterReady) {
    warnings.push("no avatar configured yet — the render worker will park the job and notify the agent to finish Settings → Voice & Avatar")
  }
  if (readiness.voiceSource === "stock_elevenlabs") {
    warnings.push("no voice clone configured — narration will use a stock ElevenLabs voice")
  } else if (readiness.voiceSource === "did_default") {
    warnings.push("ElevenLabs is not configured — narration will use D-ID's default TTS voice")
  }

  const now = new Date().toISOString()
  const row = {
    brokerage_id: params.brokerageId,
    agent_id: params.agentUserId,
    listing_id: params.listingId ?? null,
    contact_id: null,
    title: `Teammate explainer — ${content.title}`.slice(0, 200),
    script_content: content.narration,
    status,
    video_type: "avatar_explainer",
    format: "1:1",
    audience_type: "customer_facing",
    is_ai_generated: true,
    video_provider: "did",
    approval_status: "pending_review", // the unified queue's gate — never auto-approved
    compliance_status: "passed",       // the redraft gate above pre-cleared the copy
    compliance_violations: [],
    compliance_evaluated_at: now,
    brand_voice_context: {},
    video_metadata: {
      // director_key + needs_avatar are what the EXISTING director-reel-render
      // cron keys on — this row rides that rail, not a parallel one.
      director_key: `avatar_explainer:${params.agentUserId}:${params.presetId ?? "custom"}:${Date.now()}`,
      needs_avatar: true,
      situation_kind: "explainer",
      voice: "agent_own",
      requested_via: "video_studio",
      lane: "avatar_explainer",
      topic,
      audience,
      preset_id: params.presetId ?? null,
      voice_source: readiness.voiceSource,
      ...(readiness.didConfigured ? {} : { awaiting_provider: "did" }),
    },
    provider_metadata: {
      composition_id: compositionId,
      input_props: inputProps,
    },
    error_message: readiness.didConfigured
      ? null
      : "awaiting provider: DID_API_KEY is not configured — no render was submitted",
    created_at: now,
    updated_at: now,
  }

  let inserted: { id: string } | null = null
  {
    const res = await svc.from("ai_video_projects").insert(row).select("id").maybeSingle()
    if (res.error && /video_type_check|23514/.test(`${res.error.code} ${res.error.message}`)) {
      // Vocabulary drift guard: m274 (adds 'avatar_explainer' to the CHECK) not
      // applied yet. Degrade to the closest allowed type and keep the true
      // intent on video_metadata so nothing is silently mislabeled.
      const retry = await svc
        .from("ai_video_projects")
        .insert({
          ...row,
          video_type: "education",
          video_metadata: { ...row.video_metadata, video_type_intent: "avatar_explainer" },
        })
        .select("id")
        .maybeSingle()
      if (retry.error || !retry.data) {
        return { ok: false, status: "failed", reason: retry.error?.message ?? "insert failed" }
      }
      warnings.push("video_type constraint predates 'avatar_explainer' (migration m274 pending) — stored as 'education' with video_type_intent marker")
      inserted = retry.data as { id: string }
    } else if (res.error || !res.data) {
      return { ok: false, status: "failed", reason: res.error?.message ?? "insert failed" }
    } else {
      inserted = res.data as { id: string }
    }
  }

  return {
    ok: true,
    status: readiness.didConfigured ? "staged" : "awaiting_provider",
    videoProjectId: inserted.id,
    compositionId,
    voiceSource: readiness.voiceSource,
    warnings,
  }
}

// ─── Un-park awaiting-provider jobs once D-ID is configured ──────────────────

/**
 * Flip this brokerage's parked teammate-explainer jobs
 * (status='awaiting_provider') back onto the Director rail once DID_API_KEY
 * exists. Called best-effort from the studio readiness action so simply
 * opening the create surface after configuring the provider resumes them.
 * Never throws.
 */
export async function resumeAwaitingProviderExplainers(
  brokerageId: string,
): Promise<{ resumed: number }> {
  if (!didKeyConfigured() || !brokerageId) return { resumed: 0 }
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data } = await svc
      .from("ai_video_projects")
      .update({ status: "remotion_pending", error_message: null, updated_at: new Date().toISOString() })
      .eq("brokerage_id", brokerageId)
      .eq("status", "awaiting_provider")
      .contains("video_metadata", { lane: "avatar_explainer" })
      .select("id")
    return { resumed: (data ?? []).length }
  } catch {
    return { resumed: 0 }
  }
}
