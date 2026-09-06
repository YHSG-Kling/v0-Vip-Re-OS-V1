/**
 * lib/lead-governance/protected-class-signals.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROTECTED-CLASS CLASSIFIER — and the ONE place that still refuses.
 *
 * ── THE OWNER RULING THAT RESHAPED THIS FILE (wave 15) ───────────────────────
 * Verbatim: "the content should get the compliance but any lead scrapping,
 * enrichment or signals or property searching from the buyer should not be put
 * through the compliance or fair housing." And, expanding it: "do not run the
 * compliance or fair housing on scrapping, enrichment, scoring, sourcing
 * because we determine the kind of education in channels by the age group and
 * other ways to use it without violating the rules."
 *
 * That is a decision, not a proposal. HOLDING and USING demographic data about
 * people we already have is not the violation. TARGETING HOUSING ADVERTISING by
 * a protected class is. This module used to conflate the two: it refused the
 * data at the moment it arrived, which cost us the age band the owner wants for
 * choosing an education CHANNEL (lib/agents/education-delivery-producer.ts) and
 * bought no protection at the point where a violation can actually occur.
 *
 * So the file is now a CLASSIFIER with one enforcement arm, not three:
 *
 *   1. CLASSIFY (pure, and now load-bearing) — `tokenizeFieldPath`,
 *      `protectedClassReasonFor`, `isProtectedClassSource`. Unchanged, correct,
 *      and used MORE than before: they are what lets a stored provider row say
 *      WHICH of its fields are protected-class, which is what the ad-audience
 *      gate and the education selector both read.
 *
 *   2. LABEL, DO NOT STRIP — `defineSellerSignalSources` no longer throws on a
 *      protected-class source and `labelProtectedClassFields` no longer removes
 *      demographics from a provider row. Both now ANNOTATE. The functionality
 *      did not vanish (CLAUDE.md §1); it moved to arm 3 and to the callers that
 *      read the annotation.
 *
 *   3. REFUSE, at the act that is actually restricted — OUTBOUND AD AUDIENCE
 *      TARGETING, and since 2026-08-22 that is the ONLY act that refuses:
 *        · `assertAudienceSegmentationAllowed` / `protectedClassSegmentationIn`
 *          — an ad audience (Meta/Google custom audience) may not be defined by
 *          a protected-class rule. Enforced on BOTH halves (finding #298 closed
 *          the define side, which used to let the offending rule persist and be
 *          discovered only when the audience came back empty):
 *            DEFINE  — lib/kernel/ads.ts `createAudienceSegment`, before the
 *                      INSERT, and app/actions/campaign-presets.ts, the other
 *                      writer of `facebook_custom_audiences.source_rule`;
 *            POPULATE — lib/kernel/ads.ts `syncAudience`, before it reads a
 *                      contact or calls a connector, and the four staging sites
 *                      in lib/audiences/audience-sync.ts.
 *          Every one of those callers is an AD-TARGETING path. No scraping,
 *          enrichment, signal, scoring, sourcing or buyer-property-search caller
 *          reaches this arm — they call the LABELLING arms above, which is the
 *          whole point of splitting the file this way.
 *        · `screenProtectedClassCriteria(criteria, "ad_audience")` — the same
 *          refusal for a criteria PAYLOAD rather than a segmentation rule.
 *
 * ── THE PERSONA RULING (2026-08-23) — WHAT THE ADS ARM NOW REFUSES ──────────
 * Owner ruling, verbatim: "military, senior, divorced and probate need to be
 * allowed as situation persona because that is how we show them info or ads that
 * is worded to their situation as part of them-first methology." And, defining
 * the term: "persona is more the situation that the contact or lead is in."
 *
 * The ads arm below used to refuse a persona VALUE like `senior` wherever it
 * appeared in an audience rule, because arm 1 classifies the word and arm 3
 * scans values as well as keys. That is now split by OPERATION rather than by
 * word:
 *   · INCLUDING people and choosing the wording they are reached with — allowed,
 *     for a CANONICAL persona at the `personas` filter key. That is the carve-out
 *     at `isCanonicalPersonaBasisValue`, and it is the only one in this file.
 *   · EXCLUDING or suppressing an audience on a protected characteristic —
 *     REFUSED, unchanged. `exclusion_*` source-rule types turn the carve-out off.
 *
 * WHAT DID NOT MOVE, AND IS THE THING TO CHECK FIRST IF YOU ARE EDITING HERE:
 * the RAW PROVIDER ATTRIBUTE path. `min_owner_age`, `demographics.recentlyDivorced`,
 * `quicklists: ["senior-owner","inherited"]` and `contact_tags: ["seniors-55plus"]`
 * are refused/stripped on the ads lane exactly as before — by this same arm and by
 * `screenProtectedClassCriteria(criteria, "ad_audience")`, which has no carve-out
 * at all. The owner permitted a persona (a situation label on a contact we know),
 * not demographic targeting criteria sent to an ad platform.
 *
 * ── FINDING #297 — THE LAST DATA-LANE REFUSAL WAS RELEASED (2026-08-22) ──────
 * Owner ruling, verbatim: "297 just release it from fairhousing." And, in the
 * same wave: "all motivatied seller classifiers are necessary for data
 * especially demographics and protected class" and "304 needs inherited and
 * probate".
 *
 * `stripProtectedClassCriteria` was the one remaining fair-housing REFUSAL on
 * the data lane. An earlier lane kept it deliberately, on the reading that
 * asking a data broker for "owners aged 65+" is procurement of a segmented
 * population rather than enrichment. The owner has now ruled the other way for
 * the SOURCING lane specifically, and the reason is the one the standing scope
 * ruling already gave: the protected-class attribute is what lets us pick the
 * EDUCATION and the CHANNEL, and a sourcing query that cannot name it produces
 * a dataset that cannot answer the question the owner is asking of it.
 *
 * SO THE CAPABILITY WAS LANE-PARAMETERISED RATHER THAN DELETED (CLAUDE.md §1 —
 * the refusal moved lanes, it did not vanish). `screenProtectedClassCriteria`
 * takes an EXPLICIT `ProtectedClassLane`:
 *   · "data_sourcing" — scraping, enrichment, signals, scoring, sourcing, buyer
 *     property search. NOTHING IS REMOVED. Every protected-class criterion is
 *     returned intact and LABELLED with the classifier's reason sentence, so the
 *     caller can write down what it asked for and on what grounds.
 *   · "ad_audience"   — outbound ad audience targeting. The old strip, verbatim,
 *     plus the same labels.
 * The lane is REQUIRED and an unrecognised one THROWS (CLAUDE.md §4 — a gate
 * that cannot tell which lane it is on must refuse, never pass). There is no
 * default: a default is how the ads lane silently inherits the data lane's
 * exemption, which is the one regression this split exists to make impossible.
 *
 * ── WHY THE DATA IS WORTH HOLDING ───────────────────────────────────────────
 * Our property-data provider (BatchData) sells, in the SAME response row as the
 * motivation data, an entire `demographics` dataset: age, gender, hasChildren,
 * childCount, singleParent, maritalStatus, recentlyDivorced, religious,
 * religiousAffiliation, income, netWorth, householdSize, individualEducation.
 * Those field paths were read live from the provider's own dataset catalogue on
 * 2026-08-20 (`list_property_dataset_fields demographic`, 32 fields) — this is
 * not a hypothetical surface. Under the ruling those values may now be stored
 * and read; what they may not do is choose who sees a housing ad.
 *
 * ── THE OWNER'S TWO ADDITIONS ────────────────────────────────────────────────
 * Beyond the statutory list, two provider signals are classified protected by
 * owner ruling rather than by statute, and they are classified here on the same
 * footing:
 *   · `inherited` / probate — the provider's own quickList slug. It is a
 *     familial-status proxy in substance: the fact it encodes is a death in a
 *     family.
 *   · divorce — `demographics.recentlyDivorced`. Marital status, protected by
 *     statute in many states and by the same owner instruction here.
 *
 * THOSE TWO TOKENS STAY IN THE VOCABULARY AND THIS IS THE WHOLE POINT OF
 * FINDING #297'S SHAPE. The owner ruled ("304 needs inherited and probate")
 * that the seller-signal lane must SOURCE them. Deleting "inherited",
 * "probate", "heir", "deceased" and "senior" from PROTECTED_CLASS_TOKENS would
 * have delivered that — and would simultaneously have opened an ad audience
 * named "probate-heirs-55plus", because `protectedClassSegmentationIn` reads
 * this same vocabulary. The tokens are what let the ads gate keep refusing.
 * So the tokens are UNTOUCHED and the LANE decides what the classification
 * licenses: sourced-and-labelled on the data lane, refused on the ads lane.
 *
 * ── WHAT THE CLASSIFICATION MEANS NOW ────────────────────────────────────────
 * `isProtectedClassSource(x) === true` no longer means "refuse this". It means
 * "this is a fact about a PERSON, not about a PARCEL — it may be held, scored
 * and used to choose an education channel, and it may NOT choose an ad
 * audience." Everything the old allow-list called safe — sale propensity, tax
 * delinquency, involuntary liens, foreclosure filings, vacancy, absentee
 * ownership, tired-landlord composites, expired listings, equity, ownership
 * tenure — is still classified `false`, because those are recorded facts about
 * a property.
 *
 * ── HOW THE MATCHER WORKS, AND THE TRAP IT AVOIDS ────────────────────────────
 * Matching is on WHOLE WORDS after splitting a field path on dots, underscores,
 * hyphens and camelCase humps — NOT on substrings. Substring matching is the
 * obvious implementation and it is wrong in both directions here:
 *   · `"age"` as a substring is inside `mortgageHistory`, `averageAssessedValue`
 *     and `garageParkingSpaceCount`, so a substring gate would refuse three
 *     entirely innocent property fields and the next author would weaken the
 *     gate to get their work done.
 *   · A field named `senior_owner` is caught by the token `senior` regardless of
 *     the separator style the caller used, which a naive exact-name list is not.
 * The protected set is therefore a TOKEN vocabulary plus a namespace prefix
 * (`demographics.*` in full), and the positive control in
 * scripts/batchdata-seller-signal-simulator.ts proves both directions still
 * hold: a protected name is still classified protected, and an allowed one is
 * still classified allowed. scripts/compliance-scope-simulator.ts pins the
 * other half — that no content-compliance entry point is reachable from the
 * data lane, and that it is still reachable from every content lane.
 */

