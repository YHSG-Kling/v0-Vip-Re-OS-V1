/**
 * lib/compliance/adaptive-vocabulary.ts — THE ADAPTIVE REAL-ESTATE VOCABULARY (wave 144, lane 144A).
 *
 * Owner ruling 1 (verbatim essentials): contract subtype, financing and representation — and listing /
 * property types, stages, closing participants, state rules — must be SELF-HEALING. A user says a label
 * is missing or obsolete, or that a state uses different types → the manager path evaluates → compares
 * the canonical vocabulary → identifies jurisdiction + brokerage scope → proposes add / rename /
 * deactivate / alias → validates dependencies → human (compliance where legal) approval → canonical
 * configuration update → readers / UI / form mappings follow → verification. Stable canonical IDs +
 * aliases; historical values never deleted; a new financing label must not break pre-approval, offer
 * requirements, reporting or workflows; state-specific regulatory rules need a verified official source
 * and a human compliance approval — AI never invents a binding legal requirement. "Use the existing
 * self-healing / exception mechanism, not a new taxonomy OS."
 *
 * NOT A NEW TAXONOMY OS (LAW 1/2). Nothing here stores anything of its own:
 *   · the PLATFORM lists stay in their survivors and are READ here, never retyped —
 *     lib/compliance/checklist-dimensions.ts (financing types/kinds, contract subtypes, representations,
 *     stages), lib/constants/index.ts (PROPERTY_TYPES + canonicalPropertyType, LISTING_STATUSES),
 *     lib/forms/form-wizard-sequence.ts (the listing-agreement types the intake offers),
 *     lib/transactions/transaction-stages.ts, lib/state-forms/closing-participants.ts,
 *     lib/compliance/document-classifications.ts;
 *   · a brokerage's own terms, aliases, labels, deactivations and compliance attestations are ONE more
 *     versioned tenant policy key, `adaptive_vocabulary` (lib/kernel/tenant-policy.ts), in
 *     brokerage_settings.settings — history, revert and the constitution come with it;
 *   · a change travels the existing CONTROLLED-LEARNING proposal path (lib/kernel/improvement-proposals.ts:
 *     a `policy` proposal on that key, proposer human → EVALUATED → a human approves → promoteProposal →
 *     mergeBrokerageSettings → appendTenantPolicyVersion, inside withActionLedger). The server half is
 *     lib/compliance/vocabulary-healing.ts.
 *
 * THE ONE INVARIANT THAT KEEPS DEPENDENTS WORKING: every brokerage term ROLLS UP to exactly one PLATFORM
 * key of its dimension. A column read by platform-only code (offers.financing_type, listings.property_type)
 * stores the ROLL-UP (vocabularyWriteValue) — offer strength, the government-loan amendatory addendum,
 * financingKindFor, reporting buckets and the form-field enums see a value they already know. A column
 * whose readers are vocabulary-aware (brokerage_required_documents.contract_subtype / representation,
 * through checklistVocabularyFor) stores the term itself, so a Texas-only rule can name a Texas-only term.
 *
 * MODES (per dimension, VOCABULARY_DIMENSIONS):
 *   extensible        a brokerage may add terms (each rolling up), aliases, labels, deactivations
 *   label_alias_only  kernel state machines / CHECK-pinned workflow columns: aliases and display labels
 *                     only — a new stage would be a state the transition table does not know
 *   platform_only     the meaning is legal or structural (housing-topic exemptions, cited state closing
 *                     participants, the cash/financed pivot, the stage ladder, document classifications):
 *                     a report is answered with WHY and WHERE the platform owns it; nothing is written
 *
 * JURISDICTION: a change that names states (state_codes) — and ANY add on a jurisdictional dimension —
 * must cite a PRIMARY source (isPrimarySourceUrl: a .gov / .us publisher, the law-rule survivor's test)
 * and is usable only after a compliance approver ATTESTS it. Until then the term resolves (history works)
 * but is not offered for new writes.
 *
 * Pure + one async loader (takes the caller's client; no server-only import), so the settings screen,
 * the resolver and the proof read the same rules.
 */

import {
  CHECKLIST_STAGES, CHECKLIST_STAGE_LABEL, CONTRACT_SUBTYPES, CONTRACT_SUBTYPE_LABEL, FINANCING_KINDS, FINANCING_KIND_LABEL,
  FINANCING_TYPES, FINANCING_TYPE_LABEL, REPRESENTATIONS, REPRESENTATION_LABEL, normalizeVocabularyValue, platformFinancingType,
  platformContractSubtype, type ChecklistVocabulary,
} from "./checklist-dimensions"
import { ALL_DOCUMENT_CLASSIFICATIONS, DOCUMENT_CLASSIFICATION_LABEL } from "./document-classifications"
import { LISTING_STATUSES, LISTING_STATUS_LABELS, PROPERTY_TYPE_OPTIONS, canonicalPropertyType } from "@/lib/constants"
import { LISTING_INTAKE } from "@/lib/forms/form-wizard-sequence"
import { TRANSACTION_STAGES } from "@/lib/transactions/transaction-stages"
import { STATE_CLOSING_POLICIES } from "@/lib/state-forms/closing-participants"
import { isPrimarySourceUrl } from "@/lib/compliance-rules/law-rule-registry"

/** The tenant policy key (lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS) that holds a brokerage's overlay. */
export const ADAPTIVE_VOCABULARY_POLICY_KEY = "adaptive_vocabulary"

// ── 1. THE DIMENSIONS (the census's runtime half — scripts/adaptive-vocabulary-guard.ts holds it to the live CHECKs) ──

export type VocabularyDimension =
  | "financing_type" | "contract_subtype" | "representation" | "listing_type" | "property_type"
  | "listing_status" | "transaction_stage"
  | "financing_kind" | "required_stage" | "document_classification" | "closing_participant" | "housing_topic"

export type VocabularyMode = "extensible" | "label_alias_only" | "platform_only"

export interface PlatformTerm { key: string; label: string }

