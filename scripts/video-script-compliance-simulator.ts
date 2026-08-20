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
 * Four claims live in that sentence and each one is a way the code was wrong:
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
} from "@/lib/video/script-compliance"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")


const GENERATE_SCRIPT = "app/actions/video/generate-script.ts"
const CREATE_PROJECT = "app/actions/video/create-video-project.ts"
const GATE = "lib/video/script-compliance.ts"

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
    id: "B2-PROJECT-PRECHECKS-BEFORE-GENERATING",
    file: CREATE_PROJECT,
    detail: "generateAIScript must pre-check the brief before generateText — it had NO pre-check at all",
    predicate: (src) => {
      const pre = callIndex(src, "precheckBriefForFairHousing")
      const gen = callIndex(src, "generateText")
      return pre >= 0 && gen >= 0 && pre < gen
    },
    mutate: (src) => src.replace(/await\s+precheckBriefForFairHousing\s*\(/, "await NOTHING_AT_ALL("),
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
    id: "B4-PROJECT-STEER-REACHES-THE-MODEL",
    file: CREATE_PROJECT,
    detail: "generateAIScript's prompt must carry the compliance blocks — it carried none",
    predicate: (src) =>
      /const\s+complianceBlocks\s*=\s*await\s+buildComplianceSystemBlocks\s*\(/.test(src) &&
      /const\s+prompt\s*=\s*`[\s\S]*?\$\{complianceBlocks\.join\([\s\S]*?`/.test(src),
    mutate: (src) => src.replace(/\$\{complianceBlocks\.join\([^)]*\)\}/, ""),
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
    id: "B6-PROJECT-NO-LONGER-SWALLOWS-A-THROWN-EVALUATOR",
    file: CREATE_PROJECT,
    detail: "generateAIScript must not .catch() an evaluator into allowed:true, and must not call evaluateOutbound raw",
    predicate: (src) =>
      !/\.catch\s*\(\s*\(\s*\)\s*=>\s*\(\s*\{\s*allowed:\s*true/.test(src) &&
      !/\bevaluateOutbound\s*\(/.test(src),
    mutate: (src) =>
      src.replace(
        /const\s+advisoryFindings\s*=/,
        "const compliance = await evaluateOutbound({}).catch(() => ({ allowed: true, violations: [] }));\n  const advisoryFindings =",
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
    id: "B14-PROJECT-HAS-ONE-JOURNEY-TYPE",
    file: CREATE_PROJECT,
    detail: 'generateAIScript graded ONE text as journeyType "seller"/persona "seller" for brand voice and "buyer"/"first_time" for compliance — and "seller" is not even a member of the Persona union',
    predicate: (src) =>
      /const\s+journeyType\s*=\s*"buyer"\s+as\s+const/.test(src) &&
      !/journeyType:\s*"seller"/.test(src) &&
      !/persona:\s*"seller"/.test(src),
    mutate: (src) => src.replace(/const\s+journeyType\s*=\s*"buyer"\s+as\s+const/, 'const journeyType = "buyer" as const\n  const _x = { journeyType: "seller", persona: "seller" }'),
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
]

// ═══════════════════════════════════════════════════════════════════════════
// SECTION C — the human lane on the other end is REAL, and reads what we write.
//
// Escalation is only escalation if a person actually sees it. These assert the
// three links of the chain we hand off to, none of which this lane built.
// ═══════════════════════════════════════════════════════════════════════════

function humanLane() {
  const approvals = stripComments(read("app/actions/marketing-ai-approvals.ts"))
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

  const client = stripComments(read("app/dashboard/admin/marketing-approvals/marketing-approvals-client.tsx"))
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
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  await behavioural()

  const sources = new Map<string, string>()
  for (const f of [GENERATE_SCRIPT, CREATE_PROJECT, GATE]) sources.set(f, stripComments(read(f)))

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
  console.log("  and a dead evaluator never reads as clean.\n")
}

main().catch((err) => {
  console.error("video-script-compliance-lane: harness error", err)
  process.exit(1)
})
