/**
 * lib/enrichment/life-event-vocabulary.ts — THE ONE VOCABULARY for life events (CLAUDE.md §6), and since wave 148 the ONE
 * CHRONOLOGICAL VOCABULARY MAP (contract C20).
 *
 * WAVE 147, LANE 147Z (convergence; lane 147B "Still open" 5). The life-event writers and the scorers that read them had drifted
 * onto two spellings of the same event, so the scorers could not match the writers:
 *   · the WRITERS — lib/osint-client.ts (`divorce`, `death_in_family`) and lib/enrichment/web-mention-search.ts (same two);
 *   · the READERS — lib/predictive-listing/signal-generators.ts LIFE_EVENT_CONFIDENCE and lib/sphere-resonance/run-resonance-scan.ts
 *     (`divorce_filing`, `death_in_household`) — so a divorce or a death the enrichment found NEVER scored as a predictive seller
 *     signal and never reached the sphere's careful-timing rule.
 * SURVIVOR SPELLINGS: the readers' (`divorce_filing`, `death_in_household`) — they are the scoring vocabulary, they already match
 * the follow-up arbiter's signal_type spelling for a divorce (lib/ai-isa/followup-arbiter.ts LIFE_CHANGE_SIGNAL_KINDS
 * `divorce_filing`) and `foreclosure_filing` is already shared by both sides. The writers now write the survivor spellings.
 *
 * WAVE 148, LANE 148F (owner rulings 5 + 17, contract C20). The owner: "life event spellings need to be set to the chronological
 * vocab map so the code knows how to handle." The 147Z merge fixed two spellings; the repo still held a SPELLING per reader
 * (lead-intelligence's motivating list keyed on the retired `divorce`; referral radar, gift studio and the material-change detector
 * each regex their own words; the follow-up arbiter's signal vocabulary spells probate `probate_filing`), and nothing said what an
 * event MEANS for handling: which category it is, how sensitive, what outreach it allows, and where it sits in TIME relative to
 * the events before and after it. LIFE_EVENT_VOCAB below is that map — ONE entry per canonical event:
 *
 *   canonical → aliases (every spelling ever written or read) → category → chronological chain + stage → supersedes
 *     → sensitivity → C9 movement relevance → follow-up kind → allowed outreach (modes, automated experiences, never-mention terms,
 *       the empathetic tone brief)
 *
 * and every life-event RECORD carries its chronology: `event_at` (when the event happened, by the evidence), `observed_at` (when we
 * saw it), `sequence` (its ordinal in the person's life-event history) and `supersedes` (the earlier record it replaces as the
 * current state — a relocation supersedes the job change that led to it; an inheritance supersedes the death). The SAME four
 * fields ride the C9 store (`movement_signals.event_at / sequence / supersedes`, m919) — no parallel vocabulary table exists or
 * may exist: this map is code (pure, typed), and the database's CHECK on movement_signals.life_event is generated from it.
 *
 * LEGACY_LIFE_EVENT_ALIASES is kept (and DERIVED from the map) for the stored history the backfill (m920) rewrites; no writer
 * produces a retired token (test:movement-signals §J asserts it over stripped source, with a positive control).
 *
 * The element KEY drifted too: the OSINT rung stores `{ event }`, the life-change check stores `{ type }`. Every reader reads the
 * element through lifeEventTypeOf (type, else event) — one reader rule, both stored shapes — and every WRITER now writes `{ type }`
 * through normalizeLifeEvent / mergeLifeEvents.
 *
 * RULING 17 (owner, 2026-11-01): "a life event signal should never just send to a human and the arbiter should decide the best way
 * to warm engagement without mentioning the life event — it is about them and their emotions at this time." So `allowedOutreach`
 * names the FIVE modes the arbiter chooses among (quiet monitoring · research · helpful education · appropriate outreach · a
 * human), the automated experiences that may carry warm, event-agnostic help, and the words an outreach draft may NEVER contain
 * (screenLifeEventOutreach refuses a draft that names or alludes to the event — the positive control of test:life-event-engagement).
 *
 * PURE — no imports, safe in any graph (page, proof, cron).
 */

