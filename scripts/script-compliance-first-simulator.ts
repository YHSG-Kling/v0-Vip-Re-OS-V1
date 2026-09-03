#!/usr/bin/env tsx
/**
 * scripts/script-compliance-first-simulator.ts
 *   (npm run test:script-compliance-first)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULING THIS PROVES, VERBATIM:
 *
 *   "video scripts need to be written with them first, fair housing rules and
 *    compliance in mind and if it runs those then it shouldn't hold up the video
 *    creation unless it is a big red flag needed for a human."
 *
 * Three requirements live in that sentence and they pull against each other:
 *
 *   (A) COMPLIANCE INFORMS THE WRITING. The rules are an INPUT to the prompt
 *       that writes the script, not a grade applied afterwards. That includes
 *       the words THIS BROKERAGE typed into Settings → Prohibited phrases —
 *       `prohibited_phrases`, the table app/actions/compliance-phrases.ts
 *       writes. It did NOT include them: buildComplianceSystemBlocks read
 *       brand_voice_profile.prohibited_words, a different column on a different
 *       table that the settings screen never writes, and evaluateOutbound's
 *       Gate 5 walks a hard-coded ten-phrase array. A broker could add a word,
 *       watch it save, and have every AI video script in the brokerage ignore
 *       it.
 *
 *   (B) A CLEAN-ENOUGH RUN MUST NOT BLOCK. Advisory findings — ThemFirst pronoun
 *       ratio, brand-voice drift, "safe area", a UDAAP pricing claim, an
 *       info/warning-severity brokerage word — ride back with the script and
 *       hold nothing up.
 *
 *   (C) A BIG RED FLAG STOPS AND ESCALATES TO A HUMAN, and the escalation has to
 *       land in a queue a person actually reads — not set a boolean.
 *
 * ── THE FAIL-OPEN THIS EXISTS TO KEEP CLOSED ────────────────────────────────
 * "We could not check" is not "it is clean". A prior wave closed the version of
 * this where a THROWN evaluator returned `{allowed: true}`. Two survived it:
 *
 *   1. state `unknown` was honest and INERT. It produced a sentence in an array
 *      and summoned nobody, so an unevaluatable script shipped with a note on
 *      it. A label is not an escalation.
 *   2. the prohibited-phrase catalogue could not be told apart from a clean
 *      scan at all, because it was never consulted. An EMPTY catalogue — which
 *      is what `prohibited_phrases` held for the entire life of this product
 *      until m450 — is a gate that passes every script ever written.
 *
 * Both now force `unknown`, and `unknown` files the same review row a red flag
 * does with holdReason 'unevaluated'.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 * BEHAVIOUR FIRST. Sections 1–5 run the REAL gate. Only its EDGES are stubbed —
 * `@/lib/supabase/server`, `@/lib/kernel/compliance`, `@/lib/kernel/agent-identity`
 * — through `registerHooks`, so the scenario can hand the gate a loaded / empty
 * / unreadable catalogue and a working / throwing evaluator and watch what the
 * production functions actually do. The prohibited-phrase scan itself is the
 * REAL `scanForProhibitedPhrases` from lib/application/compliance-monitoring.ts.
 *
 * Section 6 asserts the CONSTRUCTS behaviour cannot see: that the two callers
 * are wired in the order the ruling requires. Section 7 re-runs every one of
 * those against an in-memory copy of the source with the defect re-introduced,
 * and fails if the check still passes. Nothing on disk is modified — other lanes
 * are editing this tree concurrently.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** Comment-stripped source. Load-bearing: these files quote their own defects. */
const code = (p: string) => stripComments(raw(p))

const GATE = "lib/video/script-compliance.ts"
const WIZARD = "app/actions/video/generate-script.ts"
const PROJECT = "app/actions/video/create-video-project.ts"
const LINK_TO_VIDEO = "app/actions/link-to-video.ts"

let pass = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string): boolean {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
  return cond
}

// ═════════════════════════════════════════════════════════════════════════════
// EDGE INTERCEPTION — so the REAL gate runs against a world we control
// ═════════════════════════════════════════════════════════════════════════════

const STUBS: Record<string, string> = {
  "@/lib/supabase/server":
    "export const createClient = (...a) => globalThis.__SCF.createClient(...a)",
  "@/lib/kernel/compliance":
    "export const evaluateOutbound = (...a) => globalThis.__SCF.evaluateOutbound(...a)",
  "@/lib/kernel/agent-identity":
    "export const resolveAgentIdInBrokerage = (...a) => globalThis.__SCF.resolveAgentIdInBrokerage(...a)\n" +
    // BOTH resolvers must be stubbed, not just the one this gate calls directly.
    // The act-as seam merge gave lib/platform/acting-context.ts an FK-safe
    // `resolveAgentId` fallback, and this simulator reaches that module
    // transitively: script-compliance -> compliance-monitoring -> lib/identity ->
    // acting-context. A stub module that omits an export the real module HAS
    // (agent-identity.ts:43) throws at import time, and the failure surfaced
    // three layers away as nine assertions about fair-housing verdicts.
    //
    // Worth recording WHY that was hard to read: the gate FAILED CLOSED exactly
    // as §4 demands — it could not run the phrase scan, so it returned `unknown`
    // and escalated to a human — so the symptom was "a clean script summons a
    // reviewer", which looks like a compliance defect and is actually a missing
    // stub export. The nine failures were one cause.
    "export const resolveAgentId = (...a) => globalThis.__SCF.resolveAgentId(...a)",
}

registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true }
    const stub = STUBS[spec]
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

// ─── THE WORLD each scenario configures ─────────────────────────────────────

type Answer = { data: any; error: any }

