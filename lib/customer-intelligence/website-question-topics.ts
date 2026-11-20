// lib/customer-intelligence/website-question-topics.ts
// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER QUESTIONS → ONE ANONYMIZED LOCAL FAQ / EDUCATION TOPIC (wave 154, lane 154I — directive I4 example 2, I1;
// widened wave 155, lane 155F — directive F2, owner R10: "if a question is consistently being asked whether in website chat,
// etc, then that should become a topic").
//
// "Tenant website receives three consented questions about new construction warranties → local FAQ and educational magnet,
// not three invented marketing identities without consent."
//
// WHAT WAS THERE (CLAUDE.md §1 — a write with no reader for this purpose): the tenant's website chat widget stores every
// question a visitor types (app/api/widget/message/route.ts → chat_messages, role 'user', under a chat_sessions row with
// session_type 'website_widget' and the tenant's brokerage_id). The only reader of those rows was the STAFF curriculum miner
// (lib/education/curriculum-author.ts → lib/education/question-gap.ts buildQuestionSignals — lessons for agents). Nothing
// turned a question several visitors asked into something the TENANT can publish for its customers.
//
// WAVE 155 (155F) — THE SOURCES, ONE FEEDER. The portal assistants log the same way: the client education tutor
// (lib/education/client-tutor.ts — session_type 'portal_widget', one session per turn, contact_id set). Both are read here, in
// ONE window, and an asker is counted ONCE across both: a signed-in Contact by contact id (the tutor opens a session per turn, so
// a session count would turn one person into many), an anonymous visitor by session. Support tickets, inbound email / SMS and
// listing inquiries already reach the pool through lib/content-intel/topic-intelligence.ts customerQuestionThemes (wave 154G1) —
// not re-read here. Voice: voice_calls.transcription exists but carries no per-utterance consent for topic use — NOT read
// (owner decision in the lane notes).
//
// SURVIVORS, EXTENDED — nothing here is a second engine:
//   · the ONE question lexicon: lib/education/question-gap.ts classifyQuestion (wave 154 adds new_construction_warranty);
//   · the ONE answer classifier: lib/portal/question-answer-decision.ts classifyPortalQuestion — an INDIVIDUAL question (this
//     person's deal, money, address, a human preference) or a guarded one (injection, steering, forecast) is never counted:
//     one private case never becomes a topic (PRIV-003); the arbiter's one-to-one answer is the portal answer itself;
//   · the ONE privacy floor for first-party demand: lib/content-intel/search-demand.ts FIRST_PARTY_MIN_CONTACTS /
//     FIRST_PARTY_WINDOW_DAYS (a theme is published only once that many DISTINCT askers raised it in the window);
//   · the ONE topic producer: lib/content-intel/topic-intake.ts intakeTopicIdeas (dedup, exclusions, personal-data refusal);
//   · the F3 hold: a theme with an open knowledge-repair task (lib/portal/question-answer-decision.ts markKnowledgeForRepair) is
//     not published until a person verifies the answer.
//
// STAGE DISCIPLINE (directive I1): an aggregate of questions is a TOPIC EVENT ONLY. What is stored is an authored, reworded
// consumer question (never an asker's words), the count of distinct askers and the observation window. No session id, no
// visitor, no contact, no lead, no persona field is written — the only table this path writes is content_topic_bank (through
// the intake). A question with no authored consumer FAQ is not a topic; a theme under the floor stays unpublished and is said.

import { classifyQuestion } from "@/lib/education/question-gap"
import { FIRST_PARTY_MIN_CONTACTS, FIRST_PARTY_WINDOW_DAYS } from "@/lib/content-intel/search-demand"
import { classifyPortalQuestion, KNOWLEDGE_REPAIR_TASK_SOURCE } from "@/lib/portal/question-answer-decision"
import type { TopicIdea, TopicIntakeResult } from "@/lib/content-intel/topic-intake"

type Db = { from: (t: string) => any }

