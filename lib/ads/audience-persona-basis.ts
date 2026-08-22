// lib/ads/audience-persona-basis.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE POSITIVE HALF OF THE AD-AUDIENCE RULE: AN AUDIENCE IS SEGMENTED ON PERSONA.
//
// OWNER RULING, VERBATIM: "audience should be segmented on persona."
//
// ── WHY THIS FILE EXISTS, AND WHAT IT IS NOT ─────────────────────────────────
// The ads lane already had a NEGATIVE rule and it is untouched here:
// lib/lead-governance/protected-class-signals.ts refuses an ad audience that is
// segmented by a protected class (`assertAudienceSegmentationAllowed`), while the
// data lanes — scraping, enrichment, signals, scoring, sourcing — hold and use the
// same attributes by the owner's standing exemption. That rule says what an
// audience may NOT be. It never said what an audience SHOULD be, so
// `facebook_custom_audiences.audience_type` carried the value `persona_segment`
// with NO writer, NO SourceRule type and NO populate branch — a live CHECK
// vocabulary member that nothing could produce (CLAUDE.md §1: no duplicate
// exists, the capability is wanted, so BUILD the missing half).
//
// This module is that half. It is NOT a second protected-class vocabulary
// (CLAUDE.md §6). It coins NOTHING:
//   · the persona roster is `CAMPAIGN_PERSONAS` (lib/campaigns/contact-sources.ts),
//     which already mirrors the `Persona` union at lib/kernel/types.ts and the
//     live CHECK `campaign_sequences_persona_check`;
//   · the eligibility split is COMPUTED by calling the one existing classifier,
//     `protectedClassReasonFor`, on each persona NAME. There is no hand-written
//     list of "bad personas" here, and that is deliberate — see below.
//
// ── THE TRAP THIS FILE IS BUILT AROUND ───────────────────────────────────────
// "Segment the audience on persona" is one careless step from being a LAUNDERING
// ROUTE. Several canonical persona names are not situations at all — they are a
// protected characteristic wearing a friendlier label:
//
//     senior    → age               probate  → inheritance / a death in a family
//     divorce   → marital status    military → veteran status
//
// Every one of those words is already in `PROTECTED_CLASS_TOKENS`, because the
// owner's data-lane ruling deliberately KEPT them there ("the tokens are what let
// the ads gate keep refusing"). So an audience rule of
// `{ type: "persona_segment", filters: { personas: ["senior"] } }` is ALREADY
// refused by `protectedClassSegmentationIn`, which scans string VALUES as well as
// keys — verified by positive control in the simulator. Nothing here weakens that,
// and this module must never become the place somebody adds an exception to it.
//
// What this module adds on top is LEGIBILITY and FAIL-CLOSED RESOLUTION:
//   · the token gate refuses with `filters.personas[0]=senior`, which tells an
//     operator that "senior" is a protected token. It does not tell them that
//     `senior` is a VALID persona everywhere else in the product. This refusal
//     names the persona, names the characteristic it stands for, and says where
//     the persona is still usable — so the refusal reads as a scope boundary
//     rather than as a bug in the persona vocabulary;
//   · a persona basis that cannot be RESOLVED — absent, empty, misspelled, or the
//     catch-all `other` — refuses too, and that is a different refusal with a
//     different reason. Before this existed, `syncAudience` had no branch for a
//     persona audience at all: it fell through to "every consented contact in the
//     tenant" and uploaded the WHOLE CRM to Meta under a name that promised a
//     narrow slice. An unresolvable basis must refuse, not populate (CLAUDE.md §4).
//
// ── THE HONEST ANSWER ON THE FOUR ───────────────────────────────────────────
// A subset of the canonical persona vocabulary REMAINS ADS-INELIGIBLE. That is
// the honest reading of the two rulings together, not a hedge: the owner exempted
// sourcing/enrichment/scoring/education from fair housing so the right EDUCATION
// reaches the right person, and kept the refusal on outbound ad targeting because
// choosing who a housing ad is SHOWN to is the regulated act. `senior`, `probate`,
// `divorce` and `military` stay fully valid for education, sourcing, scoring,
// campaign sequences and copy. They may not choose who sees a housing ad.
// `military` is flagged for an owner ruling in the lane report: veteran status is
// state-protected in several of our markets and is in the token vocabulary, so the
// gate refuses it consistently — but VA-loan education is a legitimate agent
// practice and the owner may want to draw that line differently. The gate refuses
// it TODAY because refusing is the fail-closed direction; a ruling can widen it.

