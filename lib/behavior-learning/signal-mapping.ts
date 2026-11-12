// lib/behavior-learning/signal-mapping.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE BUYER GRAPH LOOP — map a buyer's PORTAL action (what they actually save/favorite/dismiss)
// to the preference-learning signal that adjusts their criteria. The learning engine already
// existed (updatePreferencesFromSignal) but the buyer's OWN portal saves never fed it — so the
// strongest signal (their real behavior) was ignored. This PURE mapper closes that loop: favoring
// a home teaches the system what they want; dismissing one teaches what they don't.

/** The learning engine's signal vocabulary (SIGNAL_WEIGHTS in preference-updater). */
export type LearningSignal = "saved" | "love_it" | "dismissed" | "viewed" | "like_it" | "maybe" | "not_for_us"

/**
 * interestLevelToLearningSignal — PURE. Map a saved_properties.interest_level (the buyer's portal
 * action) to the learning signal that should adjust their criteria. Returns null for actions that
 * carry no preference meaning (a tour/offer REQUEST is about logistics, not taste — don't skew the
 * profile on it). saved → saved(+5), favorited/love_it → love_it(+10, strongest "want"),
 * dismissed → dismissed(-3), not_interested → not_for_us(-5, strongest "don't want").
 */
export function interestLevelToLearningSignal(interestLevel: string | null | undefined): LearningSignal | null {
  switch (interestLevel) {
    case "saved":          return "saved"
    case "favorited":
    case "love_it":        return "love_it"
    case "like_it":        return "like_it"
    case "maybe":          return "maybe"
    case "dismissed":      return "dismissed"
    case "not_interested":
    case "not_for_us":     return "not_for_us"
    // tour_requested / offer_requested — logistics, not taste; viewed — too weak to act on here.
    default:               return null
  }
}

/**
 * showingInterestToLearningSignal — PURE. After a buyer TOURS a home and rates it, that verdict is
 * the STRONGEST taste signal we ever get (they stood in it). Map the showing-feedback vocabulary
 * (very_interested/interested/neutral/not_interested) to the learning signal that re-tunes their
 * criteria. "neutral" is a weak positive (they didn't reject it) → maybe; a tour they didn't rate
 * carries no taste → null. This closes the post-tour half of the buyer-graph loop.
 */
export function showingInterestToLearningSignal(interestLevel: string | null | undefined): LearningSignal | null {
  switch (interestLevel) {
    case "very_interested": return "love_it"
    case "interested":      return "like_it"
    case "neutral":         return "maybe"
    case "not_interested":  return "not_for_us"
    default:                return null
  }
}

/**
 * portalInterestToShowingLevel — PURE. The portal's tour-feedback UI speaks human
 * (very_interested/interested/neutral/not_interested), but showings.buyer_interest_level has a CHECK
 * that only accepts the canonical love_it/like_it/maybe/no. Map portal → canonical BEFORE writing so
 * the feedback actually persists (it had been silently rejected). Returns null for unknown values.
 */
export function portalInterestToShowingLevel(
  interestLevel: string | null | undefined,
): "love_it" | "like_it" | "maybe" | "no" | null {
  switch (interestLevel) {
    case "very_interested": return "love_it"
    case "interested":      return "like_it"
    case "neutral":         return "maybe"
    case "not_interested":  return "no"
    // already-canonical values pass through (defensive)
    case "love_it": case "like_it": case "maybe": case "no": return interestLevel
    default:                return null
  }
}

/**
 * tourInterestToRating — PURE. The canonical buyer verdict as the 1-5 number the
 * story-draft brief speaks.
 *
 * WHY THIS EXISTS (orphan doctrine §1.1 — a DUPLICATE existed, so merge onto the
 * survivor). tour_stops carries TWO spellings of one idea: `rating` (integer) +
 * `feedback` (text), and `buyer_interest_level` (text) + `buyer_note` (text). Only
 * the SECOND pair has writers — app/actions/tour-planner.ts:896 (rateTourStop) and
 * :966 (completeTour) — verified live: no DB trigger, no routine and no column
 * DEFAULT touches `rating`/`feedback` on that table (pg_trigger and pg_proc both
 * empty for tour_stops, project hrvaqgvukzxfskkcrwbt). So the recap reader at
 * lib/kernel/client-story-drafts.ts:335 was reading the dead half and got NULL for
 * every stop, forever — tourRecapBrief's "never narrate a day the OS didn't see"
 * guard then returned null and NO tour recap has ever been proposed.
 *
 * ONE VOCABULARY (CLAUDE.md §6): the ladder is the LIVE CHECK on
 * tour_stops.buyer_interest_level — love_it / like_it / maybe / no — the same four
 * values portalInterestToShowingLevel above already normalises onto, which is why
 * this mapper belongs in this module rather than as a private map at the read site.
 * 'not_for_us' is accepted as the learning-signal spelling of 'no'
 * (app/actions/tour-planner.ts canonicalises 'no' → 'not_for_us' for
 * buyer_behavior_log), so a caller holding either spelling lands on the same rung.
 *
 * An unrated stop returns null and NOT a number: a stop nobody reacted to is not a
 * 1/5, and scoring it as the bottom rung would launder "we never asked" into "they
 * disliked it" — the same trap lib/lead-governance/seller-signal-strength.ts's
 * rank(-1) exists to avoid.
 */
