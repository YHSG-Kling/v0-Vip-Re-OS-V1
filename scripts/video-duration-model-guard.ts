#!/usr/bin/env tsx
/**
 * scripts/video-duration-model-guard.ts   (npm run test:video-duration-model)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PURPOSE-DRIVEN DURATION MODEL, PROVEN. Owner (wave 78, verbatim): "you
 * hardcoded the length of the video body for each video, what happens with any
 * new videos and not sure if that is the best practice because the video
 * needs to be long enough to achieve the reason for making the video."
 *
 * THE RULE (lib/video/duration-model.ts): purpose → word window → the writer
 * targets it → the fitted narration's seconds → the composition's body and
 * duration are COMPUTED (Root.tsx calculateMetadata), inside the registered
 * cap and the provider caps; every composition derives its body from the
 * duration it renders at; a new type inherits everything from one registry row.
 *
 * WHAT THIS PROVES
 *   §registry   every registered moving composition has a purpose row; every
 *               purpose has a researched min ≤ ideal ≤ max; the registered cap
 *               covers the purpose max; a synthetic NEW composition inherits the
 *               whole rule from one row, and an unregistered id fails closed
 *   §pace       the voiceover pace IS script-structure's WORDS_PER_MINUTE; the
 *               avatar pace sits in the researched 130-150 band; provider caps
 *               bound every purpose max
 *   §window     the word window is min ≤ ideal ≤ max at the host pace with the
 *               standard headroom, and the ONE directive speaks both the floor
 *               and the ceiling
 *   §body       the body is DERIVED from the narration: a script over the max is
 *               trimmed at a sentence boundary; a script under the min is
 *               reported and asked of the writer, never padded with silence; a
 *               measured length gets only the settle; nothing staged → the
 *               purpose IDEAL, never the cap; more words → more frames until the
 *               cap, which is flagged
 *   §sources    every chain composition tiles [0, duration) EXACTLY at the cap
 *               AND at a planned duration (a hardcoded body cannot); no
 *               narration composition carries a `const BODY = N * FPS` literal;
 *               the caption window equals the derived narration window
 *   §wiring     Root.tsx mounts calculateMetadata on every narration-driven
 *               composition and on no fixed one; the coordinator times the pad
 *               and the fade against the PLANNED seconds; the stagers carry
 *               spokenSeconds; the hand table is gone
 *
 * METHOD (§2): every source scan reads STRIPPED source; every absence assertion
 * has a POSITIVE CONTROL; every exclusion is PUBLISHED beside the count. PURE —
 * no network, no render, no database.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { VIDEO_COMPOSITION_FILES, NON_CHAIN_COMPOSITIONS, buildScope, tileChain, narrationWindow } from "./composition-segments"
import { COMPOSITION_GEOMETRY, geometryFor, type RegisteredGeometry } from "../lib/remotion/composition-geometry"
import {
  PURPOSE_DURATION_RULES, COMPOSITION_DURATION_RULES, AVATAR_WORDS_PER_MINUTE, DID_MAX_CLIP_SECONDS,
  VOICEOVER_MAX_SCRIPT_CHARS, NARRATION_SETTLE_SECONDS,
  hostWordsPerMinute, wordsForSeconds, spokenSecondsForWords, providerMaxSpokenSeconds,
  compositionBookends, compositionPurposes, requiredCapFrames, movingCompositionIds, capBodySeconds,
  purposeWordWindow, purposeBudgetFor, bodySecondsForNarration, planCompositionDuration,
  planDurationForProps, narrationLengthFromProps, renderedCompositionSeconds, durationMetadata,
  narrationWindowFrames, spokenSecondsProps,
  type VideoPurpose, type HostKind, type CompositionDurationSpec,
} from "../lib/video/duration-model"
import { narrationWindowBudget, narrationWindowSeconds } from "../lib/video/narration-window"
import {
  WORDS_PER_MINUTE, NARRATION_HEADROOM, narrationBudget, fitNarrationToBudget, narrationLengthDirective,
  spokenWords, spokenSentences,
} from "../lib/video/script-structure"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const readStripped = (rel: string): string => stripComments(readFileSync(join(root, rel), "utf8"))
const readCode = (rel: string): string => blankStrings(readStripped(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const skipNote = (name: string, why: string) => console.log(`  ⊘ ${name} — ${why}`)

/** The owner's own list (wave 77 matrix) — every one must be a purpose. */
const OWNER_PURPOSES: VideoPurpose[] = [
  "welcome", "anniversary_equity", "listing_promo", "cma", "market_update", "seller_update", "explainer",
  "product_demo", "memory", "partners_meeting", "lead_reel", "geo_reel", "newsletter", "photo_walkthrough",
  "listing_presentation_section", "testimonial",
]

/** Fixture sentences at natural length (8-10 words) so a trim has boundaries. */
function fixtureScript(words: number): string {
  const bank = [
    "Three days on market and two offers already came in.",
    "The kitchen's been redone with quartz counters and new appliances.",
    "It opens right onto the deck, which gets the evening light.",
    "Buyers are responding fast this week across the whole block.",
    "The roof was replaced last year, so that's one less worry.",
    "It's walkable to two parks and the coffee shop on Main.",
    "If you want a private showing, just text me back today.",
    "Rates ticked down again this month, which helps the payment.",
  ]
  const out: string[] = []
  let count = 0, i = 0
  while (count < words) { const s = bank[i % bank.length]; out.push(s); count += spokenWords(s).length; i++ }
  return out.join(" ")
}

