/**
 * lib/contact-promotion/welcome-situation.ts
 *
 * THE SITUATION A WELCOME VIDEO IS ALLOWED TO KNOW.
 *
 * OWNER RULING, verbatim: "we only sent content to leads and contacts that are
 * personalized and situation, them first messaging."
 *
 * That is a RULING, not a style note. A welcome avatar video that opens with
 * "Hi there, great to have you" is a defect on this path, because the platform
 * ALREADY KNOWS why this person is here — they told us before they converted,
 * and the conversion carried it onto the contact. This module turns what the
 * contact row knows into the FACT SET a script writer may use, and nothing
 * wider.
 *
 * ── PURE. NO I/O. ───────────────────────────────────────────────────────────
 * The caller reads the row; this decides what may be said about it. Keeping it
 * pure is what lets the simulator drive every branch — including the ones a
 * live database would almost never produce — without a network.
 *
 * ── WHY IT READS THE **CONTACT** AND NEVER THE LEAD ─────────────────────────
 * CLAUDE.md §5 / lib/contact-promotion/conversion-finality.ts: once a lead
 * converts, all communication ceases on the lead and only the CONTACT gets the
 * action. A situation resolver that reached back to `leads` to make the copy
 * richer would be re-opening the lead as a live source at the exact moment the
 * ruling closes it. Every field this module needs is a live column on
 * `contacts` (verified against the live schema: contact_type, contact_persona,
 * timeline, city, state, budget_min/max, property_type, beds) because the
 * converter carries them across. So the input shape is a CONTACT row and there
 * is no lead-shaped overload to reach for.
 *
 * ── COMPLIANCE-FIRST, WHICH IS WHERE THIS MODULE EARNS ITS KEEP ─────────────
 * CLAUDE.md §5: "Video scripts are written COMPLIANCE-FIRST — fair housing in
 * the writing prompt, not only in the post-hoc scan. Warnings pass through;
 * only a hard fair-housing flag escalates to a human."
 *
 * A welcome video is the single worst place to get this wrong, because the
 * situational facts that make it good are the same facts that make it illegal
 * if repeated carelessly: a neighbourhood, a school, a "community". Two
 * distinct defences, both BEFORE the writer sees anything:
 *
 *   1. EVERY FREE-TEXT FACT IS SCANNED FIRST. `contact_persona`,
 *      `property_type` and the market string are operator- and importer-
 *      supplied free text. A HIGH-severity fair-housing pattern in one of them
 *      (the repo's own encoding of "hard flag" —
 *      lib/compliance-rules/fair-housing-patterns.ts) means the fact is
 *      DROPPED, never rendered into the prompt, and reported. Laundering a
 *      protected-class phrase through "the CRM said so" is still authoring it.
 *      A medium/low hit RIDES THROUGH as a warning — escalating those would put
 *      a human in front of every welcome, which is the hold-up the ruling
 *      forbids.
 *   2. GEOGRAPHY SHIPS WITH ITS OWN RULE. When a market is named, the fact set
 *      carries an explicit instruction that the market may be named but never
 *      characterised by who lives there, and that schools/community/"safe" are
 *      off-limits as proxies. That line is an INPUT to the writing prompt. It
 *      does not replace the reactor's pre-flight `evaluateOutbound` gate — that
 *      still runs, still redrafts once, and still refuses — it makes the first
 *      draft clean instead of hoping the scan catches it.
 *
 * ── THEM-FIRST ──────────────────────────────────────────────────────────────
 * Every phrase below is written from the CLIENT's side of the table ("you are
 * looking to be in a home in the next three months"), never the brokerage's
 * ("we specialise in"). The reactor's Them-First gate scores pronouns on the
 * produced script; this makes the facts it is built from already point the
 * right way.
 *
 * ── TIMELINE STAYS IN BUCKETS ───────────────────────────────────────────────
 * CLAUDE.md §5: buckets (1-3 / 3-6 / 6-12), never 30/60/90. The keys below are
 * the live `contacts_timeline_check` vocabulary verbatim; an unknown value
 * yields NO timeline fact rather than a guess.
 */

import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { isLifetimeCustomerType } from "@/lib/contact-types"

/**
 * The live `contacts_timeline_check` / `leads_timeline_check` vocabulary mapped
 * to a them-first phrase. Buckets only — §5 forbids 30/60/90 spellings.
 *
 * Derived from the CHECK, not invented: 'immediate', '1-3_months',
 * '3-6_months', '6-12_months', '12+_months', 'researching'.
 */
