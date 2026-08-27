/**
 * lib/video/anniversary-script.ts
 *
 * THE HAPPY ANNIVERSARY HALF OF THE ANNIVERSARY VIDEO.
 *
 * OWNER RULING, verbatim: "anniversary video is a happy anniversary with an
 * equity report."
 *
 * Two halves, in that order of framing. It is a CELEBRATION of a client's
 * homeownership milestone that carries their equity news — not an equity
 * statement with a greeting bolted on.
 *
 * ── WHAT WAS ACTUALLY MISSING (§1.2 — build the missing half) ────────────────
 *
 * The greeting was NOT missing from the pictures. It was missing from the
 * MOUTH. Three surfaces already said it and one did not:
 *
 *   · remotion/EquityReportReel.tsx:316 — the data reel's cover renders
 *     `Happy {ordinal(yearsHeld)} home anniversary`.
 *   · lib/video/avatar-render-orchestrator.ts AVATAR_VIDEO_CHROME — the avatar
 *     reel's eyebrow is the literal "HAPPY HOME ANNIVERSARY".
 *   · lib/kernel/anniversary-equity.ts composeEquityNote — the portal note opens
 *     "Hi <name> — happy <Nth> home anniversary!" and its subject repeats it.
 *   · lib/video/intro-video-reactor.ts draftScript — the SPOKEN script. Its
 *     prompt said only "Acknowledge the anniversary without being saccharine",
 *     which is not a greeting, and then FORBADE the other half outright: "No
 *     specific home-value claims. No guaranteed returns or appreciation
 *     language."
 *
 * So the agent's own recorded words were the one surface that neither wished the
 * client a happy anniversary nor mentioned their equity, while the frame around
 * their face said "HAPPY HOME ANNIVERSARY" and the card underneath the video
 * carried the whole equity report. And the caption strip burned into the video
 * is cut VERBATIM from the first sentence of that script
 * (avatar-render-orchestrator `captionFromScript`), so whatever the model chose
 * to open with became the on-screen line a muted viewer read as the message.
 *
 * A REPO-WIDE SEARCH FOR "happy anniversary" DOES NOT FIND ANY OF THIS, which is
 * how the gap was mis-stated as "the greeting exists nowhere". `Happy {ordinal(n)}
 * home anniversary` has an interpolation between the two words, so a literal
 * substring finder walks straight past a composition that renders it in 64px
 * type. That is why `opensWithAnniversaryGreeting` below is a shape test rather
 * than a phrase test, and why the guard for it uses this same function instead
 * of grepping.
 *
 * ── PURE. NO I/O, NO server-only, NO MODEL. ─────────────────────────────────
 * Every function here is deterministic, so the whole enforcement path is
 * exercisable by a simulator with no database, no AI Gateway and no render.
 * That matters more than usual on this file: two of these functions exist to
 * decide what a video says about a named person's money, and a check that can
 * only run in production is not a check.
 */
import { FAIR_HOUSING_WRITING_FLOOR } from "@/lib/contact-promotion/welcome-situation"
import { ordinal } from "@/lib/format/ordinal"
import { spokenSentences } from "@/lib/video/script-structure"
import type { ScriptSituation } from "@/lib/video/intro-video-reactor"

/**
 * Ordinal for the anniversary NUMBER — "1st", "2nd", "5th", "11th", "21st".
 *
 * The Nth anniversary is NOT computed here and must never be: it arrives already
 * derived from `anniversaryWindow(transactions.close_date)` (or
 * `contacts.home_anniversary`, the date the moment fires from) and is the same
 * number the project title stamps as "(Ny)". This only spells it (§6 — one way
 * to say the same idea, not a second way to work it out).
 */
// TOMBSTONE (§6): ordinalYear's private suffix-speller was the FOURTH copy of
// the ordinal formatter; its body is retired onto the survivor,
// lib/format/ordinal.ts:32, the same pure leaf the kernel and the Remotion
// bundle already import. The local name is kept because the callers below read
// "the Nth YEAR", which is this file's domain vocabulary, not a formatter's.
function ordinalYear(n: number): string {
  return ordinal(Math.trunc(n))
}