/** The sourceKind every idea from this module carries (one spelling — kept from wave 154 so existing topics keep merging). */
const WEBSITE_QUESTION_SOURCE_KIND = "website_question"
/** The chat session types whose user turns are customer questions (website widget + portal assistants). */
const CUSTOMER_QUESTION_SESSION_TYPES = ["website_widget", "portal_widget"] as const
/** The named, configurable privacy floor (F2): the existing first-party floor — distinct askers within the window. */
export const QUESTION_TOPIC_FLOOR = { minDistinctAskers: FIRST_PARTY_MIN_CONTACTS, windowDays: FIRST_PARTY_WINDOW_DAYS } as const

/**
 * The consumer FAQ each classifiable theme becomes — the REWORDED question the tenant answers, authored here once. A theme
 * not listed is not published (a staff-only topic such as underwriting stays on the curriculum rail).
 */
const CONSUMER_FAQ_TITLES: Readonly<Record<string, string>> = Object.freeze({
  new_construction_warranty: "What does a new-construction builder warranty cover, for how long, and what should I check before closing?",
  closing_costs: "What closing costs should I expect, and which ones are usually the buyer's or the seller's?",
  title_insurance: "What does title insurance protect, and who usually orders it?",
  insurance: "How do I shop for homeowners insurance before closing?",
  escrow: "How does escrow work from accepted offer to closing day?",
  earnest_money: "How much earnest money is typical, and when can I get it back?",
  appraisal: "What happens if the appraisal comes in low?",
  inspection: "What does a home inspection cover, and what happens after it?",
  contingency: "Which contingencies protect a buyer, and how long do they last?",
  pre_approval: "What is the difference between pre-qualification and pre-approval?",
  hoa: "What should I ask about an HOA before I buy?",
  property_tax: "How are property taxes set, and can I appeal my assessment?",
  wire_fraud: "How do I wire closing funds safely?",
  clear_to_close: "What does \"clear to close\" mean, and what happens in the final week before closing?",
})

// ── ONE VOCABULARY FOR ONE SUBJECT (wave 155, lane 155F2 — CLAUDE.md §6) ────────────────────────────────────────────────────
// Two spellings named the same subject: this feeder keyed `website_question:<lexicon topic>` while the wave-154 customer-question
// themes (lib/content-intel/topic-intelligence.ts, 154G1) key `ti:customer_question:<theme>` — so "closing costs" asked on the
// website and "closing costs" read from inbound messages became TWO topics. THE ONE KEY is the theme vocabulary's
// (lib/content-intel/topic-themes.ts THEME_RULES — the one producer of theme labels): NEW topics from this feeder key
// `ti:customer_question:<theme>`, and a live row still carrying the old key is ADOPTED (the idea merges into it) instead of
// duplicated. Live rows are never re-keyed here — that is owner SQL (lane 155F2 notes). The reader below treats both as one subject.

/** The theme vocabulary's prefix for a customer question (topic-intelligence.ts themeDedupKey(`customer_question:<key>`)). */
export const CUSTOMER_QUESTION_SUBJECT_PREFIX = "ti:customer_question:"
/** The retired spelling — read and adopted, never written for a new topic. */
export const LEGACY_QUESTION_KEY_PREFIX = `${WEBSITE_QUESTION_SOURCE_KIND}:`
/** Each lexicon topic (lib/education/question-gap.ts) → its theme key in topic-themes.ts. Every CONSUMER_FAQ_TITLES key is mapped
 *  (scripts/portal-answer-guard.ts checks each value is a real theme key — a mapping onto a name that does not exist reads as
 *  "one subject" while merging nothing). */