export const LIFE_EVENT_TYPES = Object.freeze([
  "job_change", "job_change_to_non_local", "marriage", "new_baby", "kids_graduated", "empty_nester", "retirement",
  "divorce_filing", "foreclosure_filing", "death_in_household", "inheritance", "bankruptcy", "relocation",
] as const)
export type LifeEventType = (typeof LIFE_EVENT_TYPES)[number]

/** What kind of moment it is (handling, never targeting). */
export type LifeEventCategory = "career" | "relocation" | "household" | "marital" | "estate" | "financial_distress"
/** The chronological chain an event belongs to — each chain is ordered by `stage` (1 = earliest). */
export type LifeEventChain = "career_move" | "household" | "marital" | "estate" | "financial_distress"
/** How carefully it is handled. intimate / financial_hardship / protected_proxy are never a segment, an audience or steering. */
export type LifeEventSensitivity = "intimate" | "financial_hardship" | "protected_proxy" | "career" | "relocation"
/** The C9 movement relevance (lib/intent/movement-source-registry.ts MovementRelevance) — spelled here so this module stays pure;
 *  lib/intent/movement-signals.ts LIFE_EVENT_RELEVANCE is DERIVED from it with a compile-time check against the C9 type. */
export type LifeEventMovementRelevance = "divorce" | "probate_estate" | "relocation" | "life_stage" | "property_event"
/** The follow-up arbiter's signal kind (lib/ai-isa/followup-arbiter.ts LifeChangeKind subset). */
export type LifeEventFollowupKind = "life_event" | "moving"

/** RULING 17 — the five ways the arbiter may answer a life-event signal. None of them is "hand it to a human and stop". */
export const LIFE_EVENT_ENGAGEMENT_MODES = Object.freeze(["quiet_monitoring", "research", "helpful_education", "appropriate_outreach", "human"] as const)
export type LifeEventEngagementMode = (typeof LIFE_EVENT_ENGAGEMENT_MODES)[number]

/** Automated planner experiences (lib/ai-isa/lead-action-plan.ts EXPERIENCE_KINDS subset) that may carry warm, event-agnostic help. */
export type LifeEventAutomatedExperience = "education" | "communication" | "market_update" | "properties"

export interface LifeEventAllowedOutreach {
  /** Modes the arbiter may choose for this event (always all five — the policy narrows by evidence + authority, not by event). */
  modes: readonly LifeEventEngagementMode[]
  /** Automated experiences that may carry help for this event — ONLY with sufficient evidence AND the tenant's explicit autonomy. */
  automatedExperiences: readonly LifeEventAutomatedExperience[]
  /** The person TOLD us (their own words): a reply may acknowledge what they said. Never for intimate / hardship / proxy events. */
  acknowledgeIfSelfDisclosed: boolean
  /** Regex sources (case-insensitive) a draft must never contain for this event — naming it OR alluding to it. */
  neverMention: readonly string[]
  /** The empathetic brief for whoever (model or person) writes the help. */
  tone: string
}

export interface LifeEventVocabEntry {
  canonical: LifeEventType
  /** Every other spelling ever written or read for this event (lower-case, `_` separated). Read-side tolerance; never written. */
  aliases: readonly string[]
  category: LifeEventCategory
  chain: LifeEventChain
  /** Position in its chain (1 = earliest). Two events of one chain are ordered by stage before time. */
  stage: number
  /** Earlier events this one REPLACES as the person's current state (any chain) — and always an older record of the same type. */
  supersedes: readonly LifeEventType[]
  sensitivity: LifeEventSensitivity
  /** C9 event_relevance, or null when the event is not a movement signal (bankruptcy). */
  movementRelevance: LifeEventMovementRelevance | null
  /** Marital / familial status or age proxy (stored for authorised research, never targeting). */
  protectedProxy: boolean
  followupKind: LifeEventFollowupKind
  allowedOutreach: LifeEventAllowedOutreach
}

const ALL_MODES = LIFE_EVENT_ENGAGEMENT_MODES
const TONE = {
  intimate: "A season of loss or upheaval. Unhurried, gentle, practical; zero urgency; no congratulations, no condolences used as an opener, nothing that implies we know what happened — offer something genuinely useful and leave the door open.",
  hardship: "Dignity first. No pressure, no assumptions about money, no talk of deadlines or deals; practical, respectful, easy to ignore.",
  proxy: "Warm and neighbourly. Never assume household composition, age, family plans or relationships; help that would suit anyone.",
  career: "Upbeat, useful and never presumptuous — a neighbour sharing something handy, not a salesperson reacting to news.",
  relocation: "Practical and welcoming. Useful local know-how; acknowledge the move only if the person told us themselves.",
} as const

