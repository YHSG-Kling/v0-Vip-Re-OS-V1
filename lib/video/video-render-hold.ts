/**
 * lib/video/video-render-hold.ts
 *
 * THE HOLD. One gate, three doors.
 *
 * ── THE RULING, IN TWO PARTS ────────────────────────────────────────────────
 *
 * The original owner directive was:
 *
 *   "video scripts need to be written with them first, fair housing rules and
 *    compliance in mind and if it runs those then it shouldn't hold up the
 *    video creation unless it is a big red flag needed for a human."
 *
 * and it was read as "nothing after generation blocks". That built the writing
 * prompt, the advisory pass-through and the escalation row — but a hard Fair
 * Housing finding only ANNOTATED. It filed a `video_scripts_library` row at
 * approval_status='pending_review' and then handed the agent a script that
 * every render path would happily turn into a video, because not one of them
 * ever looked at that row. Escalation without a hold is a note in a drawer.
 *
 * The refinement closes exactly that:
 *
 *   "after the script is run then hold up the video creation if still have a
 *    big red flag needed for a human."
 *
 * So the complete rule, and what this module implements:
 *
 *   clean     → render.
 *   advisory  → RENDER. This is the half that keeps production moving and it
 *               is asserted in both directions: "safe area", a ThemFirst
 *               pronoun ratio, brand-voice drift and UDAAP pricing language
 *               must NEVER hold a video. Blocking on those would put a human
 *               in front of most listing scripts, which is the hold-up the
 *               first half of the ruling forbids.
 *   red_flag  → HOLD, and a human owns it.
 *   unknown   → HOLD. "We could not check" is not "it is clean" (CLAUDE.md §4,
 *               fail closed). The evaluator throwing, an unreadable
 *               prohibited-phrase catalogue, or a catalogue holding no active
 *               rows all land here.
 *
 * ONE VOCABULARY. The verdict is `ScriptComplianceState` from
 * lib/video/script-compliance.ts — the same four words the script generators
 * already return. There is no second "blocked"/"violation"/"severity" spelling
 * introduced here; `hold` is a boolean DERIVED from that one state, so a
 * scorer can match writer to reader across the whole lane.
 *
 * ── WHERE THE HOLD IS ENFORCED ──────────────────────────────────────────────
 *
 * Three doors reach a render, and all three now call this:
 *
 *   1. app/actions/video/create-video-project.ts:createVideoProject — the
 *      canonical creator (8 callers, incl. generateVideoFromScript,
 *      link-to-video, repurpose, CMA assembly, the wizard-staging lane and
 *      POST /api/video/projects).
 *   2. app/api/did/generate-video — the wizard/board render submit. The wizard
 *      does NOT go through createVideoProject: it inserts ai_video_projects
 *      from the browser and posts here, so this is the only common gate on
 *      that lane.
 *   3. lib/kernel/video.ts:submitVideoGenerationJob — the Video Studio submit.
 *
 * ── HOW A HOLD IS RELEASED ──────────────────────────────────────────────────
 *
 * By a PERSON, on a surface that already exists, never by a model and never by
 * time passing. Two release records, both already read by
 * /dashboard/admin/marketing-approvals (app/actions/marketing-ai-approvals.ts):
 *
 *   · video_scripts_library.approval_status = 'approved'  (kind 'video_script')
 *   · ai_video_projects.approval_status     = 'approved'  (kind 'video')
 *
 * Both are written by lib/kernel/approval-queue-aggregator.ts's ONE canonical
 * transition, behind requireAdmin. 'rejected' is the opposite record and it is
 * honoured as a PERMANENT hold — a rejected script must never be renderable by
 * resubmitting it.
 *
 * The script-level release is matched on script_content when no id travels
 * (the wizard lane carries text, not an id). Exact match, tenant-scoped.
 */