import { isCampaignPersona } from "@/lib/campaigns/contact-sources"
import { audienceUseOf } from "@/lib/ads/audience-source-rules"

/**
 * The provider dataset namespaces classified protected WHOLE. The
 * classification is the NAMESPACE, so a field added to it by the vendor
 * tomorrow is classified the day it appears rather than the day somebody
 * notices it.
 */
export const PROTECTED_CLASS_NAMESPACES: readonly string[] = ["demographics", "demographic"]

/**
 * THE TWO LANES, AND THE ONLY TWO. Added 2026-08-22 for finding #297.
 *
 * A protected-class classification does not mean one thing — it means one thing
 * per LANE, and before this type existed the code could only express one of the
 * two. Every caller of `screenProtectedClassCriteria` must name which act it is
 * performing:
 *
 *   · "data_sourcing"  — scraping, enrichment, SIGNALS, SCORING, SOURCING,
 *     buyer property search. The owner's standing scope ruling exempts these:
 *     "do not run the compliance or fair housing on scrapping, enrichment,
 *     scoring, sourcing because we determine the kind of education in channels
 *     by the age group and other ways to use it without violating the rules."
 *     Nothing is removed. Everything protected is LABELLED.
 *
 *   · "ad_audience"    — choosing who an outbound housing ad is SHOWN TO. This
 *     is the restricted act (Fair Housing Act, 42 U.S.C. § 3604(c); HUD's
 *     2019-2022 actions against Meta), and it is not exempted by anything. The
 *     protected criteria are STRIPPED and named.
 *
 * A lane outside this list throws. There is deliberately no default and no
 * fallback: the failure mode this type exists to prevent is the ads lane
 * quietly inheriting the data lane's exemption because somebody omitted an
 * argument (CLAUDE.md §4 — fail closed).
 */
