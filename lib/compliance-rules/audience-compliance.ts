// lib/compliance-rules/audience-compliance.ts
// ─────────────────────────────────────────────────────────────────────────────
// FAIR HOUSING ON AUDIENCE SELECTION AND DELIVERY — THE PROXY VOCABULARY (wave 148, lane 148C).
//
// OWNER RULING 1 (2026-11-01), verbatim: "the read of protected or prohibited can be used to determine the person's persona so
// users can create ads and posts, etc. around that persona." Wave 148 read it as "the persona handed to marketing is
// needs-based"; OWNER RULING 2026-11-03 (wave 149, lane 149A) REVERSED that reading: "Every persona is allowed and this can't
// change." This list is NOT a persona rule and never refuses a canonical persona (protected-class-signals.ts carves the
// `personas` key out); it screens free-text WORDING — a typed tag, an interest, a line of copy — for proxy language
// ("young-families", "church-goers"), which is the wording + platform-delivery side the owner kept.
//
// WHAT WAS MISSING (measured at ebed6c44). The copy gate (fair-housing-patterns.ts) reads WORDING. The audience gate
// (lib/lead-governance/protected-class-signals.ts `protectedClassSegmentationIn`) reads a segmentation rule through the
// field-token classifier (`PROTECTED_CLASS_TOKENS` — "children", "religion", "age", …). Neither recognised the PROXY words a
// person types into an audience or an interest list: `contact_tags: ["young-families"]`, `interests: ["Parenting"]`,
// `["spanish-speakers"]`, `["near-good-schools"]`, `["church-goers"]` all passed both gates — each one selects people by a
// protected characteristic without naming the statutory word.
//
// WHY A SEPARATE LIST, NOT MORE TOKENS (CLAUDE.md §6 — one vocabulary PER FUNCTION). `PROTECTED_CLASS_TOKENS` classifies a
// provider FIELD PATH and is read by the data lanes, the research store and the education selector; adding "families" or
// "school" there would relabel property facts ("single family", "school district" on a parcel) as person facts on every data
// lane. The copy patterns judge PUBLIC WORDING ("near schools" is compliant listing copy). This list judges one act only — who
// an ad audience SELECTS or an ad DELIVERS to — so it is its own function with its own vocabulary, consumed by:
//   · protectedClassSegmentationIn (the selection walk at all four audience doors),
//   · validateAdReadiness (lib/ads/connectors/ad-payload.ts — the delivery spec's interests),
//   · the persona firewall (lib/contacts/persona-layers.ts — no marketing persona text may carry a proxy).
//
// PURE. No imports (protected-class-signals.ts imports THIS module; the reverse would be a cycle).
//
// THE LEGAL BASIS, stated once: Fair Housing Act 42 U.S.C. § 3604(c) (advertising that indicates a preference, limitation or
// discrimination); HUD's 2019 charge and the 2022 DOJ settlement with Meta (housing-ad targeting and delivery by protected-class
// proxies); state statutes add age, marital status, military status, sexual orientation, gender identity and source of income.
// No universal state rule is invented here: a term is listed when it names a PERSON by a federally protected class or by one of
// the state classes the owner's classifier already tracks (PROTECTED_CLASS_TOKENS' header).

/** The protected class a proxy term stands in for (labels only — never a value about a person). */
export type AudienceProxyClass =
  | "familial_status" | "religion" | "race_color_national_origin" | "age" | "disability" | "sex_orientation"
  | "marital_status" | "source_of_income"

/**
 * Words / phrases that select PEOPLE by a protected characteristic in an audience, an interest list or persona copy.
 * Matched on whole words after normalising separators (so "young-families", "youngFamilies" and "young families" all hit).
 * Deliberately ABSENT: the singular "family" ("Single Family Residential", "multi-family" are property types) and "accessible"
 * (a factual feature in copy). A positive control in scripts/persona-compliance-guard.ts holds both directions.
 */
