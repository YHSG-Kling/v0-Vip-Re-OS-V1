/**
 * lib/voice-distiller/per-agent-voice.ts
 *
 * Wave 36.5 — per-agent voice profile distiller. Pulls the agent's
 * historical newsletters + blog posts + social posts from the last
 * 90 days, prompts Anthropic to extract a structured voice profile
 * (tone / formality / prohibited words / preferred phrases / tagline
 * candidates / 3-6 canonical example sentences), and UPSERTs into
 * brand_voice_profile at scope_type='agent'.
 *
 * Skip semantics:
 *   - Manual rows (distilled_from_asset_ids = empty or null) are
 *     NEVER overwritten. The agent's hand-tuned settings win forever
 *     unless they explicitly opt back into auto-distill.
 *   - Recently-distilled rows (< 30d) are skipped — saves Anthropic
 *     spend without losing freshness (voice doesn't change weekly).
 *   - Agents with < 3 historical pieces total skip — not enough
 *     signal to distill reliably.
 *
 * Why this matters for direct mail:
 *   draftPostcardCopy + draftLetterCopy already build their prompt
 *   from brand_voice_profile via applyBrandVoice. With per-agent
 *   distilled rows in place, the postcard the agent's farm receives
 *   sounds like THE AGENT (their actual newsletter voice from the
 *   last quarter), not the brokerage's house style. That's the
 *   differentiator vs MoxiWorks/kvCORE — they share a brand template
 *   across every agent in the firm; we per-agent-tune from real data.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"

const SAMPLE_LOOKBACK_DAYS = 90
const MIN_SAMPLES = 3
const SKIP_IF_DISTILLED_WITHIN_DAYS = 30

export interface DistillResult {
  agentUserId:  string
  outcome:      "distilled" | "skipped_recent" | "skipped_no_samples" | "skipped_manual_row" | "failed"
  reason?:      string
  profileId?:   string
  samplesUsed?: number
}

interface VoiceProfileJson {
  tone:             string
  formality_level:  string   // "casual" | "professional" | "warm" | "direct" etc.
  preferred_words:  string[]
  prohibited_words: string[]
  tagline_candidates: string[]
  tone_examples:    string[]
  key_brand_messages: string[]
}

const DISTILL_PROMPT = `\
You are analyzing real estate agent's published writing to extract their unique voice profile so an AI copy generator can sound like THEM, not their brokerage.

Input: a JSON array of items, each with {kind, title?, body}. The kind field tells you whether the piece is a newsletter, blog post, or social post.

Task: extract the agent's voice as a STRUCTURED JSON object with these keys:
- tone (one word: "warm" | "direct" | "playful" | "authoritative" | "conversational" | "analytical" | "empathetic")
- formality_level (one word: "casual" | "professional" | "balanced")
- preferred_words: 6-12 words/short phrases the agent uses repeatedly that aren't filler. NOT every common word — the SIGNATURE ones.
- prohibited_words: 4-8 words/phrases the agent never uses (you have to INFER absence — if every other agent uses "exciting" and this one doesn't, "exciting" goes here).
- tagline_candidates: 2-4 short phrases distilled from how the agent introduces themselves or wraps up their pieces.
- tone_examples: 3-6 verbatim sentences from the input that exemplify the voice. Pull them from different pieces. Each ≤ 30 words.
- key_brand_messages: 2-4 themes the agent returns to (e.g., "every transaction is a long-term relationship", "neighborhood schools as quality-of-life proxy").

Output VALID JSON only. No prose, no markdown fences.`

interface HistoricalAsset {
  asset_id: string
  kind:     "newsletter" | "blog" | "social"
  title:    string | null
  body:     string
}

export async function distillVoiceForAgent(args: {
  brokerageId: string
  agentUserId: string
  force?:      boolean
}): Promise<DistillResult> {
  const svc = createServiceClient()

  // 1. Skip if the agent already has a MANUAL row OR a recent
  // distilled row.
  const { data: existingRow } = await svc
    .from("brand_voice_profile")
    .select("id, distilled_from_asset_ids, distilled_at, is_active")
    .eq("brokerage_id", args.brokerageId)
    .eq("agent_id", args.agentUserId)
    .eq("is_active", true)
    .maybeSingle()

  if (existingRow && !args.force) {
    const isManual = !existingRow.distilled_from_asset_ids
      || (existingRow.distilled_from_asset_ids as string[]).length === 0
    if (isManual) {
      return { agentUserId: args.agentUserId, outcome: "skipped_manual_row" }
    }
    const distilledAt = existingRow.distilled_at as string | null
    if (distilledAt) {
      const daysSince = (Date.now() - new Date(distilledAt).getTime()) / 86_400_000
      if (daysSince < SKIP_IF_DISTILLED_WITHIN_DAYS) {
        return { agentUserId: args.agentUserId, outcome: "skipped_recent", reason: `last distilled ${Math.round(daysSince)}d ago` }
      }
    }
  }

  // 2. Pull historical samples. Cap per-source so a prolific
  //    newsletter writer doesn't drown out blog + social signal.
  const since = new Date(Date.now() - SAMPLE_LOOKBACK_DAYS * 86_400_000).toISOString()
  const [newslettersR, blogsR, socialR] = await Promise.all([
    svc.from("newsletter_campaigns")
      .select("id, subject_line, body_html")
      .eq("brokerage_id", args.brokerageId)
      .eq("created_by_user_id", args.agentUserId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(6),
    svc.from("blog_posts")
      .select("id, title, body_markdown")
      .eq("brokerage_id", args.brokerageId)
      .eq("agent_user_id", args.agentUserId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(6),
    svc.from("social_posts")
      .select("id, content")
      .eq("brokerage_id", args.brokerageId)
      .eq("agent_user_id", args.agentUserId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(8),
  ])

  type NewsletterRow = { id: string; subject_line: string | null; body_html: string | null }
  type BlogRow       = { id: string; title: string | null; body_markdown: string | null }
  type SocialRow     = { id: string; content: string | null }

  const samples: HistoricalAsset[] = []
  for (const r of (newslettersR.data ?? []) as NewsletterRow[]) {
    if (!r.body_html) continue
    samples.push({
      asset_id: r.id,
      kind:     "newsletter",
      title:    r.subject_line,
      body:     r.body_html.replace(/<[^>]+>/g, " ").slice(0, 2000),
    })
  }
  for (const r of (blogsR.data ?? []) as BlogRow[]) {
    if (!r.body_markdown) continue
    samples.push({
      asset_id: r.id,
      kind:     "blog",
      title:    r.title,
      body:     r.body_markdown.slice(0, 2000),
    })
  }
  for (const r of (socialR.data ?? []) as SocialRow[]) {
    if (!r.content) continue
    samples.push({
      asset_id: r.id,
      kind:     "social",
      title:    null,
      body:     r.content.slice(0, 600),
    })
  }

  if (samples.length < MIN_SAMPLES) {
    return {
      agentUserId: args.agentUserId,
      outcome:     "skipped_no_samples",
      reason:      `${samples.length} samples; need ${MIN_SAMPLES}`,
    }
  }

  // 3. Call Anthropic.
  const promptBody = JSON.stringify(samples.map((s) => ({
    kind:  s.kind,
    title: s.title,
    body:  s.body,
  })), null, 2)

  let profile: VoiceProfileJson | null = null
  try {
    const { text } = await generateTextRouted({
      feature:     "voice_distiller",
      brokerageId: args.brokerageId,
      prompt:      `${DISTILL_PROMPT}\n\nInput pieces:\n${promptBody}\n\nReturn the JSON object now.`,
      temperature: 0.2,
      maxTokens:   1200,
    })
    profile = parseProfileJson(text)
  } catch (e) {
    return { agentUserId: args.agentUserId, outcome: "failed", reason: (e as Error).message }
  }
  if (!profile) {
    return { agentUserId: args.agentUserId, outcome: "failed", reason: "non-JSON model output" }
  }

  // 4. UPSERT into brand_voice_profile at the agent tier.
  const assetIds = samples.map((s) => s.asset_id)
  const payload = {
    brokerage_id:             args.brokerageId,
    agent_id:                 args.agentUserId,
    team_id:                  null,
    tone:                     profile.tone,
    formality_level:          profile.formality_level,
    key_brand_messages:       profile.key_brand_messages,
    prohibited_words:         profile.prohibited_words,
    preferred_words:          profile.preferred_words,
    tagline:                  profile.tagline_candidates?.[0] ?? null,
    mission_statement:        null,
    custom_instructions:      null,
    is_active:                true,
    distilled_from_asset_ids: assetIds,
    distilled_at:             new Date().toISOString(),
    tone_examples:            profile.tone_examples,
    updated_at:               new Date().toISOString(),
  }

  let profileId: string | undefined
  if (existingRow) {
    const { error } = await svc.from("brand_voice_profile")
      .update(payload)
      .eq("id", existingRow.id)
    if (error) return { agentUserId: args.agentUserId, outcome: "failed", reason: error.message }
    profileId = existingRow.id as string
  } else {
    const { data, error } = await svc.from("brand_voice_profile")
      .insert(payload)
      .select("id")
      .single()
    if (error) return { agentUserId: args.agentUserId, outcome: "failed", reason: error.message }
    profileId = data.id as string
  }

  return {
    agentUserId: args.agentUserId,
    outcome:     "distilled",
    profileId,
    samplesUsed: samples.length,
  }
}

function parseProfileJson(text: string): VoiceProfileJson | null {
  // Strip code fences if the model wrapped output.
  let s = text.trim()
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "")
  }
  const start = s.indexOf("{")
  const end   = s.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Partial<VoiceProfileJson>
    if (!obj.tone || !obj.formality_level) return null
    return {
      tone:               String(obj.tone),
      formality_level:    String(obj.formality_level),
      preferred_words:    Array.isArray(obj.preferred_words)    ? obj.preferred_words.map(String).slice(0, 16) : [],
      prohibited_words:   Array.isArray(obj.prohibited_words)   ? obj.prohibited_words.map(String).slice(0, 12) : [],
      tagline_candidates: Array.isArray(obj.tagline_candidates) ? obj.tagline_candidates.map(String).slice(0, 6) : [],
      tone_examples:      Array.isArray(obj.tone_examples)      ? obj.tone_examples.map(String).slice(0, 8) : [],
      key_brand_messages: Array.isArray(obj.key_brand_messages) ? obj.key_brand_messages.map(String).slice(0, 6) : [],
    }
  } catch {
    return null
  }
}
