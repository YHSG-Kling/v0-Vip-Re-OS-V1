// lib/video/approval-render-plan.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PURE HALF OF RENDER-FROM-APPROVAL (wave 87, lane 87D).
//
// OWNER (2026-09-28): avatar + automated videos are the most important
// capability; "d-id is always first and the perferred". Lane 86F3 left the
// open item: "render-from-approval needs an avatar choice + a session-free
// render path". The server-only core (lib/video/render-from-approval.ts) does
// the I/O; everything it DECIDES lives here so a proof can execute it with no
// database:
//
//   1. THE HOST — the agent's own D-ID twin FIRST (resolveAgentPresenterMedia
//      canRender, and — for a video-sourced face — a verified consent, the ONE
//      gate lib/did/avatar-consent-gate.ts). No twin, or a twin D-ID would
//      refuse → the VOICEOVER host (the agent's voice under kinetic text).
//      Never a stock stranger, never a guessed avatar id.
//   2. THE SHAPE — the archetype by rule (lib/video/custom-video-archetypes.ts
//      planCustomVideo), hinted by the library script_type and the host, then
//      checked against the purpose band: a human-approved script is NEVER
//      trimmed to fit, so a script longer than every band on its host is
//      REFUSED with the reason (the agent edits and re-approves).
//   3. THE SCREEN — hook / title / three beats cut VERBATIM from the approved
//      text (lib/video/script-structure.ts onScreenCopyFromScript); no model
//      writes words on screen nobody approved.
//   4. THE KEY — one render per (script, approved text); a failed attempt is
//      retried under a new attempt number, a live one is never duplicated.
//
// PURE. No I/O.

import { planCustomVideo, type CustomVideoArchetype, type CustomVideoPlan } from "./custom-video-archetypes"
import { spokenSecondsForWords, type HostKind } from "./duration-model"
import type { BodyVisualAssets, BodyVisualRuleOverride } from "./body-visual-model"
import { assessScriptStructure, onScreenCopyFromScript, spokenWords, type OnScreenCopy, type ScriptStructureAssessment } from "./script-structure"
import { topicVideoContent } from "./topic-video"

/** The library row fields this plan reads (video_scripts_library, scripts/schema-snapshot.ts). */
export interface ApprovedScriptRow {
  id: string
  title: string | null
  script_content: string | null
  script_type: string | null
  listing_id?: string | null
  contact_id?: string | null
}

// ─── 1. THE HOST ─────────────────────────────────────────────────────────────

export interface TwinReadiness {
  /** resolveAgentPresenterMedia(...).canRender — an actor id or an avatar source exists. */
  canRender: boolean
  /** The consent gate's verdict for the source D-ID would be handed (true for a photo / minted actor). */
  consentOk: boolean
  /** Why not, when not — a sentence the agent can act on. */
  reason?: string | null
}

export interface HostChoice { host: Extract<HostKind, "avatar" | "voiceover">; reason: string }

/** D-ID FIRST. The avatar host only when the twin can render AND D-ID would accept it. */
export function chooseApprovalRenderHost(twin: TwinReadiness): HostChoice {
  if (twin.canRender && twin.consentOk) return { host: "avatar", reason: "the agent's D-ID twin is ready — D-ID first" }
  if (twin.canRender && !twin.consentOk) {
    return { host: "voiceover", reason: `the agent's twin is video-sourced with no verified D-ID consent — voiceover instead (${twin.reason ?? "consent required"})` }
  }
  return { host: "voiceover", reason: `no D-ID twin ready — voiceover instead${twin.reason ? ` (${twin.reason})` : ""}` }
}

// ─── 2. THE SHAPE ────────────────────────────────────────────────────────────

/** Who a library script_type speaks to — a SITUATION, never a people-group (Fair Housing). */
const AUDIENCE_BY_SCRIPT_TYPE: Record<string, string> = {
  agent_intro: "people choosing an agent to help them buy or sell",
  buyer_education: "people shopping for a home",
  listing_presentation: "homeowners deciding how to sell",
  market_update: "homeowners and shoppers following the local market",
  property_tour: "people shopping for a home",
}

/** The compliance side a script_type is graded as (postcheckScript's journey). */
export function approvalScriptSide(scriptType: string | null | undefined): "buyer" | "seller" {
  return scriptType === "listing_presentation" ? "seller" : "buyer"
}

/**
 * The archetypes tried, in order, per host. The hint is the FIRST choice; the
 * next is the fallback when the approved script is longer than the first's
 * band (a 70-second intro is carried as an explainer, 30-90 s, rather than
 * refused at the welcome band's 60 s). Every entry is re-validated by
 * planCustomVideo (hosts derived from the registry, needs checked).
 */
