#!/usr/bin/env tsx
/**
 * scripts/promo-narration-budget-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LISTING-PROMO SCRIPT LENGTH IS DERIVED, NOT TYPED (§6).
 *
 * `lib/video/listing-promo-reactor.ts` carried its own `wordCount` /
 * `durationSeconds` literals per event ("35-50", "15-20", …) — a SECOND answer
 * to a question `lib/video/promo-composition.ts:promoNarrationBudget` already
 * answers from the geometry of the composition each event actually renders on.
 * Measured against the live geometry table, every literal was over that budget
 * and four were over 2×.
 *
 * WHAT THIS GUARD ASSERTS, and what it deliberately does not:
 *   · the RULE — no length literal survives in the reactor's templates, and the
 *     prompt / token budget / verification all come from the ONE budget helper;
 *   · the ARITHMETIC — derived and PRINTED, never pinned. A composition whose
 *     frame count changes (m566 moved one from 300 to 900 mid-wave) must move
 *     the number here with nothing retyped, so a hardcoded 24 or 50 in this file
 *     would be the same waypoint defect the literals were (§2).
 *
 * Run: npx tsx scripts/promo-narration-budget-guard.ts
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { compositionForPromoEvent, promoNarrationBudget } from "../lib/video/promo-composition"
import { COMPOSITION_GEOMETRY, compositionSeconds, geometryFor } from "../lib/remotion/composition-geometry"
import {
  NARRATION_HEADROOM,
  WORDS_PER_MINUTE,
  fitNarrationToBudget,
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

/** The seven listing-promo moments (lib/kernel/lifecycle-promo-policy). */
const EVENTS = [
  "coming_soon",
  "just_listed",
  "open_house_announce",
  "open_house_reminder",
  "price_reduction",
  "under_contract",
  "just_sold",
] as const

