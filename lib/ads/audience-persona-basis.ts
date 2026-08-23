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
// ── THE OWNER RULING OF 2026-08-23, WHICH REVERSED THIS MODULE'S FIRST CUT ───
// VERBATIM: "military, senior, divorced and probate need to be allowed as
// situation persona because that is how we show them info or ads that is worded
// to their situation as part of them-first methology."
// And, defining what a persona IS: "lifetime and active seller are contact type
// not persona. persona is more the situation that the contact or lead is in."
//
// The first cut of this file COMPUTED its eligibility split by running every
// canonical persona name through `protectedClassReasonFor`, which made `senior`,
// `probate`, `divorce` and `military` ads-INELIGIBLE and flagged `military` for a
// ruling. The owner has now ruled all four ELIGIBLE **as an inclusion basis**, and
// gave the reason: the persona selects the WORDING, so a person in that situation
// gets information written for their situation. That is TAILORING.
//
// ── THE LINE THAT REPLACES IT: INCLUSION vs EXCLUSION ────────────────────────
// The fair-housing exposure in this area — 42 U.S.C. § 3604(c), and HUD's
// 2019-2022 actions against Meta — is about EXCLUSION: withholding housing
// advertising from people because of a protected characteristic. Reaching a
// widow with probate-sale information and REFUSING to show a listing to anyone
// over 55 are different operations on the same field, and only the second is the
// regulated act. So the split is no longer "which personas", it is "which
// OPERATION":
//
//   · a persona used to INCLUDE people and choose their wording  → ALLOWED,
//     all thirteen minus the catch-all, per the ruling;
//   · a persona that is a PROTECTED CHARACTERISTIC used to EXCLUDE or SUPPRESS
//     an audience                                                → REFUSED.
//     Excluding `senior` from a housing ad is withholding housing from the
//     elderly whatever the field is called.
//
// THE MODEL CAN EXPRESS THAT, WHICH IS THE ONLY REASON THE SECOND HALF IS BUILT.
// `SourceRule.type` already carries `exclusion_active_pipeline` — "an audience
// that removes people" is a first-class concept here, not one invented for this
// gate. `EXCLUSION_SOURCE_RULE_TYPES` (lib/ads/audience-source-rules.ts) derives
// that set by prefix from the one roster, and `audienceUseOf` below reads it.
// THE GAP THAT WAS NAMED HERE IS CLOSED (2026-08-23). It read: an audience
// EXPORTED and pasted into Meta's own "Exclude" box is invisible to this product,
// because `TargetingConfig` had no excluded-audience field and
// `facebook_custom_audiences` had no column saying an audience was used as a
// suppression list. Owner ruling: "capability is vital to this os to have not
// exclude" — so the capability exists in order to REFUSE. A campaign now declares
// its suppression list in `TargetingConfig.excluded_audience_ids`, and
// lib/ads/audience-exclusion.ts calls THIS gate on every audience in it, passing
// `resolveAudiencePersonaBasis(rule, "exclusion")` — the escalation, because an
// audience whose own rule reads "inclusion" still SUBTRACTS people once a
// campaign places it in that slot. Migration m538 records the fact on the
// audience. This module is unchanged in what it refuses; it is now asked in one
// more place, which is the place the exposure actually lived.
//
// ── WHY `other` STILL REFUSES, AND WHY THAT IS NOT THE REVERSED OBJECTION ────
// The owner's definition is load-bearing: "persona is more the situation that the
// contact or lead is in." `other` is the catch-all for a contact whose situation
// we have NOT learned. Refusing it is not the fair-housing objection the ruling
// reversed — it is the fail-closed one (CLAUDE.md §4): before this module existed
// `syncAudience` had no branch for a persona audience at all, fell through to
// "every consented contact in the tenant", and uploaded the WHOLE CRM to Meta
// under a name promising a narrow slice. An audience basis of "everyone we could
// not classify" is that same upload wearing a persona label, so it refuses with
// `refusalKind: "no_basis"` — a different reason with a different fix. `other`
// stays fully valid for campaign sequences, copy and every data lane.
//
// ── WHAT THIS MODULE STILL IS NOT ────────────────────────────────────────────
// It is NOT a licence for raw demographic targeting. The owner permitted a
// PERSONA — a situation label on a contact WE ALREADY KNOW, stored in
// `contacts.contact_persona` — not a demographic criterion sent to an ad
// platform. `min_owner_age`, `demographics.recentlyDivorced` and
// `quicklists: ["senior-owner"]` are REFUSED on the ads lane exactly as before,
// by `assertAudienceSegmentationAllowed` / `screenProtectedClassCriteria`, and
// the simulator proves that separation on every one of those shapes.

