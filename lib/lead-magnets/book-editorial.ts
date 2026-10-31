// lib/lead-magnets/book-editorial.ts
//
// THE BOOK'S EDITORIAL RULES, PURE (wave 144, lane 144H; owner ruling 15: "publishing serves the PLATFORM's Amazon (KDP)
// book AND tenant/agent lead magnets AND tenant KDP books. Topics must not be generic — pick topics with evidence of
// demand and unmet interest … ALWAYS a humanized review after the draft; never promise bestseller status").
//
// The pipeline is lib/lead-magnets/book-creator.ts (research → outline → chapters → fact check → edit → layout) and the
// retail half lib/lead-magnets/book-publishing-produce.ts (KDP package). Neither knew WHOSE book it was making, judged a
// topic by anything but "the search returned questions", or required the human to read the draft as a human before it
// went out. This module holds those three rules — no I/O, no model call, so each is proven directly:
//
//   1. PUBLICATION CONTEXT — lead_magnet (a tenant/agent capture asset), tenant_kdp (the tenant's/agent's own retail book on
//      THEIR KDP account), platform_kdp (the PLATFORM's own retail book, made in the platform's house tenant under the
//      platform's product brand). The owner, the brand source and every change of context are recorded on the project.
//   2. TOPIC EVIDENCE — demand (what the audience is asking, the tenant's topic bank), the audience problem, competitor
//      positioning (books already on the topic), the GAPS between them (unmet interest), originality (the concept is not a
//      re-titling of an existing book), conversion (what this tenant's magnets of the same type already captured). A
//      verdict that is not "evidenced" stops the outline before any model spend. The research is a SIGNAL, never a promise:
//      nothing here predicts a sales rank.
//   3. THE HUMANIZED REVIEW — a deterministic scan for machine-written tells. A chapter the AI drafted that still carries a
//      tell cannot publish (lead magnet) or package (KDP) until the HUMAN rewrites it in their own voice; a chapter the
//      human revised is the human's words and is never re-flagged.

// ── 1 · Publication context ────────────────────────────────────────────────────────────────────

export const BOOK_PUBLICATION_CONTEXTS = ["lead_magnet", "tenant_kdp", "platform_kdp"] as const
export type BookPublicationContext = (typeof BOOK_PUBLICATION_CONTEXTS)[number]

export interface BookPublication {
  context: BookPublicationContext
  /** Who owns the book: the agent whose magnet it is, the brokerage (no agent), or the platform (house tenant). */
  owner: "agent" | "brokerage" | "platform"
  /** Where its logo / colours / tagline come from: the tenant's brand cascade, or the platform's product brand. */
  brand_source: "tenant" | "platform"
  set_by: string | null
  set_at: string
  /** Every change of context, in order — the first entry is the project's start. */
  history: Array<{ context: BookPublicationContext; by: string | null; at: string; why: string }>
}

export function isBookPublicationContext(v: unknown): v is BookPublicationContext {
  return typeof v === "string" && (BOOK_PUBLICATION_CONTEXTS as readonly string[]).includes(v)
}

/**
 * PURE. Which contexts a tenant may use. The platform's house tenant (brokerages.is_demo — the tenant platform renders are
 * filed under) makes PLATFORM books only; every other tenant makes its own. A refusal names the rule.
 */
export function bookContextAllowed(context: BookPublicationContext, tenant: { isHouseTenant: boolean }): { ok: true } | { ok: false; error: string } {
  if (context === "platform_kdp" && !tenant.isHouseTenant) return { ok: false, error: "A platform KDP book is made only in the platform's own house tenant — this brokerage's books are its own (lead magnet or tenant KDP)." }
  if (context === "tenant_kdp" && tenant.isHouseTenant) return { ok: false, error: "The platform's house tenant publishes PLATFORM books (platform_kdp), not tenant KDP books." }
  return { ok: true }
}

/** PURE. The context a book starts in: what the caller asked for, else the tenant's default (house tenant → platform). */
export function defaultBookContext(requested: BookPublicationContext | null | undefined, tenant: { isHouseTenant: boolean }): BookPublicationContext {
  if (requested) return requested
  return tenant.isHouseTenant ? "platform_kdp" : "lead_magnet"
}

/** PURE. The retail context a KDP build moves a book into (a lead magnet becomes the tenant's — or the platform's — retail book). */
export function kdpContextFor(current: BookPublicationContext, tenant: { isHouseTenant: boolean }): BookPublicationContext {
  if (current !== "lead_magnet") return current
  return tenant.isHouseTenant ? "platform_kdp" : "tenant_kdp"
}