/** The derived-rule finder the registry check uses — a pure function so it can
 *  be proven on a synthetic set (a finder that finds nothing is blind, §2). */
function missingRules(ids: string[], rules: Record<string, unknown>): string[] {
  return ids.filter((id) => !(id in rules))
}

const NARRATION_IDS = Object.entries(COMPOSITION_DURATION_RULES).filter(([, s]) => s.bodyMode === "narration").map(([id]) => id)
const FIXED_IDS = Object.entries(COMPOSITION_DURATION_RULES).filter(([, s]) => s.bodyMode === "fixed").map(([id]) => id)

// ═══════════════════════════════════════════════════════════════════════════
function registrySection() {
  console.log("\n── §registry — every moving composition has a purpose row; every purpose has a researched range ──")
  const moving = movingCompositionIds()
  const missing = missingRules(moving, COMPOSITION_DURATION_RULES)
  check(`every registered MOVING composition (${moving.length}) has a COMPOSITION_DURATION_RULES row`, missing.length === 0, missing.join(", "))
  const unregistered = Object.keys(COMPOSITION_DURATION_RULES).filter((id) => !geometryFor(id))
  check("every duration rule names a REGISTERED composition (no ghost rows)", unregistered.length === 0, unregistered.join(", "))
  check("CONTROL: the missing-row finder catches a moving id with no rule (synthetic)",
    missingRules(["A", "B"], { A: {} }).join() === "B" && missingRules(["A"], { A: {} }).length === 0)
  const stills = Object.entries(COMPOSITION_GEOMETRY).filter(([, g]) => g.duration_frames <= 1).map(([id]) => id)
  skipNote(`${stills.length} STILL compositions (duration_frames ≤ 1) are out of scope — nothing to size`, stills.join(", "))

  for (const p of OWNER_PURPOSES) check(`owner purpose "${p}" has a rule`, p in PURPOSE_DURATION_RULES)
  for (const [p, r] of Object.entries(PURPOSE_DURATION_RULES)) {
    check(`${p}: min ${r.minSeconds} ≤ ideal ${r.idealSeconds} ≤ max ${r.maxSeconds}, positive, with a reason and ≥1 source`,
      r.minSeconds > 0 && r.minSeconds <= r.idealSeconds && r.idealSeconds <= r.maxSeconds && r.why.length > 20 && r.sources.length >= 1)
  }
  for (const id of NARRATION_IDS) {
    const geo = geometryFor(id)!
    const need = requiredCapFrames(id, geo.fps)!
    check(`${id}: registered cap ${geo.duration_frames}f ≥ ${need}f = bookends + ${Math.max(...compositionPurposes(id).map((p) => PURPOSE_DURATION_RULES[p].maxSeconds))}s (purposes: ${compositionPurposes(id).join("/")})`,
      geo.duration_frames >= need)
    const spec = COMPOSITION_DURATION_RULES[id]
    check(`${id}: bookends (${spec.introFrames}+${spec.outroFrames}) leave the purpose minimum inside the cap`,
      spec.introFrames + spec.outroFrames + PURPOSE_DURATION_RULES[spec.purpose].minSeconds * geo.fps <= geo.duration_frames)
  }
  for (const id of FIXED_IDS) check(`${id}: a fixed-body row SAYS WHY (published exclusion)`, (COMPOSITION_DURATION_RULES[id].note ?? "").length > 10)

  // NEW-TYPE INHERITANCE — a synthetic composition gets the whole rule from
  // ONE row (purpose + host + bookends). Registered into COPIES of the two
  // tables for the duration of the check, then removed.
  console.log("\n  new-type inheritance (synthetic composition):")
  const SYN = "SyntheticSellerUpdateReel"
  const before = planCompositionDuration({ compositionId: SYN, wordCount: 80 })
  check("an UNREGISTERED composition fails closed — 1 frame and a note naming the registry, never a guessed body",
    before.durationInFrames === 1 && before.notes.some((n) => /COMPOSITION_DURATION_RULES/.test(n)))
  const synSpec: CompositionDurationSpec = { purpose: "seller_update", host: "avatar", introFrames: 45, outroFrames: 75, bodyMode: "narration" }
  ;(COMPOSITION_DURATION_RULES as Record<string, CompositionDurationSpec>)[SYN] = synSpec
  ;(COMPOSITION_GEOMETRY as Record<string, RegisteredGeometry>)[SYN] = { width: 1080, height: 1080, fps: 30, duration_frames: requiredCapFrames(SYN, 30)! }
  try {
    const budget = purposeBudgetFor(SYN)
    const rule = PURPOSE_DURATION_RULES.seller_update
    check(`the synthetic row inherits the seller_update word window (${budget.minWords}/${budget.idealWords}/${budget.maxWords} words at ${AVATAR_WORDS_PER_MINUTE} wpm)`,
      budget.purpose === "seller_update" && budget.host === "avatar" && budget.maxWords === wordsForSeconds(rule.maxSeconds * (1 - NARRATION_HEADROOM), "avatar") && budget.minWords > 0)
    const plan = planCompositionDuration({ compositionId: SYN, wordCount: budget.idealWords })
    check(`…and a plan for its ideal script derives intro ${plan.introFrames} + body ${plan.bodyFrames} + outro ${plan.outroFrames} = ${plan.durationInFrames} frames from the row alone`,
      plan.introFrames === 45 && plan.outroFrames === 75 && plan.durationInFrames === 45 + plan.bodyFrames + 75 && plan.bodyFrames > 1 && !plan.clampedToCap)
    check("…the derived narration window is [intro, intro + body)", plan.narrationWindow.from === 45 && plan.narrationWindow.to === 45 + plan.bodyFrames
      && narrationWindowFrames(SYN, plan.durationInFrames).to === plan.narrationWindow.to)
    check("…the thin adapter narrationWindowBudget resolves it to the purpose budget", narrationWindowBudget(SYN).maxWords === budget.maxWords)
    check("…and the required cap is bookends + the purpose max", requiredCapFrames(SYN, 30) === 45 + rule.maxSeconds * 30 + 75)
  } finally {
    delete (COMPOSITION_DURATION_RULES as Record<string, unknown>)[SYN]
    delete (COMPOSITION_GEOMETRY as Record<string, unknown>)[SYN]
  }
  check("the synthetic row was removed (no leak into the later sections)", !(SYN in COMPOSITION_DURATION_RULES) && !(SYN in COMPOSITION_GEOMETRY))
}

