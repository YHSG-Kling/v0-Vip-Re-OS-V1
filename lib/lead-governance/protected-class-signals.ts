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
 *   3. REFUSE, at the act that is actually restricted — the two functions that
 *      govern SEGMENTING A POPULATION BY A PROTECTED CLASS still throw / still
 *      strip:
 *        · `assertAudienceSegmentationAllowed` / `protectedClassSegmentationIn`
 *          — an ad audience (Meta/Google custom audience) may not be defined by
 *          a protected-class rule. Enforced at lib/audiences/audience-sync.ts
 *          before a person is staged into an audience.
 *        · `stripProtectedClassCriteria` — we do not ask a THIRD-PARTY DATA
 *          BROKER to hand us a population selected by protected class
 *          ("give me owners aged 65+"). That is procurement of a segmented
 *          population, which is the same act as targeting one; it is not the
 *          enrichment of a lead we already hold, which the ruling exempts. See
 *          the note on that function for exactly what it does and does not
 *          reach on live traffic.
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
 *   · `inherited` / probate — the provider's own quickList slug. Ruled out by a
 *     standing owner instruction asking for a fair-housing filter on probate.
 *     It is also a familial-status proxy in substance: the fact it encodes is a
 *     death in a family.
 *   · divorce — `demographics.recentlyDivorced`. Marital status, protected by
 *     statute in many states and by the same owner instruction here.
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

/**
 * The provider dataset namespaces classified protected WHOLE. The
 * classification is the NAMESPACE, so a field added to it by the vendor
 * tomorrow is classified the day it appears rather than the day somebody
 * notices it.
 */
export const PROTECTED_CLASS_NAMESPACES: readonly string[] = ["demographics", "demographic"]

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
    return `"${source}" contains the protected-class term "${hit}". It is a characteristic of a PERSON, not of a parcel: it may be held, scored and used to choose an education channel, and it may never segment a housing audience (Fair Housing Act, 42 U.S.C. § 3604).`
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
 * The THROW did not die with it. It is the mechanism behind
 * `assertAudienceSegmentationAllowed` (this file, :518), which is where a protected class
 * choosing an audience is refused, and it is still the thing
 * scripts/batchdata-seller-signal-simulator.ts exercises to prove the
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
 * PURE. Remove protected-class criteria from an outbound DATA-BROKER query.
 *
 * THIS ARM STILL REFUSES, AND HERE IS WHY IT SURVIVED THE RULING. The ruling
 * exempts enrichment of a lead we already hold. This function does not govern
 * that; it governs asking a third party to HAND US A POPULATION SELECTED BY A
 * PROTECTED CLASS — "give me owners aged 65+", "give me households with
 * children". Procuring a segmented population and targeting a segmented
 * population are the same act with the same statute behind them, which is why
 * this sits beside `assertAudienceSegmentationAllowed` rather than beside the
 * labelling arms. A lookup of ONE lead's own address is untouched by it, so
 * nothing the ruling exempts is blocked here.
 *
 * Returns the kept criteria and the NAMES of what was removed. The names are
 * returned rather than swallowed because a silently-narrowed query is the
 * measurement defect this repo keeps paying for: the caller reports the removal
 * so "we did not segment on that" is visible, not inferred from a smaller
 * result count.
 *
 * WHAT THIS DOES AND DOES NOT DO ON LIVE TRAFFIC.
 * KEYS are always token-scanned. VALUES are scanned only for the provider's
 * SLUG_VALUED_KEYS (below) — the keys whose value IS the filter. The one live
 * call site, lib/external/batchdata-seller-signals.ts:978, passes only
 * `{ query: "<address>, <city>, <state>, <zip>" }`: the key passes and the
 * value is never examined, so that call removes nothing and cannot. `removed`
 * coming back empty from it therefore means "nothing here was gateable", NOT
 * "nothing here violated". That is the address-lookup shape the ruling exempts
 * anyway. This function is the forward guard for the population-selection
 * payload somebody will eventually assemble; it is exercised for real by
 * scripts/batchdata-seller-signal-simulator.ts, which passes protected keys and
 * protected quickList slugs and asserts both are refused.
 */
/**
 * Criteria keys whose VALUE is itself the filter — the provider's quickList
 * slugs. `senior-owner` and `inherited` ride in here, not in the key, so the
 * value has to be gated too.
 *
 * SCOPED, NOT UNIVERSAL, and the scope is load-bearing. Gating every string
 * value would refuse `property_type_category: "Single Family Residential"` —
 * a building type, not a household — and the author who hit that would weaken
 * the gate rather than narrow it. Narrowing it here is that fix, made once.
 */
const SLUG_VALUED_KEYS = new Set([
  "quicklist", "quicklists", "orquicklists", "notquicklists", "andquicklists",
])

export function stripProtectedClassCriteria(
  criteria: Record<string, unknown> | null | undefined,
): { criteria: Record<string, unknown>; removed: string[] } {
  const kept: Record<string, unknown> = {}
  const removed: string[] = []
  for (const [key, value] of Object.entries(criteria ?? {})) {
    if (isProtectedClassSource(key)) { removed.push(key); continue }
    const slugValued = SLUG_VALUED_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ""))
    if (Array.isArray(value)) {
      const keptItems: unknown[] = []
      for (const v of value) {
        if (slugValued && typeof v === "string" && isProtectedClassSource(v)) { removed.push(`${key}[${v}]`); continue }
        keptItems.push(v)
      }
      if (keptItems.length > 0) kept[key] = keptItems
      continue
    }
    if (slugValued && typeof value === "string" && isProtectedClassSource(value)) {
      removed.push(`${key}=${value}`); continue
    }
    kept[key] = value
  }
  return { criteria: kept, removed }
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

/**
 * BACK-COMPAT SHIM. Same call signature the one remaining caller already uses —
 * lib/external/batchdata-seller-signals.ts:675, which this lane does not own —
 * but it NO LONGER REDACTS. `value` is the row unchanged; `redacted` is the
 * LABEL list from `labelProtectedClassFields`.
 *
 * SURVIVOR: `labelProtectedClassFields` (this file, immediately above). Call
 * that one from new code.
 *
 * ONE VOCABULARY PER FUNCTION (CLAUDE.md §6) IS NOT YET HELD HERE, and saying
 * so is the point of this comment. The caller writes this list into
 * `signal_details.protected_class_redacted`, a column name that now describes
 * something that no longer happens: nothing is redacted. Renaming that key to
 * `protected_class_fields` is a one-line edit in
 * lib/external/batchdata-seller-signals.ts:675-693 that belongs to the lane
 * that owns it. Until then the stored key name is a known, recorded lie and
 * this shim is the duplicate that gets deleted the day it is fixed.
 */
export function redactProtectedClassFields(
  row: unknown,
  path = "",
): { value: unknown; redacted: string[] } {
  const { value, paths } = labelProtectedClassFields(row, path)
  return { value, redacted: paths }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ARM THAT STILL REFUSES — AD-AUDIENCE SEGMENTATION
// ─────────────────────────────────────────────────────────────────────────────

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
 * `stripProtectedClassCriteria`'s scoping. A segmentation rule is authored by a
 * human in free text — `{ filters: { contact_tags: ["seniors-55plus"] } }`
 * hides the protected class in the VALUE, and there is no provider vocabulary
 * to scope to. The cost is that a tag literally containing a protected word is
 * refused even when innocently meant; the positive control in
 * scripts/compliance-scope-simulator.ts holds both directions so that cost
 * stays visible.
 */
export function protectedClassSegmentationIn(rule: unknown, path = ""): string[] {
  const hits: string[] = []
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === "string") {
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