export interface VocabularyDimensionSpec {
  label: string
  mode: VocabularyMode
  /** The right answer varies by state: an ADD must name its states, cite a primary source and be attested. */
  jurisdictional: boolean
  platform: readonly PlatformTerm[]
  /** Where the platform list lives — the survivor this registry reads. */
  survivor: string
  /** Live single-column CHECKs that pin stored values ("table.column") — held equal to scripts/check-vocabularies.ts. */
  liveChecks: readonly string[]
  /** term = the column stores the term (vocabulary-aware readers); rollup = it stores the platform roll-up; none = not stored. */
  storage: "term" | "rollup" | "none"
  /** Why a platform_only / label_alias_only dimension refuses brokerage additions (shown to the reporter). */
  why?: string
}

const humanize = (k: string) => k.toLowerCase().split("_").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ")
const fromLabels = (keys: readonly string[], labels: Readonly<Record<string, string>>): PlatformTerm[] =>
  keys.map((key) => ({ key, label: labels[key] ?? humanize(key) }))

const listingTypeTerms: PlatformTerm[] = (LISTING_INTAKE.find((q) => q.key === "representation")?.options ?? []).map((o) => ({ key: o.value, label: o.label }))
const closingParticipantTerms: PlatformTerm[] = [...new Set(Object.values(STATE_CLOSING_POLICIES).flatMap((p) => p.expects.map((e) => e.role)))]
  .sort().map((key) => ({ key, label: humanize(key) }))

/**
 * RULING 17 — HOUSING ACCEPTANCE. Besides the lawful housing-for-older-persons exemption (55+ / 62+,
 * verified per community through lib/compliance/fair-housing-older-persons.ts — never assumed), probate,
 * divorce and military relocation are legitimate SERVICE TOPICS: content and outreach may be written to the
 * situation (the them-first persona ruling, lib/lead-governance/protected-class-signals.ts), but none of
 * them exempts housing marketing from the fair-housing scan, and none may become an exclusion, a
 * preference or steering. Keys are canonical personas (lib/campaigns/contact-sources.ts CAMPAIGN_PERSONAS).
 */
export const HOUSING_TOPIC_TREATMENT = {
  senior:    { label: "55+ / 62+ housing for older persons", treatment: "exemption_if_verified", fairHousingScanApplies: true,
               note: "A lawful exemption ONLY for a community whose 55+/62+ status is verified (24 CFR 100.300-100.308) — lib/compliance/fair-housing-older-persons.ts evaluates every claim; unverified copy is flagged." },
  probate:   { label: "Probate / estate sale", treatment: "service_topic", fairHousingScanApplies: true,
               note: "A service topic (heirs and executors selling an estate home). Not a fair-housing exemption: the copy is scanned like any housing ad." },
  divorce:   { label: "Selling during a divorce", treatment: "service_topic", fairHousingScanApplies: true,
               note: "A service topic. Marital status is protected in many states — the situation may shape the wording, never who may buy or rent." },
  military:  { label: "Military relocation (PCS)", treatment: "service_topic", fairHousingScanApplies: true,
               note: "A service topic for relocating service members. Military / veteran status is protected in several states — never a preference (\"military only\") or an exclusion." },
  relocated: { label: "Relocation", treatment: "service_topic", fairHousingScanApplies: true,
               note: "A service topic. Not an exemption." },
} as const satisfies Record<string, { label: string; treatment: "exemption_if_verified" | "service_topic"; fairHousingScanApplies: true; note: string }>

export const VOCABULARY_DIMENSIONS: Readonly<Record<VocabularyDimension, VocabularyDimensionSpec>> = {
  financing_type: {
    label: "Financing type", mode: "extensible", jurisdictional: false,
    platform: fromLabels(FINANCING_TYPES, FINANCING_TYPE_LABEL), survivor: "lib/compliance/checklist-dimensions.ts FINANCING_TYPES",
    liveChecks: [], storage: "rollup",
  },
  contract_subtype: {
    label: "Contract type", mode: "extensible", jurisdictional: false,
    platform: fromLabels(CONTRACT_SUBTYPES, CONTRACT_SUBTYPE_LABEL), survivor: "lib/compliance/checklist-dimensions.ts CONTRACT_SUBTYPES",
    liveChecks: ["brokerage_required_documents.contract_subtype"], storage: "term",
  },
  representation: {
    label: "Representation", mode: "extensible", jurisdictional: true,
    platform: fromLabels(REPRESENTATIONS, REPRESENTATION_LABEL), survivor: "lib/compliance/checklist-dimensions.ts REPRESENTATIONS",
    liveChecks: ["brokerage_required_documents.representation"], storage: "term",
  },
  listing_type: {
    label: "Listing agreement type", mode: "extensible", jurisdictional: true,
    platform: listingTypeTerms, survivor: "lib/forms/form-wizard-sequence.ts LISTING_INTAKE (question `representation`)",
    liveChecks: [], storage: "rollup",
  },
  property_type: {
    label: "Property type", mode: "extensible", jurisdictional: false,
    platform: PROPERTY_TYPE_OPTIONS.map((o) => ({ key: o.value, label: o.label })), survivor: "lib/constants/index.ts PROPERTY_TYPES",
    liveChecks: ["listings.property_type"], storage: "rollup",
  },
  listing_status: {
    label: "Listing status", mode: "label_alias_only", jurisdictional: false,
    platform: fromLabels(LISTING_STATUSES, LISTING_STATUS_LABELS), survivor: "lib/constants/index.ts LISTING_STATUSES",
    liveChecks: ["listings.status"], storage: "term",
    why: "Listing status is a lifecycle the platform moves (updateListingStatus validates against it); a brokerage may rename it or add a spelling, not add a state.",
  },
  transaction_stage: {
    label: "Transaction stage", mode: "label_alias_only", jurisdictional: false,
    platform: Object.values(TRANSACTION_STAGES).map((key) => ({ key, label: humanize(key) })), survivor: "lib/transactions/transaction-stages.ts TRANSACTION_STAGES",
    liveChecks: ["transactions.stage"], storage: "term",
    why: "Transaction stages are a state machine (ALLOWED_TRANSITIONS); a new stage would be a state no transition reaches. Rename or alias only.",
  },
  financing_kind: {
    label: "Cash or financed", mode: "platform_only", jurisdictional: false,
    platform: fromLabels(FINANCING_KINDS, FINANCING_KIND_LABEL), survivor: "lib/compliance/checklist-dimensions.ts FINANCING_KINDS",
    liveChecks: ["brokerage_required_documents.financing_kind"], storage: "term",
    why: "Cash vs financed is the pivot every financing type rolls up to. Add a FINANCING TYPE instead — it declares which of the two it is.",
  },
  required_stage: {
    label: "Checklist stage (due by)", mode: "platform_only", jurisdictional: false,
    platform: fromLabels(CHECKLIST_STAGES, CHECKLIST_STAGE_LABEL), survivor: "lib/compliance/checklist-dimensions.ts CHECKLIST_STAGES",
    liveChecks: ["brokerage_required_documents.required_stage"], storage: "term",
    why: "The due-by ladder is cumulative (listing < offer < contract < closing); a new rung changes what every rule means.",
  },
  document_classification: {
    label: "Document classification", mode: "platform_only", jurisdictional: false,
    platform: fromLabels(ALL_DOCUMENT_CLASSIFICATIONS, DOCUMENT_CLASSIFICATION_LABEL), survivor: "lib/compliance/document-classifications.ts",
    liveChecks: ["brokerage_required_documents.classification", "documents.classification"], storage: "term",
    why: "A new document classification is a platform migration (the documents CHECK, the scanner, the filer). Use 'other' with a description meanwhile.",
  },
  closing_participant: {
    label: "Closing participant", mode: "platform_only", jurisdictional: true,
    platform: closingParticipantTerms, survivor: "lib/state-forms/closing-participants.ts STATE_CLOSING_POLICIES",
    liveChecks: [], storage: "none",
    why: "Who must be at a state's closing is cited state law (each entry carries its source and a re-verification cadence). A correction is a platform change with a human-verified official source, not a brokerage label.",
  },
  housing_topic: {
    label: "Housing topic", mode: "platform_only", jurisdictional: false,
    platform: Object.entries(HOUSING_TOPIC_TREATMENT).map(([key, t]) => ({ key, label: t.label })), survivor: "lib/compliance/adaptive-vocabulary.ts HOUSING_TOPIC_TREATMENT",
    liveChecks: [], storage: "none",
    why: "Whether a topic is a fair-housing exemption is law, not configuration: only verified 55+/62+ housing is; probate, divorce and military relocation are service topics.",
  },
}