/** Words that reveal we are WATCHING — never in any automated outreach, whatever the event. */
export const LIFE_EVENT_SURVEILLANCE_TELLS: readonly string[] = Object.freeze([
  "\\bwe noticed\\b", "\\bi noticed\\b", "\\bwe saw that\\b", "\\bi saw that you\\b", "\\bnoticed that you\\b", "\\bheard (?:about|that) you",
  "\\bpublic records?\\b", "\\bcourt records?\\b", "\\brecords show\\b", "\\baccording to (?:public |county |court )?records\\b", "\\bfiled for\\b", "\\byour filing\\b",
])

const M = <T extends string>(...s: T[]): readonly T[] => Object.freeze(s)
const S = (...s: LifeEventType[]): readonly LifeEventType[] => Object.freeze(s)

/**
 * THE CHRONOLOGICAL VOCABULARY MAP (C20). Keyed by the canonical spelling; `aliases` absorb every spelling found in the tree on
 * 2026-11-01 (osint-client, web-mention-search, contact-enrichment-core, referral-radar, gift-studio, lead-intelligence, the
 * material-change detector, the arbiter's signal vocabulary) and the ones a provider plausibly writes.
 */
export const LIFE_EVENT_VOCAB: Readonly<Record<LifeEventType, LifeEventVocabEntry>> = Object.freeze({
  // ── career → relocation (career_move chain) ─────────────────────────────────────────────────────────────────────────────────
  job_change: {
    canonical: "job_change", aliases: M("new_job", "job_start", "started_new_job", "new_role", "new_position", "promotion", "promoted", "career_change", "new_employer", "new_company"),
    category: "career", chain: "career_move", stage: 1, supersedes: S(), sensitivity: "career", movementRelevance: "life_stage", protectedProxy: false, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication", "market_update"), acknowledgeIfSelfDisclosed: true,
      neverMention: M("\\bnew (?:job|role|position)\\b", "\\bpromot(?:ion|ed)\\b", "\\bcongrat\\w* on (?:the |your )?(?:new )?(?:job|role|position)", "\\bjob change\\b", "\\bnew employer\\b"), tone: TONE.career },
  },
  job_change_to_non_local: {
    canonical: "job_change_to_non_local", aliases: M("job_change_non_local", "out_of_area_job", "job_transfer", "transferred", "relocation_for_work", "work_relocation"),
    category: "career", chain: "career_move", stage: 2, supersedes: S("job_change"), sensitivity: "relocation", movementRelevance: "relocation", protectedProxy: false, followupKind: "moving",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication", "market_update", "properties"), acknowledgeIfSelfDisclosed: true,
      neverMention: M("\\byour transfer\\b", "\\btransferred to\\b", "\\bnew job in\\b", "\\brelocating for work\\b"), tone: TONE.relocation },
  },
  relocation: {
    canonical: "relocation", aliases: M("relocating", "relocated", "relocation_announcement", "new_mover", "change_of_address"),
    category: "relocation", chain: "career_move", stage: 3, supersedes: S("job_change", "job_change_to_non_local"), sensitivity: "relocation", movementRelevance: "relocation", protectedProxy: false, followupKind: "moving",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication", "market_update", "properties"), acknowledgeIfSelfDisclosed: true,
      neverMention: M("\\bheard (?:you(?:'re| are)|that you(?:'re| are)) (?:moving|relocating)\\b", "\\bsaw (?:you(?:'re| are)|that you(?:'re| are)) (?:moving|relocating)\\b", "\\byour (?:move|relocation) announcement\\b"), tone: TONE.relocation },
  },
  // ── household (protected-proxy chain: marital / familial status, age) ──────────────────────────────────────────────────────
  marriage: {
    canonical: "marriage", aliases: M("married", "wedding", "engaged", "engagement_announcement", "newlywed", "marriage_announcement", "spouse"),
    category: "household", chain: "household", stage: 1, supersedes: S(), sensitivity: "protected_proxy", movementRelevance: "life_stage", protectedProxy: true, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\bwedding\\b", "\\bnewlywed", "\\bjust married\\b", "\\bmarriage\\b", "\\bmarried\\b", "\\bengaged\\b", "\\bengagement (?:ring|announcement)\\b", "\\bhoneymoon\\b", "\\bspouse\\b"), tone: TONE.proxy },
  },
  new_baby: {
    canonical: "new_baby", aliases: M("baby", "birth", "newborn", "new_child", "child_born", "birth_announcement"),
    category: "household", chain: "household", stage: 2, supersedes: S(), sensitivity: "protected_proxy", movementRelevance: "life_stage", protectedProxy: true, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\bbab(?:y|ies)\\b", "\\bnewborn", "\\bnursery\\b", "\\blittle one\\b", "\\bgrowing family\\b", "\\bnew arrival\\b", "\\bparenthood\\b"), tone: TONE.proxy },
  },
  kids_graduated: {
    canonical: "kids_graduated", aliases: M("graduation", "kids_graduating", "child_graduated", "college_bound"),
    category: "household", chain: "household", stage: 3, supersedes: S("new_baby"), sensitivity: "protected_proxy", movementRelevance: "life_stage", protectedProxy: true, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\bgraduat", "\\boff to college\\b", "\\bkids? (?:are )?(?:leaving|heading off)\\b"), tone: TONE.proxy },
  },
  empty_nester: {
    canonical: "empty_nester", aliases: M("empty_nest", "kids_moved_out", "kids_left_home"),
    category: "household", chain: "household", stage: 4, supersedes: S("kids_graduated"), sensitivity: "protected_proxy", movementRelevance: "life_stage", protectedProxy: true, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\bempty[- ]nest", "\\bkids (?:have )?(?:moved|left)\\b", "\\bquiet house\\b"), tone: TONE.proxy },
  },
  retirement: {
    canonical: "retirement", aliases: M("retired", "retiring"),
    category: "household", chain: "household", stage: 5, supersedes: S("job_change"), sensitivity: "protected_proxy", movementRelevance: "life_stage", protectedProxy: true, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\bretir", "\\bgolden years\\b", "\\bdownsiz"), tone: TONE.proxy },
  },
  // ── intimate (marital dissolution, estate) ─────────────────────────────────────────────────────────────────────────────────
  divorce_filing: {
    canonical: "divorce_filing", aliases: M("divorce", "dissolution", "dissolution_of_marriage", "separation", "legal_separation", "divorced"),
    category: "marital", chain: "marital", stage: 1, supersedes: S("marriage"), sensitivity: "intimate", movementRelevance: "divorce", protectedProxy: true, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\bdivorc", "\\bseparat(?:ion|ed|ing)\\b", "\\bsplit(?:ting)? up\\b", "\\bex[- ](?:husband|wife|spouse|partner)\\b", "\\bcustody\\b", "\\bdissolution\\b", "\\bfresh start\\b", "\\bnew chapter\\b"), tone: TONE.intimate },
  },
  death_in_household: {
    canonical: "death_in_household", aliases: M("death_in_family", "death", "deceased", "obituary", "passed_away", "bereavement", "widowed"),
    category: "estate", chain: "estate", stage: 1, supersedes: S(), sensitivity: "intimate", movementRelevance: "probate_estate", protectedProxy: false, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\bcondolence", "\\bsorry for your loss\\b", "\\bloss\\b", "\\bpass(?:ed|ing) away\\b", "\\bfuneral\\b", "\\bobituar", "\\bin (?:loving )?memory\\b", "\\bwidow", "\\bdeceased\\b", "\\bdeath\\b", "\\bdied\\b", "\\bgrie(?:f|ving)\\b", "\\bbereave"), tone: TONE.intimate },
  },
  inheritance: {
    canonical: "inheritance", aliases: M("probate", "probate_filing", "estate", "estate_of", "inherited", "inherited_property", "executor", "heir"),
    category: "estate", chain: "estate", stage: 2, supersedes: S("death_in_household"), sensitivity: "intimate", movementRelevance: "probate_estate", protectedProxy: false, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\binherit", "\\bprobate\\b", "\\bestate of\\b", "\\bthe estate\\b", "\\bexecut(?:or|rix)\\b", "\\bheirs?\\b", "\\bpersonal representative\\b", "\\bestate sale\\b", "\\bcondolence", "\\bsorry for your loss\\b"), tone: TONE.intimate },
  },
  // ── financial distress ─────────────────────────────────────────────────────────────────────────────────────────────────────
  foreclosure_filing: {
    canonical: "foreclosure_filing", aliases: M("foreclosure", "pre_foreclosure", "preforeclosure", "notice_of_default", "lis_pendens", "trustee_sale"),
    category: "financial_distress", chain: "financial_distress", stage: 1, supersedes: S(), sensitivity: "financial_hardship", movementRelevance: "property_event", protectedProxy: false, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\bforeclos", "\\bnotice of default\\b", "\\blis pendens\\b", "\\bbehind on (?:your )?(?:payments|mortgage)\\b", "\\bmissed payments?\\b", "\\bforeclosure auction\\b", "\\bsheriff'?s? sale\\b", "\\btrustee'?s? sale\\b", "\\bavoid losing\\b", "\\bsave your home\\b"), tone: TONE.hardship },
  },
  bankruptcy: {
    canonical: "bankruptcy", aliases: M("bankruptcy_filing", "chapter_7", "chapter_13", "bankrupt"),
    category: "financial_distress", chain: "financial_distress", stage: 2, supersedes: S(), sensitivity: "financial_hardship", movementRelevance: null, protectedProxy: false, followupKind: "life_event",
    allowedOutreach: { modes: ALL_MODES, automatedExperiences: M("education", "communication"), acknowledgeIfSelfDisclosed: false,
      neverMention: M("\\bbankrupt", "\\bchapter (?:7|13|seven|thirteen)\\b", "\\bdebt relief\\b", "\\bcreditors?\\b"), tone: TONE.hardship },
  },
})