export const QUESTION_TOPIC_THEME: Readonly<Record<string, string>> = Object.freeze({
  new_construction_warranty: "new_construction", closing_costs: "closing_costs", title_insurance: "escrow_title", insurance: "insurance",
  escrow: "escrow_title", earnest_money: "escrow_title", appraisal: "appraisal", inspection: "home_inspection", contingency: "offers_negotiation",
  pre_approval: "pre_approval", hoa: "hoa", property_tax: "property_taxes", wire_fraud: "escrow_title", clear_to_close: "buying_process",
})
/** PURE — the ONE key a NEW topic for this lexicon topic carries. */
export function questionSubjectKey(topic: string): string {
  const theme = QUESTION_TOPIC_THEME[topic]
  return theme ? `${CUSTOMER_QUESTION_SUBJECT_PREFIX}${theme}` : `${LEGACY_QUESTION_KEY_PREFIX}${topic}`
}
/** PURE — the SUBJECT (theme key) a stored topic key names, whichever spelling it carries; null = not a customer-question topic. */
export function subjectOfTopicKey(key: string | null | undefined): string | null {
  const k = String(key ?? "")
  if (k.startsWith(CUSTOMER_QUESTION_SUBJECT_PREFIX)) return k.slice(CUSTOMER_QUESTION_SUBJECT_PREFIX.length) || null
  if (k.startsWith(LEGACY_QUESTION_KEY_PREFIX)) { const t = k.slice(LEGACY_QUESTION_KEY_PREFIX.length); return QUESTION_TOPIC_THEME[t] ?? t }
  return null
}
/** PURE — every stored key that names this subject (the new one first, then each retired lexicon spelling that maps to it). */
function keysForSubject(theme: string): string[] {
  return [`${CUSTOMER_QUESTION_SUBJECT_PREFIX}${theme}`, ...Object.keys(QUESTION_TOPIC_THEME).filter((t) => QUESTION_TOPIC_THEME[t] === theme).map((t) => `${LEGACY_QUESTION_KEY_PREFIX}${t}`)]
}

/** One customer question in the window. `askerKey` is a contact (`c:`) when signed in, else the session (`s:`). */
interface CustomerQuestionRow { askerKey: string; content: string; createdAt: string; channel?: "website" | "portal" }

interface ThemeCount { topic: string; askers: number; lastAt: string | null }

/**
 * PURE — classify each question with the ONE lexicon and count DISTINCT askers per theme. An individual or guarded question is
 * never counted. A theme becomes an idea only at or above the floor; below it, it is reported, never stored. The idea carries no
 * session, no words, no identity.
 */
function customerQuestionTopicIdeas(rows: readonly CustomerQuestionRow[], a: { now: Date; minAskers?: number }): { ideas: TopicIdea[]; belowFloor: ThemeCount[]; unclassified: number; individual: number } {
  const floor = a.minAskers ?? QUESTION_TOPIC_FLOOR.minDistinctAskers
  const byTopic = new Map<string, { askers: Set<string>; lastAt: string | null; channels: Set<string> }>()
  let unclassified = 0
  let individual = 0
  for (const r of rows) {
    const cls = classifyQuestion(r.content)
    if (!cls || !CONSUMER_FAQ_TITLES[cls.topic] || !r.askerKey) { unclassified++; continue }
    if (!classifyPortalQuestion(r.content).topicEligible) { individual++; continue }
    const e = byTopic.get(cls.topic) ?? { askers: new Set<string>(), lastAt: null, channels: new Set<string>() }
    e.askers.add(r.askerKey)
    e.channels.add(r.channel ?? "website")
    if (r.createdAt && (!e.lastAt || r.createdAt > e.lastAt)) e.lastAt = r.createdAt
    byTopic.set(cls.topic, e)
  }
  const ideas: TopicIdea[] = []
  const belowFloor: ThemeCount[] = []
  for (const [topic, e] of byTopic) {
    const askers = e.askers.size
    if (askers < floor) { belowFloor.push({ topic, askers, lastAt: e.lastAt }); continue }
    const title = CONSUMER_FAQ_TITLES[topic]
    const where = [...e.channels].sort().map((c) => (c === "portal" ? "portal assistant" : "website chat")).join(" + ")
    ideas.push({
      sourceKind: WEBSITE_QUESTION_SOURCE_KIND,
      title,
      angle: "A local FAQ and an education piece answering a question several of the tenant's own customers asked.",
      categories: ["faq", "education"],
      geo: null,
      sourceUrl: null,
      observedAt: e.lastAt ?? a.now.toISOString(),
      evidence: { kind: "measured", metric: "distinct_askers", value: askers, unit: "askers", note: `${askers} distinct askers (${where}) in ${QUESTION_TOPIC_FLOOR.windowDays} days; no asker identity or wording stored` },
      rights: "first_party",
      brief: { consumer_question: title, suggested_original_formats: ["local_faq", "education_magnet"], observation_key: `${WEBSITE_QUESTION_SOURCE_KIND}:${topic}:n${askers}` },
      dedupKey: questionSubjectKey(topic),
    })
  }
  return { ideas, belowFloor, unclassified, individual }
}