// ── 2. THE TENANT OVERLAY (stored under brokerage_settings.settings.adaptive_vocabulary) ─────────────────────────

export interface TenantTerm {
  dimension: VocabularyDimension
  key: string
  label: string
  rolls_up_to: string
  state_codes: string[] | null
  source: { url: string; title: string | null; verified_on: string | null } | null
  active: boolean
  added_at: string | null
  reason: string | null
}
export interface TenantAlias { dimension: VocabularyDimension; alias: string; target: string; added_at: string | null; reason: string | null }
export interface TenantLabel { dimension: VocabularyDimension; key: string; label: string; previous_label: string | null; renamed_at: string | null }
export interface TenantDeactivation { dimension: VocabularyDimension; key: string; active: boolean; at: string | null; reason: string | null }
export interface TenantAttestation { user_id: string; user_type: string; at: string; source_url: string }

export interface TenantVocabulary {
  terms: Record<string, TenantTerm>
  aliases: Record<string, TenantAlias>
  labels: Record<string, TenantLabel>
  deactivations: Record<string, TenantDeactivation>
  attestations: Record<string, TenantAttestation>
  /** Stored entries the reader refused, with why — published, never silently used. */
  rejected: Array<{ id: string; why: string }>
}

export const EMPTY_TENANT_VOCABULARY: TenantVocabulary = Object.freeze({ terms: {}, aliases: {}, labels: {}, deactivations: {}, attestations: {}, rejected: [] }) as TenantVocabulary

const KEY_RE = /^[a-z][a-z0-9_]{1,47}$/
const STATE_RE = /^[A-Z]{2}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const isDimension = (d: unknown): d is VocabularyDimension => typeof d === "string" && Object.prototype.hasOwnProperty.call(VOCABULARY_DIMENSIONS, d)
const entryId = (dimension: string, key: string) => `${dimension}:${key}`
/** An alias's id slug — separators only, so the proposal kernel's `a.b` field paths stay intact. */
const aliasSlug = (normalized: string) => normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60)
const platformKeyOf = (dimension: VocabularyDimension, raw: string): string | null => {
  const want = raw.toLowerCase()
  return VOCABULARY_DIMENSIONS[dimension].platform.find((t) => t.key.toLowerCase() === want)?.key ?? null
}
const stateCodesOf = (v: unknown): string[] | null | false => {
  if (v === null || v === undefined) return null
  if (!Array.isArray(v)) return false
  const codes = v.map((s) => String(s ?? "").trim().toUpperCase())
  if (codes.length === 0) return null
  return codes.every((c) => STATE_RE.test(c)) ? [...new Set(codes)].sort() : false
}

/**
 * PURE — the stored overlay as the readers may use it. Malformed / contradictory entries are REJECTED (named,
 * never used): a term that rolls up to no platform key, collides with a platform key, or names an unknown
 * dimension; an alias whose target does not resolve; an attestation without a primary source.
 */