/**
 * Tokens that are NEVER a life event of this platform: health / pregnancy / care inferences (lib/intent/movement-source-registry.ts
 * NOT_PERMITTED_MOVEMENT_SOURCES — "intimate inference from private behaviour — never, under any purpose"). A writer handing one
 * in is DROPPED by normalizeLifeEvent / mergeLifeEvents (counted, never stored, never mapped onto a permitted event).
 */
export const PROHIBITED_LIFE_EVENT_TOKENS: ReadonlySet<string> = new Set([
  "pregnancy", "pregnant", "expecting", "illness", "diagnosis", "diagnosed", "hospice", "hospitalized", "medical", "disability", "rehab", "pregnancy_announcement",
])

const norm = (raw: unknown): string => String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")

const ALIAS_INDEX: ReadonlyMap<string, LifeEventType> = (() => {
  const m = new Map<string, LifeEventType>()
  for (const t of LIFE_EVENT_TYPES) {
    m.set(t, t)
    for (const a of LIFE_EVENT_VOCAB[t].aliases) {
      // One spelling, one meaning — a duplicate alias would be a second vocabulary inside this one.
      if (m.has(a) && m.get(a) !== t) throw new Error(`life-event alias "${a}" maps to both ${m.get(a)} and ${t}`)
      m.set(a, t)
    }
  }
  return m
})()