import {
  assessProhibitedPhrases,
  detectFairHousingRedFlags,
  escalateScriptToHumanReview,
  COMPLIANCE_UNKNOWN_PREFIX,
  type ProhibitedPhraseCatalogue,
  type QueryableClient,
  type ScriptComplianceActor,
  type ScriptComplianceState,
} from "@/lib/video/script-compliance"

/** Every hold reason carries this, so a caller can grep one prefix, not four. */
export const VIDEO_HOLD_PREFIX = "Compliance HOLD:"

/** What a person decided about this script/project, if anything. */
export type HumanVerdict = "approved" | "rejected" | "pending_review" | "none"

export interface VideoRenderHoldDecision {
  /** True when the video must NOT be created, queued, or submitted to a provider. */
  hold: boolean
  /** ONE vocabulary — the same four words the script generators return. */
  state: ScriptComplianceState
  /** Hard Fair Housing hits + this brokerage's own BLOCKING phrases. */
  redFlags: string[]
  /** Advisory findings. Reported, never a reason to hold. */
  warnings: string[]
  /** Why the hold, phrased for the agent. Empty when hold is false. */
  reasons: string[]
  /** video_scripts_library.id a human now owns, when one was filed or found. */
  reviewId?: string
  /** Set when a person cleared this — the only thing that lifts a hold. */
  releasedBy?: "human_approval"
  /** True when a person REJECTED it. Permanent: resubmitting must not render it. */
  humanRejected?: boolean
  /** What the human record said (or 'none' when nobody has looked). */
  humanVerdict: HumanVerdict
}

// ── TOMBSTONE — `interface QueryableClient` (declared here until now) ────────
//
// SURVIVOR: lib/video/script-compliance.ts `QueryableClient`, imported above.
//
// Byte-identical shape, and it had to be duplicated only because this module
// was the sole one that let its caller choose the client. The escalation it
// calls now does the same — a cron under the service client is the whole reason
// — so the type belongs beside the function both modules share (§6: one
// spelling, or a scorer cannot match writer to reader across them).

interface HumanDecisionLookup {
  verdict: HumanVerdict
  reviewId?: string
  /**
   * True when the approval record's stored text is EXACTLY the text about to be
   * rendered.
   *
   * WHY THIS EXISTS. An approval is a person saying "these words are fine",
   * never "this project is fine forever". Without the binding, an admin who
   * approved a project once would have permanently unlocked it: the agent could
   * edit script_content into a protected-class script and re-submit, and the
   * gate would read 'approved' and wave it through. Only a content-bound
   * approval may release a red flag.
   */
  contentBound?: boolean
  /** Set when the lookup itself could not run — that is an UNKNOWN, not a pass. */
  error?: string
}

/**
 * What a person already decided about this exact script or project.
 *
 * PRECEDENCE. 'rejected' outranks 'approved' outranks 'pending_review'. A
 * script that was rejected once must not become renderable because a second,
 * cleaner copy of the same text was later approved — the rejection is a human
 * saying no to these words.
 *
 * supabase-js RESOLVES a refused read, so every `error` is destructured. A
 * failed lookup returns `error` rather than an empty result: "nobody has
 * approved this" and "we could not find out whether anybody approved this" are
 * different facts, and only one of them is safe to act on.
 */
