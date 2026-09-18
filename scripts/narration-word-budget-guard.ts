#!/usr/bin/env tsx
/**
 * scripts/narration-word-budget-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY VIDEO PRODUCER'S WORD ASK IS DERIVED, NEVER TYPED (§2/§6).
 *
 * THE OWNER'S RULING, verbatim: "any branch for videos should produce a very
 * informative video and then take what the script is and make the words the
 * word composition length of the video." The FITTED half of that ruling has ONE
 * contract: narrationBudget / narrationLengthDirective / narrationMaxTokens /
 * fitNarrationToBudget (lib/video/script-structure.ts), compositionSeconds
 * (lib/remotion/composition-geometry.ts), and promoNarrationBudget for the
 * promo events (lib/video/promo-composition.ts).
 *
 * THE CENSUS THIS GUARD CLOSES — five files still asked raw word counts:
 *   · lib/video/intro-video-reactor.ts    — assignment branch asked "90-130
 *     words" (maxTokens 300) against AgentTalkingHeadReel = 420f/30fps = 14s,
 *     whose D-ID track is cut at BODY=10s. The anniversary branch was already
 *     derived; the welcome branch rode the same frames unbudgeted.
 *   · app/actions/listing-video.ts        — 150-180 / 40-60 / 20-30 / 50-70 /
 *     30-50 words, hand-typed beside the durations they restated.
 *   · app/actions/video-generation.ts     — 75-100 / 150-200 / 300-400 words
 *     retyped beside the tier seconds (pure D-ID; seconds are the decision).
 *   · lib/video/avatar-explainer.ts       — 55-75 words against compositions of
 *     30s (TeammateExplainerReel) and 18s (AgentExplainerReel fallback).
 *   · lib/video/chapter-video-generator.ts — 100-150 words + a private
 *     words/2.5 pace (a second WORDS_PER_MINUTE spelling).
 *
 * MEASUREMENT DISCIPLINE (§2):
 *   · Finders run on stripComments() source ONLY — the retired literals are
 *     kept verbatim in tombstone comments (a tombstone is not a call site), and
 *     they lived inside TEMPLATE LITERALS, so blankStrings() would blank the
 *     very defect the finder hunts. The blankStrings hazard is proven as a
 *     control below, not just asserted.
 *   · Numbers are DERIVED and printed, never pinned: durations are parsed out
 *     of the target files' own tables and pushed through the real budget
 *     helpers, so a moved composition or a changed tier moves this guard's
 *     numbers with nothing retyped.
 *   · Every absence claim has a positive control proving the finder still
 *     recognises the defect it was written for.
 *
 * Run: npx tsx scripts/narration-word-budget-guard.ts
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { COMPOSITION_GEOMETRY, compositionSeconds, geometryFor } from "../lib/remotion/composition-geometry"
import {
  NARRATION_HEADROOM,
  WORDS_PER_MINUTE,
  fitNarrationToBudget,
  narrationBudget,
  narrationLengthDirective,
  narrationMaxTokens,
  targetWordCount,
} from "../lib/video/script-structure"
import { blankStrings, stripComments } from "./strip-comments"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

/** A hand-typed narration-scale word range: "90-130 words", "300-400 words"…
 *  Two-digit-plus on BOTH sides on purpose: the explainer's on-screen copy
 *  rules ("1-3 words" eyebrow, "6-14 words" bullets, "2-4 words" cta) are
 *  LAYOUT constraints on chrome nobody speaks, not narration lengths, and they
 *  are deliberately out of scope. That exclusion is a published blind spot. */