interface World {
  /** What `prohibited_phrases` answers with. `throws` = createClient/query blew up. */
  phrases: Answer | "throws"
  brandVoice: Answer
  /** What evaluateOutbound does. A function so it can throw. */
  evaluate: () => Promise<{ allowed: boolean; violations: string[]; complianceEventId?: string }>
  /** Rows the gate tried to INSERT, by table. This is the human queue, observed. */
  inserts: Array<{ table: string; row: any }>
  /** Refuse the escalation insert, to prove a refused escalation is not reported as one. */
  refuseInsert: boolean
}

let W: World

function newWorld(over: Partial<World> = {}): World {
  return {
    phrases: { data: [...FEDERALish, ...BROKERAGE_WORDS], error: null },
    brandVoice: { data: null, error: null },
    evaluate: async () => ({ allowed: true, violations: [], complianceEventId: "ce-1" }),
    inserts: [],
    refuseInsert: false,
    ...over,
  }
}

/**
 * Stand-ins for the seeded federal rows (m450). Shape only — the real catalogue
 * is 25 rows and this proof is about how the gate TREATS a row's severity, not
 * about the federal wording, which m451 asserts in the database.
 */
const FEDERALish = [
  { phrase: "no children", phrase_pattern: null, category: "fair_housing", severity: "critical", suggested_alternative: "Describe the home, not who should live in it" },
  { phrase: "safe area", phrase_pattern: null, category: "fair_housing", severity: "warning", suggested_alternative: "Describe amenities and location" },
]

/** What a brokerage typed into Settings → Prohibited phrases. */
const BROKERAGE_WORDS = [
  { phrase: "we guarantee", phrase_pattern: null, category: "brokerage_policy", severity: "critical", suggested_alternative: "we work to" },
  { phrase: "cheap", phrase_pattern: null, category: "marketing", severity: "warning", suggested_alternative: "well priced" },
]

/** A thenable query builder — every chain method returns itself. */
function query(resolve: () => Promise<Answer>): any {
  const q: any = {}
  for (const m of ["select", "eq", "neq", "is", "in", "order", "limit", "filter", "or"]) {
    q[m] = () => q
  }
  q.maybeSingle = () => resolve()
  q.single = () => resolve()
  q.then = (ok: any, no: any) => resolve().then(ok, no)
  return q
}

;(globalThis as any).__SCF = {
  createClient: async () => ({
    from(table: string) {
      if (table === "prohibited_phrases") {
        return query(async () => {
          if (W.phrases === "throws") throw new Error("cookies() outside a request scope")
          return W.phrases
        })
      }
      if (table === "brand_voice_profile") return query(async () => W.brandVoice)
      if (table === "video_scripts_library") {
        const q = query(async () => ({ data: null, error: null })) as any
        q.insert = (row: any) => {
          W.inserts.push({ table, row })
          return query(async () =>
            W.refuseInsert
              ? { data: null, error: { message: "new row violates row-level security policy" } }
              : { data: { id: "review-row-1" }, error: null },
          )
        }
        return q
      }
      return query(async () => ({ data: null, error: null }))
    },
  }),
  evaluateOutbound: async () => W.evaluate(),
  resolveAgentIdInBrokerage: async () => "agent-uuid-1",
  // Same agents.id the brokerage-scoped resolver yields, because in this
  // scenario there is one agent and both resolvers are asking the same question
  // — a different value here would be inventing a second identity the scenario
  // never set up. Real signature is (supabase, userId) => Promise<string|null>.
  resolveAgentId: async () => "agent-uuid-1",
}

// ═════════════════════════════════════════════════════════════════════════════

const ACTOR = {
  userId: "00000000-0000-0000-0000-000000000001",
  brokerageId: "00000000-0000-0000-0000-000000000002",
}

/** Features, layout, price. Nothing to find. */
const CLEAN_SCRIPT =
  "Take a look at this three bedroom, two bath home. You get an updated kitchen, " +
  "a two car garage, and just over eighteen hundred square feet. Your tour is " +
  "ready whenever you are."

/** Real findings, none of them a hard hit: medium Fair Housing + a warning-severity brokerage word. */
const WARNING_SCRIPT =
  "You will love this well kept home in a safe area. It is a cheap way into the " +
  "neighborhood and you get room to grow."

/** A protected-class preference, stated outright. */
const RED_FLAG_SCRIPT =
  "This home is perfect for families and sits in a changing neighborhood that is " +
  "ideal for retirees looking to downsize."

/** No Fair Housing problem at all — only a word THIS brokerage marked critical. */
const BROKERAGE_RED_FLAG_SCRIPT =
  "You are getting a bright three bedroom with a new roof, and we guarantee you " +
  "will be delighted with the layout."