async function lookupHumanDecision(
  supabase: QueryableClient,
  params: { brokerageId: string; script: string; scriptId?: string; projectId?: string },
): Promise<HumanDecisionLookup> {
  const verdicts: Array<{ verdict: HumanVerdict; reviewId?: string; contentBound: boolean }> = []
  const target = params.script.trim()

  if (params.projectId) {
    const { data, error } = await supabase
      .from("ai_video_projects")
      .select("id, approval_status, brokerage_id, script_content")
      .eq("id", params.projectId)
      .maybeSingle()
    if (error) return { verdict: "none", error: `project approval record unreadable — ${error.message}` }
    if (data && data.brokerage_id === params.brokerageId) {
      const st = String(data.approval_status ?? "")
      if (st === "approved" || st === "rejected" || st === "pending_review") {
        verdicts.push({
          verdict: st as HumanVerdict,
          contentBound: String(data.script_content ?? "").trim() === target && target.length > 0,
        })
      }
    }
  }

  if (params.scriptId) {
    const { data, error } = await supabase
      .from("video_scripts_library")
      .select("id, approval_status, brokerage_id, script_content")
      .eq("id", params.scriptId)
      .maybeSingle()
    if (error) return { verdict: "none", error: `script approval record unreadable — ${error.message}` }
    if (data && data.brokerage_id === params.brokerageId) {
      const st = String(data.approval_status ?? "")
      if (st === "approved" || st === "rejected" || st === "pending_review") {
        verdicts.push({
          verdict: st as HumanVerdict,
          reviewId: data.id as string,
          contentBound: String(data.script_content ?? "").trim() === target && target.length > 0,
        })
      }
    }
  }

  // No id travelled — the wizard lane carries the TEXT. Match it exactly, inside
  // the tenant. This is what makes "approve the script in Marketing Approvals,
  // then hit Generate again" actually work for the surface agents use, and it is
  // content-bound BY CONSTRUCTION: the equality IS the match.
  if (target) {
    const { data, error } = await supabase
      .from("video_scripts_library")
      .select("id, approval_status")
      .eq("brokerage_id", params.brokerageId)
      .eq("script_content", params.script)
      .in("approval_status", ["approved", "rejected", "pending_review"])
      .limit(20)
    if (error) return { verdict: "none", error: `script approval records unreadable — ${error.message}` }
    for (const row of (data ?? []) as Array<{ id: string; approval_status: string }>) {
      verdicts.push({ verdict: row.approval_status as HumanVerdict, reviewId: row.id, contentBound: true })
    }
  }

  // PRECEDENCE, and within a verdict the content-bound record wins — it is the
  // stronger record, and it is the only one allowed to release a red flag.
  for (const want of ["rejected", "approved", "pending_review"] as const) {
    const matches = verdicts.filter((v) => v.verdict === want)
    if (matches.length === 0) continue
    const hit = matches.find((v) => v.contentBound) ?? matches[0]
    return { verdict: want, reviewId: hit.reviewId, contentBound: hit.contentBound }
  }
  return { verdict: "none" }
}

/**
 * THE GATE. Decide whether this script may become a video.
 *
 * FAIL CLOSED IS THE WHOLE POINT, so the body is wrapped: any throw at all —
 * a dead client, a bad row, a module that would not import — returns a HOLD in
 * state 'unknown'. There is no path through this function that answers "go"
 * because something broke.
 *
 * The deterministic Fair Housing pass runs FIRST and needs no database, exactly
 * as assessScriptCompliance does, so a database outage can cost the advisory
 * findings and the human lookup but can never turn a protected-class script
 * into a render.
 */