/** The literals that stood in the reactor before this closure, for the record. */
const PRE_FIX_CEILINGS: Record<(typeof EVENTS)[number], number> = {
  coming_soon: 50,
  just_listed: 60,
  open_house_announce: 55,
  open_house_reminder: 40,
  price_reduction: 50,
  under_contract: 40,
  just_sold: 55,
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Listing-promo narration budget — derived, not typed")
  console.log("══════════════════════════════════════════════════\n")

  const reactorRaw = read("lib/video/listing-promo-reactor.ts")
  // STRIPPED, and string-blanked too: the TOMBSTONE in that file quotes every
  // retired literal ("35-50", "15-20") as part of the evidence table §1 requires
  // it to keep. Reading raw source would let the record of the fix read as the
  // defect, forever — the exact trap CLAUDE.md §2 records five guards falling
  // into on one JSDoc block.
  const reactor = blankStrings(stripComments(reactorRaw))

  // ── 1. THE LITERALS ARE GONE ──────────────────────────────────────────────
  console.log("[1 — no length literal survives in the reactor]")
  check("EventTemplate no longer declares durationSeconds / wordCount",
    !/durationSeconds\s*:/.test(reactor) && !/wordCount\s*:/.test(reactor))
  check("…and no template still hands the prompt a hand-typed range",
    !/\b\d{2}\s*-\s*\d{2}\s+words?\b/i.test(reactor))
  check("the reactor asks the ONE budget helper instead (import-pinned)",
    /import \{ promoNarrationBudget \} from "@\/lib\/video\/promo-composition"/.test(stripComments(reactorRaw))
    && /promoNarrationBudget\(args\.eventType\)/.test(reactor))
  check("the prompt is CONSTRAINED by the derived budget",
    /narrationLengthDirective\(budget\)/.test(reactor))
  check("the model's token budget is sized from the SAME number",
    /narrationMaxTokens\(budget\)/.test(reactor) && !/maxTokens:\s*\d+/.test(reactor))
  check("…and the returned draft is VERIFIED, not trusted",
    /fitNarrationToBudget\(text\.trim\(\), budget\)/.test(reactor))
  check("the spoken-seconds figure in the prompt is derived too",
    /\$\{budget\.compositionSeconds\}-second/.test(reactorRaw))

  // POSITIVE CONTROLS (§2) — a broken finder and a clean tree both report zero.
  console.log("\n[1b — the finders still recognise the defects they were written for]")
  check("control · the literal finder GOES RED on a spliced-in wordCount",
    /wordCount\s*:/.test(blankStrings(stripComments('  const t = { wordCount: "35-50" }'))))
  check("control · the range finder GOES RED on a hand-typed prompt line",
    /\b\d{2}\s*-\s*\d{2}\s+words?\b/i.test(blankStrings(stripComments("`- 35-50 words total`")))
    === false // blankStrings blanks a template body …
    && /\b\d{2}\s*-\s*\d{2}\s+words?\b/i.test("- 35-50 words total")) // … so the raw shape is what it matches
  check("control · a TOMBSTONE quoting the retired literals does NOT satisfy the literal finder",
    !/wordCount\s*:/.test(blankStrings(stripComments("// wordCount: \"35-50\" is GONE — survivor: promoNarrationBudget"))))
  check("control · the fixed-token finder GOES RED on a hardcoded maxTokens",
    /maxTokens:\s*\d+/.test(blankStrings(stripComments("    maxTokens:   220,"))))

  // ── 2. THE ARITHMETIC, DERIVED AND PRINTED ────────────────────────────────
  console.log("\n[2 — every event's budget, derived from the composition it renders on]")
  console.log(`   pace ${WORDS_PER_MINUTE} wpm · headroom ${NARRATION_HEADROOM} · ${Object.keys(COMPOSITION_GEOMETRY).length} registered compositions`)
  let overCount = 0
  for (const e of EVENTS) {
    const { compositionId } = compositionForPromoEvent(e)
    const geo = geometryFor(compositionId)
    const budget = promoNarrationBudget(e)
    const secs = geo ? compositionSeconds(geo) : 0
    const ratio = budget.maxWords > 0 ? PRE_FIX_CEILINGS[e] / budget.maxWords : Infinity
    if (ratio > 1) overCount++
    console.log(
      `   ${e.padEnd(20)} ${compositionId.padEnd(22)} ${String(secs).padStart(5)}s → ` +
        `${String(budget.maxWords).padStart(3)} w   (typed ceiling was ${PRE_FIX_CEILINGS[e]}, ${ratio.toFixed(2)}×)`,
    )
    check(`  ${e} — the budget is the composition's geometry, not a literal`,
      geo !== null && budget.compositionId === compositionId && budget.compositionSeconds === secs
      && budget.maxWords === targetWordCount(Number((secs * (1 - NARRATION_HEADROOM)).toFixed(3))))
  }
  console.log(`   ${overCount} of ${EVENTS.length} events were over budget before this closure`)
  check("the finding was real — at least one typed ceiling exceeded its composition",
    overCount > 0)
  check("…and every event now has a POSITIVE budget (no composition silently caps to zero)",
    EVENTS.every((e) => promoNarrationBudget(e).maxWords > 0))

  // ── 3. THE PROMPT AND THE TRIM AGREE ──────────────────────────────────────
  //
  // The directive tells the model a number; the trim enforces it. They must be
  // the SAME number, or the prompt is a suggestion and the cut is a surprise.
  console.log("\n[3 — the directive the model is given IS the ceiling the trim enforces]")
  for (const e of EVENTS) {
    const b = promoNarrationBudget(e)
    const directive = narrationLengthDirective(b)
    check(`  ${e} — the directive quotes the derived ceiling`,
      directive.includes(`AT MOST ${b.maxWords} words`) && directive.includes(`${b.compositionSeconds}-second`))
    // A draft deliberately 3× the ceiling, in whole sentences.
    const long = Array.from({ length: b.maxWords * 3 }, (_, i) => `w${i}`).join(" ").replace(/(\S+ \S+ \S+ \S+ \S+) /g, "$1. ")
    const fit = fitNarrationToBudget(long, b)
    check(`  ${e} — an over-long draft is trimmed under budget and SAYS SO`,
      fit.wordCount <= b.maxWords && fit.overran && fit.note.length > 0,
      `${fit.wordCount}/${b.maxWords} overran=${fit.overran}`)
    check(`  ${e} — the token budget covers the ceiling it asks for`,
      narrationMaxTokens(b) >= b.maxWords)
  }

  // ── 4. THE SURVIVOR IS SHARED, not re-derived ─────────────────────────────
  console.log("\n[4 — one budget helper, two producers]")
  const renderRoute = stripComments(read("app/api/internal/remotion/render-just-listed/route.ts"))
  check("the RENDER endpoint and the REACTOR ask the same function",
    /promoNarrationBudget\(/.test(renderRoute) && /promoNarrationBudget\(/.test(reactor))
  check("neither re-declares a words-per-minute pace of its own",
    !/WORDS_PER_MINUTE\s*=/.test(reactor) && !/WORDS_PER_MINUTE\s*=/.test(renderRoute))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" BLIND SPOT: this guard proves the reactor's PRE-FLIGHT draft is budgeted.")
  console.log("   That draft is compliance-gated and then DISCARDED — the spoken narration is")
  console.log("   drafted again by render-just-listed. Sizing them alike is what makes the")
  console.log("   pre-flight a probe of the same artefact; it is not itself the spoken script.")
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Promo narration length is derived from composition geometry everywhere.")
  console.log(" PROMO_NARRATION_BUDGET_PASS")
  process.exit(0)
}

main()