/**
 * THE GREETING, deterministically. Contains exactly two variables — the
 * recipient's first name and the anniversary number — and asserts nothing.
 *
 * A blank/absent first name degrades to the un-addressed form rather than
 * greeting "undefined"; a non-positive year degrades to the plain form rather
 * than wishing someone a happy 0th anniversary.
 */
export function anniversaryGreeting(args: {
  firstName?: string | null
  yearsHeld?: number | null
}): string {
  const name = (args.firstName ?? "").trim()
  const n = Number(args.yearsHeld)
  const nth = Number.isFinite(n) && n >= 1 ? `${ordinalYear(n)} ` : ""
  return name
    ? `Happy ${nth}home anniversary, ${name}!`
    : `Happy ${nth}home anniversary!`
}

/**
 * DOES THE SCRIPT OPEN BY WISHING THEM A HAPPY ANNIVERSARY?
 *
 * Scoped to the FIRST sentence on purpose, and the reason is mechanical rather
 * than stylistic:
 *
 *   · `captionFromScript` cuts the on-screen caption from the first sentence, so
 *     a greeting buried in sentence four never reaches a muted viewer.
 *   · `fitNarrationToBudget` trims from the END, so a greeting that opens the
 *     script is the one part of it a budget overrun can never remove.
 *
 * A SHAPE TEST, not a phrase test: "Happy 5th home anniversary, Dana!",
 * "Happy anniversary, Dana" and "Happy tenth home anniversary" all pass, because
 * the model is allowed to write the number in words. What it may not do is skip
 * the wish.
 */
const ANNIVERSARY_GREETING_SHAPE = /\bhappy\b[^.!?]{0,60}\banniversar(?:y|ies)\b/i

function opensWithAnniversaryGreeting(script: string | null | undefined): boolean {
  const first = spokenSentences(script)[0] ?? ""
  return ANNIVERSARY_GREETING_SHAPE.test(first)
}

/**
 * MAKE THE GREETING TRUE OF THE SCRIPT — the enforcement, not the request.
 *
 * A prompt instruction is a hope. This is why the greeting is a property of the
 * text rather than a line in the prompt: a model that ignores "open with a happy
 * anniversary" produces a video whose frame says HAPPY HOME ANNIVERSARY over an
 * agent who never says it.
 *
 * WHERE THIS RUNS IS LOAD-BEARING (§5). It is applied INSIDE the draft function,
 * so the greeting is part of the text `evaluateOutbound` grades and part of the
 * text the redraft is asked to fix — never bolted on afterwards. Prepending
 * client-facing copy AFTER the gate is the exact hole §5 exists to close, and
 * `avatar-render-orchestrator` names that same rule about the caption strip.
 *
 * NEVER REWRITES. It prepends or it returns the input untouched, so a model
 * draft that already greets keeps its own words.
 */
export function enforceAnniversaryGreeting(
  script: string | null | undefined,
  greeting: string,
): string {
  const body = (script ?? "").trim()
  if (!body) return greeting
  if (opensWithAnniversaryGreeting(body)) return body
  return `${greeting} ${body}`
}

// ═══════════════════════════════════════════════════════════════════════════
// STATING A NAMED PERSON'S EQUITY OUT LOUD
// ═══════════════════════════════════════════════════════════════════════════
//
// This video says a number about one identified individual's money. The repo
// already had a settled answer for that in TEXT — every figure is labeled an
// estimate, the copy says "not an appraisal", and with no loan on file it
// reports appreciation only AND SAYS SO (composeEquityNote, EquityReportReel's
// on-screen notes). Speech gets the same answer, plus one hazard text does not
// have:
//
//   THE TRIM CUTS THE DISCLAIMER OFF LAST-SENTENCE-FIRST. `fitNarrationToBudget`
//   keeps whole sentences from the FRONT until the word budget is spent. A
//   script written as "...your equity is about $180,000. These are estimates,
//   not an appraisal." therefore degrades, under exactly the overrun the trim
//   exists to handle, into a bare unqualified financial claim about a named
//   client — worse than the terse version it replaced, and silently.
//
// So the rule enforced here is SAME-SENTENCE: a spoken figure and its qualifier
// travel together, because that is the granularity the trim operates at.