export function tourInterestToRating(interestLevel: string | null | undefined): number | null {
  switch (interestLevel) {
    case "love_it":     return 5
    case "like_it":     return 4
    case "maybe":       return 3
    case "no":
    case "not_for_us":  return 1
    default:            return null
  }
}

// ─── The two SETS every aggregate scorer actually wants ──────────────────────
/**
 * isPositiveShowingInterest / isNegativeShowingInterest — PURE. "Did this buyer
 * WANT it?" and "did this buyer PASS?", answered on the one canonical ladder.
 *
 * WHY THESE EXIST (CLAUDE.md §6 — and the count that moved). Every aggregate
 * reader of a per-showing verdict wants the same two sets, and every one of them
 * spelled the sets itself, in a vocabulary the column has never held:
 *
 *   lib/listing-health/health-scorer.ts:182  `=== "interested" || === "very_interested"`
 *   lib/listing-health/health-scorer.ts:183  `=== "not_interested"`
 *   lib/agents/seller-update-reel-producer.ts:51  the same first pair, byte for byte
 *
 * `showings.buyer_interest_level` and `tour_stops.buyer_interest_level` both carry
 * the live CHECK love_it | like_it | maybe | no (project hrvaqgvukzxfskkcrwbt), so
 * NONE of interested / very_interested / not_interested is a member of either. The
 * three literals are the vocabulary of a DIFFERENT column entirely —
 * property_alert_results.buyer_reaction admits interested | very_interested |
 * not_interested | scheduled_showing — which is how the wrong spelling travelled.
 *
 * Nothing threw. supabase-js returns the rows, JavaScript compares strings that
 * never match, and both readers reported a structural zero that reads as data:
 * the listing-health FEEDBACK category scored 0/100 for EVERY listing that had
 * feedback (against a neutral 80 for a listing with none — collecting buyer
 * feedback made the health score 12 points WORSE), and the weekly seller video
 * told every seller their listing drew "light" interest no matter what buyers said.
 *
 * The ladder is the single owner: positive = the two rungs above "maybe"
 * (love_it 5, like_it 4), negative = the bottom rung (no / not_for_us 1). `maybe`
 * (3) is deliberately NEITHER — a lukewarm buyer is not an interested one and not
 * a rejection, and counting it either way would launder a shrug into a verdict.
 * An unrated showing returns null from the ladder and is in neither set, for the
 * same reason "we never asked" is not "they disliked it".
 *
 * Derived, not pinned (§2): the thresholds read the ladder rather than restating
 * its four values, so widening the CHECK fails the vocabulary proof in
 * test:showing-feedback-learning instead of silently leaving a rung unmapped.
 */
export function isPositiveShowingInterest(interestLevel: string | null | undefined): boolean {
  const rating = tourInterestToRating(interestLevel)
  return rating !== null && rating >= 4
}

/** The buyer PASSED. See isPositiveShowingInterest — same ladder, bottom rung. */
export function isNegativeShowingInterest(interestLevel: string | null | undefined): boolean {
  const rating = tourInterestToRating(interestLevel)
  return rating !== null && rating <= 2
}

// ─── The buyer_behavior_log.signal_type FAMILIES ─────────────────────────────
/**
 * VIEW_SIGNALS / SAVE_SIGNALS / DISMISS_SIGNALS — the canonical families of
 * buyer_behavior_log.signal_type, LIFTED here (§6, 2026-09-01) from their
 * original private spelling inside lib/showings/showing-brief.ts so every
 * reader filters on the same sets instead of re-spelling them.
 *
 * WHY TWO SPELLINGS PER FAMILY: the live CHECK on buyer_behavior_log.signal_type
 * (scripts/check-vocabularies.ts) admits NO "view"/"save"/"favorite" — the
 * writers use two spelling families: the learner vocabulary (viewed / saved /
 * love_it — lib/behavior-learning/preference-updater.ts SIGNAL_WEIGHTS) and
 * the portal/CRM telemetry spellings (property_viewed / property_saved /
 * property_dismissed — app/crm/contacts/[contactId]/search/search-client.tsx).
 * A reader that filters on only one family silently halves its data; a reader
 * that invents "view" matches zero rows structurally. Count both, from here.
 *
 * Readers: lib/showings/showing-brief.ts (per-showing signal one-liners) and
 * app/actions/email-campaigns.ts getListingCampaignRecipients (open_house /
 * price_drop audiences). This module owns the vocabulary; readers import.
 */
export const VIEW_SIGNALS    = new Set(["viewed", "property_viewed"])
export const SAVE_SIGNALS    = new Set(["saved", "property_saved", "love_it"])
export const DISMISS_SIGNALS = new Set(["dismissed", "property_dismissed", "not_for_us"])