// ═══════════════════════════════════════════════════════════════════════════
function paceSection() {
  console.log("\n── §pace — one voiceover pace, a researched avatar pace, provider caps ──")
  check(`hostWordsPerMinute("voiceover") IS script-structure's WORDS_PER_MINUTE (${WORDS_PER_MINUTE}) — never a second literal`, hostWordsPerMinute("voiceover") === WORDS_PER_MINUTE)
  check(`the avatar pace (${AVATAR_WORDS_PER_MINUTE} wpm) sits in the researched 130-150 band and below the narration pace`, AVATAR_WORDS_PER_MINUTE >= 130 && AVATAR_WORDS_PER_MINUTE <= 150 && AVATAR_WORDS_PER_MINUTE < WORDS_PER_MINUTE)
  check("wordsForSeconds and spokenSecondsForWords invert each other at both paces (±1 word)",
    (["voiceover", "avatar"] as HostKind[]).every((h) => Math.abs(wordsForSeconds(spokenSecondsForWords(100, h), h) - 100) <= 1))
  // The same character cap speaks LONGER at the slower avatar pace (2400 chars
  // ≈ 400 words: 160 s at 150 wpm, 177.8 s at 135 wpm) — both stay under
  // D-ID's clip limit, and both are the cap the purpose max is clamped to.
  check(`providerMaxSpokenSeconds: avatar ${providerMaxSpokenSeconds("avatar")}s ≤ D-ID's ${DID_MAX_CLIP_SECONDS}s clip limit; voiceover ${providerMaxSpokenSeconds("voiceover")}s = the ${VOICEOVER_MAX_SCRIPT_CHARS}-char cap at ${WORDS_PER_MINUTE} wpm`,
    providerMaxSpokenSeconds("avatar") <= DID_MAX_CLIP_SECONDS
    && providerMaxSpokenSeconds("voiceover") === spokenSecondsForWords(Math.floor(VOICEOVER_MAX_SCRIPT_CHARS / 6), "voiceover")
    && providerMaxSpokenSeconds("avatar") > providerMaxSpokenSeconds("voiceover"))
  for (const id of NARRATION_IDS) {
    const spec = COMPOSITION_DURATION_RULES[id]
    const max = Math.max(...compositionPurposes(id).map((p) => PURPOSE_DURATION_RULES[p].maxSeconds))
    if (spec.multiClip) check(`${id}: multi-clip body — purpose max (${max}s) may exceed one ${spec.host} clip (${providerMaxSpokenSeconds(spec.host)}s) because chapters are split on sentence boundaries into several clips`, max > providerMaxSpokenSeconds(spec.host))
    else check(`${id}: every purpose max (${max}s) is reachable by its ${spec.host} provider (${providerMaxSpokenSeconds(spec.host)}s)`, max <= providerMaxSpokenSeconds(spec.host))
  }
  check("reel-voiceover.ts reads the synthesis cap FROM duration-model (one number, two readers)",
    /VOICEOVER_MAX_SCRIPT_CHARS/.test(readCode("lib/video/reel-voiceover.ts")) && !/MAX_SCRIPT_CHARS\s*=\s*2400/.test(readCode("lib/video/reel-voiceover.ts")))
  check("CONTROL: the retired literal is recognised", /MAX_SCRIPT_CHARS\s*=\s*2400/.test("const MAX_SCRIPT_CHARS = 2400"))
}