export const PROTECTED_CLASS_LANES = ["data_sourcing", "ad_audience"] as const
export type ProtectedClassLane = (typeof PROTECTED_CLASS_LANES)[number]
const LANES = new Set<string>(PROTECTED_CLASS_LANES)

/**
 * ONE protected-class classification, with the classifier's REASON SENTENCE
 * attached — the shape a caller that LABELS writes down.
 *
 * `source` is whatever was classified: a provider field path
 * (`demographics.age`), a filter name (`min_owner_age`), or a criterion
 * rendered with its offending value (`quicklist=inherited`, `orQuickLists[senior-owner]`).
 * `reason` is `protectedClassReasonFor`'s sentence verbatim, never a rewording:
 * a stored row and an operator error message must be able to say the same thing.
 */
export interface ProtectedClassBasis {
  source: string
  reason: string
}

/**
 * Protected-class WORD tokens. A field path is split into words and classified
 * protected if it contains any of these. Each line names the protected class it
 * stands for so a future reader can tell a statutory classification from a
 * stylistic one.
 */
export const PROTECTED_CLASS_TOKENS: readonly string[] = [
  // Age — FHA-adjacent, state-protected, and the provider's `senior-owner`
  // quickList / min_owner_age / max_owner_age filters.
  "age", "ages", "senior", "seniors", "elderly", "birth", "birthdate", "dob",
  // Familial status — 42 U.S.C. § 3604 protects households with children.
  // NOTE the absence of a bare "family": the provider's `property_type_category`
  // takes the literal value "Single Family Residential", and banning that token
  // would refuse the most common residential property type in the country while
  // adding nothing — familial status is already fully covered by the terms
  // below, every one of which names a person rather than a building.
  "child", "children", "childcount", "kids", "minor", "minors", "parent",
  "familial", "pregnancy", "pregnant", "household", "households",
  // Marital status + the owner's divorce ruling.
  "marital", "married", "spouse", "divorce", "divorced", "widow", "widowed",
  // Probate / inheritance — the owner's standing instruction, and a death in a
  // family is familial status in substance.
  "inherited", "inheritance", "probate", "heir", "heirs", "deceased", "decedent",
  // Race, color, national origin, ancestry.
  "race", "racial", "ethnicity", "ethnic", "nationality", "ancestry", "origin",
  // Religion.
  "religion", "religions", "religious", "faith", "denomination",
  // Sex, gender, sexual orientation.
  "sex", "gender", "orientation",
  // Disability / handicap.
  "disability", "disabled", "handicap", "handicapped", "impairment",
  // Source-of-income and wealth proxies — the provider's household income and
  // net-worth filters, plus the education/occupation fields sold beside them.
  "income", "worth", "networth", "millionaire", "education", "occupation",
  // Veteran / military status (state-protected in several of our markets).
  "veteran", "veterans", "military",
  // `investor` is DELIBERATELY ABSENT (recorded 2026-08-31, when the owner made
  // it the fourteenth canonical persona — "investor is a persona and not a
  // contact type"). Investing is NOT a protected class: it is a transaction
  // posture — a fact about what someone is doing in the market, like `fsbo` or
  // `expired`, not a characteristic of the person under the Fair Housing Act or
  // any state statute this vocabulary tracks. `protectedClassReasonFor("investor")`
  // therefore returns null, which places the persona correctly downstream: it is
  // an eligible ad-audience INCLUSION basis like the other situation personas,
  // AND — unlike senior/probate/divorce/military — an eligible EXCLUSION basis,
  // because suppressing investors from a housing ad withholds nothing from a
  // protected group.
]

/**
 * PURE. Split a provider field path, filter name or quickList slug into
 * comparable lowercase words.
 *
 * `demographics.hasChildren` → ["demographics","has","children"]
 * `min_owner_age`            → ["min","owner","age"]
 * `senior-owner`             → ["senior","owner"]
 * `mortgageHistory.loanAmount` → ["mortgage","history","loan","amount"]
 *
 * The last example is the whole reason this is tokenized rather than
 * substring-matched: "mortgage" contains "age".
 */