function resolveTenantVocabulary(raw: unknown): TenantVocabulary {
  const out: TenantVocabulary = { terms: {}, aliases: {}, labels: {}, deactivations: {}, attestations: {}, rejected: [] }
  if (!isObj(raw)) return out
  const reject = (id: string, why: string) => out.rejected.push({ id, why })

  for (const [id, e] of Object.entries(isObj(raw.terms) ? raw.terms : {})) {
    if (!isObj(e) || !isDimension(e.dimension)) { reject(id, "unknown dimension"); continue }
    const dimension = e.dimension, spec = VOCABULARY_DIMENSIONS[dimension]
    const key = str(e.key), label = str(e.label), rollsUpTo = str(e.rolls_up_to)
    const states = stateCodesOf(e.state_codes)
    if (spec.mode !== "extensible") { reject(id, `${dimension} takes no brokerage terms (${spec.mode})`); continue }
    if (!key || !KEY_RE.test(key) || id !== entryId(dimension, key)) { reject(id, "the key is not a stable slug matching its id"); continue }
    if (platformKeyOf(dimension, key)) { reject(id, `"${key}" is already a platform ${dimension}`); continue }
    if (!rollsUpTo || !platformKeyOf(dimension, rollsUpTo)) { reject(id, `rolls_up_to "${rollsUpTo ?? ""}" is not a platform ${dimension}`); continue }
    if (!label || label.length > 80) { reject(id, "the label is empty or longer than 80 characters"); continue }
    if (states === false) { reject(id, "state_codes must be two-letter state codes"); continue }
    const src = isObj(e.source) && str(e.source.url) ? { url: str(e.source.url)!, title: str(e.source.title), verified_on: str(e.source.verified_on) } : null
    out.terms[id] = { dimension, key, label, rolls_up_to: platformKeyOf(dimension, rollsUpTo)!, state_codes: states, source: src, active: e.active !== false, added_at: str(e.added_at), reason: str(e.reason) }
  }

  const termKey = (dimension: VocabularyDimension, k: string) => (out.terms[entryId(dimension, k)] ? k : null)
  for (const [id, e] of Object.entries(isObj(raw.aliases) ? raw.aliases : {})) {
    if (!isObj(e) || !isDimension(e.dimension)) { reject(id, "unknown dimension"); continue }
    const dimension = e.dimension
    const alias = normalizeVocabularyValue(e.alias), target = str(e.target)
    if (VOCABULARY_DIMENSIONS[dimension].mode === "platform_only") { reject(id, `${dimension} is platform-owned`); continue }
    if (!alias || id !== entryId(dimension, aliasSlug(alias))) { reject(id, "the alias does not match its id"); continue }
    const resolvedTarget = target ? platformKeyOf(dimension, target) ?? termKey(dimension, target) : null
    if (!resolvedTarget) { reject(id, `alias target "${target ?? ""}" is not a ${dimension} term`); continue }
    out.aliases[id] = { dimension, alias, target: resolvedTarget, added_at: str(e.added_at), reason: str(e.reason) }
  }

  for (const [id, e] of Object.entries(isObj(raw.labels) ? raw.labels : {})) {
    if (!isObj(e) || !isDimension(e.dimension)) { reject(id, "unknown dimension"); continue }
    const dimension = e.dimension, key = str(e.key), label = str(e.label)
    const resolvedKey = key ? platformKeyOf(dimension, key) ?? termKey(dimension, key) : null
    if (VOCABULARY_DIMENSIONS[dimension].mode === "platform_only" || !resolvedKey || id !== entryId(dimension, resolvedKey)) { reject(id, "the label names no renameable term"); continue }
    if (!label || label.length > 80) { reject(id, "the label is empty or longer than 80 characters"); continue }
    out.labels[id] = { dimension, key: resolvedKey, label, previous_label: str(e.previous_label), renamed_at: str(e.renamed_at) }
  }

  for (const [id, e] of Object.entries(isObj(raw.deactivations) ? raw.deactivations : {})) {
    if (!isObj(e) || !isDimension(e.dimension)) { reject(id, "unknown dimension"); continue }
    const dimension = e.dimension, key = str(e.key)
    const pk = key ? platformKeyOf(dimension, key) : null
    if (VOCABULARY_DIMENSIONS[dimension].mode !== "extensible" || !pk || id !== entryId(dimension, pk)) { reject(id, "a deactivation names no platform term of an extensible dimension"); continue }
    out.deactivations[id] = { dimension, key: pk, active: e.active === true, at: str(e.at), reason: str(e.reason) }
  }

  for (const [id, e] of Object.entries(isObj(raw.attestations) ? raw.attestations : {})) {
    const term = out.terms[id]
    if (!isObj(e) || !term || !term.state_codes) { reject(id, "an attestation names no state-scoped term"); continue }
    const userId = str(e.user_id), userType = str(e.user_type), at = str(e.at), src = str(e.source_url)
    if (!userId || !userType || !at || !src || !isPrimarySourceUrl(src) || src !== term.source?.url) { reject(id, "the attestation is incomplete or does not cite the term's primary source"); continue }
    out.attestations[id] = { user_id: userId, user_type: userType, at, source_url: src }
  }
  return out
}

// ── 3. RESOLUTION (stable IDs, aliases forever, lineage) ─────────────────────────────────────────────────────

export interface ResolvedTerm {
  dimension: VocabularyDimension
  /** The canonical key — stable forever. */
  key: string
  label: string
  /** The platform key every platform-only reader sees. */
  platformKey: string
  /** [key, …ancestors] — a platform key's lineage is itself. */
  lineage: string[]
  origin: "platform" | "tenant"
  via: "exact" | "label" | "alias" | "platform_alias"
  stateCodes: string[] | null
  /** Offered for NEW writes: active, and — when state-scoped — cited and attested. History resolves either way. */
  usable: boolean
  /** A state-scoped term promoted but not yet attested by a compliance approver. */
  pendingAttestation: boolean
}

const platformAlias = (dimension: VocabularyDimension, c: string): string | null =>
  dimension === "financing_type" ? platformFinancingType(c)
  : dimension === "property_type" ? canonicalPropertyType(c)
  // Wave 145 (lane 145H): the merged second contract-type list's spellings (residential → standard …) resolve forever.
  : dimension === "contract_subtype" ? platformContractSubtype(c)
  : null

function resolveKey(dimension: VocabularyDimension, key: string, vocab: TenantVocabulary, via: ResolvedTerm["via"]): ResolvedTerm | null {
  const spec = VOCABULARY_DIMENSIONS[dimension]
  const pk = platformKeyOf(dimension, key)
  if (pk) {
    const relabel = vocab.labels[entryId(dimension, pk)]?.label
    const off = vocab.deactivations[entryId(dimension, pk)]
    return {
      dimension, key: pk, label: relabel ?? spec.platform.find((t) => t.key === pk)!.label, platformKey: pk, lineage: [pk],
      origin: "platform", via, stateCodes: null, usable: !(off && off.active === false), pendingAttestation: false,
    }
  }
  const term = vocab.terms[entryId(dimension, key)]
  if (!term) return null
  const scoped = !!term.state_codes
  const attested = scoped && !!vocab.attestations[entryId(dimension, term.key)]
  return {
    dimension, key: term.key, label: vocab.labels[entryId(dimension, term.key)]?.label ?? term.label, platformKey: term.rolls_up_to,
    lineage: [term.key, term.rolls_up_to], origin: "tenant", via, stateCodes: term.state_codes,
    usable: term.active && (!scoped || attested), pendingAttestation: term.active && scoped && !attested,
  }
}