/**
 * The 147Z retired spellings → survivor (stored history only — the m920 backfill rewrites them). DERIVED from the map so the two
 * can never disagree; kept as its own export because test:movement-signals §J scans the writers for exactly these tokens.
 */
export const LEGACY_LIFE_EVENT_ALIASES: Readonly<Record<string, LifeEventType>> = Object.freeze({
  divorce: ALIAS_INDEX.get("divorce")!,
  death_in_family: ALIAS_INDEX.get("death_in_family")!,
})

/** PURE. A raw stored / written token → the canonical spelling, or null when it is not a life event of this vocabulary. */
export function canonicalLifeEventType(raw: unknown): LifeEventType | null {
  const t = norm(raw)
  if (!t || PROHIBITED_LIFE_EVENT_TOKENS.has(t)) return null
  return ALIAS_INDEX.get(t) ?? null
}

/** PURE. A contacts.life_events element (either stored shape: `{ type }` or `{ event }`, or a bare string) → its canonical spelling. */
export function lifeEventTypeOf(el: { type?: unknown; event?: unknown } | string | null | undefined): LifeEventType | null {
  if (typeof el === "string") return canonicalLifeEventType(el)
  if (!el || typeof el !== "object") return null
  return canonicalLifeEventType(el.type ?? el.event)
}