export function tokenizeFieldPath(path: string): string[] {
  return String(path ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
}

const BANNED = new Set(PROTECTED_CLASS_TOKENS)
const BANNED_NAMESPACES = new Set(PROTECTED_CLASS_NAMESPACES)

/**
 * PURE. The reason this source is CLASSIFIED protected-class, or null when it
 * is a property-and-transaction fact.
 *
 * Returns a SENTENCE, not a boolean, because a caller that refuses (the ad
 * audience gate) has to say why in an error an operator will read, and because
 * a caller that merely LABELS (a stored provider row, an education selector)
 * has to be able to write down what it labelled and on what grounds. A boolean
 * with no reason is the shape of a classification people quietly invert.
 */
export function protectedClassReasonFor(source: string): string | null {
  const tokens = tokenizeFieldPath(source)
  if (tokens.length === 0) return null
  if (BANNED_NAMESPACES.has(tokens[0])) {
    return `"${source}" is in the provider's ${tokens[0]} dataset, which is protected whole: it carries age, gender, familial status, marital status, religion, income and household composition.`
  }
  const hit = tokens.find((t) => BANNED.has(t))
  if (hit) {
    // "may not be used to WITHHOLD" rather than the older "may never segment".
    // The old wording became overbroad on 2026-08-23: the owner ruled that a
    // canonical situation persona MAY choose who an ad reaches and how it is
    // worded, so a sentence saying the characteristic can never touch an audience
    // was no longer true of every caller quoting it — and this sentence is quoted
    // verbatim into stored rows (`signal_details.protected_class_basis`) and into
    // operator errors, where an overbroad claim reads as a bug in the gate.
    return `"${source}" contains the protected-class term "${hit}". It is a characteristic of a PERSON, not of a parcel: it may be held, scored and used to choose an education channel, and it may not be used to WITHHOLD housing advertising from anyone (Fair Housing Act, 42 U.S.C. § 3604).`
  }
  return null
}

/** PURE. True when this provider field/filter/quickList/criterion names a
 *  protected class or a direct proxy for one. NOT a refusal — see the file
 *  header for what the classification licenses and what it forbids. */
export function isProtectedClassSource(source: string): boolean {
  return protectedClassReasonFor(source) !== null
}

/**
 * Throws when `source` is a protected-class proxy. FAIL CLOSED.
 *
 * TOMBSTONE (owner ruling, wave 15). This used to be the DECLARATION gate for
 * seller signals, called from `defineSellerSignalSources` at module load, and
 * it took the whole sourcing module down when a signal type named a protected
 * field. The ruling took that off the data lane — a signal type may now be
 * sourced from a demographic — so `defineSellerSignalSources` LABELS instead
 * (see its `protectedClassSources` output at
 * lib/lead-governance/protected-class-signals.ts:274).
 *
 * WHO CALLS IT TODAY: no production caller, and re-adding the one the tombstone
 * above describes would BREAK THE LANE, not harden it. `defineSellerSignalSources`
 * is handed BATCHDATA_SELLER_SIGNAL_SOURCES at module load
 * (lib/external/batchdata-seller-signals.ts:303-304), and four of those specs
 * declare protected sources on purpose under owner ruling #304 —
 * `quickLists.inherited`, `demographics.*`, `min_owner_age`. Running this
 * assertion over them throws at IMPORT time and takes the whole seller-signal
 * lane down, which is exactly the state the wave-15 ruling reversed. Verified in
 * tree 2026-09-03, lane L2.
 *
 * IT IS NOT THE SAME FUNCTION AS `assertAudienceSegmentationAllowed` (this file,
 * below) AND DOES NOT CALL IT OR VICE VERSA — an earlier version of this comment
 * said it was "the mechanism behind" it, which read as a call graph that has
 * never existed. What they SHARE is `protectedClassReasonFor`, the one
 * classifier. The refusal that survived governs SEGMENTING an audience; this one
 * governs DECLARING a source, and its live exercise is
 * scripts/batchdata-seller-signal-simulator.ts:171-174, which proves the
 * classifier's teeth are real rather than merely declared.
 */
export function assertSellerSignalSourceAllowed(source: string, declaredBy: string): void {
  const reason = protectedClassReasonFor(source)
  if (reason) {
    throw new Error(
      `[protected-class-signals] REFUSED: signal type "${declaredBy}" may not be sourced from ${reason}`,
    )
  }
}

/** One seller-signal type and the exact provider fields it is derived from. */
export interface SellerSignalSourceSpec {
  /** The `motivated_seller_signals.signal_type` value written. */
  signalType: string
  /** Human label for operator output. */
  label: string
  /** EXACT provider field paths / quickList slugs this signal reads. Classified. */
  sources: readonly string[]
  /** Why this fact is a legitimate motivation signal about a PROPERTY. */
  why: string
  /**
   * COMPUTED by `defineSellerSignalSources`, never hand-written. The subset of
   * `sources` that name a protected class. `[]` is the normal state and means
   * "this signal is derived purely from parcel facts"; a non-empty list is the
   * label that travels with the signal so a downstream consumer knows the
   * signal carries a fact about a PERSON and must not be used to segment an
   * ad audience.
   */
  protectedClassSources?: readonly string[]
}

/**
 * THE DECLARATION ARM — a LABELLER, not a gate.
 *
 * TOMBSTONE (owner ruling, wave 15). This function used to run
 * `assertSellerSignalSourceAllowed` over every source and THROW at module load,
 * so a signal type sourced from `demographics.age` made
 * lib/external/batchdata-seller-signals.ts fail to import. The ruling —
 * "do not run the compliance or fair housing on scrapping, enrichment,
 * scoring, sourcing" — removed that refusal from the data lane.
 *
 * WHERE THE REFUSAL WENT, at file:line:
 *   · lib/lead-governance/protected-class-signals.ts:518 →
 *     `assertAudienceSegmentationAllowed` — protected class may not DEFINE AN
 *     AD AUDIENCE.
 *   · lib/audiences/audience-sync.ts → `onLeadConvertedForAudience` /
 *     `onContactBecameLifetimeForAudience` call that assertion before any
 *     person is staged into a Meta/Google custom audience.
 *
 * WHAT REPLACED IT HERE: every spec now carries `protectedClassSources`, the
 * classified subset of its own `sources`. A protected source is therefore
 * VISIBLE at the declaration instead of impossible at the declaration — the
 * capability moved, it was not deleted (CLAUDE.md §1).
 *
 * THE TWO INTEGRITY CHECKS STAY AND STILL THROW. Neither is fair-housing:
 *   · duplicate `signalType` — two specs writing one `signal_type` is how a
 *     repeating probe starts duplicating rows;
 *   · empty `sources` — a signal that names no source cannot be classified,
 *     traced, or explained to an operator.
 */
/**
 * A spec AFTER the labeller has run: `protectedClassSources` is no longer
 * optional, because `defineSellerSignalSources` always computes it.
 *
 * WHY THIS TYPE EXISTS. The function used to be declared `(specs: T): T` with an
 * `as unknown as T` on the way out — it claimed to hand back exactly what it was
 * given while in fact adding a field to every element. For an INLINE literal (how
 * every real caller writes a spec table) `T` infers without the optional field,
 * so the label the function had just computed was invisible to the caller and
 * reading it was a type error. The cast is what hid that: it asserted the lie
 * rather than expressing the truth. A labeller whose return type omits the label
 * is a write with no readable half — the orphan class this wave is burning down.
 */
export type LabelledSellerSignalSpec<S extends SellerSignalSourceSpec> = S & {
  readonly protectedClassSources: readonly string[]
}

export function defineSellerSignalSources<T extends readonly SellerSignalSourceSpec[]>(
  specs: T,
): { readonly [K in keyof T]: LabelledSellerSignalSpec<T[K] & SellerSignalSourceSpec> } {
  const seen = new Set<string>()
  const labelled: SellerSignalSourceSpec[] = []
  for (const spec of specs) {
    if (seen.has(spec.signalType)) {
      throw new Error(`[protected-class-signals] duplicate signal type declared: "${spec.signalType}"`)
    }
    seen.add(spec.signalType)
    if (spec.sources.length === 0) {
      // A signal with no declared source cannot be classified, traced or
      // explained. This has nothing to do with fair housing and stays.
      throw new Error(`[protected-class-signals] signal type "${spec.signalType}" declares no source fields`)
    }
    labelled.push(Object.freeze({
      ...spec,
      protectedClassSources: Object.freeze(spec.sources.filter(isProtectedClassSource)),
    }))
  }
  // The cast is narrowed to what it actually is: we built a NEW array whose
  // element order and arity match `specs`, which the mapped return type states
  // but TypeScript cannot verify through a push loop. It no longer asserts away
  // the added field — that is now declared.
  return Object.freeze(labelled) as { readonly [K in keyof T]: LabelledSellerSignalSpec<T[K] & SellerSignalSourceSpec> }
}

/**
 * PURE. The protected-class sources a declared signal type carries, across a
 * whole spec table. `{}` when every signal is derived purely from parcel facts.
 *
 * This is the READER for the label `defineSellerSignalSources` now writes —
 * without it the label would be a write with no reader, which is the orphan
 * class this wave is burning down (CLAUDE.md §1).
 */
export function protectedClassSourcesBySignalType(
  specs: readonly SellerSignalSourceSpec[],
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {}
  for (const spec of specs) {
    const hits = spec.protectedClassSources ?? spec.sources.filter(isProtectedClassSource)
    if (hits.length > 0) out[spec.signalType] = hits
  }
  return out
}

/**
 * PURE. The same map as `protectedClassSourcesBySignalType`, but carrying the
 * classifier's REASON SENTENCE beside each source instead of the bare name.
 *
 * WHY BOTH EXIST, AND WHY THIS IS NOT A SECOND SPELLING OF ONE IDEA
 * (CLAUDE.md §6). They answer two different questions and have two different
 * readers. `protectedClassSourcesBySignalType` answers "which sources" and is
 * read by code that BRANCHES — the ad-audience gate, the education selector.
 * This one answers "which sources, and why are they protected" and is read by
 * code that PERSISTS: lib/external/batchdata-seller-signals.ts writes it into
 * `motivated_seller_signals.signal_details.protected_class_basis`, so an auditor
 * reading a stored row a year from now can tell that this signal was derived
 * from protected-class data and read the grounds without having the classifier
 * in front of them.
 *
 * The reason is `protectedClassReasonFor`'s sentence VERBATIM. A stored
 * paraphrase drifts from the live classifier and the drift is invisible.
 */
export function protectedClassBasisBySignalType(
  specs: readonly SellerSignalSourceSpec[],
): Record<string, readonly ProtectedClassBasis[]> {
  const out: Record<string, readonly ProtectedClassBasis[]> = {}
  for (const spec of specs) {
    const sources = spec.protectedClassSources ?? spec.sources.filter(isProtectedClassSource)
    const basis: ProtectedClassBasis[] = []
    for (const source of sources) {
      const reason = protectedClassReasonFor(source)
      // A source in the label list whose reason reads null is a CONTRADICTION,
      // not a row to file quietly: the two derive from the same classifier, so
      // it would mean the label and the reason disagree. It is dropped and the
      // count difference is visible to the caller, which is why the simulator
      // asserts basis-length against source-length rather than trusting it.
      if (reason) basis.push({ source, reason })
    }
    if (basis.length > 0) out[spec.signalType] = Object.freeze(basis)
  }
  return out
}

/**
 * Criteria keys whose VALUE is itself the filter — the provider's quickList
 * slugs. `senior-owner` and `inherited` ride in here, not in the key, so the
 * value has to be classified too.
 *
 * SCOPED, NOT UNIVERSAL, and the scope is load-bearing. Classifying every string
 * value would flag `property_type_category: "Single Family Residential"` —
 * a building type, not a household — and the author who hit that would weaken
 * the classifier rather than narrow it. Narrowing it here is that fix, made once.
 *
 * The five spellings are the ones the provider's own search API publishes,
 * verified live on 2026-08-22 against BatchData's property-search criteria
 * catalogue: `quicklist`, `quicklists`, `or_quicklists` — plus the camelCase
 * wire spellings this tree assembles (`orQuickLists`, `notQuickLists`,
 * `andQuickLists`). The key is normalised to letters-only before lookup, so
 * `or_quicklists`, `orQuickLists` and `ORQUICKLISTS` are one entry.
 */
const SLUG_VALUED_KEYS = new Set([
  "quicklist", "quicklists", "orquicklists", "notquicklists", "andquicklists",
])

/**
 * PURE. Classify the protected-class criteria in an outbound provider query and
 * act on them ACCORDING TO THE LANE.
 *
 * ── WHAT THIS REPLACED (2026-08-22, finding #297) ────────────────────────────
 * `stripProtectedClassCriteria` used to be the whole capability and it was
 * LANE-BLIND: it stripped for every caller. It survives immediately below, with
 * the lane bound to `"ad_audience"` — byte-for-byte the same strip, the same
 * `removed` names, the same SLUG_VALUED_KEYS scoping — so the ads lane's
 * behaviour is unchanged and there is one implementation, not two.
 *
 * Owner ruling, verbatim: "297 just release it from fairhousing." The old
 * function refused on EVERY lane, and its only live caller was
 * lib/external/batchdata-seller-signals.ts's provider lookup — a SOURCING call,
 * which the standing scope ruling exempts. Releasing it by deleting the refusal
 * outright would have released it for the ads lane too, where the same payload
 * shape ("give me owners aged 65+") is the restricted act. So the refusal did
 * not go away: it became conditional on a lane the caller must state.
 *
 * WHAT EACH LANE DOES
 *   · "data_sourcing" — `removed` is ALWAYS empty and `criteria` is returned
 *     with every key and every quickList slug intact, including the protected
 *     ones. `labelled` carries one `ProtectedClassBasis` per protected
 *     criterion, with the classifier's reason sentence, so the caller can record
 *     WHAT it asked for and ON WHAT GROUNDS.
 *   · "ad_audience"   — the protected criteria are REMOVED and named in
 *     `removed`, and also appear in `labelled`. A caller that refuses outright
 *     reads `removed`; a caller that records reads `labelled`.
 *
 * `labelled` is populated on BOTH lanes on purpose. A removal that is not also
 * a labelled fact is a narrowing nobody can audit afterwards, and this repo has
 * paid for silently-narrowed queries before: the caller reports it so "we did
 * not segment on that" is visible, not inferred from a smaller result count.
 *
 * WHAT THIS DOES AND DOES NOT REACH ON LIVE TRAFFIC.
 * KEYS are always token-scanned. VALUES are scanned only for SLUG_VALUED_KEYS.
 * The one live call site, lib/external/batchdata-seller-signals.ts's
 * `realBatchDataPropertyLookup`, passes only
 * `{ query: "<address>, <city>, <state>, <zip>" }`: the key passes and the value
 * is never examined, so that call classifies nothing and cannot. An empty
 * `labelled` from it means "nothing here was classifiable", NOT "nothing here
 * was protected". That is the single-address lookup shape the ruling exempts
 * either way. The population-selection payload somebody will eventually
 * assemble is what both lanes are really for, and both are exercised for real
 * by scripts/batchdata-seller-signal-simulator.ts.
 *
 * FAIL CLOSED ON THE LANE ITSELF. An unrecognised lane throws rather than
 * falling back to either behaviour. Falling back to "data_sourcing" would let a
 * typo open ad targeting; falling back to "ad_audience" would let a typo
 * silently narrow a sourcing query. Neither is a thing to guess at.
 */
export function screenProtectedClassCriteria(
  criteria: Record<string, unknown> | null | undefined,
  lane: ProtectedClassLane,
): {
  lane: ProtectedClassLane
  criteria: Record<string, unknown>
  removed: string[]
  labelled: ProtectedClassBasis[]
} {
  if (!LANES.has(lane as string)) {
    throw new Error(
      `[protected-class-signals] REFUSED: unknown protected-class lane "${String(lane)}". ` +
      `A caller that cannot say which act it is performing must not be screened at all ` +
      `(expected one of: ${PROTECTED_CLASS_LANES.join(", ")}).`,
    )
  }
  const strip = lane === "ad_audience"
  const kept: Record<string, unknown> = {}
  const removed: string[] = []
  const labelled: ProtectedClassBasis[] = []

  for (const [key, value] of Object.entries(criteria ?? {})) {
    const keyReason = protectedClassReasonFor(key)
    if (keyReason) {
      labelled.push({ source: key, reason: keyReason })
      if (strip) { removed.push(key); continue }
      kept[key] = value
      continue
    }
    const slugValued = SLUG_VALUED_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ""))
    if (Array.isArray(value)) {
      const keptItems: unknown[] = []
      for (const v of value) {
        const itemReason = slugValued && typeof v === "string" ? protectedClassReasonFor(v) : null
        if (itemReason) {
          labelled.push({ source: `${key}[${v}]`, reason: itemReason })
          if (strip) { removed.push(`${key}[${v}]`); continue }
        }
        keptItems.push(v)
      }
      // An array emptied by the strip drops its key entirely rather than being
      // sent as `[]`: the provider reads an empty quickList array as "match
      // nothing", which would turn a narrowed query into a silently dead one.
      if (keptItems.length > 0) kept[key] = keptItems
      continue
    }
    const valueReason = slugValued && typeof value === "string" ? protectedClassReasonFor(value) : null
    if (valueReason) {
      labelled.push({ source: `${key}=${value}`, reason: valueReason })
      if (strip) { removed.push(`${key}=${value}`); continue }
    }
    kept[key] = value
  }
  return { lane, criteria: kept, removed, labelled }
}