type CustomerQuestionOutcome =
  | { status: "not_a_topic" }
  | { status: "individual"; reason: string }
  | { status: "below_floor"; topic: string; askers: number }
  | { status: "held_for_repair"; topic: string; askers: number; repairTaskId: string }
  | { status: "submitted"; topic: string; askers: number; inserted: number; merged: number; excluded: number }
  | { status: "refused"; reason: string }

interface CustomerQuestionDeps {
  /** The tenant's customer questions in the window. Default: chat_messages ⋈ chat_sessions (tenant + website / portal). */
  readQuestions?: (db: Db, a: { brokerageId: string; since: string }) => Promise<{ rows: CustomerQuestionRow[] } | { error: string }>
  /** THE topic intake. Default: lib/content-intel/topic-intake.ts intakeTopicIdeas. */
  intake?: (db: Db, a: { brokerageId: string; ideas: TopicIdea[]; now?: Date }) => Promise<Pick<TopicIntakeResult, "ok" | "inserted" | "merged" | "excluded">>
  /** The F3 hold. Default: the open knowledge-repair task for the theme in this tenant (tasks). */
  openRepair?: (db: Db, brokerageId: string, topic: string) => Promise<{ id: string } | { error: string } | null>
}

/**
 * THE intake, behind ONE SUBJECT, ONE TOPIC (lane 155F2): before an idea goes to lib/content-intel/topic-intake.ts, a live row for
 * its subject under either spelling is ADOPTED — the idea takes that row's key and merges into it — so a retired-key row is never
 * duplicated by its new spelling. A refused read stores nothing (fail closed: a second topic for one subject is worse than a late
 * one). An injected intake owns its own dedup.
 */
const defaultIntake: NonNullable<CustomerQuestionDeps["intake"]> = async (db, x) => {
  const { ideas } = await adoptLiveSubjectKeys(db, x.brokerageId, x.ideas)
  if (ideas.length === 0) return { ok: false, inserted: 0, merged: 0, excluded: [] }
  return (await import("@/lib/content-intel/topic-intake")).intakeTopicIdeas(db as never, { ...x, ideas })
}

/**
 * ONE SUBJECT, ONE TOPIC — the adoption step, exported for every customer-question producer (this feeder's intake, and the wave-154
 * theme pass in lib/content-intel/topic-intelligence.ts — lane 155F2 Outside-lane request to 155H). Each idea whose key names a
 * customer-question subject takes the key of a LIVE row for that subject under either spelling (new key first); `adopted` maps the
 * idea's original key → the adopted one so a caller matching intake rows by key can follow it. An idea whose read was refused is
 * HELD (left out, said) — never filed under a possibly-duplicate key. Tenant-pinned; never throws.
 */