// ═══════════════════════════════════════════════════════════════════════════
function windowSection() {
  console.log("\n── §window — the word window the writer targets, and the ONE directive ──")
  for (const p of Object.keys(PURPOSE_DURATION_RULES) as VideoPurpose[]) {
    for (const host of ["voiceover", "avatar"] as HostKind[]) {
      const w = purposeWordWindow(p, host)
      const r = PURPOSE_DURATION_RULES[p]
      check(`${p}/${host}: ${w.minWords} ≤ ${w.idealWords} ≤ ${w.maxWords} words = purpose seconds × (1 − ${NARRATION_HEADROOM}) at ${hostWordsPerMinute(host)} wpm`,
        w.minWords <= w.idealWords && w.idealWords <= w.maxWords && w.minWords > 0
        && w.maxWords === wordsForSeconds(Math.min(r.maxSeconds, providerMaxSpokenSeconds(host)) * (1 - NARRATION_HEADROOM), host))
    }
  }
  for (const id of NARRATION_IDS) {
    const b = purposeBudgetFor(id)
    const cap = capBodySeconds(id)!
    check(`${id}: purposeBudgetFor = ${b.maxWords}w / ${b.budgetSeconds}s inside the ${cap}s cap body, floor ${b.minWords}w, purpose ${b.purpose}`,
      b.maxWords > 0 && b.budgetSeconds <= cap + 1e-9 && b.compositionSeconds <= cap + 1e-9 && b.minWords > 0 && b.minWords <= b.maxWords && b.headroom === NARRATION_HEADROOM)
    const d = narrationLengthDirective(b)
    check(`${id}: the ONE directive speaks the ceiling AND the purpose floor`, d.includes(`AT MOST ${b.maxWords} words`) && d.includes(`AT LEAST ${b.minWords} words`) && d.includes(b.purpose.replace(/_/g, " ")))
  }
  for (const id of FIXED_IDS) {
    const b = purposeBudgetFor(id)
    const geo = geometryFor(id)!
    check(`${id} (fixed): the budget is the whole registered runtime, byte-for-byte the prior behaviour (${b.budgetSeconds}s)`,
      Math.abs(b.compositionSeconds - geo.duration_frames / geo.fps) < 1e-9 || b.compositionSeconds <= geo.duration_frames / geo.fps)
  }
  const plain = narrationBudget("X", 20)
  check("CONTROL: a whole-runtime narrationBudget carries NO floor, and its directive reads exactly as before", !("minWords" in plain) && !/AT LEAST/.test(narrationLengthDirective(plain)))
  check("an unregistered id yields maxWords 0 — 'cannot carry narration', never 'no limit'", purposeBudgetFor("NotARealComposition").maxWords === 0)
  check("narrationWindowSeconds is the DERIVED cap body for a registered composition", Math.abs(narrationWindowSeconds("AgentTalkingHeadReel") - capBodySeconds("AgentTalkingHeadReel")!) < 1e-9)
}

