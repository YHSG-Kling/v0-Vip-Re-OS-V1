"use server"

/**
 * ─── TOMBSTONE ───────────────────────────────────────────────────────────────
 *
 * `app/api/ai/generate-video-script/route.ts` (603 lines, POST only) was DELETED
 * into this file. It was a marketing-video script generator that wrote
 * `video_scripts_library`, and NOTHING in the tree addressed it — not a fetch,
 * not a template literal, not a config entry, not a cron, not a DB function
 * (checked live: zero Supabase edge functions, zero pg_proc bodies containing an
 * `/api/` path).
 *
 * It was not merely unreached. It was the SIXTH video-script generator and the
 * only one outside the shared gate: `scripts/video-script-compliance-guard.ts`
 * enumerates five generators that must call `lib/video/script-compliance.ts`
 * (WIZARD = this file, VIDEO-GENERATION, LINK-TO-VIDEO, KERNEL-VIDEO,
 * CONTENT-ENGINE) and that route was in none of them — it carried its own inline
 * copy of the Fair Housing wording instead, which is exactly the divergence §6
 * forbids and the hole §5's "compliance-first" ruling exists to close.
 *
 * And it could never have worked at full size anyway. It declared ELEVEN script
 * types and wrote `script_type` through raw, while the live CHECK
 * `video_scripts_library_script_type_check` admits exactly five
 * (property_tour, buyer_education, market_update, agent_intro,
 * listing_presentation — read from `hrvaqgvukzxfskkcrwbt`, not inferred). Six of
 * its own eleven — seller_education, quick_tip, market_fact, personal_story,
 * listing_spotlight, education_bite — would have been refused 23514 on every
 * insert. This file routes every videoType through `toLibraryScriptType` for
 * precisely that reason.
 *
 * WHERE THE CAPABILITY LIVES NOW:
 *   · generation + compliance gate + saveToLibrary → `generateVideoScript`
 *     below (app/actions/video/generate-script.ts:118), behind
 *     /dashboard/videos/create.
 *   · save + tenant verification of agent/listing/contact + lifecycle row +
 *     kernel event → app/actions/video-generation.ts:174 `saveVideoScript`.
 *   · template-backed scripts and script_variations →
 *     app/actions/video-generation.ts:417 `getVideoTemplates` /
 *     app/actions/video-generation.ts:509 `createScriptVariation`.
 *   · the library CRUD HTTP surface → app/api/video-scripts/route.ts, which is
 *     live (app/dashboard/videos/library/page.tsx:436).
 *
 * MERGED ONTO THIS SURVIVOR BEFORE THE DELETE, per §1: the SCRIPT_GENERATED
 * `lifecycle_events` row and `processKernelEvent` emission — the one thing the
 * route did that this path did not. See the ordinary-save branch below.
 */

import { toLibraryScriptType } from "@/app/types/video-generation"
import { createClient } from "@/lib/supabase/server"
import { generateAIResponse } from "@/lib/ai/models"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import {
  buildComplianceSystemBlocks,
  precheckBriefForFairHousing,
  postcheckScript,
  detectFairHousingRedFlags,
  detectProhibitedPhraseRedFlags,
  escalateScriptToHumanReview,
  COMPLIANCE_UNKNOWN_PREFIX,
  type ScriptComplianceState,
} from "@/lib/video/script-compliance"
import { isValidUUID } from "@/lib/validations"
import {
  TONE_INSTRUCTIONS,
  targetWordCount,
  estimateDurationSeconds,
  videoTypeToContactType,
  type GenerateVideoScriptParams,
  type GenerateVideoScriptResult,
} from "@/lib/video/script-structure"

function buildTypeSystemContext(): Record<string, string> {
  const currentYear = new Date().getFullYear()
  return {
    property_tour:
      "You are writing a property walkthrough narration for a real estate agent's avatar video. Focus on features, flow, and lifestyle benefits. Use vivid but accurate descriptions.",
    market_update:
      `You are writing a local market update script for ${currentYear}. Present stats and trends conversationally. Reference current ${currentYear} market conditions — interest rates, inventory, price trends. Give buyers and sellers actionable takeaways relevant to today's market.`,
    agent_intro:
    "You are writing a personal brand introduction for a real estate agent. Build trust, highlight unique value, and end with a clear call to action.",
    listing_presentation:
      "You are writing a listing appointment presentation script. Focus on the agent's marketing plan, expertise, and why sellers should choose them.",
    buyer_education:
      `You are writing a buyer education video for ${new Date().getFullYear()}. Explain the home buying process in simple steps with current context. Reduce anxiety and build confidence.`,
    seller_update:
      "You are writing a seller update video. Give the homeowner a warm, transparent update on their listing's activity and market position.",
    testimonial:
      "You are writing a client testimonial highlight script for a real estate agent. Emphasize authentic outcomes and emotional results.",
    tips:
      "You are writing a quick tips video for a real estate agent's social media. Give 3-5 concrete, actionable tips. Keep it energetic and shareable.",
    custom:
      "You are writing a real estate video script for an agent. Follow the provided description closely.",
  }
}