export function approvalArchetypeOrder(scriptType: string | null | undefined, host: HostChoice["host"]): CustomVideoArchetype[] {
  if (host === "avatar") {
    return scriptType === "agent_intro"
      ? ["talking_head_message", "education_explainer"]
      : ["education_explainer", "talking_head_message"]
  }
  return ["voiceover_explainer"]
}

export type ApprovalRenderPlanResult =
  | { ok: true; plan: CustomVideoPlan; copy: OnScreenCopy; structure: ScriptStructureAssessment; spokenSeconds: number; words: number }
  | { ok: false; reason: string; structure: ScriptStructureAssessment | null }

/**
 * PURE. Plan the render of one approved script on one host. Refuses (never
 * trims) a script longer than the band of every archetype the host can carry.
 */
export function planApprovalRender(
  row: ApprovedScriptRow,
  host: HostChoice["host"],
  opts: { overrides?: readonly BodyVisualRuleOverride[] | null } = {},
): ApprovalRenderPlanResult {
  const script = (row.script_content ?? "").trim()
  if (!script) return { ok: false, reason: `video script ${row.id} has no content to render`, structure: null }
  const structure = assessScriptStructure(script)
  const words = spokenWords(script).length
  const spokenSeconds = spokenSecondsForWords(words, host)
  const copy = onScreenCopyFromScript(script, row.title)
  const assets: BodyVisualAssets = {
    avatarClip: host === "avatar", brollClips: 0, propertyPhotos: 0, screenshots: 0,
    statCards: 0, clientFootage: 0, chartData: false,
  }
  const audience = AUDIENCE_BY_SCRIPT_TYPE[row.script_type ?? ""] ?? "people buying or selling a home"
  const tried: string[] = []
  for (const archetype of approvalArchetypeOrder(row.script_type, host)) {
    const planned = planCustomVideo({
      audience,
      goal: `${row.title ?? copy.hook} — ${(row.script_type ?? "video").replace(/_/g, " ")}`,
      host,
      lengthWishSeconds: spokenSeconds,
      assets,
      archetypeHint: archetype,
      content: {},
      listingId: row.listing_id ?? null,
      targetChannel: "instagram",
    }, { overrides: opts.overrides ?? null })
    if (!planned.ok) { tried.push(`${archetype}: ${planned.reason}`); continue }
    if (spokenSeconds > planned.plan.band.maxSeconds) {
      tried.push(`${archetype}: the approved script speaks ~${Math.round(spokenSeconds)}s, over the ${planned.plan.purpose} band's ${planned.plan.band.maxSeconds}s`)
      continue
    }
    const content = approvalRenderContent(planned.plan.compositionId, copy)
    return { ok: true, plan: { ...planned.plan, content }, copy, structure, spokenSeconds, words }
  }
  return {
    ok: false,
    reason: `the approved script (${words} words, ~${Math.round(spokenSeconds)}s on the ${host} host) fits no video shape — it is never trimmed after approval; shorten it and approve again. Tried: ${tried.join(" | ")}`,
    structure,
  }
}

/**
 * The composition content for an approved script — the topic runner's builder
 * (lib/video/topic-video.ts topicVideoContent: captionScript, title, bullets,
 * and the NewsletterDigestVideo keys) reused, never a second one; the talking
 * head's persistent on-screen `caption` strip is the TOPIC (the title), not the
 * whole script — the CaptionLayer already carries every spoken word, and the
 * lane's real render showed a hook-valued strip repeating the first caption
 * line word for word above it.
 */
export function approvalRenderContent(compositionId: string, copy: OnScreenCopy): Record<string, unknown> {
  const base = topicVideoContent(compositionId, copy)
  // The FULL approved text is what the voice speaks — narrationScript is the
  // key the duration model and the body-visual planner size the body from.
  const withNarration: Record<string, unknown> = { ...base, narrationScript: copy.script }
  if (compositionId === "AgentTalkingHeadReel") withNarration.caption = copy.title
  return withNarration
}

// ─── 4. THE KEY ──────────────────────────────────────────────────────────────

/** A stable 32-bit FNV-1a of the approved text — a re-approved EDIT is a new render. */
export function approvedTextHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, "0")
}

/** The Director idempotency discriminator for one approved script. */
export function approvalRenderDiscriminator(scriptId: string, text: string, priorFailedAttempts: number): string {
  const attempt = Math.max(0, Math.floor(priorFailedAttempts))
  return `approved_script:${scriptId}:${approvedTextHash(text.trim())}${attempt > 0 ? `:r${attempt}` : ""}`
}

/** What a prior attempt's status means for a new approval of the same text. */
export function priorAttemptVerdict(statuses: readonly string[]): { live: boolean; failed: number } {
  const failed = statuses.filter((s) => s === "failed").length
  return { live: statuses.some((s) => s !== "failed"), failed }
}