export const TIMELINE_BUCKET_PHRASE: Readonly<Record<string, string>> = Object.freeze({
  immediate:     "you are ready to move now",
  "1-3_months":  "you are looking at the next one to three months",
  "3-6_months":  "you are looking at the next three to six months",
  "6-12_months": "you are looking at the next six to twelve months",
  "12+_months":  "you are planning a year or more out",
  researching:   "you are still gathering information, with no date set",
})

/** What the caller must hand over. A CONTACT row — never a lead row (§5). */
export interface WelcomeSituationContact {
  contact_type?: string | null
  contact_persona?: string | null
  timeline?: string | null
  city?: string | null
  state?: string | null
  property_type?: string | null
  budget_min?: number | string | null
  budget_max?: number | string | null
  beds?: number | string | null
}

/** A fact that was refused, and why — so a drop is never silent. */
export interface DroppedFact {
  /** Which contact column carried it. */
  field: string
  /** The fair-housing phrase label that matched. */
  phrase: string
  reference: string
}

export interface WelcomeSituationResult {
  /**
   * The fact lines the writing prompt may use, already them-first and already
   * scrubbed. EMPTY is a legitimate answer: a contact we know nothing situational
   * about gets a warm hello with no invented detail, which is honest.
   */
  facts: string[]
  /**
   * The compliance instructions that go INTO the writing prompt beside the
   * facts. Never empty — the fair-housing floor applies to every welcome, and a
   * market-specific steering ban is appended when a market is named.
   */
  complianceDirectives: string[]
  /**
   * HARD fair-housing hits (severity 'high') found in the contact's own free
   * text. The fact was dropped. Non-empty means a human should look at the CRM
   * row, because something in it is unusable in customer-facing copy.
   */
  droppedFacts: DroppedFact[]
  /**
   * Medium/low fair-housing hits. The fact RODE THROUGH — §5, warnings pass
   * through — and this is the note that says so.
   */
  warnings: string[]
  /** True when at least one situational fact survived — i.e. this is not generic. */
  isSituational: boolean
  /**
   * THE CONTACT'S OWN PERSONA, AFTER THE FAIR-HOUSING SCREEN — the live
   * `contacts_contact_persona_check` vocabulary (first_time, relocated, luxury,
   * fsbo, probate, upsize, downsize, military, divorce, senior, expired,
   * foreclosure, other), or whatever free text a legacy row carries.
   *
   * NULL means one of two things and both of them mean "do not use it": the column
   * is empty, or the value carried a HIGH-severity fair-housing phrase and was
   * DROPPED. Exposing the SCREENED value rather than letting callers re-read
   * `contact_persona` off the row is the whole point — a second reader of the raw
   * column would walk straight past the screen this module exists to run (§5).
   *
   * OWNER RULING: "the wording is by their situation or persona". This is the
   * persona half; lib/kernel/client-welcome.ts feeds it to the writer as the
   * `CopyPersona.situation` and falls back to a journey phrase only when it is null.
   */
  personaLabel: string | null
}

/**
 * THE FAIR-HOUSING WRITING FLOOR — the survivor (§6, one vocabulary per
 * function).
 *
 * These three lines say nothing about which video is being written. They are
 * the constraint on what a MODEL may put in any client-facing script, and they
 * are written as WRITING instructions rather than as a grading rubric — that is
 * the whole point of §5's "in the writing prompt, not only in the post-hoc scan".
 *
 * SPLIT OUT so a second personal-video lane cannot end up with a second,
 * drifting copy of the same three sentences. `lib/video/anniversary-script.ts`
 * builds the home-anniversary directive set on top of this exact array: the
 * anniversary video's fourth rule is NOT the welcome video's (an annual equity
 * update states an estimated value on purpose, which the welcome floor
 * forbids), but its fair-housing floor must be the identical text or the two
 * lanes drift.
 *
 * A directive set is one of these plus the lane's own content rules. Nothing
 * may subtract from this array.
 */
export const FAIR_HOUSING_WRITING_FLOOR: readonly string[] = Object.freeze([
  "Fair Housing is a constraint on what you WRITE, not a review afterwards. Never reference or imply race, colour, religion, national origin, sex, gender, sexual orientation, familial status, children, age, disability, or source of income — not about the recipient, not about anyone else, not about an area.",
  "Never describe who a place is 'for', 'perfect for', 'ideal for', or 'great for'. Describe the SERVICE you provide, never the kind of person who belongs somewhere.",
  "Do not use safety, crime, 'good'/'bad' area, church proximity, or school quality as a description of a place — those are the standard steering proxies and they are prohibited here even when the recipient raised them.",
])