/**
 * THE TENANT GATE — merged in from app/actions/video/create-video-project.ts's
 * generateAIScript, which is the one thing that unwired twin did that this
 * survivor did not.
 *
 * Every export here is "use server", i.e. an HTTP endpoint the browser calls by
 * name with arguments of its choosing. brokerageId / userId / agentId arrived
 * as ARGUMENTS and were used to (a) load THAT brokerage's brand_voice_profile
 * into the AI system prompt, (b) spend paid AI inference against it, and (c)
 * insert into video_scripts_library under it — none of which authenticates
 * anything. The only RLS policy on video_scripts_library is
 * `brokerage_id = current_user_brokerage_id()`, so (c) was silently REFUSED for
 * a foreign tenant and the refusal was swallowed (savedScriptId came off an
 * un-destructured `data`), but (a) and (b) went through: the read runs on a
 * brand_voice_profile row the caller named, and the model bill lands either way.
 *
 * The parameters stay on the signature so the wizard keeps compiling; they are
 * deliberately never trusted. agentId in particular was a USERS id being
 * written into video_scripts_library.agent_id, which is a FK to agents(id) —
 * resolved below rather than substituted.
 */
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) return { ok: false, error: "Unauthorized" }
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", auth.user.id)
    .maybeSingle()
  if (profileError) return { ok: false, error: profileError.message }
  if (!profile?.brokerage_id) {
    return { ok: false, error: "Your account is not linked to a brokerage yet" }
  }
  return { ok: true, userId: auth.user.id, brokerageId: profile.brokerage_id as string }
}

/**
 * What the caller learns about compliance, beyond the advisory list.
 *
 * `complianceWarnings` alone could not tell "the gate ran and found nothing"
 * apart from "the gate never ran" — both were an empty/absent array. These
 * three fields make the honest state explicit. Declared as an intersection so
 * lib/video/script-structure.ts (shared with other lanes) is untouched, and
 * NOT exported: a top-level "use server" module's exports are HTTP endpoints,
 * and the wizard reads these fields structurally.
 */
interface ScriptComplianceReport {
  /** clean | advisory | red_flag | unknown — see lib/video/script-compliance.ts. */
  complianceState?: ScriptComplianceState
  /** True when a hard Fair Housing finding was handed to a human. */
  complianceEscalated?: boolean
  /** video_scripts_library.id now sitting at approval_status='pending_review'. */
  humanReviewId?: string
}