/**
 * THE AD-AUDIENCE STRIP, PINNED TO ITS LANE. Refuses nothing else, and cannot
 * be called for anything else.
 *
 * SURVIVOR: `screenProtectedClassCriteria` (immediately above). This is that
 * function with the lane bound to `"ad_audience"` — no second implementation,
 * no second vocabulary, and a caller that wants the data lane must name it.
 *
 * ── WHY IT KEPT ITS NAME THROUGH FINDING #297 ────────────────────────────────
 * Before 2026-08-22 this was a lane-BLIND strip, and its one live caller was
 * the seller-signal provider lookup — a sourcing call the owner's standing
 * scope ruling exempts. Owner ruling, verbatim: "297 just release it from
 * fairhousing." So it was released THERE, and only there: the caller moved to
 * `screenProtectedClassCriteria(..., "data_sourcing")`.
 *
 * What did NOT change is what this name does. It strips, and the name is
 * therefore still literally true — unlike `redactProtectedClassFields` below,
 * whose header records the opposite situation and calls itself a known lie. The
 * two are the same shape of edit with opposite verdicts, which is worth stating
 * so the next author does not "tidy" this one away by analogy with that one.
 *
 * WHO CALLS IT: no production caller today. That is BY DESIGN and is recorded
 * rather than left to be rediscovered — see the header on the survivor. The
 * live ads path refuses through `assertAudienceSegmentationAllowed`, which
 * governs a segmentation RULE; this governs a criteria PAYLOAD, which is the
 * shape a population-procurement call would take, and it is exercised for real
 * by scripts/batchdata-seller-signal-simulator.ts and
 * scripts/compliance-scope-simulator.ts. An unwired forward guard on the one
 * lane that still refuses is work to keep, not work to delete (CLAUDE.md §1).
 */