/**
 * The floor. Applies to every welcome video regardless of what the contact row
 * holds, because the model can introduce a protected-class reference the facts
 * never contained.
 *
 * The fair-housing half is FAIR_HOUSING_WRITING_FLOOR above, unchanged; the
 * fourth line is the WELCOME lane's own rule — an introduction forecasts
 * nothing, so it may promise nothing about value. Composed rather than retyped,
 * so this array is byte-identical to the one it replaced.
 */
export const WELCOME_FAIR_HOUSING_DIRECTIVES: readonly string[] = Object.freeze([
  ...FAIR_HOUSING_WRITING_FLOOR,
  "Make no promise about price, value, appreciation, rates, or timing. You are introducing yourself, not forecasting.",
])

/**
 * The extra line a named market forces. Naming a city is legitimate and is
 * exactly the personalisation the ruling asks for; characterising it is
 * steering. Both halves are said explicitly so the model cannot split the
 * difference.
 *
 * NOT EXPORTED. It was, briefly, so the simulator could assert its wording in
 * isolation — and `orphan-export-guard` was right to flag that: an export whose
 * only caller is a proof is a surface nobody asked for. The assertion moved onto
 * `buildWelcomeSituation`'s actual output, which is a better test anyway because
 * it exercises the path production uses.
 */
function marketDirectiveFor(market: string): string {
  return (
    `You may name ${market} as the market they are working in. You may NOT characterise ${market} ` +
    `or any neighbourhood, school, or community within it — not by who lives there, not by ` +
    `desirability, not by safety, not by school ratings. Name it as a place; say nothing about its people.`
  )
}

/** Trim + collapse; empty string becomes null so a blank column is not a fact. */
function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/\s+/g, " ").trim()
  return s.length > 0 ? s : null
}