/** PURE. The map entry for any spelling (null when not a life event). */
export function lifeEventVocabEntry(raw: unknown): LifeEventVocabEntry | null {
  const t = canonicalLifeEventType(raw)
  return t ? LIFE_EVENT_VOCAB[t] : null
}

// ── CHRONOLOGY (C20: event_at · observed_at · sequence · supersedes) ──────────────────────────────────────────────────────────

/** One life-event record as every writer stores it (contacts.life_events / leads.life_events element). Extra provenance fields ride along. */
export interface LifeEventRecord {
  type: LifeEventType
  /** When the event happened, by the evidence (a filing / publication / event date). null = the evidence did not date it. */
  event_at: string | null
  /** When WE observed it. */
  observed_at: string
  /** Ordinal in this person's life-event history (1 = the first record we ever kept). */
  sequence: number
  /** The `sequence` of the earlier record this one replaces as the current state, or null. */
  supersedes: number | null
  [extra: string]: unknown
}

const isoOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const dayOf = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null)

/** The event-date keys the writers have used (first wins). */
const EVENT_AT_KEYS = ["event_at", "event_date", "date", "source_date", "publishedDate", "published_date", "filed_at", "filing_date"] as const
const OBSERVED_AT_KEYS = ["observed_at", "detected_at", "detectedAt", "captured_at"] as const

export type LifeEventDrop = { token: string; reason: string }

/**
 * PURE. Any writer's raw element (`{ event }`, `{ type }`, a bare string, a provider's `{ type, date, description }`) → a canonical
 * record WITHOUT its sequence (assigned by mergeLifeEvents), or the reason it is not one. The element key becomes `type`.
 */
/** A canonical record before mergeLifeEvents assigns its place in the history (sequence / supersedes optional). */
export interface NormalizedLifeEvent {
  type: LifeEventType
  event_at: string | null
  observed_at: string
  sequence?: number
  supersedes?: number | null
  [extra: string]: unknown
}

export function normalizeLifeEvent(raw: unknown, opts: { observedAt: string }): { ok: true; record: NormalizedLifeEvent } | { ok: false; drop: LifeEventDrop } {
  const el = (typeof raw === "string" ? { type: raw } : raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : null) as Record<string, unknown> | null
  if (!el) return { ok: false, drop: { token: String(raw), reason: "not a life-event element" } }
  const token = norm(el.type ?? el.event)
  if (PROHIBITED_LIFE_EVENT_TOKENS.has(token)) return { ok: false, drop: { token, reason: "a health / pregnancy / care inference is never a life event of this platform (intimate inference — never stored)" } }
  const type = canonicalLifeEventType(token)
  if (!type) return { ok: false, drop: { token, reason: "not in LIFE_EVENT_VOCAB (never guessed onto a nearby event)" } }
  let eventAt: string | null = null
  for (const k of EVENT_AT_KEYS) { eventAt = isoOrNull(el[k]); if (eventAt) break }
  let observedAt: string | null = null
  for (const k of OBSERVED_AT_KEYS) { observedAt = isoOrNull(el[k]); if (observedAt) break }
  const rest: Record<string, unknown> = { ...el }
  // The canonical keys are re-added below in ONE fixed order, so a record written twice reads byte-identical (idempotent writes).
  for (const k of ["event", "type", "event_at", "observed_at", "sequence", "supersedes"]) delete rest[k]
  const record: NormalizedLifeEvent = {
    ...rest, type, event_at: eventAt, observed_at: observedAt ?? isoOrNull(opts.observedAt) ?? new Date().toISOString(),
  }
  if (typeof el.sequence === "number" && Number.isInteger(el.sequence) && el.sequence > 0) record.sequence = el.sequence
  if (typeof el.supersedes === "number" && Number.isInteger(el.supersedes) && el.supersedes > 0) record.supersedes = el.supersedes
  return { ok: true, record }
}

