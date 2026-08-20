/**
 * lib/lead-governance/protected-class-signals.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STRUCTURAL FAIR-HOUSING GATE FOR SELLER SIGNALS.
 *
 * WHY THIS IS A MODULE AND NOT A PARAGRAPH IN A HEADER. Our property-data
 * provider (BatchData) sells, in the SAME request body and the SAME response
 * row as the motivation data we legitimately want, an entire `demographics`
 * dataset: age, gender, hasChildren, childCount, singleParent, maritalStatus,
 * recentlyDivorced, religious, religiousAffiliation, income, netWorth,
 * householdSize, individualEducation. Those field paths were read live from the
 * provider's own dataset catalogue on 2026-08-20 (`list_property_dataset_fields
 * demographic`, 32 fields) — this is not a hypothetical surface.
 *
 * Every one of those is a protected class or a direct proxy for one under the
 * Fair Housing Act (42 U.S.C. § 3604) — race, color, religion, sex, familial
 * status, national origin, disability — plus the age and income proxies that
 * state statutes and HUD's disparate-impact rule reach. Targeting a homeowner
 * for a listing pitch on any of them is not a scoring nuance; it is the
 * violation.
 *
 * And it is one keystroke away at all times. `min_owner_age: 70` is the same
 * shape of edit as `min_sale_propensity: 70`. A rule that lives only in prose
 * gets read once, by the person who wrote it. So the rule lives in code, in
 * THREE places that each fail closed:
 *
 *   1. DECLARATION  — `defineSellerSignalSources` runs this gate over every
 *      field a signal type declares as its source, AT MODULE LOAD. A signal
 *      type sourced from a protected class cannot be added: the module that
 *      declares it throws on import, and nothing downstream of it runs.
 *   2. REQUEST      — `stripProtectedClassCriteria` removes protected filters
 *      from any outbound provider query, so we cannot even ASK the provider to
 *      segment by them, however the criteria were assembled.
 *   3. STORAGE      — `redactProtectedClassFields` strips them from a provider
 *      row before any of it is written into `signal_details`, so a value we
 *      never asked for cannot arrive unasked and be persisted anyway.
 *
 * ── THE OWNER'S TWO ADDITIONS ────────────────────────────────────────────────
 * Beyond the statutory list, two provider signals are excluded by owner ruling
 * rather than by statute, and they are excluded here on the same footing:
 *   · `inherited` / probate — the provider's own quickList slug. Ruled out by a
 *     standing owner instruction asking for a fair-housing filter on probate.
 *     It is also a familial-status proxy in substance: the fact it encodes is a
 *     death in a family.
 *   · divorce — `demographics.recentlyDivorced`. Marital status, protected by
 *     statute in many states and by the same owner instruction here.
 *
 * ── WHAT IS ALLOWED, AND WHY THE LINE IS WHERE IT IS ─────────────────────────
 * The allowed set is PROPERTY-AND-TRANSACTION STATE: facts about a parcel and
 * its recorded financial position, not about the person who owns it.
 * Sale propensity, tax delinquency, involuntary liens, foreclosure filings,
 * vacancy, absentee ownership, tired-landlord composites, expired listings,
 * equity and ownership tenure are all publicly recorded facts about a PROPERTY.
 * Age, family, religion, income and household composition are facts about a
 * PERSON. That is the whole line.
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
 * The banned set is therefore a TOKEN vocabulary plus a namespace prefix
 * (`demographics.*` in full), and the positive control in
 * scripts/batchdata-seller-signal-simulator.ts proves both directions still
 * hold: a protected name is still refused, and an allowed one still passes.
 */

/**
 * The provider dataset namespaces excluded WHOLE. Nothing under these may ever
 * source a seller signal, be requested, or be stored — the exclusion is the
 * namespace, so a field added to it by the vendor tomorrow is excluded the day
 * it appears rather than the day somebody notices it.
 */
export const PROTECTED_CLASS_NAMESPACES: readonly string[] = ["demographics", "demographic"]