/**
 * PURE — any stored or typed value → its canonical term, or null when the vocabulary cannot read it.
 * Order: platform key → brokerage term key → brokerage alias → platform alias → a term's own label.
 * A deactivated or unattested term STILL RESOLVES (historical contracts and automations keep working);
 * `usable` says whether it may be chosen for a new write.
 */
export function resolveVocabularyValue(dimension: VocabularyDimension, raw: unknown, vocab: TenantVocabulary = EMPTY_TENANT_VOCABULARY): ResolvedTerm | null {
  if (!isDimension(dimension)) return null
  const c = normalizeVocabularyValue(raw)
  if (!c) return null
  const u = c.replace(/[\s-]+/g, "_")
  const direct = resolveKey(dimension, u, vocab, "exact")
  if (direct) return direct
  const alias = vocab.aliases[entryId(dimension, aliasSlug(c))]
  if (alias && alias.alias === c) {
    const r = resolveKey(dimension, alias.target, vocab, "alias")
    if (r) return r
  }
  const pa = platformAlias(dimension, c)
  if (pa) { const r = resolveKey(dimension, pa, vocab, "platform_alias"); if (r) return r }
  const spec = VOCABULARY_DIMENSIONS[dimension]
  const byLabel = spec.platform.find((t) => normalizeVocabularyValue(t.label) === c)?.key
    ?? Object.values(vocab.terms).find((t) => t.dimension === dimension && normalizeVocabularyValue(t.label) === c)?.key
  return byLabel ? resolveKey(dimension, byLabel, vocab, "label") : null
}

export interface VocabularyOption { value: string; label: string; origin: "platform" | "tenant"; platformKey: string; stateCodes: string[] | null }

/**
 * PURE — the picker for a dimension: platform terms (not hidden) + the brokerage's USABLE terms, with the
 * brokerage's labels. With a stateCode, a state-scoped term appears only for its states; without one it is
 * labelled with them. This is the ONE option list a dropdown renders — no hard-coded alternate labels.
 */
export function vocabularyOptions(dimension: VocabularyDimension, vocab: TenantVocabulary = EMPTY_TENANT_VOCABULARY, opts: { stateCode?: string | null } = {}): VocabularyOption[] {
  const spec = VOCABULARY_DIMENSIONS[dimension]
  if (!spec) return []
  const state = opts.stateCode ? opts.stateCode.toUpperCase() : null
  const out: VocabularyOption[] = []
  for (const t of spec.platform) {
    const r = resolveKey(dimension, t.key, vocab, "exact")!
    if (r.usable) out.push({ value: r.key, label: r.label, origin: "platform", platformKey: r.key, stateCodes: null })
  }
  for (const t of Object.values(vocab.terms)) {
    if (t.dimension !== dimension) continue
    const r = resolveKey(dimension, t.key, vocab, "exact")!
    if (!r.usable) continue
    if (state && r.stateCodes && !r.stateCodes.includes(state)) continue
    out.push({ value: r.key, label: !state && r.stateCodes ? `${r.label} (${r.stateCodes.join(", ")})` : r.label, origin: "tenant", platformKey: r.platformKey, stateCodes: r.stateCodes })
  }
  return out
}

/**
 * PURE — what a WRITER stores for a typed value. `rollup` dimensions store the platform key (every
 * platform-only reader keeps working) and hand back the brokerage term as `subtype` for the column that
 * keeps it; `term` dimensions store the canonical key (an alias is canonicalised, never stored).
 * value null = the vocabulary cannot read it (the writer refuses or keeps the raw text in notes).
 */
export function vocabularyWriteValue(dimension: VocabularyDimension, raw: unknown, vocab: TenantVocabulary = EMPTY_TENANT_VOCABULARY): { value: string | null; subtype: string | null; resolved: ResolvedTerm | null } {
  const r = resolveVocabularyValue(dimension, raw, vocab)
  if (!r) return { value: null, subtype: null, resolved: null }
  return VOCABULARY_DIMENSIONS[dimension].storage === "rollup"
    ? { value: r.platformKey, subtype: r.origin === "tenant" ? r.key : null, resolved: r }
    : { value: r.key, subtype: null, resolved: r }
}

/** PURE — the brokerage's vocabulary as the checklist matcher reads it (lib/compliance/checklist-dimensions.ts rowApplicability). */
export function checklistVocabularyFor(vocab: TenantVocabulary = EMPTY_TENANT_VOCABULARY): ChecklistVocabulary {
  return {
    lineage: (column, value) => resolveVocabularyValue(column, value, vocab)?.lineage ?? null,
    label: (column, value) => resolveVocabularyValue(column, value, vocab)?.label ?? null,
  }
}

/** PURE — `financingKindFor`'s resolver for a brokerage: a financing value → its PLATFORM financing type. */
export function financingTypeResolver(vocab: TenantVocabulary = EMPTY_TENANT_VOCABULARY): (raw: string) => string | null {
  return (raw) => resolveVocabularyValue("financing_type", raw, vocab)?.platformKey ?? null
}

// ── 4. THE MANAGER'S EVALUATION (deterministic — AI explains, this decides) ──────────────────────────────────

export type VocabularyChange =
  | { op: "add"; dimension: VocabularyDimension; key: string; label: string; rollsUpTo: string; stateCodes: string[] | null; source: { url: string; title: string | null } | null; reason: string }
  | { op: "alias"; dimension: VocabularyDimension; alias: string; target: string; reason: string }
  | { op: "rename"; dimension: VocabularyDimension; key: string; label: string; reason: string }
  | { op: "deactivate" | "reactivate"; dimension: VocabularyDimension; key: string; reason: string }

export interface VocabularyReport {
  dimension: string
  /** The label the user says is missing / obsolete / different in their state, in their words. */
  label: string
  kind: "missing" | "obsolete" | "different_in_state" | "rename"
  stateCode?: string | null
  /** "It means the same as …" → an alias onto that term. */
  sameAs?: string | null
  /** "It is a kind of …" → a new term rolling up to that platform key. */
  rollsUpTo?: string | null
  /** For kind "rename": the new display label. */
  newLabel?: string | null
  sourceUrl?: string | null
  sourceTitle?: string | null
  note?: string | null
}

export interface VocabularyEvaluation {
  verdict: "already_resolves" | "propose" | "needs_detail" | "platform_owned" | "refused"
  change: VocabularyChange | null
  /** Existing terms the label resembles — the reporter chooses "same as" (alias) or "a kind of" (add). */
  candidates: Array<{ key: string; label: string; origin: "platform" | "tenant" }>
  why: string
  /** What the reporter still has to supply before a proposal can be recorded. */
  needs: string[]
}

