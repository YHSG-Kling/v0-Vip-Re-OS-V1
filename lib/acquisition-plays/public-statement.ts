// lib/acquisition-plays/public-statement.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PUBLIC-STATEMENT READER — PURE (no imports at runtime; the kind type is erased).
//
// Moved verbatim from lib/acquisition-plays/public-request.ts (wave 154, lane 154G1 — lane 154C Outside-lane request 2) so two
// callers share ONE reader without the content path reaching public-request.ts's lazy RawData / AI-ISA imports:
//   · lib/acquisition-plays/public-request.ts classifyPublicRequest — a first-person housing need → RawData under source rights;
//   · lib/content-intel/public-chatter-topics.ts routeChatter (its production default classifier) — on the TOPIC path both a
//     first-person post and an anonymous discussion end as a reworded topic; the reader only records which it was.

import type { StatedNeedKind } from "./public-request"

export interface PublicStatement { firstPerson: boolean; thirdParty: boolean; requestsAgentContact: boolean; statesHousingNeed: boolean; needKinds: StatedNeedKind[]; isQuestion: boolean; relocating: boolean; quote: string | null; /** wave 156 (156I) — the author says they are under 18 (authorStatesMinor, foot) */ minorAuthor: boolean }

const REQUEST_RE = /\b(looking for|need|seeking|searching for|hire|find|recommend(?:ation)?s?\s+(?:for|of)?|who should (?:I|we) (?:use|call|talk to))\b[^.?!]{0,60}\b(real ?estate agent|realtor|buyer'?s agent|listing agent|agent)\b|\bcan anyone recommend\b[^.?!]{0,60}\b(agent|realtor)\b/i
const FIRST_PERSON_RE = /\b(I|I'm|I am|I've|we|we're|we are|we've|my|our|me|us)\b/
const THIRD_PARTY_RE = /\b(my|our)\s+(friend|sister|brother|parents|mother|father|coworker|colleague|neighbor|client|cousin|aunt|uncle|son|daughter)\b|\bsomeone I know\b|\ba friend of mine\b/i
const QUESTION_RE = /\?|\b(how (?:much|do|does|long)|what (?:is|are|should)|is it (?:worth|better)|should (?:I|we))\b/i
const RELOCATING_RE = /\b(relocat\w*|moving to|move to|transferr?\w* to|pcs\w* to)\b/i

// The author's OWN need, in the first person (owner ruling B4). Each pattern is a phrase people write about themselves; the
// military one matches what a service member volunteers ("we PCS to …", "getting stationed at …") — it records THAT they said
// so, never orders or a duty station as a fact.
const NEED_PATTERNS: ReadonlyArray<{ kind: StatedNeedKind; re: RegExp }> = [
  { kind: "fsbo_selling", re: /\b(for sale by owner|fsbo|selling (?:it |the house |our house |my house )?(?:myself|ourselves|by owner)|by[- ]owner sale)\b/i },
  { kind: "selling", re: /\b(selling (?:my|our) (?:home|house|condo|townhouse|property)|(?:need|want|plan(?:ning)?|have) to sell (?:my|our|the)? ?(?:home|house|condo|place)?|list(?:ing)? (?:my|our) (?:home|house))\b/i },
  { kind: "buying", re: /\b(looking to buy|want(?:ing)? to buy|plan(?:ning)? to buy|buy(?:ing)? (?:a|our first|my first) (?:home|house|condo)|house[- ]hunting|searching for a (?:home|house))\b/i },
  { kind: "military_move", re: /\b(pcs(?:'?ing|'?d)?|permanent change of station|getting stationed|stationed (?:at|in|to)|military (?:move|family|relocation)|(?:my|our) (?:husband|wife|spouse) (?:is )?(?:in the )?(?:army|navy|air force|marines|coast guard|military))\b/i },
  { kind: "relocating", re: RELOCATING_RE },
]

/** First person at a sentence start too ("We PCS to …", "My husband …") — FIRST_PERSON_RE is case-sensitive so "I" never
 *  matches a stray "i"; the plural / possessive forms are safe to read in either case. */
const FIRST_PERSON_NEED_RE = /\b(I|I'm|I am|I've|[Ww]e|[Ww]e're|[Ww]e are|[Ww]e've|[Mm]y|[Oo]ur|me|us)\b/

/** PURE — read a statement: sentences split, the request / need sentence quoted verbatim (≤ 200 chars). */
export function readPublicStatement(text: string): PublicStatement {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean)
  // The AUTHOR's own first-person request wins over a headline that merely names the topic ("Looking for a realtor.").
  const requestSentence = sentences.find((s) => REQUEST_RE.test(s) && FIRST_PERSON_RE.test(s)) ?? sentences.find((s) => REQUEST_RE.test(s)) ?? null
  // The author's own need: a first-person sentence carrying a need phrase, never a third party's ("my sister is selling").
  const needSentences = sentences.filter((s) => FIRST_PERSON_NEED_RE.test(s) && !THIRD_PARTY_RE.test(s) && NEED_PATTERNS.some((p) => p.re.test(s)))
  const needKinds = Array.from(new Set(needSentences.flatMap((s) => NEED_PATTERNS.filter((p) => p.re.test(s)).map((p) => p.kind))))
  const questionSentence = sentences.find((s) => QUESTION_RE.test(s) && /\b(home|house|buy|sell|mortgage|closing|agent|realtor|neighborhood|rent)\b/i.test(s)) ?? null
  // Wave 154 (B1 "exact supporting statement"): the most complete need sentence, not a headline that merely names it.
  const bestNeed = [...needSentences].sort((x, y) => y.length - x.length)[0]
  const quoteSrc = requestSentence ?? bestNeed ?? questionSentence
  const thirdParty = !!requestSentence && THIRD_PARTY_RE.test(requestSentence)
  const requests = !!requestSentence && FIRST_PERSON_RE.test(requestSentence) && !thirdParty
  return {
    firstPerson: requests || needSentences.length > 0,
    thirdParty: thirdParty && needSentences.length === 0,
    requestsAgentContact: requests,
    statesHousingNeed: needSentences.length > 0,
    needKinds,
    isQuestion: !!questionSentence || /\?/.test(text),
    relocating: RELOCATING_RE.test(text) || needKinds.includes("military_move"),
    quote: quoteSrc ? quoteSrc.slice(0, 200) : null,
    minorAuthor: authorStatesMinor(text),
  }
}