export async function evaluateVideoRenderHold(params: {
  supabase: QueryableClient
  actor: ScriptComplianceActor
  /** The script that will actually be spoken (pre-disclosure-injection). */
  script: string
  /** video_scripts_library.id, when the render names a saved script. */
  scriptId?: string
  /** ai_video_projects.id, when the project already exists. */
  projectId?: string
  journeyType?: "buyer" | "seller"
  /** Raw video type — mapped through toLibraryScriptType by the escalation. */
  videoType?: string
  title?: string
  /**
   * File a review row when a hold is raised and no human record exists yet.
   * Default true — a hold with no queue item is a hold nobody can clear.
   */
  fileEscalation?: boolean
  /**
   * An already-loaded prohibited-phrase catalogue, to avoid a second read when
   * the caller has one. Omitted, the catalogue is read here — and an unreadable
   * or empty one produces `unknown`, which HOLDS. Passing a catalogue can only
   * ever make this gate see MORE, never less.
   */
  catalogue?: ProhibitedPhraseCatalogue
}): Promise<VideoRenderHoldDecision> {
  const journeyType = params.journeyType ?? "buyer"
  const script = params.script ?? ""

  try {
    // 1. DETERMINISTIC, no database, cannot be lost to an outage.
    const redFlags = detectFairHousingRedFlags(script, journeyType)

    // 2. This brokerage's own BLOCKING words. assessProhibitedPhrases never
    //    throws: an unreadable catalogue, an empty one and an uncompilable
    //    pattern each arrive as an explicit unknownReason, never as silence.
    const phrases = await assessProhibitedPhrases(script, params.catalogue)
    redFlags.push(...phrases.redFlags)
    const warnings = [...phrases.warnings]
    const unknownReasons = phrases.unknownReason ? [phrases.unknownReason] : []

    // 3. Has a person already ruled on this?
    const decision = await lookupHumanDecision(params.supabase, {
      brokerageId: params.actor.brokerageId,
      script,
      scriptId: params.scriptId,
      projectId: params.projectId,
    })
    if (decision.error) {
      unknownReasons.push(
        `${COMPLIANCE_UNKNOWN_PREFIX} — whether a human has cleared this script could not be determined (${decision.error}).`,
      )
    }

    // 4. A REJECTION is permanent and outranks everything, including a clean scan.
    if (decision.verdict === "rejected") {
      return {
        hold: true,
        state: redFlags.length > 0 ? "red_flag" : "unknown",
        redFlags,
        warnings,
        humanVerdict: "rejected",
        humanRejected: true,
        reviewId: decision.reviewId,
        reasons: [
          `${VIDEO_HOLD_PREFIX} a reviewer REJECTED this script. It cannot be turned into a video. Edit the script and generate a new one.`,
          ...redFlags,
        ],
      }
    }

    const state: ScriptComplianceState =
      redFlags.length > 0 ? "red_flag"
        : unknownReasons.length > 0 ? "unknown"
          : warnings.length > 0 ? "advisory"
            : "clean"

    // 5. A PERSON CLEARED IT — the only thing that lifts a hold.
    //
    // AND THE APPROVAL MUST BE CONTENT-BOUND. A reviewer approved WORDS, not a
    // project id: without this, one approval would permanently unlock a project
    // and the agent could edit script_content into a protected-class script and
    // re-submit against a stale "approved". An approval whose stored text no
    // longer matches what is about to be spoken releases nothing.
    if (decision.verdict === "approved" && decision.contentBound) {
      return {
        hold: false,
        state,
        redFlags,
        warnings,
        reasons: [],
        reviewId: decision.reviewId,
        releasedBy: "human_approval",
        humanVerdict: "approved",
      }
    }

    // 6. ADVISORY AND CLEAN RENDER. This is the anti-regression case: nothing
    //    below may be reached by a warning, or production stops for dog-whistle
    //    heuristics the ruling explicitly lets through.
    if (state === "clean" || state === "advisory") {
      return { hold: false, state, redFlags, warnings, reasons: [], humanVerdict: decision.verdict }
    }

    // 7. HOLD. red_flag or unknown.
    const reasons: string[] =
      state === "red_flag"
        ? [
            `${VIDEO_HOLD_PREFIX} a hard Fair Housing finding is still on this script, so the video is held for a human (Marketing Approvals).`,
            ...redFlags,
          ]
        : [
            `${VIDEO_HOLD_PREFIX} this script's compliance could not be checked, so the video is held for a human (Marketing Approvals). It is not known to be clean; it is known to be unchecked.`,
            ...unknownReasons,
          ]

    // A stale approval is worth SAYING, or the agent sees a hold on a script
    // they remember being cleared and reads it as the gate malfunctioning.
    if (decision.verdict === "approved" && !decision.contentBound) {
      reasons.push(
        `${VIDEO_HOLD_PREFIX} an approval exists, but it was given for DIFFERENT text. The script has changed since a person cleared it, so it needs looking at again.`,
      )
    }

    let reviewId = decision.reviewId
    if (!reviewId && params.fileEscalation !== false) {
      // ITS OWN try/catch, DELIBERATELY. escalateScriptToHumanReview opens a
      // database connection and can throw outright. If that throw reached the
      // outer catch it would overwrite a KNOWN red_flag verdict with 'unknown' —
      // a failure to file the paperwork must never be allowed to downgrade the
      // finding that caused it. The hold stands either way; only the reason
      // gains a line.
      try {
        const filed = await escalateScriptToHumanReview({
          actor: params.actor,
          script,
          videoType: params.videoType ?? "custom",
          title: params.title?.trim() || `Held video script — ${new Date().toLocaleDateString()}`,
          redFlags,
          warnings,
          holdReason: state === "unknown" ? "unevaluated" : "fair_housing_red_flag",
          unknownReasons,
        })
        if (filed.ok) {
          reviewId = filed.reviewId
        } else {
          // Never report a queue item that does not exist. The hold STANDS —
          // a red flag with no reviewer is worse than a red flag, because it
          // reads as handled.
          reasons.push(
            `${VIDEO_HOLD_PREFIX} the review row could not be filed (${filed.error}). The video is still held — ask an admin to look at this script directly.`,
          )
        }
      } catch (escalationErr) {
        reasons.push(
          `${VIDEO_HOLD_PREFIX} the review row could not be filed (${escalationErr instanceof Error ? escalationErr.message : String(escalationErr)}). The video is still held — ask an admin to look at this script directly.`,
        )
      }
    }

    return { hold: true, state, redFlags, warnings, reasons, reviewId, humanVerdict: decision.verdict }
  } catch (err) {
    // FAIL CLOSED. "The gate itself broke" is the strongest possible reason to
    // put a person in the way, not a reason to wave the render through.
    const message = err instanceof Error ? err.message : String(err)
    return {
      hold: true,
      state: "unknown",
      redFlags: [],
      warnings: [],
      humanVerdict: "none",
      reasons: [
        `${VIDEO_HOLD_PREFIX} the compliance gate could not run at all (${message}), so this video is held. Nobody checked — that is not the same as checked and fine.`,
      ],
    }
  }
}