export function stripProtectedClassCriteria(
  criteria: Record<string, unknown> | null | undefined,
): { criteria: Record<string, unknown>; removed: string[]; labelled: ProtectedClassBasis[] } {
  const { criteria: kept, removed, labelled } = screenProtectedClassCriteria(criteria, "ad_audience")
  return { criteria: kept, removed, labelled }
}

/**
 * PURE. LABEL — not strip — the protected-class fields in a provider row, so a
 * stored row says which of its own fields are facts about a PERSON.
 *
 * TOMBSTONE (owner ruling, wave 15). This was the STORAGE gate: it walked a
 * provider row and DELETED every protected-class branch before the row reached
 * `signal_details`. Under the ruling — "do not run the compliance or fair
 * housing on scrapping, enrichment, scoring, sourcing because we determine the
 * kind of education in channels by the age group" — deleting the age band on
 * the way in was destroying the exact input the owner asked for. The row now
 * arrives intact and CARRIES ITS OWN LABEL.
 *
 * WHERE THE ENFORCEMENT WENT, at file:line:
 *   · lib/lead-governance/protected-class-signals.ts:518 →
 *     `assertAudienceSegmentationAllowed` refuses a protected class DEFINING an
 *     ad audience.
 *   · lib/audiences/audience-sync.ts → `onLeadConvertedForAudience` and
 *     `onContactBecameLifetimeForAudience` run that assertion before staging a
 *     person into a Meta/Google custom audience.
 *
 * WHO READS THE LABEL:
 *   · lib/audiences/audience-sync.ts — the ad-audience gate, which needs to see
 *     that a segmentation rule leans on one of these fields.
 *   · lib/agents/education-delivery-producer.ts — the education selector, which
 *     uses the age BAND (never the raw value) to choose lesson and channel.
 *
 * `paths` is returned rather than swallowed so a label is a reported fact: an
 * empty array means "the classifier ran and this row is pure parcel state", not
 * "nobody looked".
 */
