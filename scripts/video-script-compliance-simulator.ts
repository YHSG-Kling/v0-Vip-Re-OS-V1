#!/usr/bin/env tsx
/**
 * scripts/video-script-compliance-simulator.ts
 *   (npm run test:video-script-compliance-lane)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULING THIS PROVES, VERBATIM:
 *
 *   "video scripts need to be written with them first, fair housing rules and
 *    compliance in mind and if it runs those then it shouldn't hold up the
 *    video creation unless it is a big red flag needed for a human."
 *
 * REFINED BY A SECOND OWNER DIRECTIVE, also verbatim:
 *
 *   "after the script is run then hold up the video creation if still have a
 *    big red flag needed for a human."
 *
 * The first sentence was read as "nothing after generation blocks", and that is
 * what got built: the writing prompt, the advisory pass-through, and an
 * escalation row. A hard Fair Housing finding filed a `video_scripts_library`
 * row at approval_status='pending_review' and then handed the agent a script
 * that EVERY render door would turn into a video, because not one of them
 * ever read that row. Escalation without a hold is a note in a drawer.
 * SECTION E is that half: the hold, its release, and the four cases.
 *
 * Four claims live in the first sentence and each one is a way the code was wrong:
 *
 *   1. WRITTEN WITH. The rules must reach the MODEL, before it writes — not be
 *      an opinion collected afterwards. app/actions/video/create-video-project.ts
 *      generateAIScript had no steer blocks and no pre-check at all: the brief
 *      went straight to the model and the verdict arrived too late to matter.
 *
 *   2. IF IT RUNS THOSE. It has to actually run. That path called
 *      evaluateOutbound with `.catch(() => ({ allowed: true, violations: [] }))`,
 *      so a THROWN evaluator — a DB outage, a refused compliance_events insert —
 *      reported the script as ALLOWED. lib/video/script-compliance.ts had the
 *      same shape twice more: `catch { return { blocked: false } }` and
 *      `catch { return undefined }`, the latter reading as "clean" at all five
 *      generators that call it. "We could not check" is not "it is clean".
 *
 *   3. SHOULDN'T HOLD UP. An ordinary advisory finding — ThemFirst pronoun
 *      ratio, brand-voice drift, "safe area", a UDAAP pricing phrase — passes
 *      through and is recorded. Nothing after generation may refuse a render.
 *
 *   4. UNLESS IT IS A BIG RED FLAG. A hard Fair Housing hit summons a human,
 *      on the lane that ALREADY EXISTS: video_scripts_library at
 *      approval_status='pending_review', read by
 *      app/actions/marketing-ai-approvals.ts and rendered at
 *      /dashboard/admin/marketing-approvals, approved/rejected through
 *      lib/kernel/approval-queue-aggregator.ts's one canonical transition.
 *      Not a second approval spine.
 *
 * MOSTLY BEHAVIORAL, NOT GREP. Section A imports the real gate and calls it.
 * That works — and is itself the point — because a plain node script has no
 * request scope, so `cookies()` inside createClient() genuinely throws: this
 * process IS the thrown-evaluator case, unmocked. Sections B–C assert the
 * constructs the behavioural test cannot see (call ORDER, what reaches the
 * prompt, and that the human lane on the other end is real).
 *
 * NEGATIVE CONTROLS (Section D) are not decoration. Every static check is a
 * predicate over source TEXT, so each one is re-run against a surgically
 * un-fixed copy of that text and must FAIL. A check that passes on the broken
 * source is a check that was never testing anything, and this simulator fails
 * if any of them does.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  detectFairHousingRedFlags,
  assessScriptCompliance,
  postcheckScript,
  precheckBriefForFairHousing,
  type ProhibitedPhraseCatalogue,
} from "@/lib/video/script-compliance"
import { evaluateVideoRenderHold, VIDEO_HOLD_PREFIX } from "@/lib/video/video-render-hold"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")


const GENERATE_SCRIPT = "app/actions/video/generate-script.ts"
const CREATE_PROJECT = "app/actions/video/create-video-project.ts"
const GATE = "lib/video/script-compliance.ts"
const HOLD = "lib/video/video-render-hold.ts"
const DID_ROUTE = "app/api/did/generate-video/route.ts"
const KERNEL_VIDEO = "lib/kernel/video.ts"
const VIDEO_GENERATION = "app/actions/video-generation.ts"
// The wizard client — the ONE surface that reaches a script generator. After
// generateAIScript (create-video-project.ts) was deleted 2026-09-03 onto
// generate-script.ts:generateVideoScript, the construct worth pinning is that
// the surface imports the SURVIVOR and the twin cannot come back.
const CREATE_CLIENT = "app/dashboard/videos/create/video-create-client.tsx"
const APPROVALS_ACTION = "app/actions/marketing-ai-approvals.ts"
const APPROVALS_CLIENT = "app/dashboard/admin/marketing-approvals/marketing-approvals-client.tsx"

const passes: string[] = []
const failures: string[] = []

function check(id: string, ok: boolean, detail: string) {
  if (ok) passes.push(id)
  else failures.push(`${id}: ${detail}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION A — BEHAVIOURAL. The real gate, called for real.
// ═══════════════════════════════════════════════════════════════════════════

const ACTOR = { userId: "00000000-0000-0000-0000-000000000001", brokerageId: "00000000-0000-0000-0000-000000000002" }

/** A clean listing script: features, layout, price. No protected class, no steering. */
const CLEAN_SCRIPT =
  "Take a look at this three bedroom, two bath home. You get an updated kitchen, " +
  "a two car garage, and just over eighteen hundred square feet. Your tour is " +
  "ready whenever you are — reach out and you will have the full walkthrough today."

/**
 * ADVISORY, not a red flag. Every finding here is real and worth showing:
 *   "safe area" / "quiet neighborhood" — medium-severity Fair Housing dog
 *     whistles (lib/compliance-rules/fair-housing-patterns.ts)
 *   "limited time offer" / "trust me" — ThemFirst prohibited phrases
 *   "guaranteed appreciation" — a UDAAP pricing claim
 * None of them is a protected-class reference or high-severity steering, so per
 * the ruling none of them may summon a human or hold up the render.
 */
const ADVISORY_SCRIPT =
  "I'm telling you, trust me, this is a safe area and a quiet neighborhood. " +
  "Limited time offer — guaranteed appreciation on this one. I have sold more " +
  "homes here than anyone and I know what I am talking about."

/** BIG RED FLAG: a protected-class preference, stated outright. */
const RED_FLAG_SCRIPT =
  "This home is perfect for families and sits in a changing neighborhood " +
  "that is ideal for retirees looking to downsize. No children in the building."