/** Two records are the SAME event when their canonical type matches and their event days agree (an undated side matches any day). */
function sameEvent(a: { type: LifeEventType; event_at: string | null }, b: { type: LifeEventType; event_at: string | null }): boolean {
  if (a.type !== b.type) return false
  const da = dayOf(a.event_at), db = dayOf(b.event_at)
  return da === null || db === null || da === db
}

const timeOf = (r: { event_at: string | null; observed_at: string }): number => Date.parse(r.event_at ?? r.observed_at) || 0

/**
 * PURE. THE ONE WRITE RULE for a person's life events (every writer calls it; nobody hand-appends again):
 *   · the stored array is CANONICALISED (retired spellings → canonical, `{ event }` → `{ type }`), keeping every provenance field;
 *     elements that are not life events of the vocabulary are kept untouched (not ours to drop) and counted;
 *   · stored records without a sequence get one in stored order; new records continue the sequence;
 *   · DEDUP — an incoming record that is the same event (type + event day, an undated side matching) as one already kept is not
 *     appended (the older record keeps its sequence; a missing event date is filled from the newer evidence);
 *   · CHRONOLOGY — a new record SUPERSEDES the latest earlier record of the same type or of a type its entry lists in `supersedes`
 *     (a relocation supersedes the job change; a second relocation supersedes the first);
 *   · prohibited tokens (health / pregnancy) are DROPPED with their reason — never stored.
 */
export function mergeLifeEvents(existing: unknown, incoming: readonly unknown[], opts: { now: Date | string }): {
  events: Array<Record<string, unknown>>
  added: LifeEventRecord[]
  duplicates: number
  dropped: LifeEventDrop[]
  untouched: number
} {
  const nowIso = typeof opts.now === "string" ? (isoOrNull(opts.now) ?? new Date().toISOString()) : opts.now.toISOString()
  const stored = Array.isArray(existing) ? existing : []
  const out: Array<Record<string, unknown>> = []
  const kept: LifeEventRecord[] = []
  const dropped: LifeEventDrop[] = []
  let untouched = 0
  let maxSeq = 0
  for (const el of stored) {
    const s = el && typeof el === "object" ? (el as Record<string, unknown>).sequence : undefined
    if (typeof s === "number" && Number.isInteger(s) && s > maxSeq) maxSeq = s
  }
  for (const el of stored) {
    const n = normalizeLifeEvent(el, { observedAt: nowIso })
    if (!n.ok) {
      if (PROHIBITED_LIFE_EVENT_TOKENS.has(n.drop.token)) { dropped.push(n.drop); continue }
      untouched++
      out.push(el && typeof el === "object" ? (el as Record<string, unknown>) : { type: String(el) })
      continue
    }
    const rec: LifeEventRecord = { ...n.record, sequence: n.record.sequence ?? ++maxSeq, supersedes: n.record.supersedes ?? null }
    kept.push(rec)
    out.push(rec)
  }
  const added: LifeEventRecord[] = []
  let duplicates = 0
  for (const el of incoming) {
    const n = normalizeLifeEvent(el, { observedAt: nowIso })
    if (!n.ok) { dropped.push(n.drop); continue }
    const dup = kept.find((k) => sameEvent(k, n.record))
    if (dup) {
      duplicates++
      if (!dup.event_at && n.record.event_at) dup.event_at = n.record.event_at
      continue
    }
    const entry = LIFE_EVENT_VOCAB[n.record.type]
    const replaces = kept
      .filter((k) => (k.type === n.record.type || entry.supersedes.includes(k.type)) && timeOf(k) <= timeOf(n.record))
      .sort((a, b) => timeOf(b) - timeOf(a) || b.sequence - a.sequence)[0]
    const rec: LifeEventRecord = { ...n.record, sequence: ++maxSeq, supersedes: replaces ? replaces.sequence : null }
    kept.push(rec)
    added.push(rec)
    out.push(rec)
  }
  return { events: out, added, duplicates, dropped, untouched }
}