import {
  CAMPAIGN_PERSONAS,
  isCampaignPersona,
  type CampaignPersona,
} from "@/lib/campaigns/contact-sources"
// `AudienceUse` / `audienceUseOf` MOVED to lib/ads/audience-source-rules.ts (§6,
// §1). They answer "which operation does this rule perform", and
// `protected-class-signals.ts` was answering the SAME question in a second
// spelling — `isExclusionSourceRuleType(rule?.type)` inlined at its carve-out.
// It could not call this one from here: this module imports
// `protectedClassReasonFor` FROM that module, so the wire would have been a
// cycle. Moving the pair down beside `EXCLUSION_SOURCE_RULE_TYPES` — the roster
// they are derived from — gives both readers one vocabulary and no cycle.
import {
  audienceUseOf,
  type AudienceUse,
} from "@/lib/ads/audience-source-rules"
import { protectedClassReasonFor } from "@/lib/lead-governance/protected-class-signals"

export type { AudienceUse }

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
  /** Which operation this verdict was reached for. A persona is not "eligible"
   *  in the abstract — it is eligible to INCLUDE, or to EXCLUDE, and those two
   *  now answer differently for four of the thirteen. */
  use: AudienceUse
  /** True when this persona may be the basis of an audience used THIS way. */
  eligible: boolean
  /** Null iff eligible. A sentence an operator reads, never a bare code. */
  reason: string | null
  /**
   * Which of the two refusals this is, so callers and the simulator can tell them
   * apart without parsing prose:
   *   · "protected_characteristic" — the persona is a protected class AND the
   *     audience would SUPPRESS the people it names (the only refusal left on
   *     that ground after the 2026-08-23 ruling);
   *   · "no_basis"                 — the persona names no situation (`other`),
   *     on either operation.
   */
  refusalKind: "protected_characteristic" | "no_basis" | null
}

/**
 * PURE. Whether one canonical persona may be the basis of an OUTBOUND AD AUDIENCE
 * that performs `use` on the people it selects.
 *
 * ── THE INCLUSION HALF IS NOW OPEN, BY RULING ────────────────────────────────
 * Every persona that names a SITUATION is an eligible inclusion basis, the four
 * protected-characteristic ones included: "military, senior, divorced and probate
 * need to be allowed as situation persona because that is how we show them info
 * or ads that is worded to their situation." Only `other` refuses, and on the
 * other ground entirely (see `UNRESOLVED_PERSONA`).
 *
 * ── THE EXCLUSION HALF IS DERIVED, NEVER LISTED ──────────────────────────────
 * Which personas may not SUPPRESS an audience is decided by calling the one
 * protected-class classifier on the persona name itself. Writing "senior,
 * probate, divorce, military" into a constant here would be a second vocabulary
 * that silently stops agreeing with `PROTECTED_CLASS_TOKENS` the day a token is
 * added — and the failure would be in the permissive direction, which is the one
 * that ships a violation.
 */