/**
 * Banned WORD tokens. A field path is split into words and refused if it
 * contains any of these. Each line names the protected class it stands for so a
 * future reader can tell a statutory exclusion from a stylistic one.
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
 * PURE. The reason this source is refused, or null when it is allowed.
 *
 * Returns a SENTENCE, not a boolean, because the caller that refuses a write or
 * a query has to be able to say why in an error an operator will read — and
 * because "refused" with no reason is the shape of a gate people delete.
 */
export function protectedClassReasonFor(source: string): string | null {
  const tokens = tokenizeFieldPath(source)
  if (tokens.length === 0) return null
  if (BANNED_NAMESPACES.has(tokens[0])) {
    return `"${source}" is in the provider's ${tokens[0]} dataset, which is excluded whole: it carries age, gender, familial status, marital status, religion, income and household composition.`
  }
  const hit = tokens.find((t) => BANNED.has(t))
  if (hit) {
    return `"${source}" contains the protected-class term "${hit}". Seller signals may only be sourced from property-and-transaction state, never from a characteristic of the person who owns it (Fair Housing Act, 42 U.S.C. § 3604).`
  }
  return null
}

/** PURE. True when this provider field/filter/quickList may not source a signal. */
export function isProtectedClassSource(source: string): boolean {
  return protectedClassReasonFor(source) !== null
}

/**
 * Throws when `source` is a protected-class proxy. FAIL CLOSED: the caller is a
 * module-load declaration, so a refusal takes the whole module down rather than
 * letting a violating signal type exist in a half-loaded state.
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
  /** EXACT provider field paths / quickList slugs this signal reads. Gated. */
  sources: readonly string[]
  /** Why this fact is a legitimate motivation signal about a PROPERTY. */
  why: string
}

/**
 * THE DECLARATION GATE. Every seller-signal type must be declared through this
 * function, which runs the protected-class check over every source it names and
 * THROWS on the first violation.
 *
 * This is what makes the exclusion structural rather than advisory: the call is
 * at module scope in lib/external/batchdata-seller-signals.ts, so adding
 * `demographics.age` (or `senior-owner`, or `inherited`) to any spec makes that
 * module fail to import — the cron, the simulator and the type check all stop.
 * There is no path where a protected-class signal type merely "gets reviewed".
 */
export function defineSellerSignalSources<T extends readonly SellerSignalSourceSpec[]>(specs: T): T {
  const seen = new Set<string>()
  for (const spec of specs) {
    if (seen.has(spec.signalType)) {
      throw new Error(`[protected-class-signals] duplicate signal type declared: "${spec.signalType}"`)
    }
    seen.add(spec.signalType)
    if (spec.sources.length === 0) {
      // A signal with no declared source cannot be gated, and an ungateable
      // signal is exactly what this file exists to prevent.
      throw new Error(`[protected-class-signals] signal type "${spec.signalType}" declares no source fields`)
    }
    for (const source of spec.sources) assertSellerSignalSourceAllowed(source, spec.signalType)
  }
  return Object.freeze(specs) as T
}

/**
 * PURE. Remove protected-class criteria from an outbound provider query.
 *
 * Returns the kept criteria and the NAMES of what was removed. The names are
 * returned rather than swallowed because a silently-narrowed query is the
 * measurement defect this repo keeps paying for: the caller reports the removal
 * so "we did not segment on that" is visible, not inferred from a smaller
 * result count.
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
 * PURE. Strip protected-class fields out of a provider row, recursively, before
 * any of it is stored.
 *
 * THE THIRD GATE, and the one that catches what we never asked for. A provider
 * decides what it puts in a response; asking only for the `core` dataset is not
 * a promise that `demographics` will not arrive. Anything that reaches
 * `signal_details` is persisted under a tenant's brokerage_id and readable by
 * every downstream scorer, so the redaction happens on the way IN, not on the
 * way out to a screen.
 *
 * Removed keys are listed alongside so a redaction is a reported fact.
 */
export function redactProtectedClassFields(
  row: unknown,
  path = "",
): { value: unknown; redacted: string[] } {
  const redacted: string[] = []
  const walk = (node: unknown, prefix: string): unknown => {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${prefix}[${i}]`))
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const here = prefix ? `${prefix}.${key}` : key
        if (isProtectedClassSource(key)) { redacted.push(here); continue }
        out[key] = walk(value, here)
      }
      return out
    }
    return node
  }
  return { value: walk(row, path), redacted }
}