export function labelProtectedClassFields(
  row: unknown,
  path = "",
): { value: unknown; paths: string[] } {
  const paths: string[] = []
  const walk = (node: unknown, prefix: string): void => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${prefix}[${i}]`)); return }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const here = prefix ? `${prefix}.${key}` : key
        if (isProtectedClassSource(key)) { paths.push(here); continue }
        walk(value, here)
      }
    }
  }
  walk(row, path)
  return { value: row, paths }
}

// TOMBSTONE (CLAUDE.md §1, 2026-09-03, lane L2). `redactProtectedClassFields`
// is DELETED. It was a back-compat shim over the survivor below-but-one —
// SURVIVOR: lib/lead-governance/protected-class-signals.ts:labelProtectedClassFields
// (immediately above) — that renamed `paths` to `redacted` and changed nothing
// else. Its own header set the condition for its removal in writing: "this shim
// is the duplicate that gets deleted the day it is fixed", where "it" was the
// stored key `signal_details.protected_class_redacted`, a name asserting a
// redaction that stopped happening under the wave-15 owner ruling.
//
// BOTH HALVES OF THAT CONDITION ARE NOW MET, which is why this is a deletion
// and not a deferral:
//   · the key was renamed to `protected_class_fields` on 2026-08-21 —
//     lib/external/batchdata-seller-signals.ts:1416 and
//     app/api/cron/permit-signal-scan/route.ts:248,285;
//   · the one caller the shim's header named moved to the survivor —
//     lib/external/batchdata-seller-signals.ts:1371 calls
//     `labelProtectedClassFields` directly and says so at :1367.
// NOTHING WAS PORTED because the survivor lacked nothing: the shim's whole body
// was `labelProtectedClassFields(row, path)` with `paths` re-spelled `redacted`.
// The proof that exercised the shim's shape now asserts the RULE that replaced
// it — scripts/batchdata-seller-signal-simulator.ts, section 1d.

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ARM THAT STILL REFUSES — AD-AUDIENCE SEGMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE PERSONA CARVE-OUT, AND THE REASON IT IS AS NARROW AS IT IS.
 *
 * ── THE RULING (owner, 2026-08-23, verbatim) ────────────────────────────────
 * "military, senior, divorced and probate need to be allowed as situation
 * persona because that is how we show them info or ads that is worded to their
 * situation as part of them-first methology." And: "persona is more the
 * situation that the contact or lead is in."
 *
 * Before this, `protectedClassSegmentationIn` refused
 * `{ filters: { personas: ["senior"] } }` because it scans string VALUES as well
 * as keys and "senior" is in `PROTECTED_CLASS_TOKENS`. That refusal was correct
 * under the previous reading and is what the ruling reverses — for INCLUSION.
 *
 * ── WHAT THE CARVE-OUT ADMITS, AND NOTHING ELSE ─────────────────────────────
 * BOTH conditions must hold, and each one is doing work:
 *   1. the value sits at the `personas` FILTER KEY of an audience rule
 *      (`filters.personas[0]`, or the degenerate `filters.personas` string form,
 *      which the persona gate refuses anyway for not being an array); and
 *   2. the value is a CANONICAL persona — a member of `CAMPAIGN_PERSONAS`, the
 *      one roster that mirrors the `Persona` union and the live
 *      `campaign_sequences_persona_check`.
 *
 * So `personas: ["senior"]` is admitted (a situation label on a contact WE
 * ALREADY HOLD, in `contacts.contact_persona`), while every one of these is
 * still refused, at the same key:
 *   · `personas: ["senior-owner"]`  — the PROVIDER's quickList slug, not a
 *     persona. Raw demographic targeting criteria wearing the persona key;
 *   · `personas: ["min_owner_age"]`, `personas: ["seniors-55plus"]` — same;
 *   · `contact_tags: ["seniors-55plus"]`, `min_owner_age: 65`,
 *     `demographics.recentlyDivorced: true`, `quicklists: ["senior-owner"]` —
 *     untouched by this function's carve-out and untouched by
 *     `screenProtectedClassCriteria`, which never had one.
 * The owner permitted a PERSONA. He did not permit sending a demographic
 * criterion to an ad platform, and the two are told apart by the roster, not by
 * the key alone.
 *
 * ── AND IT DOES NOT APPLY WHEN THE AUDIENCE SUBTRACTS ───────────────────────
 * `suppresses` in the caller turns the carve-out off for an `exclusion_*` rule
 * type. Reaching a widow with probate-sale information is the them-first ruling;
 * removing every `senior` from a housing ad's delivery is withholding housing
 * from the elderly. `lib/ads/audience-persona-basis.ts` refuses that too — this
 * is the second, independent refusal on the same shape, which is what "defence
 * in depth" has meant at these four doors since the gate was built.
 */
function isCanonicalPersonaBasisValue(prefix: string, value: string): boolean {
  if (!/(?:^|\.)personas(?:\[\d+\])?$/.test(prefix)) return false
  return isCampaignPersona(value.trim().toLowerCase())
}

/**
 * PURE. The protected-class attributes an ad-audience segmentation rule leans
 * on, as `path=value` strings, or `[]` when the rule segments only on
 * behaviour, lifecycle or transaction state.
 *
 * WHY THIS IS THE RIGHT PLACE FOR THE REFUSAL. 42 U.S.C. § 3604(c) reaches the
 * PUBLICATION of a housing advertisement that indicates a preference based on a
 * protected class; HUD's 2019-2022 actions against Meta reached the TARGETING
 * of housing ads by protected-class proxies. Neither reaches holding a
 * homeowner's age in a CRM. The owner's ruling draws the same line, and this
 * function is where it is drawn in code.
 *
 * EVERY audience in this product is a housing audience — this is a real-estate
 * CRM and `facebook_custom_audiences` exists only to retarget housing services
 * — so there is no "is this a housing campaign?" branch to get wrong. That is
 * deliberate: a per-campaign housing flag would be one unchecked checkbox away
 * from turning the gate off.
 *
 * BOTH KEYS AND STRING VALUES are scanned, and that is wider than
 * `screenProtectedClassCriteria`'s scoping. A segmentation rule is authored by a
 * human in free text — `{ filters: { contact_tags: ["seniors-55plus"] } }`
 * hides the protected class in the VALUE, and there is no provider vocabulary
 * to scope to. The cost is that a tag literally containing a protected word is
 * refused even when innocently meant; the positive control in
 * scripts/compliance-scope-simulator.ts holds both directions so that cost
 * stays visible.
 *
 * ONE EXCEPTION, ADDED 2026-08-23 BY OWNER RULING, and it is deliberately the
 * narrowest shape that can carry it: a CANONICAL persona at the `personas`
 * filter key of an INCLUSION rule. See `isCanonicalPersonaBasisValue` above for
 * what that admits and — more importantly — the list of neighbouring shapes it
 * still refuses. This is the only exception in this function and it must stay
 * the only one: the next author who wants to widen it is looking at the exact
 * spot where raw demographic targeting would re-enter the ads lane.
 */
export function protectedClassSegmentationIn(rule: unknown, path = ""): string[] {
  // WHICH OPERATION THIS AUDIENCE PERFORMS. An audience that REMOVES people gets
  // no persona carve-out below: suppressing an audience by a protected
  // characteristic is the restricted act, whatever field it is spelled in.
  // ONE VOCABULARY (§6): `audienceUseOf` is the same function the persona gate
  // reads the operation with, so these two doors cannot drift into disagreeing
  // about what "an audience that subtracts" means.
  const suppresses = audienceUseOf(rule) === "exclusion"
  const hits: string[] = []
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === "string") {
      if (isCanonicalPersonaBasisValue(prefix, node) && !suppresses) return
      if (isProtectedClassSource(node)) hits.push(`${prefix}=${node}`)
      return
    }
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${prefix}[${i}]`)); return }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const here = prefix ? `${prefix}.${key}` : key
        if (isProtectedClassSource(key)) { hits.push(here); continue }
        walk(value, here)
      }
    }
  }
  walk(rule, path)
  return Array.from(new Set(hits))
}

/**
 * Throws when an ad audience is segmented by a protected class. FAIL CLOSED —
 * a caller that cannot evaluate the rule must refuse, never pass (CLAUDE.md §4).
 *
 * `audienceLabel` is quoted back in the message so an operator reading the
 * skip reason knows WHICH audience to fix, not merely that something was
 * refused.
 */
export function assertAudienceSegmentationAllowed(rule: unknown, audienceLabel: string): void {
  const hits = protectedClassSegmentationIn(rule)
  if (hits.length > 0) {
    throw new Error(
      `[protected-class-signals] REFUSED: audience "${audienceLabel}" is segmented by a protected class ` +
      `(${hits.join(", ")}). Targeting housing advertising by a protected class is the restricted act ` +
      `(Fair Housing Act, 42 U.S.C. § 3604(c)); holding or scoring the same data is not.`,
    )
  }
}