/** PURE. A new publication record (or the next one, when `prev` is given and the context changes). */
export function publicationRecord(args: { context: BookPublicationContext; agentId: string | null; isHouseTenant: boolean; by: string | null; at: string; why: string; prev?: BookPublication | null }): BookPublication {
  const owner: BookPublication["owner"] = args.isHouseTenant ? "platform" : args.agentId ? "agent" : "brokerage"
  const brand_source: BookPublication["brand_source"] = args.isHouseTenant ? "platform" : "tenant"
  const history = [...(args.prev?.history ?? [])]
  if (!args.prev || args.prev.context !== args.context) history.push({ context: args.context, by: args.by, at: args.at, why: args.why })
  return { context: args.context, owner, brand_source, set_by: args.by, set_at: args.at, history }
}

// ── 2 · Topic evidence ─────────────────────────────────────────────────────────────────────────

const STOP = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "your", "you", "yours", "our", "their", "this", "that", "these", "those", "what", "when",
  "where", "which", "who", "whom", "why", "how", "are", "was", "were", "will", "would", "can", "could", "should", "does", "did", "not", "but",
  "about", "over", "under", "than", "then", "them", "they", "its", "his", "her", "all", "any", "each", "more", "most", "very", "just",
  "also", "only", "out", "off", "own", "via", "per", "year", "years", "next", "new", "one", "two", "get", "got", "make", "making",
])
// The vocabulary EVERY real-estate book shares — a concept made only of these names no niche.
const GENERIC = new Set([
  "home", "homes", "house", "houses", "housing", "buy", "buys", "buying", "buyer", "buyers", "sell", "sells", "selling", "seller", "sellers",
  "guide", "guides", "guidebook", "book", "books", "handbook", "tips", "tricks", "real", "estate", "realestate", "everything", "ultimate",
  "complete", "beginner", "beginners", "know", "need", "needs", "learn", "property", "properties", "agent", "agents", "realtor", "realtors",
  "process", "step", "steps", "basics", "simple", "easy", "great", "good", "best", "people", "anyone", "everyone", "today", "now",
])