const tokens = (s: string) => new Set(normalizeVocabularyValue(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1))
function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b)
  if (!x.size || !y.size) return 0
  let inter = 0
  for (const w of x) if (y.has(w)) inter++
  return inter / (x.size + y.size - inter)
}
const slugFor = (label: string) => {
  const s = normalizeVocabularyValue(label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48)
  return /^[a-z]/.test(s) ? s : `t_${s}`.slice(0, 48)
}

/**
 * PURE — the manager's deterministic evaluation of a user's report against the canonical vocabulary:
 * what it already resolves to, what it resembles, which scope (brokerage / the named state) it belongs
 * to, and the ONE change it implies — or what is still missing to propose one. No model call.
 */
export function evaluateVocabularyReport(report: VocabularyReport, vocab: TenantVocabulary = EMPTY_TENANT_VOCABULARY): VocabularyEvaluation {
  const none = (verdict: VocabularyEvaluation["verdict"], why: string, extra: Partial<VocabularyEvaluation> = {}): VocabularyEvaluation =>
    ({ verdict, change: null, candidates: [], why, needs: [], ...extra })
  if (!isDimension(report.dimension)) return none("refused", `"${report.dimension}" is not a vocabulary this platform keeps`)
  const dimension = report.dimension, spec = VOCABULARY_DIMENSIONS[dimension]
  const label = String(report.label ?? "").trim()
  if (!label) return none("refused", "say which label is missing or obsolete")
  if (spec.mode === "platform_only") {
    const topic = dimension === "housing_topic" ? (HOUSING_TOPIC_TREATMENT as Record<string, { note: string }>)[resolveVocabularyValue(dimension, label, vocab)?.key ?? ""] : undefined
    return none("platform_owned", `${spec.label} is owned by the platform (${spec.survivor}): ${spec.why ?? ""}${topic ? ` — ${topic.note}` : ""}`.trim())
  }
  const state = report.stateCode ? String(report.stateCode).trim().toUpperCase() : null
  const existing = resolveVocabularyValue(dimension, label, vocab)
  const reason = String(report.note ?? "").trim().slice(0, 280) || `reported ${report.kind}${state ? ` (${state})` : ""}`
  const candidatesFor = () => [...spec.platform.map((t) => ({ key: t.key, label: resolveKey(dimension, t.key, vocab, "exact")!.label, origin: "platform" as const })),
    ...Object.values(vocab.terms).filter((t) => t.dimension === dimension).map((t) => ({ key: t.key, label: t.label, origin: "tenant" as const }))]
    .map((c) => ({ c, s: Math.max(similarity(label, c.label), similarity(label, c.key)) }))
    .filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.c)

  if (report.kind === "obsolete") {
    if (!existing) return none("refused", `"${label}" is not a ${spec.label.toLowerCase()} here — nothing to retire`, { candidates: candidatesFor() })
    if (spec.mode !== "extensible") return none("refused", `${spec.label} values are not retired by a brokerage: ${spec.why ?? ""}`.trim())
    if (!existing.usable && !existing.pendingAttestation) return none("already_resolves", `"${existing.label}" is already retired for new work (it still reads on historical records)`)
    return { verdict: "propose", change: { op: "deactivate", dimension, key: existing.key, reason }, candidates: [], why: `retire "${existing.label}" for NEW work — historical records keep reading it`, needs: [] }
  }
  if (report.kind === "rename") {
    const newLabel = String(report.newLabel ?? "").trim()
    if (!existing) return none("refused", `"${label}" is not a ${spec.label.toLowerCase()} here — nothing to rename`, { candidates: candidatesFor() })
    if (!newLabel) return none("needs_detail", "say the new label", { needs: ["newLabel"] })
    return { verdict: "propose", change: { op: "rename", dimension, key: existing.key, label: newLabel, reason }, candidates: [], why: `show "${existing.label}" as "${newLabel}" — the stable key ${existing.key} does not change`, needs: [] }
  }
  // missing / different_in_state — a label that already resolves is answered, never duplicated
  if (existing) {
    if (report.sameAs) {
      const target = resolveVocabularyValue(dimension, report.sameAs, vocab)
      if (target && target.key === existing.key) return none("already_resolves", `"${label}" already reads as "${target.label}"`)
      return none("refused", `"${label}" already reads as "${existing.label}" — an alias is never re-pointed silently; retire or rename instead`)
    }
    if (existing.usable) return none("already_resolves", `"${label}" already reads as "${existing.label}" (${existing.key}${existing.via === "exact" ? "" : `, via ${existing.via.replace("_", " ")}`})`)
    if (existing.pendingAttestation) return none("already_resolves", `"${existing.label}" exists and is waiting for a compliance approver to attest its source`)
    return { verdict: "propose", change: { op: "reactivate", dimension, key: existing.key, reason }, candidates: [], why: `"${existing.label}" exists but was retired — reactivate it`, needs: [] }
  }
  if (report.sameAs) {
    const target = resolveVocabularyValue(dimension, report.sameAs, vocab)
    if (!target) return none("needs_detail", `"${report.sameAs}" is not a ${spec.label.toLowerCase()} — choose one of the candidates`, { candidates: candidatesFor(), needs: ["sameAs"] })
    return { verdict: "propose", change: { op: "alias", dimension, alias: normalizeVocabularyValue(label), target: target.key, reason }, candidates: [], why: `read "${label}" as "${target.label}" everywhere, including historical records`, needs: [] }
  }
  if (spec.mode !== "extensible") return none("needs_detail", `${spec.label} takes no new values: ${spec.why ?? ""} — say which existing value it means (an alias)`.trim(), { candidates: candidatesFor(), needs: ["sameAs"] })
  if (!report.rollsUpTo) return none("needs_detail", `say which existing ${spec.label.toLowerCase()} it is a kind of (every new term rolls up to one, so pre-approval, offer requirements, reporting and forms keep working), or which one it means`, { candidates: candidatesFor(), needs: ["rollsUpTo|sameAs"] })
  const parent = platformKeyOf(dimension, String(report.rollsUpTo)) ?? resolveVocabularyValue(dimension, report.rollsUpTo, vocab)?.platformKey ?? null
  if (!parent) return none("needs_detail", `"${report.rollsUpTo}" is not a platform ${spec.label.toLowerCase()}`, { candidates: candidatesFor(), needs: ["rollsUpTo"] })
  const stateCodes = state ? [state] : null
  const needs: string[] = []
  if (spec.jurisdictional && !stateCodes) needs.push("stateCode")
  if ((spec.jurisdictional || stateCodes) && !isPrimarySourceUrl(report.sourceUrl ?? null)) needs.push("sourceUrl (an official .gov / .us source)")
  if (needs.length) return none("needs_detail", `a ${stateCodes ? `${state}-specific` : "state-varying"} ${spec.label.toLowerCase()} needs the state(s) it applies in and the official source that says so — the platform never invents a legal requirement`, { needs })
  return {
    verdict: "propose",
    change: { op: "add", dimension, key: slugFor(label), label, rollsUpTo: parent, stateCodes, source: report.sourceUrl ? { url: String(report.sourceUrl).trim(), title: report.sourceTitle ? String(report.sourceTitle).trim().slice(0, 200) : null } : null, reason },
    candidates: candidatesFor(), why: `add "${label}" as a ${spec.label.toLowerCase()} that rolls up to ${parent}${stateCodes ? ` in ${state}` : " brokerage-wide"}`, needs: [],
  }
}