// ═══════════════════════════════════════════════════════════════════════════
function bodySection() {
  console.log("\n── §body — the body is derived from the narration, never typed ──")
  for (const id of ["AgentTalkingHeadReel", "MarketUpdateReel", "JustListedReel", "PartnersMeetingReel", "ListingSectionReel", "NewsletterDigestVideo"]) {
    const spec = COMPOSITION_DURATION_RULES[id]
    const geo = geometryFor(id)!
    const b = purposeBudgetFor(id)
    const rule = PURPOSE_DURATION_RULES[b.purpose]

    // OVER THE MAX — trimmed at a sentence boundary, body ≤ purpose max.
    const long = fixtureScript(b.maxWords * 2)
    const fitLong = fitNarrationToBudget(long, b)
    const sentences = spokenSentences(long)
    check(`${id}: a ${spokenWords(long).length}-word draft is trimmed to ${fitLong.wordCount} ≤ ${b.maxWords} at a SENTENCE boundary (a prefix of whole sentences, never mid-word)`,
      fitLong.overran && fitLong.wordCount <= b.maxWords && /[.!?]$/.test(fitLong.script) && long.startsWith(fitLong.script)
      && sentences.slice(0, spokenSentences(fitLong.script).length).join(" ") === fitLong.script)
    const planLong = planCompositionDuration({ compositionId: id, wordCount: fitLong.wordCount })
    check(`${id}: the trimmed script plans a ${planLong.bodySeconds}s body ≤ the ${rule.maxSeconds}s purpose max, inside the ${geo.duration_frames}f cap`,
      planLong.bodySeconds <= rule.maxSeconds + 1 / geo.fps && !planLong.clampedToCap && !planLong.abovePurposeMax)

    // IDEAL — body = narration / (1 − headroom); duration = bookends + body.
    const ideal = fixtureScript(b.idealWords)
    const fitIdeal = fitNarrationToBudget(ideal, b)
    const planIdeal = planCompositionDuration({ compositionId: id, wordCount: fitIdeal.wordCount })
    const expectSeconds = bodySecondsForNarration(spokenSecondsForWords(fitIdeal.wordCount, spec.host), "estimated")
    check(`${id}: an ideal ${fitIdeal.wordCount}-word script → narration ${planIdeal.spokenSeconds}s → body ${planIdeal.bodySeconds}s (= ${expectSeconds}s, the 80 % claim) → ${planIdeal.durationInFrames}f = ${spec.introFrames}+${planIdeal.bodyFrames}+${spec.outroFrames}`,
      !fitIdeal.overran && Math.abs(planIdeal.bodyFrames - Math.round(expectSeconds * geo.fps)) <= 0
      && planIdeal.durationInFrames === spec.introFrames + planIdeal.bodyFrames + spec.outroFrames
      && planIdeal.narrationWindow.from === spec.introFrames && planIdeal.narrationWindow.to === spec.introFrames + planIdeal.bodyFrames
      && !planIdeal.belowPurposeMin && !planIdeal.abovePurposeMax)
    check(`${id}: a script at budget read at the ${spec.host} pace ends INSIDE the derived window (${planIdeal.spokenSeconds}s < ${planIdeal.bodySeconds}s)`,
      (planIdeal.spokenSeconds ?? 0) < planIdeal.bodySeconds)

    // UNDER THE MIN — reported, asked of the writer, NOT padded with silence.
    const shortWords = Math.max(3, Math.floor(b.minWords / 2))
    const planShort = planCompositionDuration({ compositionId: id, wordCount: shortWords })
    const shortNarration = spokenSecondsForWords(shortWords, spec.host)
    check(`${id}: a ${shortWords}-word script (under the ${b.minWords}-word floor) plans a ${planShort.bodySeconds}s body that TRACKS the narration (${shortNarration}s / 0.8), flagged belowPurposeMin — no silence added to reach the ${rule.minSeconds}s minimum`,
      planShort.belowPurposeMin && planShort.bodyFrames === Math.round(bodySecondsForNarration(shortNarration, "estimated") * geo.fps) && planShort.bodySeconds < rule.minSeconds
      && planShort.notes.some((n) => /never padded with silence/.test(n)))
    check(`${id}: …and the writer's directive already asks for AT LEAST ${b.minWords} words — the floor is closed by the script, not the composition`,
      narrationLengthDirective(b).includes(`AT LEAST ${b.minWords} words`))

    // MEASURED — exact, plus the settle only.
    const measured = planCompositionDuration({ compositionId: id, spokenSeconds: 12.3, spokenSecondsSource: "measured" })
    check(`${id}: a MEASURED 12.3s narration plans a ${measured.bodySeconds}s body (12.3 + ${NARRATION_SETTLE_SECONDS} settle), no headroom multiplier`,
      Math.abs(measured.bodySeconds - (12.3 + NARRATION_SETTLE_SECONDS)) < 1 / geo.fps + 1e-9)

    // NOTHING STAGED — the purpose ideal, never the cap.
    const none = planCompositionDuration({ compositionId: id })
    check(`${id}: nothing staged → body = the ${b.purpose} ideal (${rule.idealSeconds}s), NOT the ${geo.duration_frames}f cap`,
      none.bodyFrames === Math.round(rule.idealSeconds * geo.fps) && none.durationInFrames < geo.duration_frames && none.notes.some((n) => /ideal/.test(n)))

    // MONOTONE, then CLAMPED and flagged.
    const a = planCompositionDuration({ compositionId: id, wordCount: 40 }).durationInFrames
    const c = planCompositionDuration({ compositionId: id, wordCount: 80 }).durationInFrames
    const huge = planCompositionDuration({ compositionId: id, spokenSeconds: 10_000, spokenSecondsSource: "measured" })
    check(`${id}: more words → more frames (${a} < ${c}); a 10,000s narration is CLAMPED to the cap (${huge.durationInFrames} = ${geo.duration_frames}) and says so`,
      a < c && huge.durationInFrames === geo.duration_frames && huge.clampedToCap && huge.notes.some((n) => /clamped/.test(n)))

    // calculateMetadata IS the plan.
    const props = { captionScript: ideal, ...spokenSecondsProps({ narration: ideal, compositionId: id }) }
    check(`${id}: durationMetadata("${id}")({ props }) returns exactly planDurationForProps' durationInFrames`,
      durationMetadata(id)({ props }).durationInFrames === planDurationForProps(id, props).durationInFrames
      && planDurationForProps(id, props).durationInFrames === planIdeal.durationInFrames)
    check(`${id}: renderedCompositionSeconds (the coordinator's number) is the plan's frames / fps, not the cap`,
      Math.abs(renderedCompositionSeconds({ composition_id: id, ...geo }, props) - planIdeal.durationInFrames / geo.fps) < 1e-9)
  }

  // The props reader's order of trust, and the copy-only floor.
  console.log("\n  narrationLengthFromProps — order of trust:")
  const id = "MarketUpdateReel"
  check("staged spokenSeconds (measured) beats everything", narrationLengthFromProps(id, { spokenSeconds: 20, spokenSecondsSource: "measured", avatarDurationSeconds: 5, captionScript: "x y z" })?.from === "staged")
  check("avatarDurationSeconds (D-ID's measurement) is read when nothing is staged", narrationLengthFromProps(id, { avatarDurationSeconds: 9.5, captionScript: "x y z" })?.source === "measured")
  const cues = [{ text: "a", fromFrame: 60, durationFrames: 30 }, { text: "b", fromFrame: 90, durationFrames: 60 }]
  check("captionsCues: the last cue's end minus the intro is the narration's length (measured)", narrationLengthFromProps(id, { captionsCues: cues })?.spokenSeconds === 3)
  check("a staged narrationScript is a fitted script (estimated, 'staged')", narrationLengthFromProps(id, { narrationScript: fixtureScript(30) })?.from === "staged")
  check("captionScript alone is on-screen COPY", narrationLengthFromProps(id, { captionScript: "$675K MEDIAN SALE PRICE · 12 days AVG DAYS ON MARKET" })?.from === "copy")
  const copyPlan = planDurationForProps(id, { captionScript: "$675K MEDIAN SALE PRICE · 12 days AVG DAYS ON MARKET · 84 ACTIVE LISTINGS" })
  check(`a Director reel whose only text is its stat strip keeps the ${PURPOSE_DURATION_RULES.market_update.minSeconds}s market_update MINIMUM (the cards need their dwell) — ${copyPlan.bodySeconds}s`,
    copyPlan.bodySeconds === PURPOSE_DURATION_RULES.market_update.minSeconds && copyPlan.notes.some((n) => /floorToPurposeMin/.test(n)))
  const scriptPlan = planDurationForProps(id, { narrationScript: fixtureScript(10) })
  check("…while a fitted SCRIPT that short is NOT floored — the body tracks it and the shortfall is reported to the writer",
    scriptPlan.bodySeconds < PURPOSE_DURATION_RULES.market_update.minSeconds && scriptPlan.belowPurposeMin)
  check("nothing readable → null (the planner then uses the ideal)", narrationLengthFromProps(id, { brand: {} }) === null && narrationLengthFromProps(id, null) === null)
  check("a fixed-body composition renders at its registered frames whatever is staged",
    planDurationForProps("CMAReel", { captionScript: fixtureScript(5) }).durationInFrames === geometryFor("CMAReel")!.duration_frames)
  check("spokenSecondsProps: measured wins; otherwise the fitted words at the host pace; nothing → {}",
    spokenSecondsProps({ measuredSeconds: 7.25, narration: fixtureScript(50), compositionId: id }).spokenSecondsSource === "measured"
    && spokenSecondsProps({ narration: fixtureScript(50), compositionId: id }).spokenSecondsSource === "estimated"
    && Object.keys(spokenSecondsProps({ narration: "", compositionId: id })).length === 0)
}