export function personaAdsEligibility(
  persona: CampaignPersona,
  use: AudienceUse = "inclusion",
): PersonaAdsEligibility {
  if (persona === UNRESOLVED_PERSONA) {
    return {
      persona,
      use,
      eligible: false,
      refusalKind: "no_basis",
      reason:
        `persona "${persona}" names no situation — it is the catch-all for a contact whose ` +
        `situation we have not learned yet ("persona is more the situation that the contact or ` +
        `lead is in"). An ad audience must declare what kind of client it is aimed at and what ` +
        `they are trying to do; "${persona}" declares the absence of that, so it would silently ` +
        `mean "everyone". It stays valid for campaign sequences and copy.`,
    }
  }
  if (use === "exclusion") {
    const protectedReason = protectedClassReasonFor(persona)
    if (protectedReason) {
      return {
        persona,
        use,
        eligible: false,
        refusalKind: "protected_characteristic",
        reason:
          `persona "${persona}" names a PROTECTED CHARACTERISTIC, and this audience SUPPRESSES the ` +
          `people it selects rather than reaching them. ${protectedReason} Reaching someone with ` +
          `information written for their situation is the owner's them-first ruling and is allowed; ` +
          `WITHHOLDING housing advertising from them on that same ground is the restricted act ` +
          `(Fair Housing Act, 42 U.S.C. § 3604(c); HUD's 2019-2022 actions against Meta). Build this ` +
          `audience as an inclusion basis, or exclude on a behaviour or pipeline state instead.`,
      }
    }
  }
  return { persona, use, eligible: true, refusalKind: null, reason: null }
}

/**
 * Every canonical persona an ad audience may be TARGETED on. Computed at load.
 *
 * Since the 2026-08-23 ruling this is every canonical persona except the
 * catch-all — the four protected-characteristic personas are in it, because the
 * persona is what selects the WORDING their information is written in.
 */
export const ADS_ELIGIBLE_PERSONAS: readonly CampaignPersona[] = Object.freeze(
  CAMPAIGN_PERSONAS.filter((p) => personaAdsEligibility(p, "inclusion").eligible),
)

/** Every canonical persona an ad audience MAY NOT be targeted on. Computed at load. */
export const ADS_INELIGIBLE_PERSONAS: readonly CampaignPersona[] = Object.freeze(
  CAMPAIGN_PERSONAS.filter((p) => !personaAdsEligibility(p, "inclusion").eligible),
)

/**
 * Every canonical persona that may not be the basis of an audience which REMOVES
 * people (`exclusion_*` source-rule types). Computed at load from the classifier,
 * so it is the protected-characteristic personas plus the null basis and it
 * cannot drift from `PROTECTED_CLASS_TOKENS`.
 *
 * READ, not merely declared (CLAUDE.md §1 — a constant with no reader is an
 * orphan whatever it documents): `resolveAudiencePersonaBasis` names this set in
 * the exclusion refusal an operator reads, so the error says which personas may
 * not suppress an audience rather than only which one was rejected. The ads
 * dashboard has no surface for it yet; the simulator asserts it against an
 * independent re-derivation from `PROTECTED_CLASS_TOKENS`.
 */
export const EXCLUSION_INELIGIBLE_PERSONAS: readonly CampaignPersona[] = Object.freeze(
  CAMPAIGN_PERSONAS.filter((p) => !personaAdsEligibility(p, "exclusion").eligible),
)

/** The shape the ads lane reads a persona basis out of. Matches `SourceRule`. */
export interface PersonaBasisRule {
  type?: unknown
  filters?: { personas?: unknown } | null
}