export async function generateVideoScript(
  params: GenerateVideoScriptParams
): Promise<GenerateVideoScriptResult & ScriptComplianceReport> {
  if (!isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid brokerage ID" }
  }
  if (!params.description?.trim()) {
    return { success: false, error: "Description is required" }
  }

  // Reads brand-voice config, spends paid inference and writes a review row —
  // authenticate before any of that, and derive the tenant from the session.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const brokerageId = auth.brokerageId
  const userId = auth.userId

  const supabase = await createClient()
  const duration = params.targetDurationSeconds ?? 60
  const wordTarget = targetWordCount(duration)
  const contactType = videoTypeToContactType(params.videoType)

  // ── Build listing context block ──────────────────────────────────────────────
  let listingBlock = ""
  if (params.listingContext) {
    const l = params.listingContext
    listingBlock = `
Listing context:
- Address: ${l.address}, ${l.city}, ${l.state}
- List price: $${l.listPrice.toLocaleString()}
${l.bedrooms ? `- Bedrooms: ${l.bedrooms}` : ""}
${l.bathrooms ? `- Bathrooms: ${l.bathrooms}` : ""}
${l.sqft ? `- Square feet: ${l.sqft.toLocaleString()}` : ""}
${l.features?.length ? `- Key features: ${l.features.join(", ")}` : ""}
`
  }

  // ── Brand voice + ThemFirst + Fair Housing: proactive AI guidelines ──────────
  // Brand voice is loaded here and also re-evaluated at post-generation gate.
  // The AI system prompt injects all three proactively so generated content
  // is already compliant before the post-generation check runs.
  //
  // These three blocks used to be written out inline here, which is why the
  // wizard was the only script generator that had them. They now live in
  // lib/video/script-compliance.ts so the other three generators enforce the
  // same gate instead of shipping ungated marketing copy.
  // Session-derived, never the caller-supplied ids — see requireCaller above.
  const actor = { userId, brokerageId }
  const journeyType = contactType === "seller" ? ("seller" as const) : ("buyer" as const)
  const complianceBlocks = await buildComplianceSystemBlocks(
    brokerageId,
    params.brandVoiceTone,
  )

  // ── Pre-generation compliance check: Fair Housing only on description ─────────
  // We scan the brief for Fair Housing violations only — ThemFirst and Brand Voice
  // do not apply to a user's raw description input (they apply to outbound content).
  //
  // ORDER MATTERS AND IS ASSERTED: this runs BEFORE the generateAIResponse call
  // below. The ruling is "written WITH fair housing rules and compliance in
  // mind" — steer the prompt (complianceBlocks, above), then refuse a brief
  // that is already a violation, then generate. Checking afterwards would mean
  // paying for a script written from a discriminatory instruction.
  const preCheck = await precheckBriefForFairHousing(actor, params.description, journeyType)
  if (preCheck.blocked) {
    return {
      success: false,
      complianceBlocked: true,
      complianceState: "red_flag",
      error: `Description contains a Fair Housing violation: ${preCheck.reason}`,
    }
  }
  // The brief passed, but say HOW it passed. `evaluatorFailed` means the kernel
  // gate never ran — Fair Housing was still checked deterministically, brand
  // voice and ThemFirst were not. Carried into the warnings the agent sees
  // rather than being dropped on the floor.
  const precheckNotes: string[] = preCheck.evaluatorFailed
    ? [`${COMPLIANCE_UNKNOWN_PREFIX} — the brief could not be evaluated (${preCheck.evaluatorError ?? "unknown error"}). Fair Housing was checked deterministically; brand voice and ThemFirst were not.`]
    : []

  // ── Claude script generation ─────────────────────────────────────────────────
  const typeSystemContext = buildTypeSystemContext()
  const { SCRIPT_QUALITY_CHARTER } = await import("@/lib/ai/script-standards")
  const systemPrompt = [
    typeSystemContext[params.videoType] ?? typeSystemContext.custom,
    TONE_INSTRUCTIONS[params.tone] ?? TONE_INSTRUCTIONS.professional,
    ...complianceBlocks,
    SCRIPT_QUALITY_CHARTER,
    `Write ONLY the script content — no stage directions, no [pause] markers, no speaker labels.`,
    `Target approximately ${wordTarget} words (for a ${duration}-second video at a natural speaking pace).`,
    `Do NOT include any greeting before the script or explanation after it. Output the script only.`,
  ]
    .filter(Boolean)
    .join("\n\n")

  const userPrompt = [
    `Video brief: ${params.description.trim()}`,
    listingBlock,
    `Video type: ${params.videoType.replace(/_/g, " ")}`,
    `Tone: ${params.tone}`,
    `Target duration: ${duration} seconds (~${wordTarget} words)`,
    `Current date: ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
  ]
    .filter(Boolean)
    .join("\n")

  let script: string
  try {
    const { text } = await generateAIResponse({
      // Feature key maps to video_script_generation → claude-sonnet in AI_TASK_ROUTING.
      // resolveAIModel inside generateAIResponse applies brokerage tier caps automatically.
      model: "claude-sonnet",
      system: systemPrompt,
      prompt: userPrompt,
      maxTokens: 1024,
      temperature: 0.7,
      metadata: {
        feature: "video_script_generation",
        userId,
        agentId: params.agentId,
        brokerageId,
      },
    })
    script = text.trim()
  } catch (err: any) {
    return { success: false, error: `AI generation failed: ${err.message}` }
  }

  // ── Post-generation compliance check: advisory (all gates, warnings only) ────
  // AI-generated content has already followed brand voice + ThemFirst + Fair Housing
  // proactively via the system prompt. Any remaining violations are surfaced as
  // advisory warnings alongside the script — not a hard block. The UI should
  // show these with a "Regenerate" option.
  const complianceWarnings = await postcheckScript(actor, script, journeyType)

  // ── Escalation: ADVISORY PASSES, A BIG RED FLAG GOES TO A HUMAN ─────────────
  //
  // OWNER RULING: "if it runs those then it shouldn't hold up the video
  // creation unless it is a big red flag needed for a human."
  //
  // So the script is returned either way — nothing below sets success:false.
  // The difference is who else finds out. Ordinary warnings ride back in
  // complianceWarnings and are recorded in compliance_events by the gate above.
  // A hard Fair Housing finding additionally files a row on the EXISTING human
  // lane (video_scripts_library at approval_status='pending_review' →
  // /dashboard/admin/marketing-approvals). No second approval spine.
  //
  // This runs off detectFairHousingRedFlags, which is pure and synchronous, so
  // it is deliberately NOT downstream of the throwing evaluator: a database
  // outage can cost the advisory findings, never the escalation.
  const redFlags = detectFairHousingRedFlags(script, journeyType)
  // …plus the words THIS BROKERAGE marked blocking in Settings → Prohibited
  // phrases. Those are graded inside the shared gate (postcheckScript ran the
  // scan a few lines up) and arrive in the flat list under a stable prefix, so
  // this is a PURE filter over what already came back — not a second catalogue
  // read that could disagree with the first.
  redFlags.push(...detectProhibitedPhraseRedFlags(complianceWarnings ?? []))
  const advisory = (complianceWarnings ?? []).filter(
    (w) => !redFlags.includes(w) && !w.startsWith(COMPLIANCE_UNKNOWN_PREFIX),
  )

  // ── FAIL CLOSED: "we could not check" is a reason to summon a human ─────────
  // The gate can be unevaluatable three ways — the kernel evaluator threw, the
  // prohibited-phrase catalogue could not be read, or it holds no active rows —
  // and every one of them used to end as a sentence in an array. A script nobody
  // could check is not a clean script, so it takes the same lane a red flag
  // takes. It still is not BLOCKED: the agent gets their draft, exactly as the
  // ruling requires. A person is simply put on it before it goes anywhere.
  const unknownNotes = [
    ...precheckNotes,
    ...(complianceWarnings ?? []).filter((w) => w.startsWith(COMPLIANCE_UNKNOWN_PREFIX)),
  ]
  const unevaluated = unknownNotes.length > 0

  const words = script.split(/\s+/).filter(Boolean)
  const wordCount = words.length
  const estimatedDurationSeconds = estimateDurationSeconds(wordCount)

  const scriptTitle = `AI Script — ${params.videoType.replace(/_/g, " ")} — ${new Date().toLocaleDateString()}`

  let savedScriptId: string | undefined
  let humanReviewId: string | undefined
  let complianceEscalated = false
  const escalationNotes: string[] = []

  if (redFlags.length > 0) {
    // The row is FORCED regardless of saveToLibrary — an escalation with no row
    // is nobody's queue item. See escalateScriptToHumanReview for why.
    const escalation = await escalateScriptToHumanReview({
      actor,
      script,
      videoType: params.videoType,
      title: scriptTitle,
      redFlags,
      warnings: advisory,
      brandVoiceTone: params.tone,
      durationTargetSeconds: estimatedDurationSeconds,
    })
    if (escalation.ok) {
      complianceEscalated = true
      humanReviewId = escalation.reviewId
      savedScriptId = escalation.reviewId
      escalationNotes.push(
        "This script was sent to a human for Fair Housing review (Marketing Approvals). You still have the script — it is not blocked.",
      )
    } else {
      // Do NOT report an escalation that did not land. A red flag with no
      // reviewer is worse than a red flag, because it reads as handled.
      escalationNotes.push(
        `Compliance: ESCALATION FAILED — a hard Fair Housing finding could not be filed for human review (${escalation.error}). Do not publish this script until someone has looked at it.`,
      )
    }
  } else if (unevaluated) {
    // ── FAIL CLOSED ──────────────────────────────────────────────────────────
    // No red flag was FOUND, but the gate did not fully run, so "no red flag
    // found" is not a fact about the script — it is a fact about the gate. Same
    // lane, same forced row, different note: the reviewer is told they are
    // judging an ABSENCE of checking rather than a finding.
    const hold = await escalateScriptToHumanReview({
      actor,
      script,
      videoType: params.videoType,
      title: scriptTitle,
      redFlags: [],
      warnings: advisory,
      holdReason: "unevaluated",
      unknownReasons: unknownNotes,
      brandVoiceTone: params.tone,
      durationTargetSeconds: estimatedDurationSeconds,
    })
    if (hold.ok) {
      complianceEscalated = true
      humanReviewId = hold.reviewId
      savedScriptId = hold.reviewId
      escalationNotes.push(
        "Compliance could not be fully checked on this script, so it was sent to a human (Marketing Approvals). You still have the script — it is not blocked.",
      )
    } else {
      escalationNotes.push(
        `Compliance: HOLD FAILED — this script could not be compliance-checked AND could not be filed for human review (${hold.error}). Do not publish it until someone has looked at it.`,
      )
    }
  } else if (params.saveToLibrary) {
    // ── Ordinary save to video_scripts_library ───────────────────────────────
    // 'draft' is correct here: the agent's own shelf, no human summoned. Only
    // 'pending_review' reaches the admin queue, and an advisory finding is
    // explicitly not a reason to put a person in the way.
    //
    // video_scripts_library.agent_id is a FK to agents(id) while the wizard
    // passes `agentId: user.id`, a USERS id — a users id can never equal an
    // agents id, so it is RESOLVED here rather than written through. Null when
    // the user has no agent profile in this brokerage: the column is nullable,
    // and a saved script with no agent beats a refused insert.
    const { resolveAgentIdInBrokerage } = await import("@/lib/kernel/agent-identity")
    const libraryAgentId = await resolveAgentIdInBrokerage(supabase, userId, brokerageId)

    const { data: saved, error: saveError } = await supabase
      .from("video_scripts_library")
      .insert({
        brokerage_id: brokerageId,
        agent_id: libraryAgentId,
        // live CHECK admits only the five canonical script types — the raw
        // videoType ("listing_tour"/"custom"/…) violated it and saveToLibrary
        // silently never saved. Map through the canonical vocabulary.
        script_type: toLibraryScriptType(params.videoType),
        title: scriptTitle,
        script_content: script,
        duration_target_seconds: estimatedDurationSeconds,
        brand_voice_tone: params.tone,
        ai_generated: true,
        approval_status: "draft",
        is_active: true,
        created_by: userId,
      })
      .select("id")
      .maybeSingle()

    // supabase-js RESOLVES a refused insert, so this used to report a saved
    // script for a write RLS had thrown away.
    if (saveError) {
      escalationNotes.push(`The script could not be saved to your library: ${saveError.message}`)
    } else {
      savedScriptId = saved?.id

      // ── THE KERNEL LEDGER ROW THIS PATH NEVER WROTE ────────────────────────
      //
      // MERGED IN from the deleted `app/api/ai/generate-video-script/route.ts`
      // (see the TOMBSTONE at the head of this file). That route was the only
      // generator that recorded SCRIPT_GENERATED, and it recorded it for
      // scripts nobody could reach. Every other library writer already emits
      // this pair — app/actions/video-generation.ts:250 `saveVideoScript` —
      // so the wizard, the one surface an agent actually uses, was the single
      // save path leaving no lifecycle row behind. §1: the survivor gets what
      // the duplicate had BEFORE the duplicate goes.
      //
      // Not fatal, and deliberately after `savedScriptId`: the script is
      // saved, and a ledger write that fails must not un-save it.
      if (savedScriptId) {
        const { error: ledgerError } = await supabase.from("lifecycle_events").insert({
          entity_type: "video_script",
          entity_id: savedScriptId,
          brokerage_id: brokerageId,
          event_type: KernelEvent.SCRIPT_GENERATED,
          actor_user_id: userId,
          metadata: {
            script_type: toLibraryScriptType(params.videoType),
            ai_generated: true,
            approval_status: "draft",
          },
        })
        // supabase-js RESOLVES a refused insert. Without this the ledger could
        // be empty forever and every surface would read that as "no scripts".
        if (ledgerError) {
          console.error("[generate-script] lifecycle_events insert refused:", ledgerError.message)
        }

        await processKernelEvent({
          event: KernelEvent.SCRIPT_GENERATED,
          brokerageId,
          entityType: "video_script",
          entityId: savedScriptId,
        }).catch((err) => console.error("[generate-script] Kernel event failed:", err))
      }
    }
  }

  // Note: generateAIResponse already writes to ai_usage_logs via logAIUsage internally.
  // No separate insert needed here.

  // Everything the agent needs to see rides in the ONE array the wizard already
  // renders (video-create-client.tsx maps scriptComplianceWarnings). Adding a
  // second channel would mean a finding that only exists in a field no surface
  // reads — the exact defect the compliance guard was written for.
  const allWarnings = [...unknownNotes, ...redFlags, ...advisory, ...escalationNotes]

  const complianceState: ScriptComplianceState =
    redFlags.length > 0 ? "red_flag"
      : unevaluated ? "unknown"
        : advisory.length > 0 ? "advisory"
          : "clean"

  return {
    success: true,
    script,
    wordCount,
    estimatedDurationSeconds,
    savedScriptId,
    complianceWarnings: allWarnings.length ? allWarnings : undefined,
    complianceState,
    complianceEscalated,
    humanReviewId,
  }
}