function tokens(text: string): string[] {
  return (text ?? "").toLowerCase().replace(/[’']s\b/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w))
}
function contentTokens(text: string): string[] {
  return tokens(text).filter((w) => !STOP.has(w))
}

/** PURE. The words in a concept that name a niche (not shared vocabulary every real-estate book uses). */
export function conceptSpecifics(concept: string): string[] {
  return [...new Set(contentTokens(concept).filter((w) => !GENERIC.has(w)))]
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

export const BOOK_EVIDENCE_RULES = {
  /** A concept needs at least this many niche words. */
  minConceptSpecifics: 1,
  /** A concept/title this similar (Jaccard over content words) to an existing book's title is a re-titling, not original. */
  maxTitleSimilarity: 0.6,
  /** A demand question is COVERED by the competition when this share of its words appear in competitor titles/snippets. */
  coveredShare: 0.6,
  maxGaps: 8,
} as const

export type BookEvidenceVerdict = "evidenced" | "generic" | "no_demand" | "crowded"

export interface BookTopicEvidence {
  scored_at: string
  concept_specifics: string[]
  demand: { questions: Array<{ topic: string; score: number }>; bank: string[]; total: number }
  /** The single most-asked question — the problem the book exists to solve. */
  audience_problem: string | null
  positioning: { researched: boolean; competitor_titles: string[]; note: string | null }
  /** Demand the existing books do not answer — the unmet interest the outline must own. */
  gaps: string[]
  originality: { closest_title: string | null; similarity: number; original: boolean }
  /** This tenant's magnets of the same type and the captures they produced (null = not readable / not measured). */
  conversion: { magnets: number; captures: number } | null
  verdict: BookEvidenceVerdict
  reasons: string[]
}

/**
 * PURE. The evidence for a book topic and the verdict. "evidenced" is the only verdict the outline accepts.
 * Positioning that could not be researched is SAID (positioning.researched false; every demand question counts as a gap,
 * unverified) — it does not pass as "no competition".
 */
export function scoreBookTopicEvidence(input: {
  concept: string
  workingTitle?: string | null
  demand: ReadonlyArray<{ topic: string; score?: number }>
  bank: ReadonlyArray<string>
  positioning: { titles: ReadonlyArray<string>; snippets: ReadonlyArray<string> } | null
  conversion: { magnets: number; captures: number } | null
  now: string
}): BookTopicEvidence {
  const reasons: string[] = []
  const specifics = conceptSpecifics(input.concept)
  const questions = input.demand.filter((d) => d && typeof d.topic === "string" && d.topic.trim()).map((d) => ({ topic: d.topic.trim(), score: Number(d.score ?? 0) || 0 }))
  const bank = input.bank.filter((b) => typeof b === "string" && b.trim()).map((b) => b.trim())
  const total = questions.length + bank.length
  const audienceProblem = [...questions].sort((a, b) => b.score - a.score)[0]?.topic ?? bank[0] ?? null

  const titles = (input.positioning?.titles ?? []).map((t) => String(t ?? "").trim()).filter(Boolean)
  const researched = !!input.positioning && (titles.length > 0 || (input.positioning.snippets ?? []).length > 0)
  const corpus = new Set(contentTokens([...titles, ...(input.positioning?.snippets ?? [])].join(" ")))
  const gaps = questions.filter((q) => {
    if (!researched) return true
    const t = contentTokens(q.topic).filter((w) => !GENERIC.has(w))
    if (t.length === 0) return false
    return t.filter((w) => corpus.has(w)).length / t.length < BOOK_EVIDENCE_RULES.coveredShare
  }).map((q) => q.topic).slice(0, BOOK_EVIDENCE_RULES.maxGaps)

  const mine = contentTokens(`${input.concept} ${input.workingTitle ?? ""}`)
  let closest: string | null = null, similarity = 0
  for (const t of titles) {
    const s = jaccard(mine, contentTokens(t))
    if (s > similarity) { similarity = s; closest = t }
  }
  const original = similarity < BOOK_EVIDENCE_RULES.maxTitleSimilarity

  let verdict: BookEvidenceVerdict = "evidenced"
  if (specifics.length < BOOK_EVIDENCE_RULES.minConceptSpecifics) {
    verdict = "generic"
    reasons.push("The concept names no niche — only words every real-estate book shares. Say who it is for, the one problem it solves, and where (a neighbourhood, a situation, a kind of move).")
  } else if (total === 0) {
    verdict = "no_demand"
    reasons.push("The research found no one asking about this — no audience questions and nothing in the topic bank. Sharpen the concept toward a question people actually ask.")
  } else if (researched && !original) {
    verdict = "crowded"
    reasons.push(`An existing book already carries nearly this title ("${closest}") — a re-titling is not an original book. Choose an angle it does not cover.`)
  } else if (researched && gaps.length === 0) {
    verdict = "crowded"
    reasons.push("Every question the audience asks is already answered by books on the topic — there is no unmet interest to own. Pick a narrower audience or a situation they skip.")
  }
  if (verdict === "evidenced") {
    reasons.push(`${total} demand signal(s); ${gaps.length} unmet question(s)${researched ? ` against ${titles.length} competing title(s)` : " (competitor positioning NOT researched — every question counted as a gap, unverified)"}.`)
    if (input.conversion) reasons.push(`This tenant's ${input.conversion.magnets} magnet(s) of the same type captured ${input.conversion.captures} lead(s).`)
    else reasons.push("Conversion history not measured for this tenant.")
  }
  return {
    scored_at: input.now, concept_specifics: specifics,
    demand: { questions, bank, total }, audience_problem: audienceProblem,
    positioning: { researched, competitor_titles: titles.slice(0, 10), note: researched ? null : "positioning research returned nothing (no provider result or no key) — originality and gaps are unverified" },
    gaps, originality: { closest_title: closest, similarity: Number(similarity.toFixed(3)), original },
    conversion: input.conversion, verdict, reasons,
  }
}

// ── 3 · The humanized review ───────────────────────────────────────────────────────────────────

export interface AiTellFinding { phrase: string; rule: string }

/**
 * A SAFE deterministic removal of one tell (wave 145, lane 145G — owner ruling 20: "all distributions of material created by
 * ai should have a last phase of removing any ai typical wording"). Only a tell whose removal cannot change a fact gets one:
 * an introductory clause that ends in a comma, a hedge in front of the real sentence, essay scaffolding, a verb with a plain
 * equivalent. A tell with no safe rewrite ("unlock the potential", "as an AI") stays OPEN for the human to rewrite — the
 * final phase never guesses at meaning. `re` is global; `to` is the replacement (a function receives the match groups).
 */
interface AiTellFix { re: RegExp; to: string | ((m: RegExpExecArray) => string) }

const VERB_TENSE = (stem: string, m: RegExpExecArray): string => {
  const suffix = (m[1] ?? "").toLowerCase()
  return suffix === "es" || suffix === "s" ? `${stem}s` : suffix === "ed" ? `${stem}ed` : suffix === "ing" ? `${stem}ing` : stem
}

// Tells a reader recognises as machine-written. A short list on purpose: each is a phrase people notice, not a style
// opinion — the human review is the judgement; this only points at sentences that must not ship unread. ONE list for the
// book's humanized review AND the final distribution phase (lib/marketing/humanize-final.ts) — never a second humanizer.
const AI_TELLS: ReadonlyArray<{ re: RegExp; rule: string; fix?: AiTellFix }> = [
  { re: /\bin today'?s\s+(?:fast[\s-]paced|ever[\s-]changing|ever[\s-]evolving|competitive|dynamic)\s+(?:real[\s-]estate\s+)?(?:market|world|landscape|economy|environment)\b/i, rule: "stock opener ('in today's fast-paced market')",
    fix: { re: /\bin today'?s\s+(?:fast[\s-]paced|ever[\s-]changing|ever[\s-]evolving|competitive|dynamic)\s+(?:real[\s-]estate\s+)?(?:market|world|landscape|economy|environment),\s*/gi, to: "" } },
  { re: /\bin the (?:ever[\s-]evolving|ever[\s-]changing|dynamic) (?:world|landscape|realm) of\b/i, rule: "stock opener ('in the ever-evolving world of')",
    fix: { re: /\bin the (?:ever[\s-]evolving|ever[\s-]changing|dynamic) (?:world|landscape|realm) of [^,.;:!?\n\d$%]{1,60},\s*/gi, to: "" } },
  { re: /\bit(?:'s| is) (?:important|worth|crucial|essential) to (?:note|remember|mention) that\b/i, rule: "hedging filler ('it's important to note that')",
    fix: { re: /\bit(?:'s| is) (?:important|worth|crucial|essential) to (?:note|remember|mention) that\s+/gi, to: "" } },
  { re: /\bdelv(?:e|es|ed|ing) (?:deeper )?into\b/i, rule: "model diction ('delve into')",
    fix: { re: /\bdelv(e|es|ed|ing) (deeper )?into\b/gi, to: (m) => `${m[1]?.toLowerCase() === "ing" ? "looking" : VERB_TENSE("look", m)}${m[2] ? " closer" : ""} at` } },
  { re: /\bnavigat(?:e|es|ed|ing) the (?:complex(?:ities)?|intricac(?:y|ies)|maze|labyrinth)\b/i, rule: "model diction ('navigate the complexities')",
    fix: { re: /\bnavigat(e|es|ed|ing) the (?:complexities|intricacies|maze|labyrinth) of\b/gi, to: (m) => `${m[1]?.toLowerCase() === "ing" ? "working" : VERB_TENSE("work", m)} through` } },
  { re: /\bembark(?:s|ed|ing)? on (?:a|an|your|this) (?:journey|adventure)\b/i, rule: "model diction ('embark on a journey')" },
  { re: /\bis a testament to\b/i, rule: "model diction ('a testament to')",
    fix: { re: /\bis a testament to\b/gi, to: "shows" } },
  { re: /\bunlock(?:s|ing)? the (?:secrets?|power|potential)\b/i, rule: "model diction ('unlock the secrets')" },
  { re: /\b(?:rich|vibrant|intricate) tapestry\b/i, rule: "model diction ('a rich tapestry')" },
  { re: /\blook no further\b/i, rule: "ad-copy filler ('look no further')",
    // Only the sentence-final form ("Looking for X? Look no further!"); "look no further than our team" keeps its object → open.
    fix: { re: /\s*\blook no further[.!]+/gi, to: "" } },
  { re: /\bwhether you(?:'re| are) a (?:first[\s-]time|seasoned|savvy)\b[^.]{0,80}\bor a (?:seasoned|first[\s-]time|savvy)\b/i, rule: "symmetric both-sides opener" },
  { re: /\bas an ai\b|\b(?:large )?language model\b/i, rule: "the model talking about itself" },
  { re: /\bin conclusion,|\bto sum(?:marize| it)? up,/i, rule: "essay scaffolding ('in conclusion,')",
    fix: { re: /\b(?:in conclusion|to sum(?:marize| it)? up),\s*/gi, to: "" } },
  { re: /\bthis (?:comprehensive |ultimate |complete )?(?:guide|chapter|book) will (?:walk|take|explore|delve|cover)\b/i, rule: "self-announcing paragraph ('this guide will walk you through')" },
]

/** PURE. Machine-written tells in a text. Empty = none of the listed tells (the positive control is in the guard). */
export function scanAiTells(text: string): AiTellFinding[] {
  const out: AiTellFinding[] = []
  for (const t of AI_TELLS) {
    const m = t.re.exec(text ?? "")
    if (m) out.push({ phrase: m[0], rule: t.rule })
  }
  return out
}

/**
 * PURE (wave 145, lane 145G). Apply every SAFE removal above to a text and say what was removed; whatever tell has no safe
 * rewrite is left exactly where it was (scanAiTells on the result names it — the human rewrites those). Never touches a
 * digit, a currency amount or a percentage (the fixes' patterns exclude them), so material terms survive by construction;
 * lib/marketing/humanize-final.ts still proves it on every final. A removal at a sentence start re-capitalises the next word.
 */
export function stripAiTells(text: string): { text: string; removed: AiTellFinding[] } {
  let out = String(text ?? "")
  const removed: AiTellFinding[] = []
  for (const t of AI_TELLS) {
    if (!t.fix) continue
    const re = new RegExp(t.fix.re.source, t.fix.re.flags.includes("g") ? t.fix.re.flags : `${t.fix.re.flags}g`)
    const cap = (s: string) => (/^[a-z]/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s)
    let next = ""
    let last = 0
    let capNext = false
    for (let m = re.exec(out); m; m = re.exec(out)) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      const replacement = typeof t.fix.to === "string" ? t.fix.to : t.fix.to(m)
      const between = out.slice(last, m.index)
      next += capNext ? cap(between) : between
      // An emptied introductory clause leaves the real sentence: capitalise its first letter when it now starts one.
      const atSentenceStart = /(^|[.!?:]\s+|\n\s*|>\s*)$/.test(next)
      if (replacement === "") capNext = atSentenceStart
      else { next += atSentenceStart ? cap(replacement) : replacement; capNext = false }
      removed.push({ phrase: m[0].trim(), rule: t.rule })
      last = re.lastIndex
    }
    const tail = out.slice(last)
    out = next + (capNext ? cap(tail) : tail)
  }
  return { text: out, removed }
}

export interface HumanizedReviewState {
  /** Chapters the AI drafted that still carry a tell — the human must rewrite them (1-based). */
  open: Array<{ chapter: number; phrases: string[] }>
  /** Chapters the human rewrote (their words — never re-flagged). */
  humanRevised: number[]
  ready: boolean
}

/** PURE. Where the humanized review stands for a manuscript. */
export function humanizedReviewState(chapters: ReadonlyArray<{ body?: string | null; edited?: { human_revised_at?: string | null; [k: string]: unknown } | null }>): HumanizedReviewState {
  const open: HumanizedReviewState["open"] = []
  const humanRevised: number[] = []
  chapters.forEach((c, i) => {
    if (c?.edited?.human_revised_at) { humanRevised.push(i + 1); return }
    const tells = scanAiTells(String(c?.body ?? ""))
    if (tells.length) open.push({ chapter: i + 1, phrases: tells.map((t) => t.phrase) })
  })
  return { open, humanRevised, ready: open.length === 0 }
}

/** The record the human's sign-off leaves on the book (book_projects.project.humanized_review — wave 145; was settings.book). */
export interface HumanizedReviewRecord {
  by: string
  at: string
  /** How the human signed off: the lead-magnet publish (the reviewer's approval) or the KDP attestation. */
  basis: "lead_magnet_publish" | "kdp_attestation"
  chapters_human_revised: number[]
  ai_tells_open: 0
}

/** PURE. The refusal text for an unfinished humanized review (names the chapter and the phrase). */
export function humanizedReviewRefusal(state: HumanizedReviewState): string {
  const parts = state.open.map((o) => `chapter ${o.chapter} ("${o.phrases.slice(0, 2).join('", "')}")`)
  return `Humanized review: ${parts.join(", ")} still read${state.open.length === 1 ? "s" : ""} machine-written — rewrite ${state.open.length === 1 ? "it" : "them"} in your own words (Revise chapter) before this book goes out.`
}