import {
  CAMPAIGN_PERSONAS,
  isCampaignPersona,
  type CampaignPersona,
} from "@/lib/campaigns/contact-sources"
import { protectedClassReasonFor } from "@/lib/lead-governance/protected-class-signals"

/** The `SourceRule.type` and `audience_type` that declare a persona basis. */
export const PERSONA_SEGMENT_TYPE = "persona_segment"

/**
 * The catch-all member of the canonical persona union. It is a valid persona
 * everywhere a persona may be UNKNOWN (a contact whose situation we have not
 * learned yet still needs a campaign), and it is NOT a valid ad-audience BASIS:
 * "everyone we could not classify" is the absence of a basis wearing one.
 */
export const UNRESOLVED_PERSONA: CampaignPersona = "other"

export interface PersonaAdsEligibility {
  persona: CampaignPersona
  /** True when this persona names a TRANSACTION SITUATION an ad may be aimed at. */
  eligible: boolean
  /** Null iff eligible. A sentence an operator reads, never a bare code. */
  reason: string | null
  /**
   * Which of the two refusals this is, so callers and the simulator can tell them
   * apart without parsing prose:
   *   · "protected_characteristic" — the persona IS a protected class (senior, …)
   *   · "no_basis"                 — the persona names no situation (`other`)
   */
  refusalKind: "protected_characteristic" | "no_basis" | null
}

/**
 * PURE. Whether one canonical persona may be the basis of an OUTBOUND AD AUDIENCE.
 *
 * DERIVED, NEVER LISTED. The protected half is decided by calling the one
 * protected-class classifier on the persona name itself. Writing the four names
 * into a constant here would be a second vocabulary that silently stops agreeing
 * with `PROTECTED_CLASS_TOKENS` the day a token is added — and the failure would
 * be in the permissive direction, which is the one that ships a violation.
 */
export function personaAdsEligibility(persona: CampaignPersona): PersonaAdsEligibility {
  if (persona === UNRESOLVED_PERSONA) {
    return {
      persona,
      eligible: false,
      refusalKind: "no_basis",
      reason:
        `persona "${persona}" names no transaction situation — it is the catch-all for a contact ` +
        `whose situation we have not learned yet. An ad audience must declare what kind of client ` +
        `it is aimed at and what they are trying to do; "${persona}" declares the absence of that, ` +
        `so it would silently mean "everyone". It stays valid for campaign sequences and copy.`,
    }
  }
  const protectedReason = protectedClassReasonFor(persona)
  if (protectedReason) {
    return {
      persona,
      eligible: false,
      refusalKind: "protected_characteristic",
      reason:
        `persona "${persona}" is a PROTECTED CHARACTERISTIC wearing a persona label, not a ` +
        `transaction situation. ${protectedReason} It remains fully valid for education, ` +
        `sourcing, enrichment, scoring, campaign sequences and copy — by the owner's standing ` +
        `exemption on the data lane — and it may not choose who a housing ad is shown to ` +
        `(Fair Housing Act, 42 U.S.C. § 3604(c)).`,
    }
  }
  return { persona, eligible: true, refusalKind: null, reason: null }
}

/** Every canonical persona an ad audience MAY be segmented on. Computed at load. */
export const ADS_ELIGIBLE_PERSONAS: readonly CampaignPersona[] = Object.freeze(
  CAMPAIGN_PERSONAS.filter((p) => personaAdsEligibility(p).eligible),
)

/** Every canonical persona an ad audience MAY NOT be segmented on. Computed at load. */
export const ADS_INELIGIBLE_PERSONAS: readonly CampaignPersona[] = Object.freeze(
  CAMPAIGN_PERSONAS.filter((p) => !personaAdsEligibility(p).eligible),
)

/** The shape the ads lane reads a persona basis out of. Matches `SourceRule`. */
export interface PersonaBasisRule {
  type?: unknown
  filters?: { personas?: unknown } | null
}

export type PersonaBasisResolution =
  | { ok: true; personas: CampaignPersona[] }
  | { ok: false; refusal: string }

/**
 * PURE. Does this audience rule DECLARE a persona basis?
 *
 * True for `type === "persona_segment"` OR for any rule carrying a `personas`
 * filter, whatever its type — a persona filter smuggled onto a `contact_list`
 * rule is still a persona basis, and gating only on the type string would let a
 * caller opt out of this rule by mislabelling the type.
 */