// ── 5. DEPENDENCY VALIDATION (before a proposal is recorded, and again against the LIVE value before promotion) ──

export interface VocabularyValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  /** A state-scoped change: a compliance approver must approve it and attest its primary source. */
  requiresCompliance: boolean
}

/** PURE. `ruleRefs` = how many required-document rules name the term (the caller counted them). */
export function validateVocabularyChange(change: VocabularyChange, vocab: TenantVocabulary = EMPTY_TENANT_VOCABULARY, deps: { ruleRefs?: number } = {}): VocabularyValidation {
  const errors: string[] = [], warnings: string[] = []
  const done = (requiresCompliance: boolean): VocabularyValidation => ({ ok: errors.length === 0, errors, warnings, requiresCompliance })
  if (!change || !isDimension(change.dimension)) { errors.push("unknown vocabulary"); return done(false) }
  const spec = VOCABULARY_DIMENSIONS[change.dimension]
  if (spec.mode === "platform_only") { errors.push(`${spec.label} is platform-owned: ${spec.why ?? ""}`.trim()); return done(false) }
  const existing = (k: string) => resolveKey(change.dimension, k, vocab, "exact")
  const refs = deps.ruleRefs ?? 0

  if (change.op === "add") {
    if (spec.mode !== "extensible") errors.push(`${spec.label} takes no new values: ${spec.why ?? ""}`.trim())
    if (!KEY_RE.test(change.key)) errors.push(`"${change.key}" is not a stable key (lower-case letters, digits, underscores; starts with a letter)`)
    if (platformKeyOf(change.dimension, change.key)) errors.push(`"${change.key}" is already a platform ${spec.label.toLowerCase()} — propose an alias or a rename`)
    if (vocab.terms[entryId(change.dimension, change.key)]) errors.push(`"${change.key}" already exists for this brokerage — reactivate or rename it`)
    const labelClash = resolveVocabularyValue(change.dimension, change.label, vocab)
    if (labelClash) errors.push(`"${change.label}" already reads as "${labelClash.label}" — a label never means two things`)
    if (!change.label.trim() || change.label.trim().length > 80) errors.push("the label is empty or longer than 80 characters")
    if (!platformKeyOf(change.dimension, change.rollsUpTo)) errors.push(`rolls up to "${change.rollsUpTo}", which is not a platform ${spec.label.toLowerCase()} — every term needs one so platform-only readers keep working`)
    const states = stateCodesOf(change.stateCodes)
    if (states === false) errors.push("state codes must be two-letter codes")
    const scoped = !!(states && states.length)
    if (spec.jurisdictional && !scoped) errors.push(`${spec.label} varies by state — name the state(s) it applies in`)
    if (scoped && !isPrimarySourceUrl(change.source?.url ?? null)) errors.push("a state-scoped term cites an official source (.gov / .us) — a commentary, vendor or blog page is not one")
    if (!scoped && !spec.jurisdictional) warnings.push("a brokerage-wide label — if a state's law is the reason, scope it to that state and cite the source")
    return done(scoped)
  }
  if (change.op === "alias") {
    const alias = normalizeVocabularyValue(change.alias)
    if (!alias || alias.length > 80) errors.push("the alias is empty or longer than 80 characters")
    const already = resolveVocabularyValue(change.dimension, alias, vocab)
    if (already) errors.push(`"${alias}" already reads as "${already.label}" — an alias is never re-pointed silently`)
    const target = existing(change.target)
    if (!target) errors.push(`alias target "${change.target}" is not a ${spec.label.toLowerCase()} here`)
    else warnings.push(`historical values spelled "${alias}" will read as "${target.label}"`)
    return done(!!target?.stateCodes)
  }
  const target = existing(change.key)
  if (!target) { errors.push(`"${change.key}" is not a ${spec.label.toLowerCase()} here`); return done(false) }
  if (change.op === "rename") {
    if (!change.label.trim() || change.label.trim().length > 80) errors.push("the label is empty or longer than 80 characters")
    if (change.label.trim() === target.label) errors.push("the new label is the current label")
    const clash = resolveVocabularyValue(change.dimension, change.label, vocab)
    if (clash && clash.key !== target.key) errors.push(`"${change.label}" already reads as "${clash.label}"`)
    return done(!!target.stateCodes)
  }
  if (spec.mode !== "extensible") { errors.push(`${spec.label} values are not retired by a brokerage: ${spec.why ?? ""}`.trim()); return done(false) }
  if (change.op === "deactivate") {
    if (!target.usable && !target.pendingAttestation) errors.push(`"${target.label}" is already retired`)
    if (refs > 0) warnings.push(`${refs} required-document rule(s) name it — they keep applying (historical values never break); it is hidden from NEW rules and pickers`)
    const aliasCount = Object.values(vocab.aliases).filter((a) => a.dimension === change.dimension && a.target === target.key).length
    if (aliasCount) warnings.push(`${aliasCount} alias(es) point at it and keep resolving`)
    if (target.origin === "platform") warnings.push("a platform term is hidden for this brokerage only — the platform value itself never changes")
  } else {
    const off = target.origin === "platform" ? vocab.deactivations[entryId(change.dimension, target.key)] : null
    const tenantTerm = vocab.terms[entryId(change.dimension, target.key)]
    if (target.origin === "platform" ? !(off && off.active === false) : tenantTerm?.active !== false) errors.push(`"${target.label}" is not retired`)
  }
  return done(!!target.stateCodes)
}