export type PersonaBasisResolution =
  | { ok: true; personas: CampaignPersona[] }
  | {
      ok: false
      refusal: string
      /**
       * WHICH refusal this is, so a caller can tell them apart without parsing
       * prose. Mirrors `PersonaAdsEligibility["refusalKind"]` and adds the one
       * refusal that is about the DECLARATION rather than the persona:
       *   · "protected_characteristic" — a protected-class persona in a slot
       *     that SUPPRESSES (the fair-housing refusal);
       *   · "no_basis"                 — `other`, which names no situation;
       *   · "unresolvable"             — no personas, an empty list, a
       *     non-string entry, or a spelling outside the canonical roster.
       *
       * ADDED FOR THE EXCLUSION SLOT (lib/ads/audience-exclusion.ts): that gate
       * must report WHY an audience may not be a suppression list, and
       * `refusal.includes("PROTECTED")` is a second vocabulary waiting to
       * happen (CLAUDE.md §6).
       */
      refusalKind: "protected_characteristic" | "no_basis" | "unresolvable"
    }

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
 *   · senior / probate / divorce / military   → ADMITTED on an INCLUSION rule
 *                                               (owner ruling 2026-08-23), and
 *                                               refused on an `exclusion_*` rule
 *                                               (protected_characteristic)
 *
 * Deliberately NOT run through `normalizeContactPersona`: that function maps
 * DRIFTED DATABASE SPELLINGS forward for a reader, which is right for reading a
 * stored contact row and wrong for accepting an operator's audience definition.
 * An audience basis is AUTHORED, so it must be authored in the canon; accepting
 * `luxury_buyer` here would make the ads lane a second place the vocabulary is
 * allowed to drift.
 *
 * ── `escalateTo` — THE PLACEMENT CAN MAKE AN AUDIENCE SUBTRACT ──────────────
 * An audience's own rule type is not the only thing that decides which
 * operation it performs. A campaign that lists an audience in its EXCLUDED
 * slot (`TargetingConfig.excluded_audience_ids`) subtracts that audience's
 * people whatever its rule type says — a `persona_segment` audience of
 * `senior` reads as "inclusion" from its rule and suppresses the elderly from
 * a housing ad once it is placed there. `lib/ads/audience-exclusion.ts` passes
 * `"exclusion"` here so the verdict is reached for the operation actually
 * being performed.
 *
 * IT IS TYPED SO IT CAN ONLY ESCALATE. The parameter admits the single literal
 * `"exclusion"`; there is no way to spell "treat this exclusion rule as an
 * inclusion". The objection to a `use` parameter was that a caller could get it
 * wrong in the PERMISSIVE direction, and a one-way parameter cannot: the worst
 * a confused caller can do is apply the stricter arm.
 */
export function resolveAudiencePersonaBasis(
  rule: unknown,
  escalateTo?: "exclusion",
): PersonaBasisResolution {
  // WHICH OPERATION FIRST, then which personas. Read off the rule itself rather
  // than passed in: every caller already hands the whole rule to this function,
  // and a two-way `use` parameter would be one more thing a caller could get
  // wrong in the permissive direction. `escalateTo` is one-way (see above).
  const use: AudienceUse = escalateTo === "exclusion" ? "exclusion" : audienceUseOf(rule)
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
      refusalKind: "unresolvable",
    }
  }
  if (!Array.isArray(declared)) {
    return {
      ok: false,
      refusal:
        `persona basis must be an ARRAY of canonical personas, got ${typeof declared}. ` +
        `Name one or more of: ${ADS_ELIGIBLE_PERSONAS.join(", ")}.`,
      refusalKind: "unresolvable",
    }
  }
  if (declared.length === 0) {
    return {
      ok: false,
      refusal:
        `persona basis is an EMPTY list. A basis of nothing is not a basis — it would ` +
        `populate with every consented contact in the brokerage. ` +
        `Name one or more of: ${ADS_ELIGIBLE_PERSONAS.join(", ")}.`,
      refusalKind: "unresolvable",
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
        refusalKind: "unresolvable",
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
        refusalKind: "unresolvable",
      }
    }
    const verdict = personaAdsEligibility(candidate, use)
    if (!verdict.eligible) {
      // The exclusion refusal names the WHOLE refused set, not only the persona
      // that tripped it: an operator fixing a suppression list needs to know
      // which other personas will trip it on the next attempt. Read here rather
      // than in `personaAdsEligibility` because that function is what computes
      // the set — referencing it there would be a temporal-dead-zone crash at
      // module load, not a cycle anybody would see in review.
      const suffix =
        verdict.refusalKind === "protected_characteristic"
          ? ` The personas that may not be an EXCLUSION basis are: ${EXCLUSION_INELIGIBLE_PERSONAS.join(", ")}.`
          : ""
      return { ok: false, refusal: verdict.reason! + suffix, refusalKind: verdict.refusalKind! }
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
 *
 * SINCE 2026-08-23 THIS IS ALSO THE GATE THAT CARRIES THE EXCLUSION REFUSAL. The
 * token gate can no longer refuse `senior` under `filters.personas` — the owner
 * ruled that inclusion lawful — so a protected-characteristic persona on an
 * `exclusion_*` rule is refused HERE, and (belt and braces) by the token gate
 * too, which keeps its refusal for exactly that shape. Both are wired at all four
 * doors onto `facebook_custom_audiences`; the simulator pins both.
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