/**
 * Record the hold ON THE PROJECT, so the video board and the admin queue can
 * both see it.
 *
 * Columns are the LIVE ones, and the values are the live CHECK vocabulary
 * (scripts/check-vocabularies.ts):
 *   compliance_status ∈ failed | needs_review | not_evaluated | passed
 *   approval_status   ∈ approved | draft | pending_review | published | rejected
 *
 * 'needs_review' + 'pending_review' is what puts the project into
 * aggregatePendingApprovals' `vp` query and marketing-ai-approvals' kind
 * 'video' — the SAME queue the script lands in, so a held video has a human
 * surface at both levels rather than a new spine.
 *
 * PGRST204: an UPDATE naming an absent column is refused ENTIRELY, so every
 * column here is verified present on ai_video_projects in
 * scripts/schema-snapshot.ts.
 */
export async function stampProjectComplianceHold(
  supabase: QueryableClient,
  projectId: string,
  decision: VideoRenderHoldDecision,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from("ai_video_projects")
    .update({
      compliance_status: decision.hold ? "needs_review" : "passed",
      compliance_violations: decision.hold ? decision.reasons : decision.warnings,
      compliance_evaluated_at: new Date().toISOString(),
      ...(decision.hold ? { approval_status: "pending_review" } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)
  // supabase-js RESOLVES a refusal — an un-destructured await here would report
  // a hold that was never recorded, and the board would show a clean video.
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** The one sentence a caller shows the agent when a hold stops them. */
export function holdErrorMessage(decision: VideoRenderHoldDecision): string {
  return decision.reasons[0] ?? `${VIDEO_HOLD_PREFIX} this video is held for human review.`
}