/**
 * PURE — the field PATCH a `policy` proposal on ADAPTIVE_VOCABULARY_POLICY_KEY carries (the proposal kernel
 * merges it one nested level onto the LIVE value at promotion, and a rollback restores only these fields).
 * A deactivation never removes an entry: the term is kept with active:false.
 */
export function vocabularyPatchFor(change: VocabularyChange, vocab: TenantVocabulary, at: string): Record<string, Record<string, unknown>> {
  const id = (k: string) => entryId(change.dimension, k)
  switch (change.op) {
    case "add":
      return { terms: { [id(change.key)]: {
        dimension: change.dimension, key: change.key, label: change.label.trim(), rolls_up_to: change.rollsUpTo,
        state_codes: change.stateCodes && change.stateCodes.length ? change.stateCodes : null,
        source: change.source ? { url: change.source.url, title: change.source.title, verified_on: at.slice(0, 10) } : null,
        active: true, added_at: at, reason: change.reason,
      } } }
    case "alias": {
      const alias = normalizeVocabularyValue(change.alias)
      return { aliases: { [id(aliasSlug(alias))]: { dimension: change.dimension, alias, target: change.target, added_at: at, reason: change.reason } } }
    }
    case "rename": {
      const cur = resolveKey(change.dimension, change.key, vocab, "exact")
      return { labels: { [id(cur?.key ?? change.key)]: { dimension: change.dimension, key: cur?.key ?? change.key, label: change.label.trim(), previous_label: cur?.label ?? null, renamed_at: at } } }
    }
    case "deactivate":
    case "reactivate": {
      const active = change.op === "reactivate"
      const term = vocab.terms[id(change.key)]
      if (term) return { terms: { [id(term.key)]: { ...term, active, [active ? "reactivated_at" : "deactivated_at"]: at, reason: change.reason } } }
      const pk = platformKeyOf(change.dimension, change.key) ?? change.key
      return { deactivations: { [id(pk)]: { dimension: change.dimension, key: pk, active, at, reason: change.reason } } }
    }
  }
}

/** PURE — the compliance approver's attestation of a state-scoped term (written by vocabulary-healing.ts, never proposed). */
export function attestationPatchFor(term: Pick<TenantTerm, "dimension" | "key" | "source">, approver: { userId: string; userType: string }, at: string): Record<string, Record<string, unknown>> {
  return { attestations: { [entryId(term.dimension, term.key)]: { user_id: approver.userId, user_type: approver.userType, at, source_url: term.source?.url ?? "" } } }
}

/** PURE — after promotion: does the LIVE vocabulary now say what the change said? (the "→ verifies" step) */
export function verifyVocabularyChange(change: VocabularyChange, after: TenantVocabulary): { ok: boolean; why: string } {
  switch (change.op) {
    case "add": {
      const r = resolveVocabularyValue(change.dimension, change.key, after)
      if (!r || r.origin !== "tenant" || r.platformKey !== change.rollsUpTo) return { ok: false, why: `"${change.key}" does not resolve to a brokerage term rolling up to ${change.rollsUpTo}` }
      if (!r.usable) return { ok: r.pendingAttestation, why: r.pendingAttestation ? `"${r.label}" landed and waits for a compliance approver's attestation` : `"${r.label}" landed but is not usable` }
      return { ok: true, why: `"${r.label}" resolves (${r.key} → ${r.platformKey}) and is offered for new work` }
    }
    case "alias": {
      const r = resolveVocabularyValue(change.dimension, change.alias, after)
      return r && r.key === change.target ? { ok: true, why: `"${change.alias}" reads as "${r.label}"` } : { ok: false, why: `"${change.alias}" does not read as ${change.target}` }
    }
    case "rename": {
      const r = resolveVocabularyValue(change.dimension, change.key, after)
      return r && r.label === change.label.trim() ? { ok: true, why: `${r.key} now shows as "${r.label}"` } : { ok: false, why: `${change.key} does not show the new label` }
    }
    case "deactivate":
    case "reactivate": {
      const r = resolveVocabularyValue(change.dimension, change.key, after)
      const want = change.op === "reactivate"
      return r && (r.usable || r.pendingAttestation) === want ? { ok: true, why: `${r.key} is ${want ? "offered again" : "retired for new work and still resolves on history"}` } : { ok: false, why: `${change.key} is not ${want ? "active" : "retired"}` }
    }
  }
}

// ── 6. THE ONE ASYNC LOADER ──────────────────────────────────────────────────────────────────────────────────

type Svc = { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any }
const MISSING_FN = new Set(["PGRST202", "42883"])

/**
 * The brokerage's overlay. Prefers the m847 SECURITY DEFINER reader `tenant_adaptive_vocabulary(p_brokerage_id)`
 * (any member of the brokerage may read the vocabulary — brokerage_settings itself is admin-only under RLS);
 * before m847 it reads brokerage_settings directly (service client). FAIL CLOSED: a refused read is
 * `ok:false` — never "no vocabulary", which would read a brokerage term as unknown without saying why.
 */
export async function loadTenantVocabulary(svc: Svc, brokerageId: string): Promise<{ ok: true; vocabulary: TenantVocabulary } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no brokerage — the vocabulary cannot be read" }
  if (typeof svc.rpc === "function") {
    const { data, error } = await svc.rpc("tenant_adaptive_vocabulary", { p_brokerage_id: brokerageId })
    if (!error) return { ok: true, vocabulary: resolveTenantVocabulary(data) }
    if (!MISSING_FN.has(String(error.code ?? ""))) return { ok: false, error: `the brokerage vocabulary could not be read: ${error.message}` }
  }
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `the brokerage vocabulary could not be read: ${error.message}` }
  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings
  return { ok: true, vocabulary: resolveTenantVocabulary(isObj(settings) ? settings[ADAPTIVE_VOCABULARY_POLICY_KEY] : null) }
}