/** A spoken money or percentage figure — the thing that needs a qualifier. */
const FINANCIAL_FIGURE = /(\$\s?[\d,]+(?:\.\d+)?\s*(?:k|m|million|thousand)?)|(\b\d+(?:\.\d+)?\s?%)/i

/**
 * Words that make a figure honest. "estimate"/"estimated" is the floor the whole
 * lane already uses; "about"/"around"/"roughly" alone are NOT enough — hedging a
 * number is not disclosing that it is a model's guess rather than an appraisal.
 */
const ESTIMATE_QUALIFIER = /\bestimat(?:e|ed|es)\b/i

/**
 * The disclaimer the lane has always carried in text. Required somewhere in any
 * script that speaks a figure at all — `composeEquityNote` and
 * `EquityReportReel`'s stat notes both say it, and speech may not be the one
 * surface that drops it.
 */
const NOT_AN_APPRAISAL = /\bnot\s+an\s+appraisal\b/i

/**
 * Every sentence that states a figure without qualifying it IN THAT SENTENCE.
 *
 * Returns [] for a script with no figures at all — a greeting-only anniversary
 * video makes no financial claim and needs no disclaimer, which is exactly the
 * degraded form `safeAnniversaryFallback` produces.
 */
function unqualifiedFinancialSentences(script: string | null | undefined): string[] {
  return spokenSentences(script).filter(
    (s) => FINANCIAL_FIGURE.test(s) && !ESTIMATE_QUALIFIER.test(s),
  )
}

/** Does this script state a figure at all? */
function statesFinancialFigure(script: string | null | undefined): boolean {
  return spokenSentences(script).some((s) => FINANCIAL_FIGURE.test(s))
}

export interface EquityClaimVerdict {
  /** Safe to speak as written. */
  ok: boolean
  /** Human-readable reason when not. Empty string when ok. */
  reason: string
}

/**
 * MAY THIS SCRIPT BE SPOKEN TO THIS CLIENT AS WRITTEN?
 *
 * FAILS CLOSED (§4). Run on the script AFTER the budget trim, because the trim
 * is what can turn a compliant draft into a non-compliant one. Three ways to
 * fail, all of them about the same thing — a number that outruns its honesty:
 *
 *   1. a figure in a sentence that does not call it an estimate;
 *   2. figures anywhere, with "not an appraisal" nowhere;
 *   3. no loan data on file, but the script claims EQUITY rather than the value
 *      growth the platform can actually stand behind. `computeEquityLine`
 *      returns estimatedEquity null in that case and every text surface degrades
 *      to appreciation-only; a video that says "your equity" anyway would be
 *      asserting a number nobody computed.
 */
export function verifyEquityClaims(
  script: string | null | undefined,
  opts: { hasLoanData: boolean },
): EquityClaimVerdict {
  const unqualified = unqualifiedFinancialSentences(script)
  if (unqualified.length > 0) {
    return {
      ok: false,
      reason:
        `${unqualified.length} spoken figure(s) carry no "estimate" qualifier in their own sentence — ` +
        `the budget trim cuts trailing sentences, so a disclaimer parked at the end is not protection: ` +
        `"${unqualified[0].slice(0, 120)}"`,
    }
  }
  if (statesFinancialFigure(script) && !NOT_AN_APPRAISAL.test(script ?? "")) {
    return {
      ok: false,
      reason: `the script states a figure but never says "not an appraisal" — the one disclaimer every other equity surface carries`,
    }
  }
  if (!opts.hasLoanData && /\bequit(?:y|ies)\b/i.test(script ?? "")) {
    return {
      ok: false,
      reason:
        `no original loan amount is on file, so estimatedEquity is null and the honest line is value growth only — ` +
        `the script claims equity anyway`,
    }
  }
  return { ok: true, reason: "" }
}