/** PURE. The person's life events in chronological order (stage within a chain breaks a same-moment tie). */
export function lifeEventChronology(events: unknown, opts: { observedFallback?: string | null } = {}): LifeEventRecord[] {
  // An element that never recorded when we saw it takes the caller's fallback (the row's last_life_event_detected) — never "now".
  const fallback = (opts.observedFallback && isoOrNull(opts.observedFallback)) || new Date(0).toISOString()
  const merged = mergeLifeEvents(events, [], { now: fallback }).events
  return merged
    .map((e) => normalizeLifeEvent(e, { observedAt: fallback }))
    .filter((n): n is Extract<typeof n, { ok: true }> => n.ok)
    .map((n) => ({ ...n.record, sequence: n.record.sequence ?? 0, supersedes: n.record.supersedes ?? null }))
    .sort((a, b) => timeOf(a) - timeOf(b) || LIFE_EVENT_VOCAB[a.type].stage - LIFE_EVENT_VOCAB[b.type].stage || a.sequence - b.sequence)
}

/** PURE. The records that still describe the person NOW: every record no later record supersedes. */
export function currentLifeEvents(events: unknown): LifeEventRecord[] {
  const chron = lifeEventChronology(events)
  const replaced = new Set(chron.map((r) => r.supersedes).filter((s): s is number => typeof s === "number"))
  return chron.filter((r) => !replaced.has(r.sequence))
}

// ── RULING 17: THE OUTREACH SCREEN — a draft never names or alludes to the event ───────────────────────────────────────────────

export interface LifeEventScreenHit { event: LifeEventType | "surveillance"; term: string }

/** Sensitivities whose words are NEVER in automated outreach, whether or not this person's record carries the event (a funeral, a
 *  divorce, a foreclosure is never the opener of automated help). Protected-proxy and career words are screened only for the events
 *  the person's record carries — "nursery" in a listing description is a room, not an allusion. */
const ALWAYS_SCREENED: ReadonlySet<LifeEventSensitivity> = new Set(["intimate", "financial_hardship"])

/**
 * PURE. Screen an outreach draft (subject + body) against the life-event map. REFUSED when it contains:
 *   · any surveillance tell ("we noticed", "public records", "filed for" …);
 *   · any never-mention term of an intimate / financial-hardship event (always — those words are never the opener of automated
 *     help, whatever we think we know);
 *   · any never-mention term of a protected-proxy / career / relocation event the PERSON'S record carries (`events`) — unless they
 *     told us themselves (`selfDisclosed`) and the entry allows acknowledging it.
 * The screen is the deterministic backstop; the expert prompts tell the writer the same thing first.
 */
export function screenLifeEventOutreach(text: string, opts: { events?: unknown; selfDisclosed?: readonly LifeEventType[] } = {}): { ok: boolean; hits: LifeEventScreenHit[] } {
  const hay = String(text ?? "")
  const hits: LifeEventScreenHit[] = []
  for (const re of LIFE_EVENT_SURVEILLANCE_TELLS) {
    const m = hay.match(new RegExp(re, "i"))
    if (m) hits.push({ event: "surveillance", term: m[0] })
  }
  const carried = new Set<LifeEventType>()
  for (const el of Array.isArray(opts.events) ? opts.events : []) { const t = lifeEventTypeOf(el as never); if (t) carried.add(t) }
  const disclosed = new Set(opts.selfDisclosed ?? [])
  for (const t of LIFE_EVENT_TYPES) {
    const e = LIFE_EVENT_VOCAB[t]
    const screened = ALWAYS_SCREENED.has(e.sensitivity) || (carried.has(t) && !(disclosed.has(t) && e.allowedOutreach.acknowledgeIfSelfDisclosed))
    if (!screened) continue
    for (const re of e.allowedOutreach.neverMention) {
      const m = hay.match(new RegExp(re, "i"))
      if (m) { hits.push({ event: t, term: m[0] }); break }
    }
  }
  return { ok: hits.length === 0, hits }
}

/** PURE. The empathetic tone brief for a person's CURRENT life events (most sensitive first), or null when none is carried. */
export function lifeEventToneBrief(events: unknown): string | null {
  const order: LifeEventSensitivity[] = ["intimate", "financial_hardship", "protected_proxy", "career", "relocation"]
  const cur = currentLifeEvents(events)
  if (cur.length === 0) return null
  const top = [...cur].sort((a, b) => order.indexOf(LIFE_EVENT_VOCAB[a.type].sensitivity) - order.indexOf(LIFE_EVENT_VOCAB[b.type].sensitivity))[0]
  return LIFE_EVENT_VOCAB[top.type].allowedOutreach.tone
}