async function main() {
  const gate = await import("@/lib/video/script-compliance")
  const {
    buildComplianceSystemBlocks,
    loadProhibitedPhraseCatalogue,
    assessProhibitedPhrases,
    assessScriptCompliance,
    postcheckScript,
    detectFairHousingRedFlags,
    detectProhibitedPhraseRedFlags,
    escalateScriptToHumanReview,
    COMPLIANCE_UNKNOWN_PREFIX,
  } = gate

  console.log("══════════════════════════════════════════════════")
  console.log(" Script compliance FIRST — written with, not graded after")
  console.log("══════════════════════════════════════════════════")

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. (A) THE RULES REACH THE MODEL — including the brokerage's OWN words
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[1] (A) compliance is an INPUT to the writing prompt")
  {
    W = newWorld()
    const blocks = await buildComplianceSystemBlocks(ACTOR.brokerageId)
    const prompt = blocks.join("\n\n")

    check(
      "1.1 the Fair Housing directive is in the prompt that writes the script",
      /Fair Housing compliance \(Gate 4/.test(prompt) && /protected|race, color, religion/i.test(prompt),
      `blocks: ${JSON.stringify(blocks).slice(0, 300)}`,
    )
    check(
      "1.2 the ThemFirst directive is in the prompt that writes the script",
      /ThemFirst communication philosophy \(Gate 5/.test(prompt),
    )
    check(
      "1.3 THE BROKERAGE'S OWN prohibited words are in the prompt that writes the script",
      prompt.includes("we guarantee") && prompt.includes("cheap"),
      "prohibited_phrases is what Settings writes; it never reached the prompt before — " +
      `got: ${JSON.stringify(blocks.filter((b: string) => /Prohibited/.test(b)))}`,
    )
    check(
      "1.4 the blocking words are named as NEVER, not lumped in with the advisory ones",
      /NEVER write any of these[^\n]*"no children"[^\n]*|NEVER write any of these[^\n]*"we guarantee"/.test(prompt),
      "critical severity is the brokerage's own 'will not leave the building' bar",
    )
    check(
      "1.5 the suggested replacement rides along, so the model has somewhere to go",
      /Preferred replacements/.test(prompt) && prompt.includes("we work to"),
    )

    // …and an unreadable catalogue must not put a half-truth in the prompt.
    W = newWorld({ phrases: "throws" })
    const degraded = (await buildComplianceSystemBlocks(ACTOR.brokerageId)).join("\n\n")
    check(
      "1.6 an unreadable catalogue emits NO phrase block rather than an empty one",
      !/Prohibited words and phrases/.test(degraded) && /Fair Housing compliance \(Gate 4/.test(degraded),
      "a prompt cannot usefully say 'we failed to load your rules' — the honesty belongs to the assessment",
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. THE THREE OUTCOMES, END TO END, THROUGH THE REAL GATE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[2] (B)/(C) clean proceeds · warning proceeds AND is surfaced · red flag is HELD")

  /**
   * The caller's disposition, run for real: exactly the sequence
   * app/actions/video/generate-script.ts performs after the model returns.
   * Section 6 asserts the shipped caller has this same shape, and Section 7
   * proves those assertions can fail.
   */
  async function runLane(script: string) {
    const findings = (await postcheckScript(ACTOR, script, "buyer")) ?? []
    const redFlags = detectFairHousingRedFlags(script, "buyer")
    redFlags.push(...detectProhibitedPhraseRedFlags(findings))
    const unknownReasons = findings.filter((f: string) => f.startsWith(COMPLIANCE_UNKNOWN_PREFIX))
    const advisory = findings.filter(
      (f: string) => !redFlags.includes(f) && !f.startsWith(COMPLIANCE_UNKNOWN_PREFIX),
    )

    let escalated = false
    let reviewId: string | undefined
    let escalationError: string | undefined
    if (redFlags.length > 0) {
      const r = await escalateScriptToHumanReview({
        actor: ACTOR, script, videoType: "listing_tour", title: "t",
        redFlags, warnings: advisory,
      })
      escalated = r.ok
      reviewId = r.reviewId
      escalationError = r.error
    } else if (unknownReasons.length > 0) {
      const r = await escalateScriptToHumanReview({
        actor: ACTOR, script, videoType: "listing_tour", title: "t",
        redFlags: [], warnings: advisory,
        holdReason: "unevaluated", unknownReasons,
      })
      escalated = r.ok
      reviewId = r.reviewId
      escalationError = r.error
    }
    // The ruling: nothing here refuses the script.
    return { script, findings, redFlags, advisory, unknownReasons, escalated, reviewId, escalationError }
  }

  // ── CLEAN ──────────────────────────────────────────────────────────────────
  {
    W = newWorld()
    const a = await assessScriptCompliance(ACTOR, CLEAN_SCRIPT, "buyer")
    check("2.1 a clean script assesses as clean", a.state === "clean", JSON.stringify(a))
    check(
      "2.2 …and the catalogue is recorded as actually READ",
      a.phraseCatalogueState === "loaded" && a.unknownReasons.length === 0,
      JSON.stringify(a),
    )
    const lane = await runLane(CLEAN_SCRIPT)
    check(
      "2.3 a clean script proceeds — nothing filed, nothing held",
      lane.escalated === false && W.inserts.length === 0 && lane.script === CLEAN_SCRIPT,
      JSON.stringify({ escalated: lane.escalated, inserts: W.inserts.length }),
    )
  }

  // ── WARNING-LEVEL ──────────────────────────────────────────────────────────
  {
    W = newWorld({
      // What the kernel gate really produces for this text: a medium Fair
      // Housing dog-whistle and a ThemFirst pronoun-ratio miss.
      evaluate: async () => ({
        allowed: false,
        violations: [
          'FairHousing: Potentially violates Fair Housing Act by using language that could imply preference or discrimination: "safe area"',
          "ThemFirst: Content is only 40% contact-focused (target ≥60%). Reduce agent-centric language.",
        ],
        complianceEventId: "ce-2",
      }),
    })
    const a = await assessScriptCompliance(ACTOR, WARNING_SCRIPT, "buyer")
    check(
      "2.4 warning-level findings assess as ADVISORY, not red_flag and not unknown",
      a.state === "advisory",
      JSON.stringify(a),
    )
    const lane = await runLane(WARNING_SCRIPT)
    check(
      "2.5 a warning-level script PROCEEDS — no human is summoned",
      lane.escalated === false && W.inserts.length === 0,
      `a warning that silently halts the pipeline is a defect against the ruling — ${JSON.stringify(W.inserts)}`,
    )
    check(
      "2.6 …and the warning is SURFACED, not swallowed",
      lane.advisory.length >= 3 &&
        lane.advisory.some((w: string) => w.includes("safe area")) &&
        lane.advisory.some((w: string) => w.startsWith("ThemFirst:")) &&
        lane.advisory.some((w: string) => w.includes("cheap")),
      `an advisory that reaches no surface is the defect this whole lane exists for — got ${JSON.stringify(lane.advisory)}`,
    )
    check(
      "2.7 the brokerage's own WARNING-severity word rides along and does not escalate",
      lane.advisory.some((w: string) => w.startsWith("ProhibitedPhrase:") && w.includes("cheap")) &&
        lane.redFlags.length === 0,
      JSON.stringify({ advisory: lane.advisory, redFlags: lane.redFlags }),
    )
  }

  // ── RED FLAG (Fair Housing) ────────────────────────────────────────────────
  {
    W = newWorld()
    const a = await assessScriptCompliance(ACTOR, RED_FLAG_SCRIPT, "buyer")
    check("2.8 a protected-class script assesses as red_flag", a.state === "red_flag", JSON.stringify(a))

    const lane = await runLane(RED_FLAG_SCRIPT)
    const filed = W.inserts.filter((i) => i.table === "video_scripts_library")
    check(
      "2.9 a red flag is HELD — a row is filed on the human lane",
      lane.escalated === true && filed.length === 1,
      `escalated=${lane.escalated} inserts=${JSON.stringify(W.inserts)}`,
    )
    check(
      "2.10 …at approval_status 'pending_review', the ONLY value the admin queue reads",
      filed[0]?.row?.approval_status === "pending_review",
      `'draft' is what every generator used to write, and the queue has never read it — got ${filed[0]?.row?.approval_status}`,
    )
    check(
      "2.11 …carrying the reason, so the reviewer can judge it",
      typeof filed[0]?.row?.compliance_review_notes === "string" &&
        filed[0].row.compliance_review_notes.includes("HELD FOR HUMAN REVIEW") &&
        /perfect for families|Protected Class|Fair Housing/i.test(filed[0].row.compliance_review_notes),
      JSON.stringify(filed[0]?.row?.compliance_review_notes),
    )
    check(
      "2.12 …under the caller's own brokerage and a RESOLVED agents id",
      filed[0]?.row?.brokerage_id === ACTOR.brokerageId && filed[0]?.row?.agent_id === "agent-uuid-1",
      JSON.stringify(filed[0]?.row),
    )
    check(
      "2.13 …and the script is STILL RETURNED — the ruling forbids holding up creation",
      lane.script === RED_FLAG_SCRIPT,
    )
  }

  // ── RED FLAG (the brokerage's own blocking word, no Fair Housing hit) ──────
  {
    W = newWorld()
    const fh = detectFairHousingRedFlags(BROKERAGE_RED_FLAG_SCRIPT, "buyer")
    check(
      "2.14 the brokerage-word script has NO Fair Housing hit of its own",
      fh.length === 0,
      `the point of this scenario is that only the tenant's list catches it — got ${JSON.stringify(fh)}`,
    )
    const lane = await runLane(BROKERAGE_RED_FLAG_SCRIPT)
    check(
      "2.15 a word THIS BROKERAGE marked critical is a red flag and reaches the human queue",
      lane.redFlags.length === 1 &&
        lane.redFlags[0].startsWith("ProhibitedPhrase(blocking):") &&
        lane.escalated === true &&
        W.inserts.length === 1,
      `severity 'critical' is the only value the settings screen says blocks content — got ${JSON.stringify(lane.redFlags)}`,
    )
  }

  // ── A REFUSED ESCALATION IS NOT AN ESCALATION ─────────────────────────────
  {
    W = newWorld({ refuseInsert: true })
    const lane = await runLane(RED_FLAG_SCRIPT)
    check(
      "2.16 an escalation RLS refused is reported as failed, not as handled",
      lane.escalated === false && typeof lane.escalationError === "string",
      "supabase-js RESOLVES a refused insert; reporting it as escalated is worse than the red flag " +
      `— got ${JSON.stringify({ escalated: lane.escalated, error: lane.escalationError })}`,
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. FAIL CLOSED — make the evaluator THROW
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[3] FAIL CLOSED — an unevaluatable script is held, not approved")
  {
    W = newWorld({
      evaluate: async () => { throw new Error("compliance_events insert refused") },
    })
    const a = await assessScriptCompliance(ACTOR, CLEAN_SCRIPT, "buyer")
    check(
      "3.1 a thrown evaluator is 'unknown', never 'clean'",
      a.state === "unknown" && a.evaluatorFailed === true,
      JSON.stringify(a),
    )
    check(
      "3.2 …and it says WHY, so the state is actionable",
      typeof a.evaluatorError === "string" && a.evaluatorError.length > 0 &&
        a.unknownReasons.some((r: string) => r.startsWith(COMPLIANCE_UNKNOWN_PREFIX)),
      JSON.stringify(a.unknownReasons),
    )
    const flat = (await postcheckScript(ACTOR, CLEAN_SCRIPT, "buyer")) ?? []
    check(
      "3.3 the flat list the other five generators read carries an explicit UNKNOWN line",
      flat.some((f: string) => f.startsWith(COMPLIANCE_UNKNOWN_PREFIX)),
      `undefined/[] reads as clean at every one of those call sites — got ${JSON.stringify(flat)}`,
    )

    // THE ONE THAT MATTERS: the hold has to REACH A HUMAN, not just be labelled.
    W = newWorld({ evaluate: async () => { throw new Error("compliance_events insert refused") } })
    const lane = await runLane(CLEAN_SCRIPT)
    const filed = W.inserts.filter((i) => i.table === "video_scripts_library")
    check(
      "3.4 AN UNEVALUATABLE SCRIPT IS ESCALATED TO A HUMAN — not merely annotated",
      lane.escalated === true && filed.length === 1 && filed[0].row.approval_status === "pending_review",
      "state 'unknown' used to produce a sentence in an array and summon nobody — that is fail-OPEN " +
      `on fair housing wearing a disclosure. inserts=${JSON.stringify(W.inserts)}`,
    )
    check(
      "3.5 …and the review row says it is UNCHECKED, not that a violation was found",
      /could NOT be compliance-checked/.test(filed[0]?.row?.compliance_review_notes ?? "") &&
        /What could not be checked/.test(filed[0]?.row?.compliance_review_notes ?? ""),
      `a reviewer judging an absence must be told it is an absence — got ${JSON.stringify(filed[0]?.row?.compliance_review_notes)}`,
    )

    // A KNOWN violation must not be downgraded to a shrug by a dead evaluator.
    W = newWorld({ evaluate: async () => { throw new Error("db down") } })
    const withFlag = await assessScriptCompliance(ACTOR, RED_FLAG_SCRIPT, "buyer")
    check(
      "3.6 a red flag SURVIVES a dead evaluator (the deterministic pass is outside the try)",
      withFlag.state === "red_flag" && withFlag.redFlags.length > 0,
      JSON.stringify(withFlag),
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. AN EMPTY / UNREADABLE PROHIBITED LIST IS NOT A PASS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[4] 'no rules configured' is not 'compliant'")
  {
    // ── EMPTY. This is not hypothetical: prohibited_phrases held ZERO rows for
    //    the whole life of the product until m450, and every scan passed.
    W = newWorld({ phrases: { data: [], error: null } })
    const cat = await loadProhibitedPhraseCatalogue()
    check("4.1 an empty catalogue reads as 'empty', not as 'loaded'", cat.state === "empty", JSON.stringify(cat))

    const findings = await assessProhibitedPhrases(CLEAN_SCRIPT)
    check(
      "4.2 an empty catalogue yields an UNKNOWN reason, not an empty finding list",
      findings.redFlags.length === 0 && typeof findings.unknownReason === "string" &&
        findings.unknownReason.startsWith(COMPLIANCE_UNKNOWN_PREFIX),
      JSON.stringify(findings),
    )
    const a = await assessScriptCompliance(ACTOR, CLEAN_SCRIPT, "buyer")
    check(
      "4.3 A CLEAN SCRIPT AGAINST AN EMPTY CATALOGUE IS 'unknown', NOT 'clean'",
      a.state === "unknown" && a.phraseCatalogueState === "empty",
      `the evaluator returned no violations and the script really is clean — but nothing was checked ` +
      `against the brokerage's list, and that must not read as a pass. Got ${JSON.stringify(a)}`,
    )
    const lane = await runLane(CLEAN_SCRIPT)
    check(
      "4.4 …and it reaches a human rather than shipping unchecked",
      lane.escalated === true && W.inserts.length === 1,
      JSON.stringify(W.inserts),
    )

    // ── UNREADABLE (a refusal that supabase-js RESOLVES).
    W = newWorld({ phrases: { data: null, error: { message: "permission denied for table prohibited_phrases" } } })
    const refused = await loadProhibitedPhraseCatalogue()
    check(
      "4.5 a REFUSED read is 'unreadable' — a refusal is not an empty catalogue",
      refused.state === "unreadable" && /permission denied/.test(refused.error ?? ""),
      "supabase-js resolves a failed query; an un-destructured `data` reports a denial as 'no phrases' — " +
      JSON.stringify(refused),
    )
    check(
      "4.6 …and it forces 'unknown' too",
      (await assessScriptCompliance(ACTOR, CLEAN_SCRIPT, "buyer")).state === "unknown",
    )

    // ── THROWN (no request scope, network down).
    W = newWorld({ phrases: "throws" })
    const thrown = await loadProhibitedPhraseCatalogue()
    check(
      "4.7 a THROWN read is 'unreadable', and does not take the generation down with it",
      thrown.state === "unreadable" && typeof thrown.error === "string",
      JSON.stringify(thrown),
    )

    // ── UNCOMPILABLE. One bad stored pattern aborts the whole scan; that is
    //    deliberate in scanForProhibitedPhrases, and must land as UNKNOWN here.
    W = newWorld({
      phrases: { data: [{ phrase: "bad", phrase_pattern: "([", category: "marketing", severity: "warning", suggested_alternative: null }], error: null },
    })
    const broken = await assessProhibitedPhrases(CLEAN_SCRIPT)
    check(
      "4.8 a stored pattern that does not COMPILE is UNKNOWN, not a clean scan",
      broken.redFlags.length === 0 && broken.warnings.length === 0 &&
        (broken.unknownReason ?? "").startsWith(COMPLIANCE_UNKNOWN_PREFIX),
      `one uncompilable row must not report the content clean — got ${JSON.stringify(broken)}`,
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. THE CATALOGUE READ ITSELF
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[5] the catalogue read is federal ∪ tenant, and honest about failure")
  {
    W = newWorld()
    const cat = await loadProhibitedPhraseCatalogue()
    check(
      "5.1 both scopes come back in ONE read (RLS unions them; a brokerage filter would hide the federal rows)",
      cat.state === "loaded" &&
        cat.rows.some((r: any) => r.phrase === "no children") &&
        cat.rows.some((r: any) => r.phrase === "we guarantee"),
      JSON.stringify(cat.rows.map((r: any) => r.phrase)),
    )
    const gateSrc = code(GATE)
    check(
      "5.2 the read carries NO .eq(\"brokerage_id\", …) — NULL = <uuid> is never true",
      !/from\(\s*["']prohibited_phrases["']\s*\)[\s\S]{0,400}?\.eq\(\s*["']brokerage_id["']/.test(gateSrc),
      "that filter would drop all 25 federal rows and silently reopen the gate m450 closed",
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. CONSTRUCTS the behaviour layer cannot see — the shipped callers
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[6] the two callers are wired in the order the ruling requires")

  interface SourceCheck {
    id: string
    file: string
    detail: string
    predicate: (src: string) => boolean
    /** Put the defect back. Section 7 requires the predicate to go red on this. */
    mutate: (src: string) => string
  }

  const idx = (src: string, name: string) => {
    const m = new RegExp(String.raw`await\s+${name}\s*\(`).exec(src)
    return m ? m.index : -1
  }

  const SOURCE_CHECKS: SourceCheck[] = [
    {
      id: "6.1 GATE-PROMPT-CARRIES-THE-TENANT-CATALOGUE",
      file: GATE,
      detail: "buildComplianceSystemBlocks must splice the prohibited-phrase block into what it returns — computing it and not returning it is the dead-gate shape",
      predicate: (s) =>
        // `\([^)]*\)` not `\(\)`: the catalogue read carries a tenant scope since
        // 2026-09-02 (lane W4a) — pinning the empty-argument spelling was a §2
        // waypoint that went red because the work landed.
        /buildComplianceSystemBlocks[\s\S]{0,600}?buildProhibitedPhraseBlock\(\s*await\s+loadProhibitedPhraseCatalogue\([^)]*\)\s*\)/.test(s) &&
        /return\s*\[[^\]]*phraseBlock[^\]]*\]\.filter\(Boolean\)/.test(s),
      mutate: (s) => s.replace(/,\s*phraseBlock\]/, "]"),
    },
    {
      id: "6.2 GATE-PHRASE-PASS-IS-OUTSIDE-THE-TRY",
      file: GATE,
      detail: "assessProhibitedPhrases must run before the try block in assessScriptCompliance — inside it, a thrown evaluator would hide the brokerage's own blocking words",
      predicate: (s) => {
        const fn = /export async function assessScriptCompliance[\s\S]*?\n\}/.exec(s)?.[0] ?? ""
        const p = fn.indexOf("assessProhibitedPhrases(")
        const t = fn.indexOf("try {")
        return p >= 0 && t >= 0 && p < t
      },
      // `script[^)]*` not `script`: the call carries the catalogue and tenant scope
      // since 2026-09-02 (lane W4a); a mutation anchored on the old spelling
      // silently changes nothing and the control never runs (§2).
      mutate: (s) => s.replace(/const\s+phrases\s*=\s*await\s+assessProhibitedPhrases\(script[^)]*\)/, "const phrases = { catalogueState: \"loaded\" as const, redFlags: [] as string[], warnings: [] as string[], unknownReason: undefined }"),
    },
    {
      id: "6.3 GATE-KEEPS-THE-PHRASE-WARNINGS",
      file: GATE,
      detail: "the kernel gate's violations must be APPENDED to the phrase warnings — assigning over them silently drops every non-blocking word the brokerage configured",
      predicate: (s) => /warnings\.push\(\s*\.\.\.\(postCheck\.violations\s*\?\?\s*\[\]\)/.test(s),
      mutate: (s) => s.replace(/warnings\.push\(\s*\.\.\.\((postCheck\.violations[\s\S]*?)\)\s*\)/, "warnings = ($1)"),
    },
    {
      id: "6.4 GATE-UNKNOWN-OUTRANKS-ADVISORY",
      file: GATE,
      detail: "an unapplied rule set must not be graded 'advisory' — a clean bill of health with a note attached is how an unchecked script ships",
      predicate: (s) =>
        /redFlags\.length\s*>\s*0\s*\?\s*"red_flag"\s*:\s*unknownReasons\.length\s*>\s*0\s*\?\s*"unknown"\s*:\s*warnings\.length\s*>\s*0\s*\?\s*"advisory"/.test(
          s.replace(/\s+/g, " "),
        ),
      mutate: (s) => s.replace(/:\s*unknownReasons\.length\s*>\s*0\s*\?\s*"unknown"/, ': false ? "unknown"'),
    },
    {
      id: "6.5 GATE-CATALOGUE-DESTRUCTURES-ERROR",
      file: GATE,
      detail: "supabase-js RESOLVES a refused read; without `error` a permission denial arrives as an empty catalogue and every script passes",
      predicate: (s) =>
        /loadProhibitedPhraseCatalogue[\s\S]{0,900}?const\s*\{\s*data,\s*error\s*\}\s*=\s*await\s+supabase[\s\S]{0,400}?if\s*\(\s*error\s*\)\s*return\s*\{\s*state:\s*"unreadable"/.test(s),
      mutate: (s) => s.replace(/if\s*\(\s*error\s*\)\s*return\s*\{\s*state:\s*"unreadable",\s*rows:\s*\[\],\s*error:\s*error\.message\s*\}/, ""),
    },
    {
      id: "6.6 GATE-EMPTY-IS-NOT-LOADED",
      file: GATE,
      detail: "zero active phrases must read as 'empty' — that is a gate that would pass every script ever written, which is exactly what happened before m450",
      predicate: (s) => /if\s*\(\s*rows\.length\s*===\s*0\s*\)\s*return\s*\{\s*state:\s*"empty"/.test(s),
      mutate: (s) => s.replace(/if\s*\(\s*rows\.length\s*===\s*0\s*\)\s*return\s*\{\s*state:\s*"empty",\s*rows:\s*\[\]\s*\}/, ""),
    },
    {
      id: "6.7 WIZARD-HOLDS-AN-UNEVALUATABLE-SCRIPT",
      file: WIZARD,
      detail: "state 'unknown' must file the review row, not just a sentence — an escalation nobody is summoned to is not an escalation",
      predicate: (s) =>
        /else\s+if\s*\(\s*unevaluated\s*\)\s*\{[\s\S]{0,900}?await\s+escalateScriptToHumanReview\s*\(\{[\s\S]{0,600}?holdReason:\s*"unevaluated"/.test(s),
      mutate: (s) => s.replace(/else\s+if\s*\(\s*unevaluated\s*\)\s*\{/, "else if (false) {"),
    },
    {
      // RETARGETED 2026-09-03. This asserted the hold on `generateAIScript`, the
      // twin generator DELETED onto generate-script.ts (6.7 asserts the hold on
      // that survivor). The rule did not disappear with the function: the twin
      // file still runs PAID INFERENCE over a script — `improveScript` rewrites
      // a gated script on request — and that rewrite reached the agent with no
      // compliance blocks in its prompt and no post-check on its output, which
      // made it the last script path outside the gate. So the assertion follows
      // the RISK rather than the deleted name: the rewrite must be steered.
      id: "6.8 PROJECT-REWRITE-IS-STEERED-BEFORE-IT-SPENDS",
      file: PROJECT,
      detail: "improveScript must put buildComplianceSystemBlocks INTO the prompt before generateText — a rewrite of a gated script is a new script",
      predicate: (s) => {
        const blocks = idx(s, "buildComplianceSystemBlocks")
        const gen = idx(s, "generateText")
        return blocks >= 0 && gen >= 0 && blocks < gen && /\$\{complianceBlocks\.join\(/.test(s)
      },
      mutate: (s) => s.replace(/\$\{complianceBlocks\.join\([^)]*\)\}\n\n/, ""),
    },
    {
      id: "6.9 WIZARD-COUNTS-THE-BROKERAGE-BLOCKING-WORDS-AS-RED-FLAGS",
      file: WIZARD,
      detail: "a word the brokerage marked critical must join redFlags, or the settings screen's 'Critical — block the content' is a lie",
      predicate: (s) => /redFlags\.push\(\s*\.\.\.detectProhibitedPhraseRedFlags\(/.test(s),
      mutate: (s) => s.replace(/redFlags\.push\(\s*\.\.\.detectProhibitedPhraseRedFlags\([^)]*\)\s*\)/, ""),
    },
    {
      // RETARGETED 2026-09-03, same reason as 6.8: the rule moved to the rewrite.
      // A brokerage's blocking word must stop the REWRITE too, and the original
      // script is untouched on screen, so refusing costs the agent nothing.
      id: "6.10 PROJECT-REWRITE-REFUSES-A-BROKERAGE-BLOCKING-WORD",
      file: PROJECT,
      detail: "improveScript must post-check its output and refuse on a prohibited-phrase red flag — not hand back copy the brokerage marked blocking",
      predicate: (s) => {
        const post = idx(s, "postcheckScript")
        // `idx` anchors on `await NAME(`; the red-flag filter is SYNCHRONOUS, so
        // it is located by plain search rather than silently reading as absent.
        const flags = s.indexOf("detectProhibitedPhraseRedFlags(")
        return post >= 0 && flags >= 0 && post < flags &&
          /if\s*\(\s*redFlags\.length\s*>\s*0\s*\)[\s\S]{0,400}?complianceBlocked:\s*true/.test(s)
      },
      mutate: (s) => s.replace(/if\s*\(\s*redFlags\.length\s*>\s*0\s*\)\s*\{/, "if (false) {"),
    },
    {
      id: "6.11 WIZARD-STEERS-BEFORE-IT-WRITES",
      file: WIZARD,
      detail: "buildComplianceSystemBlocks and the brief pre-check must both precede generateAIResponse — 'with them first' means the constraints are inputs",
      predicate: (s) => {
        const blocks = idx(s, "buildComplianceSystemBlocks")
        const pre = idx(s, "precheckBriefForFairHousing")
        const gen = idx(s, "generateAIResponse")
        return blocks >= 0 && pre >= 0 && gen >= 0 && blocks < gen && pre < gen
      },
      mutate: (s) => s.replace(/await\s+precheckBriefForFairHousing\s*\(/, "await NOTHING("),
    },
    {
      id: "6.12 WIZARD-NEVER-REFUSES-AFTER-GENERATION",
      file: WIZARD,
      detail: "no `success: false` may appear after the post-generation check — a warning that halts the pipeline is a defect against the ruling",
      predicate: (s) => {
        const post = idx(s, "postcheckScript")
        return post >= 0 && !s.slice(post).includes("success: false")
      },
      mutate: (s) =>
        s.replace(
          // Anchored on `const advisory = [`, not on the whole initializer: the
          // advisory list gained a spread and moved onto two lines, so the old
          // one-line anchor could not apply and the control silently proved
          // nothing (it SAID so, which is how this was caught).
          /const\s+advisory\s*=\s*\[/,
          'if (redFlags.length) return { success: false, error: "blocked" }\n  const advisory = [',
        ),
    },
    {
      id: "6.13 WIZARD-ADVISORY-EXCLUDES-THE-UNKNOWN-LINES",
      file: WIZARD,
      detail: "an UNKNOWN line counted as advisory would make state 'advisory' and skip the hold",
      predicate: (s) => /!w\.startsWith\(COMPLIANCE_UNKNOWN_PREFIX\)/.test(s),
      mutate: (s) => s.replace(/\s*&&\s*!w\.startsWith\(COMPLIANCE_UNKNOWN_PREFIX\)/, ""),
    },
    {
      // The content-studio lane is the only OTHER caller with a hold lever
      // (video_generation_queue.script_status = 'needs_revision'). It graded
      // severity off `startsWith("FairHousing:")` alone, so a word the brokerage
      // marked critical — and a gate that never ran — both landed as "warning"
      // and the row was written compliance_check_passed with no revision.
      id: "6.13b LINK-TO-VIDEO-GRADES-A-BLOCKING-WORD-AS-A-VIOLATION",
      file: LINK_TO_VIDEO,
      detail: "a brokerage-critical word and an UNKNOWN gate must force needs_revision on the one lane that can, not ride as advisory",
      predicate: (s) =>
        /issue\.startsWith\(PROHIBITED_PHRASE_RED_FLAG_PREFIX\)/.test(s) &&
        /issue\.startsWith\(COMPLIANCE_UNKNOWN_PREFIX\)/.test(s) &&
        /script_status:\s*["']needs_revision["']/.test(s),
      mutate: (s) => s.replace(/issue\.startsWith\(PROHIBITED_PHRASE_RED_FLAG_PREFIX\)\s*\|\|/, ""),
    },
  ]

  const sources = new Map<string, string>()
  for (const f of [GATE, WIZARD, PROJECT, LINK_TO_VIDEO]) sources.set(f, code(f))
  for (const c of SOURCE_CHECKS) {
    check(c.id, c.predicate(sources.get(c.file)!), `${c.file} — ${c.detail}`)
  }

  // ── the human lane on the other end is real and reads what we write ────────
  {
    const approvals = code("app/actions/marketing-ai-approvals.ts")
    check(
      "6.14 the admin queue lists video_scripts_library at approval_status='pending_review'",
      /\.from\(\s*["']video_scripts_library["']\s*\)[\s\S]{0,400}?\.eq\(\s*["']approval_status["']\s*,\s*["']pending_review["']\s*\)/.test(approvals),
      "the value the escalation writes must be the value the queue filters on",
    )
    const aggregator = code("lib/kernel/approval-queue-aggregator.ts")
    check(
      "6.15 approve/reject routes through the ONE canonical transition (video_script → video_scripts_library)",
      /video_script:\s*["']video_scripts_library["']/.test(aggregator),
      "no second approval spine",
    )
    const page = code("app/dashboard/admin/marketing-approvals/page.tsx")
    check(
      "6.16 a rendered surface consumes that queue",
      /await\s+listPendingMarketingAssetsAction\s*\(/.test(page),
      "an escalation into a list nothing renders summons nobody",
    )
    const settings = code("app/dashboard/settings/components/prohibited-phrases-panel.tsx")
    check(
      "6.17 the brokerage can actually ADD the words this gate now enforces",
      /addCompliancePhrase/.test(settings) && /deleteCompliancePhrase/.test(settings),
      "the owner ruled brokerages add their own prohibited words in settings — the writer has to exist",
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. NEGATIVE CONTROLS — put each defect back, in memory, and require red
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[7] negative controls — every check above must fail on the broken source")
  {
    const dead: string[] = []
    for (const c of SOURCE_CHECKS) {
      const original = sources.get(c.file)!
      const broken = c.mutate(original)
      if (broken === original) {
        dead.push(`${c.id}: the mutation changed nothing — the control never ran`)
        continue
      }
      if (c.predicate(broken)) {
        dead.push(`${c.id}: still PASSES with the defect reintroduced — it is not testing the fix`)
      }
    }
    check("7.1 every source check goes red on its own defect", dead.length === 0, `\n      ${dead.join("\n      ")}`)
  }

  // ── Behavioural negative controls: state the OLD behaviour and require that
  //    the current code no longer produces it.
  {
    // OLD: an empty catalogue was never consulted at all, so a clean script
    //      came back clean and shipped. Re-create that reading here.
    W = newWorld({ phrases: { data: [], error: null } })
    const now = await assessScriptCompliance(ACTOR, CLEAN_SCRIPT, "buyer")
    check(
      "7.2 the old 'empty catalogue reads as clean' answer is no longer produced",
      now.state !== "clean",
      `an empty prohibited-phrase list must not grade a script clean — got ${JSON.stringify(now)}`,
    )

    // OLD: postcheckScript returned undefined on a thrown evaluator, and every
    //      one of the five generators read undefined as clean.
    W = newWorld({ evaluate: async () => { throw new Error("db down") } })
    const flat = await postcheckScript(ACTOR, CLEAN_SCRIPT, "buyer")
    check(
      "7.3 the old `undefined` return on a thrown evaluator is no longer produced",
      flat !== undefined && Array.isArray(flat) && flat.length > 0,
      "undefined reads as clean at all five generators",
    )

    // OLD: state 'unknown' summoned nobody. Prove the lane now files a row for
    //      exactly the input that used to produce the inert label.
    W = newWorld({ evaluate: async () => { throw new Error("db down") } })
    const lane = await runLane(CLEAN_SCRIPT)
    check(
      "7.4 the old 'unknown label, no reviewer' outcome is no longer produced",
      lane.escalated === true && W.inserts.length === 1,
      `inserts=${JSON.stringify(W.inserts)}`,
    )

    // OLD: an advisory finding summoned a human, which is the OTHER way to get
    //      this wrong — a person in front of most listing scripts.
    W = newWorld({
      evaluate: async () => ({
        allowed: false,
        violations: ["ThemFirst: Content is only 40% contact-focused (target ≥60%)."],
        complianceEventId: "ce-3",
      }),
    })
    const advisoryLane = await runLane(WARNING_SCRIPT)
    check(
      "7.5 an advisory finding still does NOT summon a human (the opposite failure)",
      advisoryLane.escalated === false && W.inserts.length === 0,
      `escalating every medium finding is the hold-up the ruling forbids — ${JSON.stringify(W.inserts)}`,
    )
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fails.length} failed`)
  if (fails.length > 0) {
    for (const f of fails) console.log(`   - ${f}`)
    console.log(" ❌ SCRIPT_COMPLIANCE_FIRST_FAIL — a rule the writer never saw, or a check nobody could fail")
    process.exit(1)
  }
  console.log(
    " ✅ SCRIPT_COMPLIANCE_FIRST_PASS — fair housing and the brokerage's own prohibited words are",
  )
  console.log(
    "    written INTO the prompt, ordinary warnings ride back with the script, and a big red flag —",
  )
  console.log(
    "    or a script nobody could check — files a row a human actually reads.",
  )
}

main().catch((err) => {
  console.error("script-compliance-first: harness error", err)
  process.exit(1)
})