const RAW_RANGE = /\b\d{2,3}\s*-\s*\d{2,3}\s+words?\b/i

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Narration word budgets — derived from the video, everywhere")
  console.log("══════════════════════════════════════════════════")
  console.log(` pace ${WORDS_PER_MINUTE} wpm · headroom ${NARRATION_HEADROOM} · ${Object.keys(COMPOSITION_GEOMETRY).length} registered compositions\n`)

  // ── 0. THE FINDER ITSELF, proven before any absence claim (§2) ────────────
  console.log("[0 — positive controls: the finders recognise the defects]")
  check("control · the range finder GOES RED on the retired welcome ask",
    RAW_RANGE.test(stripComments("`Open with a hook. 90-130 words. No jargon.`")))
  check("control · …and on the retired long-tier ask",
    RAW_RANGE.test(stripComments("`Length: 2-3 minutes (approximately 300-400 words)`")))
  check("control · a TOMBSTONE quoting the literal does NOT satisfy it (comments stripped)",
    !RAW_RANGE.test(stripComments("// WHAT STOOD HERE: \"90-130 words.\" — retired, see narrationBudget")))
  check("control · the blankStrings HAZARD is real: blanking strings would hide the\n    defect inside a prompt template, which is why these finders never use it",
    !RAW_RANGE.test(blankStrings(stripComments("const p = `90-130 words.`")))
    && RAW_RANGE.test(stripComments("const p = `90-130 words.`")))
  check("control · the derived-directive finder GOES RED when the directive is removed",
    !/narrationLengthDirective\(/.test("prompt = `just vibes`"))

  // ── 1. intro-video-reactor — BOTH triggers ride the derived budget ────────
  console.log("\n[1 — lib/video/intro-video-reactor.ts (welcome + anniversary)]")
  const reactorRaw = read("lib/video/intro-video-reactor.ts")
  const reactor = stripComments(reactorRaw)
  const introComp = "AgentTalkingHeadReel"
  const introGeo = geometryFor(introComp)
  const introBudget = narrationBudget(introComp, introGeo ? compositionSeconds(introGeo) : 0)
  console.log(`   ${introComp}: ${introGeo?.duration_frames}f @ ${introGeo?.fps}fps = ${introBudget.compositionSeconds}s → ${introBudget.budgetSeconds}s claimable → ${introBudget.maxWords} words`)
  check("no hand-typed word range survives in live code", !RAW_RANGE.test(reactor))
  check("…while the RAW source keeps the retired '90-130 words' legible as the record",
    reactorRaw.includes("90-130 words"))
  check("the ASSIGNMENT prompt itself asks the ONE directive (anchored inside its\n    own template literal, not anywhere in the file)",
    /const basePrompt = args\.trigger === "contact_agent_assigned"\s*\?\s*`[^`]*\$\{narrationLengthDirective\(budget\)\}[^`]*`/.test(reactor))
  check("the anniversary prompt still asks it too (no regression)",
    (reactor.match(/\$\{narrationLengthDirective\(budget\)\}/g) ?? []).length >= 2)
  check("the model's token ceiling is derived for BOTH lanes — the flat 300 is gone",
    /maxTokens:\s*narrationMaxTokens\(budget\)/.test(reactor) && !/maxTokens:\s*\d/.test(reactor))
  {
    // The fit must run for BOTH triggers: between the gate's pass (`script =
    // complianceResult.script`) and the fit call there must be NO anniversary
    // conditional, and the fit must precede the anniversary-only verification.
    const passIdx = reactor.indexOf("script = complianceResult.script")
    const fitIdx = reactor.indexOf("fitNarrationToBudget(script, budget)")
    const verifyIdx = reactor.indexOf("verifyEquityClaims(")
    check("the returned script is FITTED for both triggers — the trim sits outside the\n    anniversary conditional and before the equity verification",
      passIdx !== -1 && fitIdx > passIdx && verifyIdx > fitIdx
      && !reactor.slice(passIdx, fitIdx).includes("home_anniversary"))
  }
  check(`the budget the reactor derives is the composition's, derived here too:\n    ${introBudget.maxWords} words from ${introBudget.compositionSeconds}s (nothing pinned)`,
    introBudget.maxWords === targetWordCount(Number((introBudget.compositionSeconds * (1 - NARRATION_HEADROOM)).toFixed(3)))
    && introBudget.maxWords > 0)
  check("the directive the model reads quotes exactly that derived ceiling",
    narrationLengthDirective(introBudget).includes(`AT MOST ${introBudget.maxWords} words`))
  {
    const long = Array.from({ length: introBudget.maxWords * 3 }, (_, i) => `w${i}`).join(" ")
      .replace(/(\S+ \S+ \S+ \S+ \S+) /g, "$1. ")
    const fit = fitNarrationToBudget(long, introBudget)
    check("an over-long welcome draft is trimmed under budget and SAYS SO",
      fit.wordCount <= introBudget.maxWords && fit.overran && fit.note.length > 0)
  }

  // ── 2. app/actions/listing-video.ts — the narration lane is MERGED AWAY ───
  // 2026-08-27: generateListingVideo no longer authors narration AT ALL. Its
  // bespoke assembler (AI photo selection + narration + a queue row nothing
  // read) was merged onto the Director rail (§1.1 — survivor
  // lib/video/video-director.ts commissionVideo, kind 'photo_walkthrough');
  // this guard's earlier finding here ("budget derives from the ONE duration
  // table") described a prompt whose output was written to a project row no
  // renderer ever picked up. The rule this section now holds: the file stages
  // through the Director and does not grow a narration ask back — and if one
  // ever returns, RAW_RANGE + the derived-directive finders above will judge
  // it like every other lane.
  console.log("\n[2 — app/actions/listing-video.ts (merged onto the Director rail)]")
  const listingRaw = read("app/actions/listing-video.ts")
  const listing = stripComments(listingRaw)
  check("no hand-typed word range survives in live code", !RAW_RANGE.test(listing))
  check("…while the RAW source keeps the retired map legible as the record",
    listingRaw.includes("150-180 words (2 min narration)"))
  check("the file stages through the Director's commissionVideo (photo_walkthrough)",
    /commissionVideo\(/.test(listing) && /['"]photo_walkthrough['"]/.test(listing))
  check("no narration is authored here any more — no model call remains",
    !/generateText\(/.test(listing) && !/generateAIResponse\(/.test(listing)
    && !/maxTokens/.test(listing))
  check("…and no private duration table came back (the geometry lives in\n    lib/remotion/composition-geometry.ts, §6)",
    !/getDurationForType/.test(listing))

  // ── 3. app/actions/video-generation.ts — tier words derive from tier seconds ─
  console.log("\n[3 — app/actions/video-generation.ts (1:1 contact messages, pure D-ID)]")
  const vgenRaw = read("app/actions/video-generation.ts")
  const vgen = stripComments(vgenRaw)
  check("no hand-typed word range survives in live code", !RAW_RANGE.test(vgen))
  check("…while the RAW source keeps the retired tiers legible as the record",
    vgenRaw.includes("(approximately 75-100 words)"))
  check("the tiers declare SECONDS and derive words through targetWordCount",
    /lengthTierSeconds/.test(vgen)
    && /targetWordCount\(tierSeconds\[0\]\)/.test(vgen)
    && /targetWordCount\(tierSeconds\[1\]\)/.test(vgen))
  {
    const pairs = [...vgen.matchAll(/(short|medium|long):\s*\[(\d+),\s*(\d+)\]/g)]
      .map((m) => [m[1], Number(m[2]), Number(m[3])] as const)
    check("all three tiers parse from the file's own table", pairs.length === 3, `parsed ${pairs.length}`)
    for (const [tier, lo, hi] of pairs) {
      console.log(`   ${tier.padEnd(8)} ${lo}-${hi}s declared → ${targetWordCount(lo)}-${targetWordCount(hi)} words at ${WORDS_PER_MINUTE} wpm`)
      check(`  ${tier} — the derived words are the one pace over the declared seconds`,
        targetWordCount(lo) === Math.round((lo / 60) * WORDS_PER_MINUTE)
        && targetWordCount(hi) === Math.round((hi / 60) * WORDS_PER_MINUTE))
    }
  }

  // ── 4. lib/video/avatar-explainer.ts — budget from the chosen composition ──
  console.log("\n[4 — lib/video/avatar-explainer.ts (teammate/agent explainer)]")
  const explRaw = read("lib/video/avatar-explainer.ts")
  const expl = stripComments(explRaw)
  const tGeo = geometryFor("TeammateExplainerReel")
  const aGeo = geometryFor("AgentExplainerReel")
  const tBudget = narrationBudget("TeammateExplainerReel", tGeo ? compositionSeconds(tGeo) : 0)
  const aBudget = narrationBudget("AgentExplainerReel", aGeo ? compositionSeconds(aGeo) : 0)
  console.log(`   TeammateExplainerReel ${tBudget.compositionSeconds}s → ${tBudget.maxWords} words · AgentExplainerReel ${aBudget.compositionSeconds}s → ${aBudget.maxWords} words`)
  check("the retired '55-75 words' ask is gone from live code",
    !RAW_RANGE.test(expl))
  check("…while the RAW source keeps it legible as the record", explRaw.includes("55-75 words"))
  check("the author derives its budget from the composition it is told about",
    /narrationBudget\(args\.compositionId,/.test(expl))
  check("a composition with no runtime is a REFUSAL, not 'no limit'",
    /budget\.maxWords\s*<=\s*0/.test(expl) && /no runtime to narrate/.test(explRaw))
  check("the prompt asks the ONE directive",
    /\$\{narrationLengthDirective\(budget\)\}/.test(expl))
  check("the compliance gate treats an overrun as a VIOLATION the redraft must fix",
    /n\s*>\s*budget\.maxWords/.test(expl))
  check("…and the fit backstop still runs on what parses, reported never silent",
    /fitNarrationToBudget\(content\.narration,\s*budget\)/.test(expl) && /fit\.note/.test(expl))
  check("the commission picks the composition BEFORE authoring, so the budget the\n    writer used and the frames the render uses are the same fact",
    expl.indexOf("await pickCompositionId()") !== -1
    && expl.indexOf("await pickCompositionId()") < expl.indexOf("await authorExplainerContent({"))
  check("both live compositions carry a real, distinct budget (the fallback is the\n    SHORTER one — authoring against the wrong id would overrun it)",
    tBudget.maxWords > 0 && aBudget.maxWords > 0 && aBudget.maxWords < tBudget.maxWords)
  const directorContent = stripComments(read("lib/video/director-content.ts"))
  check("the Director rail's call names its composition too",
    /authorExplainerContent\(\{[\s\S]{0,400}?compositionId,/.test(directorContent))

  // ── 5. lib/video/chapter-video-generator.ts — derived ask, one pace ───────
  console.log("\n[5 — lib/video/chapter-video-generator.ts (presentation chapters, pure D-ID)]")
  const chapRaw = read("lib/video/chapter-video-generator.ts")
  const chap = stripComments(chapRaw)
  check("no hand-typed word range survives in live code", !RAW_RANGE.test(chap))
  check("…while the RAW source keeps the retired '100-150 words' legible",
    chapRaw.includes("100-150 words"))
  check("the seconds are the ONLY length decision, and the words derive from them",
    /CHAPTER_TARGET_SECONDS_MIN\s*=\s*\d+/.test(chap)
    && /targetWordCount\(CHAPTER_TARGET_SECONDS_MIN\)/.test(chap)
    && /chapterBudget\.maxWords/.test(chap))
  check("the token ceiling is derived — the flat 400 is gone",
    /maxTokens:\s*narrationMaxTokens\(chapterBudget\)/.test(chap) && !/maxTokens:\s*\d/.test(chap))
  check("the private words/2.5 pace is gone — duration estimates go through the ONE\n    estimateDurationSeconds (§6)",
    !/\/\s*2\.5/.test(chap) && /estimateDurationSeconds\(spokenWords\(script\)\.length\)/.test(chap))
  {
    const mMin = /CHAPTER_TARGET_SECONDS_MIN\s*=\s*(\d+)/.exec(chap)
    const mMax = /CHAPTER_TARGET_SECONDS_MAX\s*=\s*(\d+)/.exec(chap)
    const lo = Number(mMin?.[1] ?? 0)
    const hi = Number(mMax?.[1] ?? 0)
    console.log(`   chapter target ${lo}-${hi}s declared → ${targetWordCount(lo)}-${targetWordCount(hi)} words at ${WORDS_PER_MINUTE} wpm`)
    check("the declared chapter seconds parse and derive a real ask",
      lo > 0 && hi > lo && targetWordCount(hi) === narrationBudget("chapter_video", hi, 0).maxWords)
  }

  // ── 6. Non-regression — the routes that already derived still do ──────────
  console.log("\n[6 — non-regression: the derived routes stay derived]")
  const newsRoute = stripComments(read("app/api/internal/remotion/render-newsletter-video/route.ts"))
  const justRoute = stripComments(read("app/api/internal/remotion/render-just-listed/route.ts"))
  check("render-newsletter-video: budget derived + directive + derived tokens + fit",
    /narrationBudget\(/.test(newsRoute) && /narrationLengthDirective\(/.test(newsRoute)
    && /narrationMaxTokens\(/.test(newsRoute) && /fitNarrationToBudget\(/.test(newsRoute))
  check("render-just-listed: promoNarrationBudget + directive + derived tokens + fit",
    /promoNarrationBudget\(/.test(justRoute) && /narrationLengthDirective\(/.test(justRoute)
    && /narrationMaxTokens\(/.test(justRoute) && /fitNarrationToBudget\(/.test(justRoute))
  check("neither route re-declares a words-per-minute pace of its own",
    !/WORDS_PER_MINUTE\s*=/.test(newsRoute) && !/WORDS_PER_MINUTE\s*=/.test(justRoute))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" BLIND SPOTS, published beside the number (§2):")
  console.log("   · Denominator: the five census files + the two render routes named above —")
  console.log("     a NEW producer that types a raw range is caught only if added here.")
  console.log("   · Single-digit on-screen copy rules (explainer eyebrow/title/bullets/cta,")
  console.log("     newsletter's editorial '25-35 word' target under its enforced cap) are")
  console.log("     layout/editorial constraints, deliberately outside RAW_RANGE's reach.")
  console.log("   · video-generation.ts asks are derived from DECLARED durations, not")
  console.log("     Remotion frame caps — that lane is pure D-ID with no composition to")
  console.log("     derive from. listing-video.ts's queue reachability question is RESOLVED")
  console.log("     (2026-08-27): its narration lane never reached a renderer and was merged")
  console.log("     onto commissionVideo — section 2 now asserts the merged state.")
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Every video producer's word ask derives from the video it rides.")
  console.log(" NARRATION_WORD_BUDGET_PASS")
  process.exit(0)
}

main()