function numeric(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function money(n: number): string {
  return n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
    : `$${Math.round(n / 1000)}K`
}

/**
 * Scan ONE free-text value before it can become a fact.
 *
 * Returns the value when it may be used and null when it must be dropped. §5's
 * split is enforced here and nowhere else: `severity === "high"` is the hard
 * flag and drops the fact; anything softer rides through with a warning.
 */
function screenFreeText(
  field: string,
  value: string,
  out: { droppedFacts: DroppedFact[]; warnings: string[] },
): string | null {
  const hits = detectFairHousingViolations(value)
  if (hits.length === 0) return value

  const hard = hits.filter((h) => h.severity === "high")
  if (hard.length > 0) {
    for (const h of hard) {
      out.droppedFacts.push({ field, phrase: h.phrase, reference: h.reference })
    }
    return null
  }

  for (const h of hits) {
    out.warnings.push(
      `contacts.${field} carries an advisory fair-housing phrase ("${h.phrase}", ${h.severity}) — ` +
        `it rides through to the welcome script per the ruling, but the CRM wording is worth fixing.`,
    )
  }
  return value
}

/**
 * Build the them-first, situational fact set for a newly-converted contact's
 * welcome video, compliance-screened before anything reaches a writing prompt.
 *
 * NEVER THROWS and never returns null: an unknown-everything contact yields an
 * empty `facts` array with the fair-housing floor intact, which the caller
 * renders as a warm, honest, generic-but-not-invented hello.
 */
export function buildWelcomeSituation(
  contact: WelcomeSituationContact | null | undefined,
): WelcomeSituationResult {
  const out: WelcomeSituationResult = {
    facts: [],
    complianceDirectives: [...WELCOME_FAIR_HOUSING_DIRECTIVES],
    droppedFacts: [],
    warnings: [],
    isSituational: false,
    personaLabel: null,
  }
  if (!contact) return out

  // ── SIDE. The one fact that changes the whole shape of the script. ─────────
  const type = (clean(contact.contact_type) ?? "").toLowerCase()
  if (type.includes("seller")) {
    out.facts.push("They are selling — the move starts with their current home.")
  } else if (type === "both") {
    out.facts.push("They are selling AND buying — one move, two transactions that have to line up.")
  } else if (type.includes("buyer") || type === "renter") {
    out.facts.push("They are buying — they are looking for a home, they do not have one to sell first.")
  } else if (type === "investor") {
    out.facts.push("They are investing — this is a numbers decision, not a nesting decision.")
  } else if (isLifetimeCustomerType(type)) {
    // The LIFETIME arm. Added when the owner ruled that a lifetime customer's
    // welcome is picked up by the Sphere Manager: without it a past client reached
    // the writer with NO side fact at all, and the copy could only be generic —
    // which is the them-first defect this module exists to prevent. Tolerant of the
    // spellings m539 retired, like every other persona resolver in the OS.
    out.facts.push(
      "They have already closed with us — this is a lifetime relationship, not a new transaction. " +
        "Nothing is being sold to them here.",
    )
  }

  // ── TIMELINE. Buckets only (§5). An unrecognised value produces NO fact. ───
  const timeline = clean(contact.timeline)
  if (timeline) {
    const phrase = TIMELINE_BUCKET_PHRASE[timeline]
    if (phrase) {
      out.facts.push(`On their own timing: ${phrase}.`)
    } else {
      out.warnings.push(
        `contacts.timeline '${timeline}' is outside the canonical bucket vocabulary — ` +
          `no timing fact was given to the writer rather than guessing at one.`,
      )
    }
  }

  // ── MARKET. Named, never characterised. Screened like any free text. ───────
  const city = clean(contact.city)
  const state = clean(contact.state)
  const marketRaw = city && state ? `${city}, ${state}` : city ?? state
  let market: string | null = null
  if (marketRaw) {
    market = screenFreeText("city/state", marketRaw, out)
    if (market) {
      out.facts.push(`The market they are working in is ${market}.`)
      out.complianceDirectives.push(marketDirectiveFor(market))
    }
  }

  // ── PERSONA. Operator free text — the highest-risk field on the row. ───────
  const personaRaw = clean(contact.contact_persona)
  if (personaRaw) {
    const persona = screenFreeText("contact_persona", personaRaw, out)
    if (persona) {
      // The SCREENED persona is published so the writing prompt's `situation` can be
      // the contact's persona rather than their contact_type (owner ruling). It is
      // set INSIDE the `if (persona)` — a dropped persona leaves it null, so the
      // fair-housing screen governs this exit exactly as it governs the fact.
      out.personaLabel = persona
      out.facts.push(
        `Their situation as the CRM records it is "${persona}" — match that register without ` +
          `naming the label back at them.`,
      )
    }
  }

  // ── PROPERTY TYPE. Free text; screened. ───────────────────────────────────
  const propertyRaw = clean(contact.property_type)
  if (propertyRaw) {
    const property = screenFreeText("property_type", propertyRaw, out)
    // Them-first, like every other fact: the property type is THEIRS, not an
    // inventory line. "The property type in play is X" reads as the brokerage's
    // filing system; the simulator's pronoun assertion catches exactly that.
    if (property) out.facts.push(`The property type they are working in is ${property}.`)
  }

  // ── BUDGET. A RANGE they told us, never a promise about it. ───────────────
  const lo = numeric(contact.budget_min)
  const hi = numeric(contact.budget_max)
  if (lo && hi) {
    out.facts.push(
      `The range they gave is ${money(lo)}–${money(hi)}. Acknowledge that you have it; ` +
        `promise nothing about what it buys.`,
    )
  } else if (hi) {
    out.facts.push(
      `They gave a ceiling of ${money(hi)}. Acknowledge that you have it; promise nothing about what it buys.`,
    )
  }

  // ── BEDS. A stated need, stated plainly. NOT a familial-status inference. ──
  const beds = numeric(contact.beds)
  if (beds) {
    out.facts.push(
      `They asked for ${beds} bedroom${beds === 1 ? "" : "s"}. State it as their requirement; ` +
        `do not speculate about who the rooms are for.`,
    )
  }

  out.isSituational = out.facts.length > 0
  return out
}

/**
 * The dropped facts as operator-readable warning lines. Separate from
 * `warnings` on purpose: a DROP is a fair-housing hard flag sitting in the CRM
 * and it wants a person, while the advisory list is a wording nit.
 */
export function describeDroppedFacts(dropped: readonly DroppedFact[]): string[] {
  return dropped.map(
    (d) =>
      `HARD fair-housing phrase in contacts.${d.field} ("${d.phrase}", ${d.reference}) — ` +
      `the fact was withheld from the welcome-video writing prompt. Fix the CRM wording.`,
  )
}