async function behavioural() {
  // ── The clean script is clean ───────────────────────────────────────────
  const cleanFlags = detectFairHousingRedFlags(CLEAN_SCRIPT, "buyer")
  check(
    "A1-CLEAN-SCRIPT-RAISES-NO-RED-FLAG",
    cleanFlags.length === 0,
    `a features-and-price script must not be escalated — got ${JSON.stringify(cleanFlags)}`,
  )

  // ── An advisory finding is NOT a red flag ───────────────────────────────
  // This is the whole of "shouldn't hold up the video creation": the ONLY
  // thing that triggers escalation is a non-empty red-flag list, and content
  // full of genuine advisory findings produces an empty one.
  const advisoryFlags = detectFairHousingRedFlags(ADVISORY_SCRIPT, "buyer")
  check(
    "A2-ADVISORY-CONTENT-IS-NOT-ESCALATED",
    advisoryFlags.length === 0,
    `ThemFirst / brand-voice / medium Fair Housing findings must pass through — got ${JSON.stringify(advisoryFlags)}`,
  )

  // ── A hard Fair Housing violation IS a red flag ─────────────────────────
  const redFlags = detectFairHousingRedFlags(RED_FLAG_SCRIPT, "buyer")
  check(
    "A3-PROTECTED-CLASS-IS-A-RED-FLAG",
    redFlags.length > 0 && redFlags.every((f) => f.startsWith("FairHousing:")),
    `a protected-class preference must be flagged, prefixed FairHousing: — got ${JSON.stringify(redFlags)}`,
  )
  // link-to-video.ts grades severity off exactly this prefix
  // (`startsWith("FairHousing:") ? "violation" : "warning"`), so the prefix is
  // load-bearing and not cosmetic.
  check(
    "A4-RED-FLAG-KEEPS-THE-FAIRHOUSING-PREFIX",
    redFlags.every((f) => f.startsWith("FairHousing:")),
    "app/actions/link-to-video.ts classifies severity by this prefix",
  )

  // ── THE FAIL-OPEN. This process has no request scope, so createClient()'s
  //    cookies() call really throws inside evaluateOutbound. Unmocked.
  const thrown = await assessScriptCompliance(ACTOR, CLEAN_SCRIPT, "buyer")
  check(
    "A5-THROWN-EVALUATOR-IS-NOT-CLEAN",
    thrown.state === "unknown" && thrown.evaluatorFailed === true,
    `a thrown evaluator must report state 'unknown', not 'clean' — got ${JSON.stringify(thrown)}`,
  )
  check(
    "A6-THROWN-EVALUATOR-NAMES-ITS-FAILURE",
    typeof thrown.evaluatorError === "string" && thrown.evaluatorError.length > 0,
    "the caller must be able to say WHY the gate could not run",
  )

  // ── …and the flat list the other four generators consume says so too.
  //    This used to return `undefined`, which every one of them read as clean.
  const flat = await postcheckScript(ACTOR, CLEAN_SCRIPT, "buyer")
  check(
    "A7-POSTCHECK-DOES-NOT-RETURN-UNDEFINED-ON-THROW",
    Array.isArray(flat) && flat.some((w) => w.startsWith("Compliance: UNKNOWN")),
    `postcheckScript must surface an explicit UNKNOWN line — got ${JSON.stringify(flat)}`,
  )

  // ── THE ONE THAT MATTERS MOST: evaluator down AND a red flag present.
  //    The old code answered "allowed". The deterministic pass runs outside
  //    the try, so the answer is still red_flag.
  const thrownWithFlag = await assessScriptCompliance(ACTOR, RED_FLAG_SCRIPT, "buyer")
  check(
    "A8-RED-FLAG-SURVIVES-A-DEAD-EVALUATOR",
    thrownWithFlag.state === "red_flag" && thrownWithFlag.redFlags.length > 0,
    `with the evaluator throwing, a protected-class script must still read red_flag — got ${JSON.stringify(thrownWithFlag)}`,
  )
  check(
    "A9-RED-FLAG-OUTRANKS-UNKNOWN",
    thrownWithFlag.state !== "unknown",
    "a known violation must not be downgraded to 'we do not know' just because the async gate died",
  )

  // ── The BRIEF pre-check has the same property: a discriminatory brief is
  //    refused even with the kernel gate unreachable.
  const briefBlocked = await precheckBriefForFairHousing(ACTOR, "Write something aimed at families with no children", "buyer")
  check(
    "A10-DISCRIMINATORY-BRIEF-BLOCKED-WITHOUT-A-DB",
    briefBlocked.blocked === true,
    `the pre-check must refuse a protected-class brief deterministically — got ${JSON.stringify(briefBlocked)}`,
  )
  const briefClean = await precheckBriefForFairHousing(ACTOR, "Write a tour for a three bedroom listing", "buyer")
  check(
    "A11-CLEAN-BRIEF-PASSES-BUT-SAYS-THE-GATE-DIED",
    briefClean.blocked === false && briefClean.evaluatorFailed === true,
    `a clean brief must pass, and must NOT claim the gate ran — got ${JSON.stringify(briefClean)}`,
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION E — THE HOLD. Behavioural, against the real gate.
//
// THE REFINEMENT THIS PROVES, VERBATIM:
//
//   "after the script is run then hold up the video creation if still have a
//    big red flag needed for a human."
//
// Before this, a hard Fair Housing finding ANNOTATED and nothing more. It filed
// a video_scripts_library row at approval_status='pending_review' and handed the
// agent a script that all three render doors would turn into a video, because
// not one of them ever read that row. The four cases below are the whole rule:
//
//   clean     → renders
//   ADVISORY  → RENDERS  (the anti-regression: warnings must not stop production)
//   red_flag  → HELD, and a human owns it
//   unknown   → HELD     (fail closed: "nobody checked" ≠ "checked and fine")
//
// The catalogue is INJECTED rather than read, because this process has no
// request scope and every DB read genuinely throws here. That injection is only
// ever a way for the gate to see MORE: E4b and E4d run it with no catalogue at
// all and assert the unreadable case still HOLDS.
// ═══════════════════════════════════════════════════════════════════════════

const BROKERAGE = ACTOR.brokerageId

/** A catalogue with one BLOCKING word and one advisory word. */
const CATALOGUE_LOADED: ProhibitedPhraseCatalogue = {
  state: "loaded",
  rows: [
    { phrase: "guaranteed profit", severity: "critical", category: "UDAAP", suggested_alternative: "historical performance" },
    { phrase: "limited time offer", severity: "warning", category: "UDAAP", suggested_alternative: null },
  ],
}

/**
 * A stub PostgREST builder. Every chain this gate uses resolves through it:
 *   .select().eq().maybeSingle()      → one row or null
 *   .select().eq().eq().in().limit()  → a list (awaited directly, hence `then`)
 */
function stubClient(opts: {
  scriptRows?: Array<{ id: string; approval_status: string; brokerage_id?: string; script_content?: string }>
  projectRow?: { id: string; approval_status: string; brokerage_id: string; script_content?: string } | null
  readError?: string
  throwOnFrom?: boolean
}) {
  const make = (table: string) => {
    const rows =
      table === "video_scripts_library" ? (opts.scriptRows ?? []) : opts.projectRow ? [opts.projectRow] : []
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      limit: () => builder,
      update: () => builder,
      order: () => builder,
      maybeSingle: async () =>
        opts.readError ? { data: null, error: { message: opts.readError } } : { data: rows[0] ?? null, error: null },
      then: (resolve: (v: any) => void) =>
        resolve(opts.readError ? { data: null, error: { message: opts.readError } } : { data: rows, error: null }),
    }
    return builder
  }
  return {
    from: (table: string) => {
      if (opts.throwOnFrom) throw new Error("the compliance gate's database client is unavailable")
      return make(table)
    },
  }
}

/** A script containing a BLOCKING phrase from this brokerage's own catalogue. */
const BLOCKING_PHRASE_SCRIPT =
  "This three bedroom home is a guaranteed profit for whoever buys it. " +
  "Call today and you will have the full walkthrough by this afternoon."

async function theHold() {
  const base = { actor: ACTOR, journeyType: "buyer" as const, videoType: "listing_tour", title: "T" }

  // ── CASE 1 — A CLEAN SCRIPT PROCEEDS ────────────────────────────────────
  const clean = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({}) as any,
    script: CLEAN_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E1-CLEAN-SCRIPT-PROCEEDS",
    clean.hold === false && clean.state === "clean",
    `a features-and-price script must render — got ${JSON.stringify(clean)}`,
  )
  check(
    "E1b-CLEAN-SCRIPT-CARRIES-NO-HOLD-REASON",
    clean.reasons.length === 0,
    "a video that is not held must not be handed a hold reason",
  )

  // ── CASE 2 — A WARNING PROCEEDS. THE ANTI-REGRESSION. ───────────────────
  // This is the half of the ruling that keeps production moving: "safe area",
  // "quiet neighborhood", ThemFirst slips and a non-critical prohibited phrase
  // are all REAL findings and none of them may stop a render. Holding here
  // would put a person in front of most listing scripts.
  const advisory = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({}) as any,
    script: ADVISORY_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E2-WARNING-PROCEEDS",
    advisory.hold === false,
    `an advisory finding must NEVER hold a video — got ${JSON.stringify(advisory)}`,
  )
  check(
    "E2b-WARNING-IS-STATE-ADVISORY-NOT-RED-FLAG",
    advisory.state === "advisory" && advisory.warnings.length > 0 && advisory.redFlags.length === 0,
    `the advisory script must produce warnings and no red flags — got ${JSON.stringify(advisory)}`,
  )
  check(
    "E2c-WARNING-IS-STILL-REPORTED",
    advisory.warnings.some((w) => w.toLowerCase().includes("limited time offer")),
    "passing through is not the same as being silent — the finding must still ride back",
  )

  // ── CASE 3 — A HARD RED FLAG HOLDS, AND ESCALATES ───────────────────────
  const red = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({}) as any,
    script: RED_FLAG_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E3-HARD-RED-FLAG-HOLDS",
    red.hold === true && red.state === "red_flag",
    `a protected-class script must HOLD the video — got ${JSON.stringify(red)}`,
  )
  check(
    "E3b-HOLD-NAMES-ITS-REASON",
    red.reasons.length > 0 && red.reasons[0].startsWith(VIDEO_HOLD_PREFIX) && red.redFlags.length > 0,
    "the agent must be told WHY the video was held, under one greppable prefix",
  )
  // The escalation genuinely cannot run in this process (no request scope), and
  // that must not downgrade the verdict — a failure to file the paperwork can
  // never turn a known red flag into "we do not know".
  check(
    "E3c-A-FAILED-ESCALATION-DOES-NOT-DOWNGRADE-THE-HOLD",
    red.hold === true && red.state === "red_flag" &&
      red.reasons.some((r) => r.includes("review row could not be filed")),
    `with the review row unfilable the hold must STAND and stay red_flag — got ${JSON.stringify(red.reasons)}`,
  )
  // …and this brokerage's OWN blocking word is a red flag on the same footing.
  const blocking = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({}) as any,
    script: BLOCKING_PHRASE_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E3d-A-BROKERAGE-BLOCKING-PHRASE-HOLDS-TOO",
    blocking.hold === true && blocking.state === "red_flag",
    `a phrase the brokerage graded 'critical' must hold the video — got ${JSON.stringify(blocking)}`,
  )

  // ── CASE 4 — THE EVALUATOR CANNOT RUN, SO IT HOLDS ──────────────────────
  // Three ways the gate goes blind, and none of them may read as a pass.
  const unreadable = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({}) as any,
    script: CLEAN_SCRIPT,
    catalogue: { state: "unreadable", rows: [], error: "connection refused" },
  })
  check(
    "E4a-UNREADABLE-CATALOGUE-HOLDS",
    unreadable.hold === true && unreadable.state === "unknown",
    `an unreadable prohibited-phrase catalogue must HOLD, not pass — got ${JSON.stringify(unreadable)}`,
  )
  const empty = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({}) as any,
    script: CLEAN_SCRIPT,
    catalogue: { state: "empty", rows: [] },
  })
  check(
    "E4b-EMPTY-CATALOGUE-HOLDS",
    empty.hold === true && empty.state === "unknown",
    `"no rules configured" is not "compliant" — got ${JSON.stringify(empty)}`,
  )
  const gateDown = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({ throwOnFrom: true }) as any,
    script: CLEAN_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E4c-A-THROWN-GATE-HOLDS",
    gateDown.hold === true && gateDown.state === "unknown",
    `when the gate itself throws the video must be HELD — got ${JSON.stringify(gateDown)}`,
  )
  // UNMOCKED: no catalogue argument at all, in a process where the real
  // createClient() genuinely throws. This is the production outage shape.
  const unmocked = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({}) as any,
    script: CLEAN_SCRIPT,
  })
  check(
    "E4d-NO-DATABASE-AT-ALL-HOLDS",
    unmocked.hold === true && unmocked.state === "unknown",
    `with no reachable database the gate must hold — got ${JSON.stringify(unmocked)}`,
  )
  // A red flag OUTRANKS unknown even here: a dead catalogue must not be able to
  // relabel a protected-class script as a shrug.
  const redWithDeadCatalogue = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({}) as any,
    script: RED_FLAG_SCRIPT,
    catalogue: { state: "unreadable", rows: [], error: "connection refused" },
  })
  check(
    "E4e-RED-FLAG-OUTRANKS-UNKNOWN-AT-THE-HOLD",
    redWithDeadCatalogue.hold === true && redWithDeadCatalogue.state === "red_flag",
    `a known violation must not be downgraded to 'unknown' — got ${JSON.stringify(redWithDeadCatalogue)}`,
  )

  // ── THE RELEASE — a PERSON, and only a person, lifts the hold ───────────
  const released = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({
      scriptRows: [{ id: "11111111-1111-1111-1111-111111111111", approval_status: "approved", brokerage_id: BROKERAGE }],
    }) as any,
    script: RED_FLAG_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E5-HUMAN-APPROVAL-RELEASES-THE-HOLD",
    released.hold === false && released.releasedBy === "human_approval" && released.humanVerdict === "approved",
    `an admin approving the script in Marketing Approvals must release the render — got ${JSON.stringify(released)}`,
  )
  check(
    "E5b-RELEASE-STILL-REPORTS-WHAT-WAS-FOUND",
    released.redFlags.length > 0 && released.state === "red_flag",
    "releasing is a human decision about a finding, not a claim the finding vanished",
  )

  // …but the approval is bound to the WORDS, not to the project id. Approving
  // once must not permanently unlock a project the agent can then re-script.
  const staleApproval = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({
      projectRow: {
        id: "44444444-4444-4444-4444-444444444444",
        approval_status: "approved",
        brokerage_id: BROKERAGE,
        script_content: CLEAN_SCRIPT,
      },
    }) as any,
    projectId: "44444444-4444-4444-4444-444444444444",
    // The project was approved carrying CLEAN_SCRIPT; this is what is now
    // actually about to be spoken.
    script: RED_FLAG_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E5c-AN-APPROVAL-FOR-DIFFERENT-TEXT-RELEASES-NOTHING",
    staleApproval.hold === true && staleApproval.state === "red_flag",
    `an approval is a person clearing WORDS, not a project id — editing the script after approval must re-hold it — got ${JSON.stringify(staleApproval)}`,
  )
  check(
    "E5d-THE-STALE-APPROVAL-IS-EXPLAINED",
    staleApproval.reasons.some((r) => r.includes("given for DIFFERENT text")),
    "an agent who remembers this being approved must be told why it is held again, or the gate reads as broken",
  )

  // A human "no" is PERMANENT — resubmitting the same words must not render.
  const rejected = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({
      scriptRows: [{ id: "22222222-2222-2222-2222-222222222222", approval_status: "rejected", brokerage_id: BROKERAGE }],
    }) as any,
    script: CLEAN_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E6-A-HUMAN-REJECTION-HOLDS-EVEN-A-CLEAN-SCAN",
    rejected.hold === true && rejected.humanRejected === true,
    `a reviewer's "no" must outrank a clean scan of the same words — got ${JSON.stringify(rejected)}`,
  )

  // A script already waiting on a human stays held — it must not render out
  // from under the reviewer while they are looking at it.
  const waiting = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({
      scriptRows: [{ id: "33333333-3333-3333-3333-333333333333", approval_status: "pending_review", brokerage_id: BROKERAGE }],
    }) as any,
    script: RED_FLAG_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E6b-A-SCRIPT-ALREADY-IN-THE-QUEUE-STAYS-HELD-AND-REUSES-ITS-ROW",
    waiting.hold === true && waiting.reviewId === "33333333-3333-3333-3333-333333333333",
    `an existing pending row must be reused, not duplicated — got ${JSON.stringify(waiting)}`,
  )

  // FAIL CLOSED on the RELEASE lookup itself: if we cannot find out whether a
  // human cleared this, we have not been cleared.
  const lookupDown = await evaluateVideoRenderHold({
    ...base,
    supabase: stubClient({ readError: "permission denied for table video_scripts_library" }) as any,
    script: CLEAN_SCRIPT,
    catalogue: CATALOGUE_LOADED,
  })
  check(
    "E7-AN-UNREADABLE-APPROVAL-RECORD-HOLDS",
    lookupDown.hold === true && lookupDown.state === "unknown",
    `"we could not find out whether a human cleared this" is not "a human cleared this" — got ${JSON.stringify(lookupDown)}`,
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION B — CONSTRUCTS the behavioural test cannot see.
//
// Each is a predicate over source TEXT so Section D can re-run it against an
// un-fixed copy. `mutate` is the surgical revert that must make it fail.
// ═══════════════════════════════════════════════════════════════════════════

interface SourceCheck {
  id: string
  file: string
  detail: string
  predicate: (src: string) => boolean
  /** Turn the fixed source back into the broken source. */
  mutate: (src: string) => string
}

/** Index of the first real call to `name(` in comment-stripped source, or -1. */
function callIndex(src: string, name: string): number {
  const m = new RegExp(String.raw`await\s+${name}\s*\(`).exec(src)
  return m ? m.index : -1
}

const SOURCE_CHECKS: SourceCheck[] = [
  // ── 1. WRITTEN WITH: the pre-check runs BEFORE the model call ────────────
  {
    id: "B1-WIZARD-PRECHECKS-BEFORE-GENERATING",
    file: GENERATE_SCRIPT,
    detail: "precheckBriefForFairHousing must be awaited BEFORE generateAIResponse — checking after means paying for a script written from a discriminatory brief",
    predicate: (src) => {
      const pre = callIndex(src, "precheckBriefForFairHousing")
      const gen = callIndex(src, "generateAIResponse")
      return pre >= 0 && gen >= 0 && pre < gen
    },
    // Delete the pre-check call entirely — the state the survivor would be in
    // if the gate were dropped.
    mutate: (src) => src.replace(/await\s+precheckBriefForFairHousing\s*\(/, "await NOTHING_AT_ALL("),
  },
  {
    // RETARGETED 2026-09-03. This used to assert generateAIScript pre-checked
    // before it spent. That function is DELETED onto generate-script.ts (B1
    // asserts the pre-check on the survivor). What is worth pinning on the
    // project file now is that the ungated twin does not return.
    id: "B2-PROJECT-SCRIPT-TWIN-STAYS-DELETED",
    file: CREATE_PROJECT,
    detail: "generateAIScript was deleted onto generate-script.ts:generateVideoScript — a second script generator on the project file would be a second door with its own (unproven) gate",
    predicate: (src) => !/function\s+generateAIScript\s*\(/.test(src),
    mutate: (src) => src + "\nexport async function generateAIScript(params: any) { return generateText({ prompt: params.description }) }\n",
  },

  // ── 2. WRITTEN WITH: the steer blocks reach the MODEL ────────────────────
  // Not "the file mentions buildComplianceSystemBlocks" — the RESULT has to be
  // spliced into the string handed to the model. Both spellings below name the
  // variable inside the prompt construction.
  {
    id: "B3-WIZARD-STEER-REACHES-THE-MODEL",
    file: GENERATE_SCRIPT,
    detail: "complianceBlocks must be spread into systemPrompt, not merely computed",
    predicate: (src) =>
      /const\s+complianceBlocks\s*=\s*await\s+buildComplianceSystemBlocks\s*\(/.test(src) &&
      /const\s+systemPrompt\s*=\s*\[[\s\S]{0,400}?\.\.\.complianceBlocks[\s\S]{0,400}?\]/.test(src),
    // Compute them and then not use them — the classic dead-gate shape.
    mutate: (src) => src.replace(/\.\.\.complianceBlocks,/, ""),
  },
  {
    // RETARGETED 2026-09-03 (generateAIScript deleted). The steer reaching the
    // model is B3 on the survivor; this now pins that the wizard SURFACE calls
    // the survivor, so the steer B3 proves is the steer a user actually gets.
    id: "B4-WIZARD-SURFACE-REACHES-THE-SURVIVOR",
    file: CREATE_CLIENT,
    detail: "video-create-client must import generateVideoScript from generate-script.ts (the gated survivor), never a script generator from create-video-project.ts",
    predicate: (src) =>
      /import\s*\{[^}]*\bgenerateVideoScript\b[^}]*\}\s*from\s*["']@\/app\/actions\/video\/generate-script["']/.test(src) &&
      !/generateAIScript/.test(src),
    mutate: (src) => src.replace(/@\/app\/actions\/video\/generate-script/, "@/app/actions/video/create-video-project"),
  },

  // ── 3. IF IT RUNS THOSE: no fail-open anywhere on this lane ──────────────
  {
    id: "B5-GATE-HAS-NO-CATCH-THAT-MEANS-CLEAN",
    file: GATE,
    detail: "a catch block must not resolve to an allowed/undefined verdict — that is the fail-open",
    predicate: (src) =>
      !/catch\s*(\([^)]*\))?\s*\{\s*return\s+undefined\s*\}/.test(src) &&
      !/catch\s*(\([^)]*\))?\s*\{\s*return\s*\{\s*blocked:\s*false\s*\}\s*\}/.test(src) &&
      /evaluatorFailed\s*=\s*true/.test(src),
    // Restore the exact old catch.
    mutate: (src) =>
      src.replace(
        /catch\s*\(err\)\s*\{[\s\S]*?evaluatorFailed\s*=\s*true[\s\S]*?\}/,
        "catch { return undefined }",
      ),
  },
  {
    // RETARGETED 2026-09-03 (generateAIScript deleted): the same fail-open
    // shape must never appear on the survivor either.
    id: "B6-WIZARD-NO-LONGER-SWALLOWS-A-THROWN-EVALUATOR",
    file: GENERATE_SCRIPT,
    detail: "generateVideoScript must not .catch() an evaluator into allowed:true, and must not call evaluateOutbound raw — the shared gate carries the fail-closed 'unknown' state",
    predicate: (src) =>
      !/\.catch\s*\(\s*\(\s*\)\s*=>\s*\(\s*\{\s*allowed:\s*true/.test(src) &&
      !/\bevaluateOutbound\s*\(/.test(src),
    mutate: (src) =>
      src.replace(
        /const\s+complianceWarnings\s*=/,
        "const compliance = await evaluateOutbound({}).catch(() => ({ allowed: true, violations: [] }));\n  const complianceWarnings =",
      ),
  },
  {
    id: "B7-DETERMINISTIC-PASS-IS-NOT-BEHIND-THE-TRY",
    file: GATE,
    detail: "detectFairHousingRedFlags must be called before the try block in assessScriptCompliance — inside it, a throw would hide a protected-class violation",
    predicate: (src) => {
      const fn = /export async function assessScriptCompliance[\s\S]*?\n\}/.exec(src)?.[0] ?? ""
      const det = fn.indexOf("detectFairHousingRedFlags(")
      const tryAt = fn.indexOf("try {")
      return det >= 0 && tryAt >= 0 && det < tryAt
    },
    mutate: (src) =>
      src.replace(
        /const\s+redFlags\s*=\s*detectFairHousingRedFlags\(script,\s*journeyType\)/,
        "let redFlags: string[] = []",
      ),
  },

  // ── 4. SHOULDN'T HOLD UP: nothing after generation refuses the render ────
  {
    id: "B8-WIZARD-NEVER-BLOCKS-AFTER-GENERATION",
    file: GENERATE_SCRIPT,
    detail: "no `success: false` may appear after the post-generation check — the ruling forbids compliance holding up video creation",
    predicate: (src) => {
      const post = callIndex(src, "postcheckScript")
      if (post < 0) return false
      return !src.slice(post).includes("success: false")
    },
    mutate: (src) =>
      src.replace(
        /const\s+redFlags\s*=\s*detectFairHousingRedFlags\(script,\s*journeyType\)/,
        "const redFlags = detectFairHousingRedFlags(script, journeyType)\n  if (redFlags.length) return { success: false, error: \"blocked\" }",
      ),
  },
  {
    id: "B9-ESCALATION-IS-GATED-ONLY-ON-RED-FLAGS",
    file: GENERATE_SCRIPT,
    detail: "the human lane must be summoned by redFlags alone — gating it on warnings would put a person in front of every ThemFirst slip",
    predicate: (src) =>
      /if\s*\(\s*redFlags\.length\s*>\s*0\s*\)\s*\{[\s\S]{0,600}?await\s+escalateScriptToHumanReview\s*\(/.test(src),
    mutate: (src) => src.replace(/if\s*\(\s*redFlags\.length\s*>\s*0\s*\)/, "if (advisory.length > 0 || redFlags.length > 0)"),
  },

  // ── 5. BIG RED FLAG: it lands on the lane, at the value the lane reads ───
  {
    id: "B10-ESCALATION-WRITES-PENDING-REVIEW",
    file: GATE,
    detail: "escalateScriptToHumanReview must insert into video_scripts_library at approval_status 'pending_review' — 'draft' is what every generator wrote and the admin queue has never read it",
    predicate: (src) =>
      /\.from\(\s*["']video_scripts_library["']\s*\)[\s\S]{0,900}?approval_status:\s*["']pending_review["']/.test(src) &&
      /compliance_review_notes:/.test(src),
    mutate: (src) => src.replace(/approval_status:\s*"pending_review"/, 'approval_status: "draft"'),
  },
  {
    id: "B11-ESCALATION-REPORTS-A-REFUSED-INSERT",
    file: GATE,
    detail: "supabase-js RESOLVES a refused insert — an un-destructured error would report an escalation that summoned nobody",
    predicate: (src) =>
      /const\s*\{\s*data,\s*error\s*\}\s*=\s*await\s+supabase[\s\S]{0,900}?video_scripts_library/.test(src) &&
      /if\s*\(\s*error\s*\)\s*return\s*\{\s*ok:\s*false/.test(src),
    mutate: (src) => src.replace(/if\s*\(\s*error\s*\)\s*return\s*\{\s*ok:\s*false[^}]*\}/, ""),
  },
  {
    id: "B12-CALLER-IS-TOLD-WHEN-ESCALATION-FAILED",
    file: GENERATE_SCRIPT,
    detail: "a red flag whose review row was refused must NOT be reported as escalated",
    predicate: (src) =>
      /if\s*\(\s*escalation\.ok\s*\)[\s\S]{0,700}?else\s*\{[\s\S]{0,500}?ESCALATION FAILED/.test(src),
    mutate: (src) => src.replace(/if\s*\(\s*escalation\.ok\s*\)/, "if (true)"),
  },
  {
    id: "B13-ESCALATION-FORCES-THE-ROW",
    file: GENERATE_SCRIPT,
    detail: "saveToLibrary is optional, so a red flag must file the review row regardless — an escalation with no row is nobody's queue item",
    predicate: (src) => {
      const esc = src.indexOf("escalateScriptToHumanReview(")
      if (esc < 0) return false
      // The escalation branch must not be nested under a saveToLibrary test.
      const before = src.slice(Math.max(0, esc - 1200), esc)
      return !/params\.saveToLibrary/.test(before)
    },
    mutate: (src) =>
      src.replace(/if\s*\(\s*redFlags\.length\s*>\s*0\s*\)\s*\{/, "if (params.saveToLibrary && redFlags.length > 0) {"),
  },

  // ── 6. ONE journey/persona per evaluation (the seller/buyer mismatch) ────
  {
    // RETARGETED 2026-09-03 (generateAIScript deleted): the survivor derives
    // ONE journeyType from the video type and hands the SAME identifier to the
    // pre-check and the post-check, so brand voice and compliance can never
    // grade one text under two personas again.
    id: "B14-WIZARD-HAS-ONE-JOURNEY-TYPE",
    file: GENERATE_SCRIPT,
    detail: 'generateVideoScript must derive journeyType once (from contactType) and pass that identifier to BOTH precheckBriefForFairHousing and postcheckScript — no literal "seller"/persona "seller" for one text',
    predicate: (src) =>
      /const\s+journeyType\s*=\s*contactType\s*===\s*"seller"/.test(src) &&
      /precheckBriefForFairHousing\(actor,\s*params\.description,\s*journeyType\)/.test(src) &&
      /postcheckScript\(actor,\s*script,\s*journeyType\)/.test(src) &&
      !/journeyType:\s*"seller"/.test(src) &&
      !/persona:\s*"seller"/.test(src),
    mutate: (src) => src.replace(/postcheckScript\(actor,\s*script,\s*journeyType\)/, 'postcheckScript(actor, script, "seller")'),
  },
  {
    id: "B15-GATE-USES-ONE-PERSONA-CONSTANT",
    file: GATE,
    detail: "both evaluateOutbound calls in the gate must take the same named persona so they cannot drift",
    predicate: (src) => {
      const uses = src.match(/persona:\s*SCRIPT_BROADCAST_PERSONA/g) ?? []
      return uses.length >= 2 && !/persona:\s*["'][a-z_]+["']/.test(src.replace(/SCRIPT_BROADCAST_PERSONA\s*=\s*"[a-z_]+"/, ""))
    },
    mutate: (src) => src.replace(/persona:\s*SCRIPT_BROADCAST_PERSONA/, 'persona: "luxury"'),
  },

  // ── 7. TENANCY merged in from the twin ───────────────────────────────────
  {
    id: "B16-WIZARD-DERIVES-THE-TENANT-FROM-THE-SESSION",
    file: GENERATE_SCRIPT,
    detail: "generateVideoScript is a public HTTP endpoint; brokerageId/userId arrived as ARGUMENTS and were used to read another tenant's brand voice and spend its AI budget",
    predicate: (src) =>
      /const\s+auth\s*=\s*await\s+requireCaller\(\)/.test(src) &&
      /const\s+brokerageId\s*=\s*auth\.brokerageId/.test(src) &&
      !/buildComplianceSystemBlocks\(\s*params\.brokerageId/.test(src) &&
      !/brokerage_id:\s*params\.brokerageId/.test(src),
    mutate: (src) => src.replace(/const\s+brokerageId\s*=\s*auth\.brokerageId/, "const brokerageId = params.brokerageId"),
  },
  {
    id: "B17-LIBRARY-AGENT-ID-IS-RESOLVED-NOT-SUBSTITUTED",
    file: GENERATE_SCRIPT,
    detail: "video_scripts_library.agent_id is a FK to agents(id); the wizard passes agentId: user.id, a USERS id",
    predicate: (src) =>
      !/agent_id:\s*params\.agentId/.test(src) &&
      /resolveAgentIdInBrokerage/.test(src),
    mutate: (src) => src.replace(/agent_id:\s*libraryAgentId/, "agent_id: params.agentId"),
  },
  {
    id: "B18-LIBRARY-SAVE-REPORTS-A-REFUSED-INSERT",
    file: GENERATE_SCRIPT,
    detail: "`const { data: saved } = await …insert()` swallowed an RLS refusal and reported savedScriptId anyway",
    predicate: (src) =>
      /const\s*\{\s*data:\s*saved,\s*error:\s*saveError\s*\}/.test(src) && /if\s*\(\s*saveError\s*\)/.test(src),
    mutate: (src) => src.replace(/const\s*\{\s*data:\s*saved,\s*error:\s*saveError\s*\}/, "const { data: saved }"),
  },

  // ══ THE HOLD — the refinement: "hold up the video creation if still have a
  //    big red flag needed for a human." Three doors reach a render; all three
  //    must call the ONE gate, and none of them may hold on a warning.
  {
    id: "B19-ONLY-RED-FLAG-AND-UNKNOWN-HOLD",
    file: HOLD,
    detail: "clean and advisory must return hold:false BEFORE the hold branch — holding on a warning is the regression that stops production",
    predicate: (src) =>
      /if\s*\(\s*state\s*===\s*"clean"\s*\|\|\s*state\s*===\s*"advisory"\s*\)\s*\{[\s\S]{0,300}?hold:\s*false/.test(src),
    mutate: (src) =>
      src.replace(/if\s*\(\s*state\s*===\s*"clean"\s*\|\|\s*state\s*===\s*"advisory"\s*\)/, 'if (state === "clean")'),
  },
  {
    id: "B20-THE-GATE-FAILS-CLOSED",
    file: HOLD,
    detail: "the outer catch must return hold:true — a gate that throws must refuse, never pass",
    predicate: (src) => /catch\s*\(err\)\s*\{[\s\S]{0,900}?hold:\s*true,\s*\n?\s*state:\s*"unknown"/.test(src),
    mutate: (src) =>
      src.replace(/hold:\s*true,\s*\n(\s*)state:\s*"unknown",\s*\n\1redFlags:\s*\[\],/, 'hold: false,\n$1state: "clean",\n$1redFlags: [],'),
  },
  {
    id: "B21-CREATOR-ENFORCES-THE-HOLD",
    file: CREATE_PROJECT,
    detail: "createVideoProject is the canonical creator (8 callers) — it must run the hold and REFUSE to create a held video",
    // Scoped to createVideoProject's own body — submitAvatarVideoRender below
    // carries the same shape (B30), so an unscoped predicate would keep passing
    // on the OTHER door's copy and this control would never flip.
    predicate: (src) => {
      // The slice used to end at submitAvatarVideoRender, which was DELETED
      // 2026-09-03; the next surviving export after createVideoProject is
      // getVideoProject.
      const fn = src.slice(
        src.indexOf("export async function createVideoProject"),
        src.indexOf("export async function getVideoProject("),
      )
      return (
        /await\s+evaluateVideoRenderHold\s*\(/.test(fn) &&
        /if\s*\(\s*hold\.hold\s*\)\s*\{[\s\S]{0,400}?success:\s*false/.test(fn)
      )
    },
    mutate: (src) => src.replace(/if\s*\(\s*hold\.hold\s*\)/g, "if (false)"),
  },
  {
    id: "B22-CREATOR-HOLDS-BEFORE-IT-INSERTS",
    file: CREATE_PROJECT,
    detail: "the hold must run before the ai_video_projects insert — holding after creation means the row already exists and the queue can pick it up",
    predicate: (src) => {
      // Scope to createVideoProject's own body — the file's FIRST
      // .from("ai_video_projects") is the tenant gate helper near the top,
      // which is not the insert this ordering is about.
      const fn = src.slice(src.indexOf("export async function createVideoProject"))
      const hold = callIndex(fn, "evaluateVideoRenderHold")
      const insert = fn.indexOf('.from("ai_video_projects")')
      return hold >= 0 && insert >= 0 && hold < insert
    },
    mutate: (src) => src.replace(/await\s+evaluateVideoRenderHold\s*\(/, "await NOTHING_AT_ALL("),
  },
  {
    id: "B23-DID-ROUTE-HOLDS-BEFORE-IT-SPENDS",
    file: DID_ROUTE,
    detail: "the wizard inserts ai_video_projects from the BROWSER and posts here, so this is the only common gate on that lane — and it must run before the slot claim and before any provider spend",
    predicate: (src) => {
      const hold = callIndex(src, "evaluateVideoRenderHold")
      const claim = src.indexOf('.neq("status", "generating")')
      const tts = src.indexOf("/api/elevenlabs/tts")
      return hold >= 0 && claim >= 0 && tts >= 0 && hold < claim && hold < tts
    },
    mutate: (src) => src.replace(/await\s+evaluateVideoRenderHold\s*\(/, "await NOTHING_AT_ALL("),
  },
  {
    id: "B24-DID-ROUTE-REFUSES-A-HELD-RENDER",
    file: DID_ROUTE,
    detail: "detecting the hold and continuing anyway is the defect this fixes — the route must return instead of rendering",
    predicate: (src) =>
      /if\s*\(\s*hold\.hold\s*\)\s*\{[\s\S]{0,800}?return\s+NextResponse\.json\([\s\S]{0,400}?compliance_hold:\s*true/.test(src),
    mutate: (src) => src.replace(/compliance_hold:\s*true/, "compliance_hold: false"),
  },
  {
    id: "B25-DID-ROUTE-HOLDS-ON-THE-RAW-SCRIPT",
    file: DID_ROUTE,
    detail: "the gate must judge `script`, not `renderScript` — renderScript already carries the injected brokerage disclosure, so matching a human-approved script by content would never match",
    predicate: (src) =>
      /evaluateVideoRenderHold\s*\(\s*\{[\s\S]{0,400}?script,\s*\n/.test(src) &&
      !/evaluateVideoRenderHold\s*\(\s*\{[\s\S]{0,400}?script:\s*renderScript/.test(src),
    mutate: (src) => src.replace(/(evaluateVideoRenderHold\(\{[\s\S]{0,400}?)script,\n/, "$1script: renderScript,\n"),
  },
  {
    id: "B26-KERNEL-SUBMIT-HOLDS-BEFORE-THE-SLOT-CLAIM",
    file: KERNEL_VIDEO,
    detail: "submitVideoGenerationJob is the third render door — holding after the claim would wedge the project at status='generating' with no provider job for the poller to chase",
    predicate: (src) => {
      const hold = callIndex(src, "evaluateVideoRenderHold")
      const claim = src.indexOf('.neq("status", "generating")')
      return hold >= 0 && claim >= 0 && hold < claim
    },
    mutate: (src) => src.replace(/await\s+evaluateVideoRenderHold\s*\(/, "await NOTHING_AT_ALL("),
  },
  {
    id: "B27-RENDER-FROM-SAVED-SCRIPT-READS-approval_status",
    file: VIDEO_GENERATION,
    detail: "generateVideoFromScript selected script_content and title from video_scripts_library and never looked at approval_status — so it rendered scripts a human was still holding, and scripts a human had REJECTED",
    predicate: (src) =>
      /\.from\("video_scripts_library"\)[\s\S]{0,200}?approval_status/.test(src) &&
      /scriptApproval\s*===\s*"pending_review"\s*\|\|\s*scriptApproval\s*===\s*"rejected"/.test(src),
    mutate: (src) =>
      src.replace(/scriptApproval\s*===\s*"pending_review"\s*\|\|\s*scriptApproval\s*===\s*"rejected"/, "false"),
  },
  {
    // RETARGETED 2026-09-03. submitAvatarVideoRender (and its siblings
    // pollVideoStatus / retryVideoGeneration) were DELETED onto
    // lib/kernel/video.ts:submitVideoGenerationJob (B26 proves THAT door holds
    // before its claim), the poll-did-videos finalizer and the board's retry.
    // The hole an ungated door leaves is now closed by the door not existing —
    // so pin that: no render-start function may return to the project file
    // under any of the three names.
    id: "B30-NO-THIRD-RENDER-DOOR-RETURNS",
    file: CREATE_PROJECT,
    detail: "create-video-project.ts must declare none of submitAvatarVideoRender / pollVideoStatus / retryVideoGeneration — a third writer of the ai_video_projects render slot was deleted, and the surviving doors (D-ID route, kernel submit) carry the hold",
    predicate: (src) =>
      !/function\s+(submitAvatarVideoRender|pollVideoStatus|retryVideoGeneration)\s*\(/.test(src),
    mutate: (src) =>
      src + "\nexport async function submitAvatarVideoRender(projectId: string) { return generateAvatarVideo({ projectId }) }\n",
  },
  {
    id: "B28-THE-HOLD-IS-ONE-VOCABULARY",
    file: HOLD,
    detail: "the verdict must be ScriptComplianceState — a second severity spelling would mean writers and readers could not be matched (CLAUDE.md §6)",
    predicate: (src) =>
      /state:\s*ScriptComplianceState/.test(src) &&
      /import\s*\{[\s\S]*?type\s+ScriptComplianceState[\s\S]*?\}\s*from\s*"@\/lib\/video\/script-compliance"/.test(src),
    // Global: the type is named twice (the decision field and the local
    // verdict). Reverting only the first leaves the predicate matching the
    // second, which would make this control a no-op.
    mutate: (src) =>
      src
        .replace(/state:\s*ScriptComplianceState/g, 'state: "ok" | "blocked"')
        .replace(/type\s+ScriptComplianceState,/, ""),
  },
  {
    id: "B29-ONLY-A-HUMAN-RELEASES-A-HOLD",
    file: HOLD,
    detail: "the release must come from an approval_status a person writes — never from a model verdict, a retry count, or elapsed time",
    predicate: (src) =>
      /decision\.verdict\s*===\s*"approved"\s*&&\s*decision\.contentBound/.test(src) &&
      /releasedBy:\s*"human_approval"/.test(src) &&
      /decision\.verdict\s*===\s*"rejected"/.test(src),
    mutate: (src) =>
      src.replace(/decision\.verdict\s*===\s*"approved"\s*&&\s*decision\.contentBound/, "true"),
  },
]

// ═══════════════════════════════════════════════════════════════════════════
// SECTION C — the human lane on the other end is REAL, and reads what we write.
//
// Escalation is only escalation if a person actually sees it. These assert the
// three links of the chain we hand off to, none of which this lane built.
// ═══════════════════════════════════════════════════════════════════════════

function humanLane() {
  const approvals = stripComments(read(APPROVALS_ACTION))
  check(
    "C1-ADMIN-QUEUE-READS-VIDEO-SCRIPTS-LIBRARY-PENDING-REVIEW",
    /\.from\(\s*["']video_scripts_library["']\s*\)[\s\S]{0,400}?approval_status["']?\s*,?\s*["']pending_review["']/.test(approvals) ||
      /\.from\(\s*["']video_scripts_library["']\s*\)[\s\S]{0,400}?\.eq\(\s*["']approval_status["']\s*,\s*["']pending_review["']\s*\)/.test(approvals),
    "app/actions/marketing-ai-approvals.ts must list video_scripts_library rows at approval_status='pending_review' — that is the value the escalation writes",
  )
  check(
    "C2-ADMIN-QUEUE-EXPOSES-THEM-AS-video_script",
    /kind:\s*["']video_script["']/.test(approvals),
    "the queue row must be typed video_script so the approve/reject cascade can route it",
  )

  const aggregator = stripComments(read("lib/kernel/approval-queue-aggregator.ts"))
  check(
    "C3-CANONICAL-TRANSITION-MAPS-video_script",
    /video_script:\s*["']video_scripts_library["']/.test(aggregator),
    "MARKETING_TABLE_BY_KIND must map video_script → video_scripts_library, so approve/reject uses the ONE canonical transition and this lane is not a second approval spine",
  )

  const page = stripComments(read("app/dashboard/admin/marketing-approvals/page.tsx"))
  check(
    "C4-A-RENDERED-SURFACE-CONSUMES-THE-QUEUE",
    /await\s+listPendingMarketingAssetsAction\s*\(/.test(page),
    "/dashboard/admin/marketing-approvals must call listPendingMarketingAssetsAction — an escalation into a list nothing renders summons nobody",
  )

  const client = stripComments(read(APPROVALS_CLIENT))
  check(
    "C4b-THE-SURFACE-CAN-DRAW-A-video_script-ROW",
    /video_script:\s*\{/.test(client) && /approveMarketingAssetAction/.test(client) && /rejectMarketingAssetAction/.test(client),
    "the approvals client must have a video_script kind AND the approve/reject controls — a row it cannot draw or act on is not a review",
  )

  const library = stripComments(read("app/dashboard/videos/library/page.tsx"))
  check(
    "C5-compliance_review_notes-IS-RENDERED",
    /compliance_review_notes/.test(library),
    "the reason a script was held must be visible to the human who has to judge it",
  )

  // ── THE HOLD'S OWN SURFACE ────────────────────────────────────────────────
  // A hold nobody can SEE THE REASON FOR is a hold that gets rubber-stamped.
  // The admin queue drew the held row with its title, tone and body and nothing
  // about the violation — the reviewer was being asked to clear a Fair Housing
  // escalation without being shown the escalation.
  check(
    "C6-THE-QUEUE-READS-THE-HOLD-REASON",
    /compliance_review_notes/.test(approvals) && /compliance_violations/.test(approvals),
    "listPendingMarketingAssetsAction must select video_scripts_library.compliance_review_notes AND ai_video_projects.compliance_violations — the two columns that say WHY a person was summoned",
  )
  check(
    "C7-THE-SURFACE-RENDERS-THE-HOLD-REASON",
    /compliance_notes/.test(client) && /is_compliance_hold/.test(client),
    "the approvals card must draw the hold reason and mark the row as a compliance hold, not an ordinary draft",
  )

  // ── THE RELEASE IS ADMIN-ONLY ────────────────────────────────────────────
  // "A model's opinion is not a human sign-off": the thing that lifts a Fair
  // Housing hold has to be a person with authority, on the canonical transition.
  check(
    "C8-THE-RELEASE-IS-ADMIN-GATED",
    /export\s+async\s+function\s+approveMarketingAssetAction[\s\S]{0,300}?await\s+requireAdmin\(\)/.test(approvals) &&
      /export\s+async\s+function\s+rejectMarketingAssetAction[\s\S]{0,300}?await\s+requireAdmin\(\)/.test(approvals),
    "approve/reject must be behind requireAdmin — a hold anyone could clear is not a human review",
  )
  check(
    "C9-APPROVAL-WRITES-THE-VALUE-THE-HOLD-READS",
    /approval_status:\s*["']approved["']/.test(aggregator) &&
      /approval_status:\s*["']rejected["']/.test(aggregator),
    "applyMarketingAssetApproval/Rejection must write 'approved'/'rejected' — lib/video/video-render-hold.ts reads exactly those two values to release or permanently hold",
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  await behavioural()
  await theHold()

  const sources = new Map<string, string>()
  for (const f of [
    GENERATE_SCRIPT, CREATE_PROJECT, GATE,
    HOLD, DID_ROUTE, KERNEL_VIDEO, VIDEO_GENERATION, CREATE_CLIENT,
  ]) sources.set(f, stripComments(read(f)))

  for (const c of SOURCE_CHECKS) {
    check(c.id, c.predicate(sources.get(c.file)!), `${c.file} — ${c.detail}`)
  }

  humanLane()

  // ── SECTION D — NEGATIVE CONTROLS ────────────────────────────────────────
  // Re-run every source check against a surgically un-fixed copy. A check that
  // still passes on the broken source proves nothing, and is a failure here.
  const deadControls: string[] = []
  for (const c of SOURCE_CHECKS) {
    const original = sources.get(c.file)!
    const broken = c.mutate(original)
    if (broken === original) {
      deadControls.push(`${c.id}: the mutation did not change the source — the negative control never ran`)
      continue
    }
    if (c.predicate(broken)) {
      deadControls.push(`${c.id}: the check still PASSES with the fix reverted — it is not testing the fix`)
    }
  }
  check(
    "D-NEGATIVE-CONTROLS-ALL-FLIP-RED",
    deadControls.length === 0,
    `\n      ${deadControls.join("\n      ")}`,
  )

  // Behavioural negative controls: state the OLD behaviour and assert we are
  // not producing it. Each of these three literals is what the code returned
  // before the fix, so if a fix is reverted the corresponding assertion above
  // starts producing exactly this value again.
  const oldPostcheckOnThrow = undefined
  const nowPostcheckOnThrow = await postcheckScript(ACTOR, CLEAN_SCRIPT, "buyer")
  check(
    "D2-OLD-POSTCHECK-RETURN-IS-NO-LONGER-PRODUCED",
    nowPostcheckOnThrow !== oldPostcheckOnThrow,
    "postcheckScript still returns undefined when the evaluator throws — the caller will read that as clean",
  )
  const oldAssessOnThrow = { allowed: true, violations: [] as string[] }
  const nowAssess = await assessScriptCompliance(ACTOR, RED_FLAG_SCRIPT, "buyer")
  check(
    "D3-OLD-ALLOWED-TRUE-SHAPE-IS-NO-LONGER-PRODUCED",
    !(nowAssess.state === "clean") && nowAssess.redFlags.length > oldAssessOnThrow.violations.length,
    "a thrown evaluator on a protected-class script still reads as allowed with no violations",
  )

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`\nvideo-script-compliance-lane: ${passes.length} passed, ${failures.length} failed`)
  console.log(`  (${SOURCE_CHECKS.length} source checks, each re-run against a reverted copy)\n`)
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL  ${f}`)
    console.error("\nVIDEO_SCRIPT_COMPLIANCE_LANE_FAIL\n")
    process.exit(1)
  }
  console.log("  Compliance is written in FIRST, advisory findings pass through,")
  console.log("  a big red flag reaches a human on the lane that already existed,")
  console.log("  and a dead evaluator never reads as clean.")
  console.log("  A big red flag also HOLDS the video at every render door,")
  console.log("  an unrunnable gate holds too, and only an admin's approval releases it.\n")
}

main().catch((err) => {
  console.error("video-script-compliance-lane: harness error", err)
  process.exit(1)
})