export const AUDIENCE_PROXY_TERMS: Readonly<Record<string, AudienceProxyClass>> = Object.freeze({
  // familial status — a household with children, pregnancy, or a life stage that names one
  families: "familial_status", "young families": "familial_status", "growing family": "familial_status", parenting: "familial_status",
  parents: "familial_status", moms: "familial_status", dads: "familial_status", baby: "familial_status", babies: "familial_status",
  toddler: "familial_status", toddlers: "familial_status", newborn: "familial_status", nursery: "familial_status",
  teen: "familial_status", teens: "familial_status", "empty nester": "familial_status", "empty nesters": "familial_status",
  school: "familial_status", schools: "familial_status", "school district": "familial_status", "good schools": "familial_status",
  // religion — houses of worship and faith groups
  church: "religion", churches: "religion", mosque: "religion", synagogue: "religion", temple: "religion", parish: "religion",
  christian: "religion", christians: "religion", catholic: "religion", jewish: "religion", muslim: "religion", hindu: "religion",
  buddhist: "religion", mormon: "religion", "church goers": "religion",
  // race, color, national origin (incl. language used as an audience selector)
  hispanic: "race_color_national_origin", latino: "race_color_national_origin", latina: "race_color_national_origin",
  latinx: "race_color_national_origin", asian: "race_color_national_origin", black: "race_color_national_origin",
  white: "race_color_national_origin", caucasian: "race_color_national_origin", african: "race_color_national_origin",
  immigrant: "race_color_national_origin", immigrants: "race_color_national_origin", "foreign born": "race_color_national_origin",
  expat: "race_color_national_origin", expats: "race_color_national_origin", "spanish speaking": "race_color_national_origin",
  "spanish speakers": "race_color_national_origin", "non english": "race_color_national_origin",
  // age (state-protected; the classifier tracks it)
  young: "age", youthful: "age", millennial: "age", millennials: "age", boomer: "age", boomers: "age", "gen z": "age",
  retiree: "age", retirees: "age", retired: "age", retirement: "age", elderly: "age", "55 plus": "age", "over 55": "age",
  // disability
  wheelchair: "disability", handicapped: "disability", disabled: "disability", "special needs": "disability",
  // sex, sexual orientation, gender identity (state-protected)
  women: "sex_orientation", men: "sex_orientation", ladies: "sex_orientation", gay: "sex_orientation", lesbian: "sex_orientation",
  lgbt: "sex_orientation", lgbtq: "sex_orientation", queer: "sex_orientation", transgender: "sex_orientation",
  // marital status (state-protected; the owner's divorce ruling)
  singles: "marital_status", newlywed: "marital_status", newlyweds: "marital_status", bachelor: "marital_status",
  "single moms": "marital_status", widows: "marital_status",
  // source of income / wealth used to select people (state-protected source of income; the owner's wealth proxies)
  affluent: "source_of_income", wealthy: "source_of_income", "low income": "source_of_income", "high income": "source_of_income",
  "section 8": "source_of_income", voucher: "source_of_income", vouchers: "source_of_income",
})

/** PURE. Lowercase words with every separator (space, dash, underscore, dot, camelCase hump) collapsed to one space. */
function normalise(text: string): string {
  return ` ${String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `
}

export interface AudienceProxyHit {
  term: string
  proxyFor: AudienceProxyClass
}

/**
 * PURE. Every proxy term this text carries, as whole words / phrases. Empty = no proxy recognised (which is NOT a verdict on
 * the statutory words — callers run the field-token classifier beside this; the two together are the selection gate).
 */
export function audienceProxyHits(text: string, exemptPersonaLabels?: ReadonlySet<string>): AudienceProxyHit[] {
  const hay = normalise(text)
  if (hay.trim() === "") return []
  const hits: AudienceProxyHit[] = []
  for (const [term, proxyFor] of Object.entries(AUDIENCE_PROXY_TERMS)) {
    if (!hay.includes(` ${term} `)) continue
    // Owner ruling 1 (wave 149, 2026-11-03 — "every persona is allowed"): a term that IS a persona label of the OS (a kernel-portal
    // persona, a C20 life-event situation or one of its spellings — "empty nesters", "retirement", "newlyweds") is an audience
    // BASIS, not a proxy, when the caller hands the persona vocabulary in. The ad platform's own housing rules (age / gender /
    // ZIP / lookalike) are enforced beside this by the caller; words that are only a protected class ("women", "church goers")
    // are never persona labels and still hit. Without the set the behaviour is unchanged (copy screens, segmentation rules).
    if (exemptPersonaLabels && (exemptPersonaLabels.has(term) || exemptPersonaLabels.has(singular(term)))) continue
    hits.push({ term, proxyFor })
  }
  return hits
}

/** PURE. "empty nesters" → "empty nester", "babies" → "baby", "retirees" → "retiree" (a label match is tried both ways). */
function singular(term: string): string {
  if (term.endsWith("ies")) return term.slice(0, -3) + "y"
  if (term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1)
  return term
}

/** PURE. The persona vocabulary a caller hands to `audienceProxyHits` — every label normalised the way the proxy terms are
 *  (lower-case, separators collapsed), with `_buyer` / `_seller` portal suffixes also offered bare ("first_time_buyer" → "first time
 *  buyer" + "first time"). The SOURCES live where the personas live: lib/portal/persona-config.ts PERSONA_CONFIGS (ruling 2) and
 *  lib/enrichment/life-event-vocabulary.ts LIFE_EVENT_VOCAB (C20) — this module stays import-free (see the header), so the
 *  caller passes the raw labels and this normalises them. */
export function personaLabelSet(rawLabels: Iterable<string>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const raw of rawLabels) {
    const label = normalise(raw).trim()
    if (!label) continue
    out.add(label)
    const bare = label.replace(/ (buyer|seller|buyers|sellers)$/, "")
    if (bare && bare !== label) out.add(bare)
  }
  return out
}

/**
 * PURE. The sentence an operator reads when a value selects people by a proxy, or null. Quoted verbatim into refusals at the
 * selection doors (protectedClassSegmentationIn) and the delivery validator, so both say the same thing (§6).
 */
export function audienceProxyReasonFor(text: string): string | null {
  const hits = audienceProxyHits(text)
  if (hits.length === 0) return null
  const first = hits[0]
  return `"${text}" selects people by the term "${first.term}", a proxy for ${first.proxyFor.replace(/_/g, " ")}. An audience or a delivery ` +
    `spec may describe a NEED or a PROPERTY (relocation research, first-home guidance, acreage, price band) and never a protected ` +
    `characteristic or its proxy (Fair Housing Act, 42 U.S.C. § 3604(c); HUD v. Meta).`
}