export function declaresPersonaBasis(rule: unknown): boolean {
  if (!rule || typeof rule !== "object") return false
  const r = rule as PersonaBasisRule
  if (r.type === PERSONA_SEGMENT_TYPE) return true
  return r.filters != null && typeof r.filters === "object" && "personas" in r.filters
}

/**
 * PURE. Resolve the persona basis of an ad audience, or REFUSE with the reason.
 *
 * FAILS CLOSED (CLAUDE.md §4). Every path that is not an explicit list of
 * eligible canonical personas is a refusal:
 *   · not an object / no `filters`            → refuse (nothing was declared)
 *   · `personas` absent, not an array, empty  → refuse (a basis of nothing)
 *   · a non-string or unknown spelling        → refuse, naming the value and the
 *                                               roster (never guessed forward —
 *                                               a guessed persona is a silently
 *                                               different audience)
 *   · `other`                                 → refuse (no_basis)
 *   · senior / probate / divorce / military   → refuse (protected_characteristic)
 *
 * Deliberately NOT run through `normalizeContactPersona`: that function maps
 * DRIFTED DATABASE SPELLINGS forward for a reader, which is right for reading a
 * stored contact row and wrong for accepting an operator's audience definition.
 * An audience basis is AUTHORED, so it must be authored in the canon; accepting
 * `luxury_buyer` here would make the ads lane a second place the vocabulary is
 * allowed to drift.
 */
export function resolveAudiencePersonaBasis(rule: unknown): PersonaBasisResolution {
  const declared = (rule && typeof rule === "object"
    ? (rule as PersonaBasisRule).filters?.personas
    : undefined)

  if (declared === undefined || declared === null) {
    return {
      ok: false,
      refusal:
        `declares a persona basis (${PERSONA_SEGMENT_TYPE}) but names no persona. ` +
        `An audience whose basis cannot be resolved must refuse, not populate: with no persona ` +
        `filter this audience uploads every consented contact in the brokerage. ` +
        `Name one or more of: ${ADS_ELIGIBLE_PERSONAS.join(", ")}.`,
    }
  }
  if (!Array.isArray(declared)) {
    return {
      ok: false,
      refusal:
        `persona basis must be an ARRAY of canonical personas, got ${typeof declared}. ` +
        `Name one or more of: ${ADS_ELIGIBLE_PERSONAS.join(", ")}.`,
    }
  }
  if (declared.length === 0) {
    return {
      ok: false,
      refusal:
        `persona basis is an EMPTY list. A basis of nothing is not a basis — it would ` +
        `populate with every consented contact in the brokerage. ` +
        `Name one or more of: ${ADS_ELIGIBLE_PERSONAS.join(", ")}.`,
    }
  }

  const resolved: CampaignPersona[] = []
  for (const raw of declared) {
    if (typeof raw !== "string") {
      return {
        ok: false,
        refusal:
          `persona basis contains a non-string entry (${typeof raw}). ` +
          `Name one or more of: ${ADS_ELIGIBLE_PERSONAS.join(", ")}.`,
      }
    }
    const candidate = raw.trim().toLowerCase()
    if (!isCampaignPersona(candidate)) {
      return {
        ok: false,
        refusal:
          `"${raw}" is not a canonical persona and is NOT guessed forward — a guessed persona ` +
          `is a different audience than the one the operator asked for. The canonical roster is ` +
          `${CAMPAIGN_PERSONAS.join(", ")} (lib/campaigns/contact-sources.ts, mirroring the ` +
          `Persona union at lib/kernel/types.ts and the live campaign_sequences_persona_check).`,
      }
    }
    const verdict = personaAdsEligibility(candidate)
    if (!verdict.eligible) {
      return { ok: false, refusal: verdict.reason! }
    }
    if (!resolved.includes(candidate)) resolved.push(candidate)
  }
  return { ok: true, personas: resolved }
}

/**
 * Throws when an ad audience declares a persona basis it may not be built on, or
 * declares one that cannot be resolved. Same shape and same fail-closed contract
 * as `assertAudienceSegmentationAllowed`, which it sits BESIDE rather than
 * replaces: that one refuses what an audience may not be, this one requires what
 * it must be. `audienceLabel` is quoted back so an operator reading the error
 * knows WHICH audience to fix.
 */
export function assertAudiencePersonaBasis(rule: unknown, audienceLabel: string): void {
  if (!declaresPersonaBasis(rule)) return
  const res = resolveAudiencePersonaBasis(rule)
  if (!res.ok) {
    throw new Error(
      `[audience-persona-basis] REFUSED: audience "${audienceLabel}" ${res.refusal}`,
    )
  }
}