export async function adoptLiveSubjectKeys(db: Db, brokerageId: string, input: readonly TopicIdea[]): Promise<{ ideas: TopicIdea[]; adopted: Map<string, string>; held: string[] }> {
  const ideas: TopicIdea[] = []
  const adopted = new Map<string, string>()
  const held: string[] = []
  for (const idea of input) {
    const subject = subjectOfTopicKey(idea.dedupKey)
    if (!subject) { ideas.push(idea); continue }
    try {
      const keys = keysForSubject(subject)
      const { data: live, error } = await db.from("content_topic_bank").select("id, raw_data").eq("brokerage_id", brokerageId).in("raw_data->>dedup_key", keys).limit(10)
      if (error) { held.push(String(idea.dedupKey)); console.error(`[website-question-topics] topic pool read refused (${error.message}) — ${idea.dedupKey} held, nothing stored`); continue }
      const liveKeys = new Set(((live ?? []) as Array<{ raw_data: { dedup_key?: string } | null }>).map((r) => String(r.raw_data?.dedup_key ?? "")))
      const adopt = keys.find((k) => liveKeys.has(k))
      if (adopt && adopt !== idea.dedupKey) adopted.set(String(idea.dedupKey), adopt)
      ideas.push(adopt ? { ...idea, dedupKey: adopt } : idea)
    } catch (e) {
      held.push(String(idea.dedupKey)); console.error(`[website-question-topics] subject adoption threw — ${idea.dedupKey} held:`, e instanceof Error ? e.message : e)
    }
  }
  return { ideas, adopted, held }
}

const defaultReadQuestions: NonNullable<CustomerQuestionDeps["readQuestions"]> = async (db, a) => {
  const { data, error } = await db.from("chat_messages")
    .select("session_id, content, created_at, chat_sessions!inner(brokerage_id, session_type, contact_id)")
    .eq("role", "user").eq("chat_sessions.brokerage_id", a.brokerageId).in("chat_sessions.session_type", [...CUSTOMER_QUESTION_SESSION_TYPES])
    .gte("created_at", a.since).order("created_at", { ascending: false }).limit(2000)
  if (error) return { error: error.message }
  return {
    rows: ((data ?? []) as Array<{ session_id: string; content: string | null; created_at: string; chat_sessions?: { contact_id?: string | null; session_type?: string | null } | null }>).map((r) => ({
      askerKey: r.chat_sessions?.contact_id ? `c:${r.chat_sessions.contact_id}` : `s:${r.session_id}`,
      content: r.content ?? "", createdAt: r.created_at,
      channel: r.chat_sessions?.session_type === "portal_widget" ? "portal" as const : "website" as const,
    })),
  }
}

/** The open knowledge-repair task for a theme (F3), tenant-pinned; a refused read holds the theme (fail closed). */
async function openRepairFor(db: Db, brokerageId: string, topic: string): Promise<{ id: string } | { error: string } | null> {
  const { data, error } = await db.from("tasks").select("id").eq("brokerage_id", brokerageId).eq("source", KNOWLEDGE_REPAIR_TASK_SOURCE).contains("tags", [`kb_repair:${topic}`]).neq("status", "completed").limit(1)
  if (error) return { error: error.message }
  const row = ((data ?? []) as Array<{ id: string }>)[0]
  return row ? { id: row.id } : null
}

/**
 * The door the website widget and the portal tutor call after they store a question. A question with no consumer FAQ costs
 * nothing (no read); an individual one is never counted. Otherwise the tenant's own window is read, the floor applied, an open
 * knowledge repair holds the theme, and — at or above the floor — ONE anonymized idea goes to the intake (a re-ask merges into
 * the same topic by its dedup key). Never throws; a refused read stores nothing and says so.
 * TOMBSTONE (wave 155, lane 155F — CLAUDE.md §1): `considerWebsiteQuestion` was this function's name while the widget was its
 * only caller. RENAMED, not removed — the survivor is considerCustomerQuestion (this declaration), now also the portal tutor's door.
 */
