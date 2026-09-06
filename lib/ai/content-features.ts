/**
 * lib/ai/content-features.ts
 *
 * THE ONE FEATURE VOCABULARY THAT CONNECTS THE TWO CONTENT-GENERATION LANES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * There are two content-generation lanes, and they are NOT duplicates
 * (docs/content-generation-audit.md establishes that at length — one is a
 * draft-only generator carrying a guard-enforced Fair Housing video path, the
 * other is a persisted lifecycle system across seven tables). What they were
 * was DISCONNECTED: ask "what has this brokerage's AI generated, and what did
 * it cost?" and the answer depended on which lane you asked, because the two
 * lanes stamped their AI calls with two different feature vocabularies.
 *
 *   Lane B  app/actions/ai-content-generation.tsx
 *           feature: "listing_description" | "blog_post_generation" |
 *                    "social_post_generation" | "email_generation" | …
 *           → 5 of 5 are real AI_TASK_ROUTING keys.
 *
 *   Lane A  lib/content-generation/content-generator.ts
 *           feature: `content_generation_${content_type}`,
 *                    "content_generation_audio", "content_generation_video",
 *                    "content_generation_image_prompt"
 *           → 0 of 10 are AI_TASK_ROUTING keys. Verified by extracting the
 *             table's 50 keys and testing membership, not by reading.
 *
 * TWO CONSEQUENCES, BOTH REAL:
 *
 *   1. ROUTING. selectModelForTask() misses on every Lane A feature, so Lane A
 *      never got the model the routing table designates for its task. The worst
 *      case is `content_generation_video`: that is the fifth guarded Fair
 *      Housing script path (scripts/video-script-compliance-guard.ts names the
 *      file), and it missed `video_script_generation` — "claude-sonnet …  brand
 *      voice, persona-aware, Them-First scored" — falling through to the static
 *      default instead.
 *
 *   2. LEDGER. Every AI call writes ai_tool_usage (lib/ai/cost-tracking.ts
 *      logAIUsage, called from generateAIResponse) with its feature string.
 *      That is the platform's ONE cost ledger — real provider token counts, the
 *      dated provider price table, brokerage/team/agent dimensions, the monthly
 *      aggregate RPC and the fair-use counter all hang off it. With two
 *      vocabularies, no single query could ask "content generation" and get
 *      both lanes.
 *
 * Keying both lanes to the SAME registry fixes both at once: Lane A gets routed,
 * and one `feature IN (…)` predicate finally spans the whole content surface.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS A NAME MAP, NOT A NEW REGISTRY.
 *
 * Every string below is an EXISTING key in AI_TASK_ROUTING (lib/ai/models.ts).
 * Nothing here invents a feature. If you add one, add it to AI_TASK_ROUTING
 * first — an unrouted feature is exactly the bug this file closes, and
 * scripts/content-lane-ledger-simulator.ts fails if any member of
 * CONTENT_GENERATION_FEATURES is missing from the routing table.
 *
 * No "use server" and no imports: this is plain data, so both a server action
 * and a simulator can read it without pulling the AI stack (models.ts is
 * server-only) into their module graph.
 */

/**
 * Lane A's content_type union → the routing key that governs that task.
 *
 * Source union: lib/content-generation/content-generator.ts
 * ContentGenerationParams["content_type"].
 *
 * `image_prompt` maps to the generic `generate_text` rather than to an image
 * feature on purpose: Lane A's image path produces a PROMPT STRING for an
 * external tool, not an image (docs/content-generation-audit.md §3.3). Routing
 * it to `property_image_analysis` would describe work the function does not do.
 */
export const CONTENT_TYPE_FEATURE: Record<string, string> = {
  email:               "email_generation",
  newsletter:          "newsletter_generation",
  sms_script:          "sms_generation",
  direct_mail:         "direct_mail_copy",
  blog:                "blog_post_generation",
  social_post:         "social_post_generation",
  listing_description: "listing_description",
  ad_copy:             "social_post_generation",
  podcast_script:      "video_script_generation",
  video_script:        "video_script_generation",
  audio_script:        "video_script_generation",
  image_prompt:        "generate_text",
}

/**
 * Resolve a Lane A content_type to its routing feature.
 *
 * Falls back to `generate_text` — a REAL routing key — rather than
 * synthesizing `content_generation_${type}`, which is precisely the unrouted
 * string this module exists to stop producing.
 */
export function contentFeatureForType(contentType: string): string {
  return CONTENT_TYPE_FEATURE[contentType] ?? "generate_text"
}

/**
 * Every feature that counts as CONTENT GENERATION, across both lanes.
 *
 * This is the predicate the content cost/volume surface filters ai_tool_usage
 * by. It is deliberately narrower than "all AI spend": the content panel should
 * answer for content, not for voice calls, CMAs or lead scoring, which also
 * write ai_tool_usage.
 *
 * Membership rule — a feature belongs here when a content ARTIFACT is what the
 * call produces. Two deliberate exclusions:
 *   · `tag_classification` — Lane B calls it while filing content, but it
 *     classifies; it does not generate.
 *   · `generate_text` — the generic fallback. It is a real routing key and the
 *     honest destination for Lane A's image_prompt path (a prompt string is
 *     text), but it is used across the whole product, so counting it here would
 *     sweep unrelated AI spend into the content panel.
 */
export const CONTENT_GENERATION_FEATURES: readonly string[] = [
  "email_generation",
  "newsletter_generation",
  "sms_generation",
  "direct_mail_copy",
  "blog_post_generation",
  "social_post_generation",
  "listing_description",
  "video_script_generation",
]

/** Is this ai_tool_usage row a content generation? */
export function isContentFeature(feature: string | null | undefined): boolean {
  return !!feature && CONTENT_GENERATION_FEATURES.includes(feature)
}