// ── WAVE 156 (lane 156I — directive 156I row 5: "identity & AGE check → Raw Lead Gate") ─────────────────────────────────
// The person path checked the statement's age (the 90-day window, a required date) and the author's identity (a contact point
// they published), but nothing read the AUTHOR's age: a teenager's "I'm 16 and want to buy my first house, email me at …" on a
// permitted page passed every gate and was filed as a Raw Lead. A minor cannot be held to a real-estate contract and is never
// an outreach target. The reader records only what the author SAYS about themselves (an age under 18, "I'm a minor / a teen",
// "I'm in high school"); nothing is inferred from style, and a statement that says nothing about age is not assumed adult or
// minor — it stays with the existing gates. Consumer: lib/acquisition-plays/contract.ts personCandidateProblem.

const MINOR_AGE_RE = /\b(?:I'?m|I am|im)\s+(?:only\s+|just\s+)?(?:1[0-7]|[5-9])(?:\s*(?:years?|yrs?)(?:\s*old)?|\s*y\/?o)?(?![\d.,])(?!\s*(?:months?|weeks?|days?|%|k\b|percent|minutes?|mins?|hours?|hrs?|miles?|blocks?|houses?|homes?|times?|stars?|o'?clock|am\b|pm\b))(?!\s+(?:into|in|of|at|with|since|away|from|years?)\b)/i
const MINOR_SELF_RE = /\b(?:I'?m|I am|im)\s+(?:a\s+)?(?:minor|teen(?:ager)?|high[- ]?school(?:er| student| senior| junior| sophomore| freshman)?|in high school|still in high school|underage)\b|\bI(?:'m| am) not 18\b|\bI(?:'ll| will) be 18\b/i

/** PURE — does the author say, in their own words, that they are under 18? */
export function authorStatesMinor(text: string): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ")
  return MINOR_AGE_RE.test(t) || MINOR_SELF_RE.test(t)
}