export async function considerCustomerQuestion(db: Db, a: { brokerageId: string | null; text: string; now?: Date }, deps: CustomerQuestionDeps = {}): Promise<CustomerQuestionOutcome> {
  try {
    const cls = classifyQuestion(a.text)
    if (!cls || !CONSUMER_FAQ_TITLES[cls.topic]) return { status: "not_a_topic" }
    if (!classifyPortalQuestion(a.text).topicEligible) return { status: "individual", reason: "a question about one person's own deal, money or a preference is answered one-to-one, never published" }
    if (!a.brokerageId) return { status: "refused", reason: "no tenant on the session — nothing is published" }
    const now = a.now ?? new Date()
    const since = new Date(now.getTime() - QUESTION_TOPIC_FLOOR.windowDays * 86_400_000).toISOString()
    const read = await (deps.readQuestions ?? defaultReadQuestions)(db, { brokerageId: a.brokerageId, since })
    if ("error" in read) return { status: "refused", reason: `customer questions read refused: ${read.error}` }
    const { ideas, belowFloor } = customerQuestionTopicIdeas(read.rows, { now })
    // Two lexicon topics may share a subject (escrow / earnest money), so the idea is found by its own FAQ, not by the shared key.
    const idea = ideas.find((i) => i.title === CONSUMER_FAQ_TITLES[cls.topic])
    if (!idea) return { status: "below_floor", topic: cls.topic, askers: belowFloor.find((b) => b.topic === cls.topic)?.askers ?? 0 }
    const askers = idea.evidence.value ?? 0
    const repair = await (deps.openRepair ?? openRepairFor)(db, a.brokerageId, cls.topic)
    if (repair && "error" in repair) return { status: "refused", reason: `knowledge-repair read refused (${repair.error}) — held, nothing published` }
    if (repair) return { status: "held_for_repair", topic: cls.topic, askers, repairTaskId: repair.id }
    const intake = deps.intake ?? defaultIntake
    const r = await intake(db, { brokerageId: a.brokerageId, ideas: [idea], now })
    if (!r.ok && r.inserted === 0 && r.merged === 0 && r.excluded.length === 0) return { status: "refused", reason: "the topic intake stored nothing" }
    return { status: "submitted", topic: cls.topic, askers, inserted: r.inserted, merged: r.merged, excluded: r.excluded.length }
  } catch (e) {
    return { status: "refused", reason: e instanceof Error ? e.message : String(e) }
  }
}

// ── F3 — THE EDUCATION LOOP'S NUMBERS (per tenant; measured or null, never invented) ─────────────

export interface QuestionLoopMetrics {
  windowDays: number
  /** Distinct askers per theme in the window (counted with the same rules as the topic). */
  repeatAskersByTheme: Record<string, number>
  /** Median hours from a portal question's task to its authoritative close; null when none closed. */
  medianHoursToAuthoritativeAnswer: number | null
  openQuestionTasks: number
  reopenedQuestionTasks: number
  openKnowledgeRepairs: number
  /** Per published theme: distinct askers in the 30 days before vs after the topic's first use. null = not measurable yet. */
  repeatsAroundPublication: Array<{ theme: string; before: number; after: number | null; firstUsedAt: string }>
  blindSpots: string[]
}

/**
 * The per-tenant reader F3 asks for. Reads only this tenant's rows; every unmeasurable number is null with a blind spot.
 * Mounted on no new dashboard: the integrator wires it into the Command Center results field (lane notes, Outside-lane).
 */