// ═══════════════════════════════════════════════════════════════════════════
function sourcesSection() {
  console.log("\n── §sources — every composition derives its body from the duration it renders at ──")
  const HARDCODED_BODY = /const\s+(BODY|STAT|PHOTOS|DIAGRAM|QUOTE|REACT|B1|B2|B3|MARKET|SECTIONS|IMAGES)\s*=\s*(?:Math\.round\()?\s*[\d.]+\s*\*\s*FPS/
  const seen: string[] = []
  for (const [id, file] of Object.entries(VIDEO_COMPOSITION_FILES)) {
    const spec = COMPOSITION_DURATION_RULES[id]
    const geo = geometryFor(id)
    check(`${id}: has a duration rule and geometry`, !!spec && !!geo)
    if (!spec || !geo) continue
    const source = readStripped(file)
    if (spec.bodyMode === "fixed") { skipNote(`[sources] ${id}`, `fixed-body (${spec.note}) — published exclusion`); continue }
    seen.push(id)
    if (spec.introFrames === 0 && spec.outroFrames === 0) {
      skipNote(`[bookends] ${id}`, "no chrome tiles of its own (0/0) — the whole duration is body; nothing to read from the registry (published exclusion)")
      check(`${id}: no hardcoded body literal survives`, !HARDCODED_BODY.test(source))
    } else {
      check(`${id}: reads its bookends from the ONE registry (compositionBookends("${id}")) and no hardcoded body literal survives`,
        new RegExp(`compositionBookends\\("${id}"\\)`).test(source) && !HARDCODED_BODY.test(source))
    }
    check(`${id}: derives its body from useVideoConfig().durationInFrames (never a TOTAL literal)`,
      /useVideoConfig\(\)/.test(source) && !/const\s+TOTAL\s*=/.test(source))
    if (NON_CHAIN_COMPOSITIONS.has(id)) { skipNote(`[tile] ${id}`, "not a flat Sequence chain (derived split / nested ask / single body) — checked by video-assembly and the matrix by its own rule"); continue }
    // Tiles at the CAP…
    const atCap = tileChain(source, buildScope(source, geo, id), geo.duration_frames)
    check(`${id}: Sequence chain tiles [0, ${geo.duration_frames}) exactly at the cap${atCap.note}`, atCap.ok, atCap.reason)
    // …AND at a PLANNED duration — which a hardcoded body could not do.
    const planned = planCompositionDuration({ compositionId: id, wordCount: purposeBudgetFor(id).idealWords })
    const plannedGeo = { ...geo, duration_frames: planned.durationInFrames }
    const atPlan = tileChain(source, buildScope(source, plannedGeo, id), planned.durationInFrames)
    check(`${id}: …and tiles [0, ${planned.durationInFrames}) exactly at the PLANNED duration (ideal script)${atPlan.note}`, atPlan.ok, atPlan.reason)
    // The caption window IS the derived narration window.
    const win = narrationWindow(source, buildScope(source, plannedGeo, id), planned.durationInFrames)
    const derived = narrationWindowFrames(id, planned.durationInFrames)
    if (win.declared) {
      check(`${id}: <CaptionLayer> window [${win.from}, ${win.to}) equals the derived narration window [${derived.from}, ${derived.to}) at the planned duration`,
        win.to === derived.to && (win.from === derived.from || (spec.host === "voiceover" && win.from === 0)))
    } else {
      skipNote(`[window] ${id}`, "mounts no CaptionLayer (finish-spec captions:false) — published exclusion")
    }
  }
  check(`the derivation sweep covered ${seen.length} narration compositions (a sweep that covers none is blind)`, seen.length >= 15)

  // POSITIVE CONTROLS
  const specimen = "const FPS = 30\nconst COVER = 2 * FPS\nconst BODY = 10 * FPS\nconst OUTRO = 2 * FPS\n<Sequence from={0} durationInFrames={COVER}>\n<Sequence from={COVER} durationInFrames={BODY}>\n<Sequence from={COVER + BODY} durationInFrames={OUTRO}>"
  const specGeo = { width: 1, height: 1, fps: 30, duration_frames: 420 }
  check("CONTROL: a HARDCODED body (const BODY = 10 * FPS) tiles at its own 420 frames…", tileChain(specimen, buildScope(specimen, specGeo), 420).ok)
  check("CONTROL: …and FAILS at any other duration (600) — the hardcoded body cannot follow the narration", !tileChain(specimen, buildScope(specimen, specGeo), 600).ok)
  check("CONTROL: the hardcoded-body finder recognises the retired lines", HARDCODED_BODY.test("const BODY   = 10 * FPS") && HARDCODED_BODY.test("const BODY  = Math.round(24.5 * FPS)") && HARDCODED_BODY.test("const STAT   = 4 * FPS"))
  const derivedSpecimen = "const BOOKENDS = compositionBookends(\"AgentTalkingHeadReel\")\nconst COVER = BOOKENDS.introFrames\nconst OUTRO = BOOKENDS.outroFrames\nconst timeline = computeAssemblyTimeline({ durationInFrames, introFrames: COVER, outroFrames: OUTRO })\nconst BODY = timeline.body.durationInFrames\n<Sequence from={0} durationInFrames={COVER}>\n<Sequence from={COVER} durationInFrames={BODY}>\n<Sequence from={COVER + BODY} durationInFrames={OUTRO}>"
  check("CONTROL: the DERIVED idiom tiles at 420 AND at 600 (the body follows the duration)",
    tileChain(derivedSpecimen, buildScope(derivedSpecimen, { ...specGeo, duration_frames: 420 }, "AgentTalkingHeadReel"), 420).ok
    && tileChain(derivedSpecimen, buildScope(derivedSpecimen, { ...specGeo, duration_frames: 600 }, "AgentTalkingHeadReel"), 600).ok)
}

// ═══════════════════════════════════════════════════════════════════════════
function wiringSection() {
  console.log("\n── §wiring — Root.tsx calculateMetadata, the coordinator, the stagers, the retired table ──")
  const rootSrc = readStripped("remotion/Root.tsx")
  check("Root.tsx imports durationMetadata from the model", /durationMetadata/.test(rootSrc) && /lib\/video\/duration-model/.test(rootSrc))
  for (const block of rootSrc.split(/<Composition\b/).slice(1)) {
    const id = block.match(/id="([A-Za-z0-9_]+)"/)?.[1]
    if (!id) continue
    const seg = block.slice(0, block.indexOf("/>"))
    const spec = COMPOSITION_DURATION_RULES[id]
    const mounted = new RegExp(`calculateMetadata=\\{durationMetadata\\("${id}"\\)\\}`).test(seg)
    if (spec?.bodyMode === "narration") check(`Root.tsx: ${id} mounts calculateMetadata={durationMetadata("${id}")}`, mounted)
    else if (spec?.bodyMode === "fixed") check(`Root.tsx: ${id} (fixed) mounts NO calculateMetadata`, !mounted)
    else check(`Root.tsx: ${id} is a still (no duration rule) and mounts no calculateMetadata`, !mounted && (geometryFor(id)?.duration_frames ?? 0) <= 1)
  }
  check("CONTROL: the mount finder does not match a composition without it",
    !/calculateMetadata=\{durationMetadata\("X"\)\}/.test('<Composition id="X" component={X} durationInFrames={420} />'))

  const coord = readCode("lib/remotion/render-coordinator.ts")
  check("render-coordinator times the narration pad and the music fade against renderedCompositionSeconds (the plan), never compositionSeconds(composition)",
    /renderedCompositionSeconds\(composition, stagedProps\)/.test(coord) && !/compositionSeconds\(composition\)/.test(coord)
    && (coord.match(/mainCutSeconds \+ bookendSeconds/g) ?? []).length === 2)
  check("CONTROL: the retired shape is recognised", /compositionSeconds\(composition\)/.test("const videoSeconds = compositionSeconds(composition) + bookendSeconds"))

  const STAGERS = [
    "lib/intelligence/partners-meeting.ts", "lib/kernel/board-packet-reel.ts", "lib/video/listing-pitch-reel.ts",
    "lib/kernel/deal-room-reel.ts", "lib/listing-presentation/section-narration-orchestrator.ts",
    "app/api/internal/remotion/render-newsletter-video/route.ts", "app/api/internal/remotion/render-just-listed/route.ts",
  ]
  for (const f of STAGERS) check(`${f} stages spokenSeconds through spokenSecondsProps (the measured voiceover length reaches calculateMetadata)`, /spokenSecondsProps\(/.test(readCode(f)))
  check("the avatar lane already stages avatarDurationSeconds (D-ID's own measurement) — the planner reads it (order of trust above)",
    /avatarDurationSeconds/.test(readCode("lib/video/avatar-render-orchestrator.ts")))
  const PURPOSE_BUDGET_CALLERS = ["lib/video/promo-composition.ts", "lib/listing-presentation/section-narration.ts", "app/api/internal/remotion/render-newsletter-video/route.ts"]
  for (const f of PURPOSE_BUDGET_CALLERS) check(`${f} sizes its script through purposeBudgetFor (the purpose, not the whole runtime)`, /purposeBudgetFor\(/.test(readCode(f)))
  for (const f of ["lib/video/intro-video-reactor.ts", "lib/video/avatar-explainer.ts"]) check(`${f} sizes its script through the narrationWindowBudget adapter (now the purpose budget)`, /narrationWindowBudget\(/.test(readCode(f)))

  const nw = readCode("lib/video/narration-window.ts")
  check("the hand table NARRATION_WINDOW_FRAMES is GONE from narration-window.ts (tombstone kept in prose)", !/NARRATION_WINDOW_FRAMES\s*[:=]/.test(nw) && /NARRATION_WINDOW_FRAMES/.test(readFileSync(join(root, "lib/video/narration-window.ts"), "utf8")))
  check("CONTROL: the table finder recognises the retired declaration", /NARRATION_WINDOW_FRAMES\s*[:=]/.test("export const NARRATION_WINDOW_FRAMES: Record<string, X> = {"))
  const model = readStripped("lib/video/duration-model.ts")
  check("duration-model.ts uses only RELATIVE imports (it rides the Remotion bundle, which resolves no @/ alias)", !/from\s+"@\//.test(model))
  check("the model cites its research (Exa, 2026-09-22) beside the purpose table", /Exa web_search_exa, 2026-09-22/.test(readFileSync(join(root, "lib/video/duration-model.ts"), "utf8")))
}

// ═══════════════════════════════════════════════════════════════════════════
function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Video duration model — purpose → words → computed body, every composition")
  console.log("══════════════════════════════════════════════════════════════")
  console.log(` ${Object.keys(PURPOSE_DURATION_RULES).length} purposes · ${NARRATION_IDS.length} narration-driven + ${FIXED_IDS.length} fixed compositions · voiceover ${WORDS_PER_MINUTE} wpm / avatar ${AVATAR_WORDS_PER_MINUTE} wpm · headroom ${NARRATION_HEADROOM}`)
  console.log("\n  purpose                      min  ideal  max   voiceover words  avatar words")
  for (const [p, r] of Object.entries(PURPOSE_DURATION_RULES)) {
    const v = purposeWordWindow(p as VideoPurpose, "voiceover"), a = purposeWordWindow(p as VideoPurpose, "avatar")
    console.log(`  ${p.padEnd(28)} ${String(r.minSeconds).padStart(3)}  ${String(r.idealSeconds).padStart(5)}  ${String(r.maxSeconds).padStart(3)}   ${`${v.minWords}/${v.idealWords}/${v.maxWords}`.padEnd(16)} ${a.minWords}/${a.idealWords}/${a.maxWords}`)
  }
  console.log("\n  composition                 purpose(s)                         host       bookends   cap(f)  ideal(f)")
  for (const id of [...NARRATION_IDS, ...FIXED_IDS]) {
    const s = COMPOSITION_DURATION_RULES[id], g = geometryFor(id)!
    const ideal = planCompositionDuration({ compositionId: id, wordCount: purposeBudgetFor(id).idealWords }).durationInFrames
    console.log(`  ${id.padEnd(27)} ${compositionPurposes(id).join("/").padEnd(34)} ${s.host.padEnd(10)} ${`${s.introFrames}+${s.outroFrames}`.padEnd(10)} ${String(g.duration_frames).padStart(5)}   ${String(ideal).padStart(5)}${s.bodyMode === "fixed" ? "  (fixed)" : ""}`)
  }

  registrySection()
  paceSection()
  windowSection()
  bodySection()
  sourcesSection()
  wiringSection()

  console.log("\n────────────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" BLIND SPOTS, published beside the number (§2):")
  console.log("   · The purpose ranges are research-backed targets, not measured retention on THIS product's videos;")
  console.log("     the video_plays ledger is where a per-purpose completion curve would move them.")
  console.log("   · Fixed-body rows (CMAReel, AffordabilitySnapshotReel, the two slide components) are sized by")
  console.log("     their tiles, not by narration — listed as exclusions, not proven derived.")
  console.log("   · The live remotion_compositions caps are m658 (APPLIED LIVE 2026-09-22 — until then the integrator applied")
  console.log("     it); test:remotion-setup §3b compares the mirror to live only when a service key is present.")
  console.log("   · A Director voiceover reel (video-plays / director-content) stages captionScript from on-screen copy;")
  console.log("     its body is floored at the purpose minimum rather than derived from a fitted script until those")
  console.log("     producers stage a narration (spokenSecondsProps) — recorded, not hidden.")
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Purpose → word window → fitted narration → computed body: every registered composition")
  console.log("    derives its length from the reason it exists, and a new type inherits the rule from one row.")
  console.log(" VIDEO_DURATION_MODEL_PASS")
}
main()