/**
 * THE DEGRADED FORM, when the equity half cannot be spoken safely.
 *
 * Not a failure and not an empty video: it is still a happy anniversary, still
 * from the agent, and it still routes the client to the equity report — which is
 * on the very portal card this clip is stamped onto
 * (app/api/cron/intro-video-email-backfill writes `anniversary_video_url` into
 * the equity_report card's metadata). So the second half is not lost, it is
 * delivered by the surface that has room for it and its disclaimers.
 *
 * DETERMINISTIC TEMPLATE CHROME. It names the recipient and the anniversary
 * number and nothing else: no protected characteristic can appear in it, and it
 * makes no claim about money at all. That is the same reasoning
 * `AVATAR_VIDEO_CHROME` states for the eyebrow and CTA it adds after the gate.
 *
 * DELIBERATELY SHORT. This text is substituted AFTER `fitNarrationToBudget` has
 * already run, so nothing downstream will trim it — it has to fit the
 * composition on its own or the agent is cut off saying it. Kept well inside the
 * `AgentTalkingHeadReel` budget so that even a long first name cannot push it
 * over; the proof derives that ceiling from the live geometry rather than
 * trusting this sentence.
 */
export function safeAnniversaryFallback(greeting: string): string {
  return `${greeting} Your annual home value update is waiting in your portal whenever you would like to walk through it.`
}

// ═══════════════════════════════════════════════════════════════════════════
// WHAT THE WRITER IS TOLD — §5, COMPLIANCE-FIRST
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The home-anniversary directive set: the shared fair-housing floor, plus the
 * rules this lane needs BECAUSE it states a value.
 *
 * WHY IT IS NOT `WELCOME_FAIR_HOUSING_DIRECTIVES` (§6, merged onto the shared
 * survivor rather than copied). Those two sets share their first three lines
 * verbatim — imported here, never retyped — and differ in the fourth, which they
 * must: the welcome floor says "Make no promise about price, value,
 * appreciation, rates, or timing", and an ANNUAL EQUITY UPDATE exists to state
 * an estimated value. Reusing the welcome set would have told the writer to
 * refuse the owner's own ruling; retyping the fair-housing lines would have left
 * two copies to drift.
 *
 * Every line below is a WRITING instruction. §5: the rules reach the model that
 * composes the script, not only the scan that grades it afterwards.
 */
const ANNIVERSARY_WRITING_DIRECTIVES: readonly string[] = Object.freeze([
  ...FAIR_HOUSING_WRITING_FLOOR,
  "Open by wishing them a happy home anniversary, by name. This is a celebration of their milestone that happens to carry their value update — not a financial statement with a greeting in front of it.",
  "You may state ONLY the figures listed in the facts above. Never compute, round differently, project, or invent a number, and never state a figure that is not there.",
  "Any sentence containing a dollar amount or a percentage must ALSO call it an estimate IN THAT SAME SENTENCE. Do not save the disclaimer for the end — a script that runs long is cut from the end, and the figure would outlive its qualifier.",
  "Say the words 'not an appraisal' somewhere in the script whenever you state a figure.",
  "Make no promise or forecast about future value, appreciation, rates, or timing, and give no financial advice. Refinancing and loan terms belong to their lender, not to you.",
  "Close warmly with no pressure and no pitch — an open invitation to talk, nothing to sign up for.",
])

/**
 * The FACTS the anniversary writer may build the script from, as a
 * `ScriptSituation` — the SAME shape and the same prompt slots the welcome lane
 * already uses (§6). The reactor renders `facts` and `complianceDirectives` into
 * the prompt above the length rule for both triggers.
 *
 * `facts` is passed in rather than derived, because deriving it here would be a
 * second copy of the equity narrative. `lib/kernel/anniversary-equity.ts`
 * already builds exactly this list for the portal note out of the REAL computed
 * `EquityLine`; this is the reader that list never had.
 *
 * `equityFacts` EMPTY is a legitimate call and yields a directive-only
 * situation: the writer then has no figure to state, the greeting is still
 * enforced, and `verifyEquityClaims` has nothing to object to.
 */
export function buildAnniversarySituation(equityFacts: readonly string[]): ScriptSituation {
  return {
    facts: equityFacts.filter((f) => typeof f === "string" && f.trim().length > 0).map((f) => f.trim()),
    complianceDirectives: [...ANNIVERSARY_WRITING_DIRECTIVES],
  }
}