/**
 * feedbackTemperatureToRating — PURE. The SHOWING-AGENT feedback form's buyer
 * TEMPERATURE as the same 1-5 number, so an aggregate reader of that form uses one
 * threshold instead of inventing its own.
 *
 * ── §1 ADJUDICATION, recorded so the next audit does not re-flag it ──────────
 *
 * `showing_feedback.buyer_interest_level` carries a THIRD live CHECK for a column
 * of the same name — hot | warm | cool | cold — and the obvious reading is that it
 * is a duplicate of showings/tour_stops' love_it | like_it | maybe | no. It is NOT.
 * They are two different axes, and the evidence is on the form itself:
 *
 *   · WHO writes it. showings/tour_stops.buyer_interest_level is written by the
 *     BUYER'S OWN side — app/actions/tour-planner.ts rateTourStop + completeTour
 *     (the agent recording the buyer's verdict on a stop) and
 *     app/actions/smart-insights.ts updateShowingFeedback (the buyer's own portal
 *     submission, normalised through portalInterestToShowingLevel above).
 *     showing_feedback is written by ONE caller, app/api/showings/feedback/[token]/
 *     route.ts — a tokenized form the LISTING agent sends to a THIRD-PARTY showing
 *     agent, whose row is stamped submitted_by_agent_name / submitted_by_agent_email.
 *   · WHAT ELSE the row holds. That same form already has a property-verdict column
 *     beside this one — `overall_impression` (spoke loved_it | liked_it | neutral |
 *     not_interested at adjudication time; m568 moved it onto the canonical
 *     love_it | like_it | maybe | no) — plus `offer_interest` (very_likely |
 *     possible | unlikely | no). A form does not ask the same question three times. The verdict on the
 *     HOUSE is overall_impression; the likelihood of an OFFER is offer_interest;
 *     buyer_interest_level is how hot the BUYER is, which is why it is spelled in
 *     the temperature vocabulary this product uses everywhere else for exactly that
 *     (contacts.lead_temperature, leads.lead_temperature, unified_lead_profile.
 *     temperature, open_house_attendees.interest_level hot|warm|cold|no_interest).
 *   · ROW COUNTS decide nothing here: showings, tour_stops and showing_feedback are
 *     all EMPTY on the live project (0 / 0 / 0, verified 2026-08-26), so there is no
 *     usage evidence either way and no backfill risk in either direction. Saying so
 *     is the measurement; inferring a survivor from three zeroes would not be.
 *
 * VERDICT: not a duplicate, no merge, no migration — a per-showing PROPERTY VERDICT
 * and a per-buyer TEMPERATURE are different facts that happen to share a column
 * name. What §6 does bite is the NAME COLLISION, which is precisely what let
 * app/actions/seller-showing-sentiment.ts compare this text column against the
 * NUMBERS 4 and 2 (`(f.buyer_interest_level ?? 0) >= 4`) — NaN on every row, so
 * highInterestCount and lowInterestCount were both structurally 0, "urgency" was
 * permanently "now" (0 >= 0) and the pricing-pressure "raise" arm was unreachable.
 * This mapper gives that reader the ladder the column can actually produce, on the
 * author's own 4/2 thresholds.
 *
 * THAT LOOP IS NOW CLOSED (m568): `showing_feedback.overall_impression` was a
 * second SPELLING of the same property-verdict idea as
 * showings.buyer_interest_level, and m568 moved its CHECK onto the one
 * vocabulary (love_it | like_it | maybe | no). Both COLUMNS remain — the buyer's
 * own tap and the third-party showing agent's form are two speakers who can
 * disagree on one showing — but they now speak the same four rungs, and
 * tourInterestToRating reads both. The old dialect's bridge (impressionToRating)
 * is retired; see its tombstone at the bottom of this file.
 */
export function feedbackTemperatureToRating(temperature: string | null | undefined): number | null {
  switch (temperature) {
    case "hot":   return 5
    case "warm":  return 4
    case "cool":  return 2
    case "cold":  return 1
    default:      return null
  }
}

// TOMBSTONE (§1, m568 wave): `impressionToRating` lived here — the bridge that
// spelled the showing-agent form's PRIVATE dialect (loved_it | liked_it | neutral
// | not_interested) onto the 1-5 ladder while showing_feedback.overall_impression
// still spoke it. m568 retired that dialect: the column's CHECK now admits the
// ONE showing-verdict vocabulary (love_it | like_it | maybe | no), the same four
// rungs showings.buyer_interest_level and tour_stops.buyer_interest_level carry,
// so a bridge from a vocabulary the column can no longer hold had exactly zero
// possible inputs. Survivor: tourInterestToRating in THIS FILE (the canonical
// ladder, defined above), which its one caller
// app/actions/seller-showing-sentiment.ts:174 now reads directly. Nothing was
// merged onto the survivor because the survivor already spoke every post-m568
// rung; the mapping the bridge encoded (loved_it→5 … not_interested→1) survives
// as m568's data-migration CASE, where it belongs — at the boundary between the
// old rows and the new vocabulary, not in live code.