export async function readQuestionLoopMetrics(db: Db, a: { brokerageId: string; now?: Date }, deps: Pick<CustomerQuestionDeps, "readQuestions"> = {}): Promise<QuestionLoopMetrics> {
  const now = a.now ?? new Date()
  const out: QuestionLoopMetrics = { windowDays: QUESTION_TOPIC_FLOOR.windowDays, repeatAskersByTheme: {}, medianHoursToAuthoritativeAnswer: null, openQuestionTasks: 0, reopenedQuestionTasks: 0, openKnowledgeRepairs: 0, repeatsAroundPublication: [], blindSpots: [] }
  const since = new Date(now.getTime() - QUESTION_TOPIC_FLOOR.windowDays * 86_400_000).toISOString()
  const read = await (deps.readQuestions ?? defaultReadQuestions)(db, { brokerageId: a.brokerageId, since })
  const rows = "error" in read ? [] : read.rows
  if ("error" in read) out.blindSpots.push(`questions not read (${read.error})`)
  const byTheme = new Map<string, Array<{ askerKey: string; at: string }>>()
  for (const r of rows) {
    const t = classifyQuestion(r.content)?.topic
    if (!t || !classifyPortalQuestion(r.content).topicEligible) continue
    byTheme.set(t, [...(byTheme.get(t) ?? []), { askerKey: r.askerKey, at: r.createdAt }])
  }
  for (const [t, list] of byTheme) out.repeatAskersByTheme[t] = new Set(list.map((x) => x.askerKey)).size
  const { data: tasks, error: tErr } = await db.from("tasks").select("status, tags, created_at, completed_at, source").eq("brokerage_id", a.brokerageId).in("source", ["portal_question", KNOWLEDGE_REPAIR_TASK_SOURCE]).gte("created_at", since).limit(2000)
  if (tErr) out.blindSpots.push(`question tasks not read (${tErr.message})`)
  const hours: number[] = []
  for (const t of (tasks ?? []) as Array<{ status: string | null; tags: string[] | null; created_at: string; completed_at: string | null; source: string }>) {
    if (t.source === KNOWLEDGE_REPAIR_TASK_SOURCE) { if (t.status !== "completed") out.openKnowledgeRepairs++; continue }
    if (t.status !== "completed") out.openQuestionTasks++
    if ((t.tags ?? []).includes("pq_reopened")) out.reopenedQuestionTasks++
    if (t.status === "completed" && t.completed_at) { const h = (Date.parse(t.completed_at) - Date.parse(t.created_at)) / 3_600_000; if (Number.isFinite(h) && h >= 0) hours.push(h) }
  }
  if (hours.length) { const s = hours.sort((x, y) => x - y); out.medianHoursToAuthoritativeAnswer = Math.round((s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 10) / 10 }
  const { data: bank, error: bErr } = await db.from("content_topic_bank").select("id, raw_data").eq("brokerage_id", a.brokerageId).limit(500)
  if (bErr) out.blindSpots.push(`topic pool not read (${bErr.message})`)
  // BOTH SPELLINGS ARE ONE SUBJECT (lane 155F2, CLAUDE.md §6): a topic keyed `website_question:<lexicon>` (retired) and one keyed
  // `ti:customer_question:<theme>` (the one key) are read as the same subject; its first use is the earliest across them, and its
  // askers are every lexicon topic that maps to it.
  const ours = ((bank ?? []) as Array<{ id: string; raw_data: { dedup_key?: string } | null }>).filter((b) => subjectOfTopicKey(b.raw_data?.dedup_key) !== null)
  if (ours.length) {
    const { data: uses, error: uErr } = await db.from("content_topic_uses").select("topic_id, used_at").eq("brokerage_id", a.brokerageId).in("topic_id", ours.map((b) => b.id)).limit(2000)
    if (uErr) out.blindSpots.push(`topic uses not read (${uErr.message})`)
    const firstBySubject = new Map<string, string>()
    for (const b of ours) {
      const first = ((uses ?? []) as Array<{ topic_id: string; used_at: string | null }>).filter((u) => u.topic_id === b.id && u.used_at).map((u) => u.used_at as string).sort()[0]
      const subject = subjectOfTopicKey(b.raw_data?.dedup_key) as string
      if (first && (!firstBySubject.has(subject) || first < (firstBySubject.get(subject) as string))) firstBySubject.set(subject, first)
    }
    for (const [theme, first] of firstBySubject) {
      const list = [...byTheme.entries()].filter(([t]) => (QUESTION_TOPIC_THEME[t] ?? t) === theme).flatMap(([, l]) => l)
      const f = Date.parse(first)
      const before = new Set(list.filter((x) => Date.parse(x.at) < f && Date.parse(x.at) >= f - 30 * 86_400_000).map((x) => x.askerKey)).size
      const afterWindowClosed = now.getTime() - f >= 30 * 86_400_000
      const after = afterWindowClosed ? new Set(list.filter((x) => Date.parse(x.at) >= f && Date.parse(x.at) < f + 30 * 86_400_000).map((x) => x.askerKey)).size : null
      out.repeatsAroundPublication.push({ theme, before, after, firstUsedAt: first })
    }
  }
  return out
}
