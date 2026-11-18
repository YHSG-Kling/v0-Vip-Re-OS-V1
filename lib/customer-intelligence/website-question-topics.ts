// lib/customer-intelligence/website-question-topics.ts
// ─────────────────────────────────────────────────────────────────────────────
// WEBSITE QUESTIONS → ONE ANONYMIZED LOCAL FAQ / EDUCATION TOPIC (wave 154, lane 154I — directive I4 example 2, I1).
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
// SURVIVORS, EXTENDED — nothing here is a second engine:
//   · the ONE question lexicon: lib/education/question-gap.ts classifyQuestion (wave 154 adds new_construction_warranty);
//   · the ONE privacy floor for first-party demand: lib/content-intel/search-demand.ts FIRST_PARTY_MIN_CONTACTS /
//     FIRST_PARTY_WINDOW_DAYS (a theme is published only once that many DISTINCT askers raised it in the window);
//   · the ONE topic producer: lib/content-intel/topic-intake.ts intakeTopicIdeas (dedup, exclusions, personal-data refusal).
//
// STAGE DISCIPLINE (directive I1): an aggregate of anonymous questions is a TOPIC EVENT ONLY. What is stored is an authored,
// reworded consumer question (never a visitor's words), the count of distinct sessions and the observation window. No
// session id, no visitor, no contact, no lead, no persona field is written — the only table this path writes is
// content_topic_bank (through the intake). A question with no authored consumer FAQ is not a topic; a theme under the floor
// stays unpublished and is said.

import { classifyQuestion } from "@/lib/education/question-gap"
import { FIRST_PARTY_MIN_CONTACTS, FIRST_PARTY_WINDOW_DAYS } from "@/lib/content-intel/search-demand"
import type { TopicIdea, TopicIntakeResult } from "@/lib/content-intel/topic-intake"

type Db = { from: (t: string) => any }

/** The sourceKind every idea from this module carries (one spelling). */
const WEBSITE_QUESTION_SOURCE_KIND = "website_question"

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
})

interface WebsiteQuestionRow { sessionId: string; content: string; createdAt: string }

interface ThemeCount { topic: string; askers: number; lastAt: string | null }

/**
 * PURE — classify each question with the ONE lexicon and count DISTINCT sessions per theme. A theme becomes an idea only at
 * or above the floor; below it, it is reported, never stored. The idea carries no session, no words, no identity.
 */
function websiteQuestionTopicIdeas(rows: readonly WebsiteQuestionRow[], a: { now: Date; minAskers?: number }): { ideas: TopicIdea[]; belowFloor: ThemeCount[]; unclassified: number } {
  const floor = a.minAskers ?? FIRST_PARTY_MIN_CONTACTS
  const byTopic = new Map<string, { sessions: Set<string>; lastAt: string | null }>()
  let unclassified = 0
  for (const r of rows) {
    const cls = classifyQuestion(r.content)
    if (!cls || !CONSUMER_FAQ_TITLES[cls.topic] || !r.sessionId) { unclassified++; continue }
    const e = byTopic.get(cls.topic) ?? { sessions: new Set<string>(), lastAt: null }
    e.sessions.add(r.sessionId)
    if (r.createdAt && (!e.lastAt || r.createdAt > e.lastAt)) e.lastAt = r.createdAt
    byTopic.set(cls.topic, e)
  }
  const ideas: TopicIdea[] = []
  const belowFloor: ThemeCount[] = []
  for (const [topic, e] of byTopic) {
    const askers = e.sessions.size
    if (askers < floor) { belowFloor.push({ topic, askers, lastAt: e.lastAt }); continue }
    const title = CONSUMER_FAQ_TITLES[topic]
    ideas.push({
      sourceKind: WEBSITE_QUESTION_SOURCE_KIND,
      title,
      angle: "A local FAQ and an education piece answering a question several of the tenant's own website visitors asked.",
      categories: ["faq", "education"],
      geo: null,
      sourceUrl: null,
      observedAt: e.lastAt ?? a.now.toISOString(),
      evidence: { kind: "measured", metric: "distinct_website_askers", value: askers, unit: "askers", note: `${askers} distinct website chat sessions in ${FIRST_PARTY_WINDOW_DAYS} days; no visitor identity or wording stored` },
      rights: "first_party",
      brief: { consumer_question: title, suggested_original_formats: ["local_faq", "education_magnet"], observation_key: `${WEBSITE_QUESTION_SOURCE_KIND}:${topic}:n${askers}` },
      dedupKey: `${WEBSITE_QUESTION_SOURCE_KIND}:${topic}`,
    })
  }
  return { ideas, belowFloor, unclassified }
}

type WebsiteQuestionOutcome =
  | { status: "not_a_topic" }
  | { status: "below_floor"; topic: string; askers: number }
  | { status: "submitted"; topic: string; askers: number; inserted: number; merged: number; excluded: number }
  | { status: "refused"; reason: string }

interface WebsiteQuestionDeps {
  /** The tenant's website-widget questions in the window. Default: chat_messages ⋈ chat_sessions (tenant + website_widget). */
  readQuestions?: (db: Db, a: { brokerageId: string; since: string }) => Promise<{ rows: WebsiteQuestionRow[] } | { error: string }>
  /** THE topic intake. Default: lib/content-intel/topic-intake.ts intakeTopicIdeas. */
  intake?: (db: Db, a: { brokerageId: string; ideas: TopicIdea[]; now?: Date }) => Promise<Pick<TopicIntakeResult, "ok" | "inserted" | "merged" | "excluded">>
}

const defaultReadQuestions: NonNullable<WebsiteQuestionDeps["readQuestions"]> = async (db, a) => {
  const { data, error } = await db.from("chat_messages")
    .select("session_id, content, created_at, chat_sessions!inner(brokerage_id, session_type)")
    .eq("role", "user").eq("chat_sessions.brokerage_id", a.brokerageId).eq("chat_sessions.session_type", "website_widget")
    .gte("created_at", a.since).order("created_at", { ascending: false }).limit(2000)
  if (error) return { error: error.message }
  return { rows: ((data ?? []) as Array<{ session_id: string; content: string | null; created_at: string }>).map((r) => ({ sessionId: r.session_id, content: r.content ?? "", createdAt: r.created_at })) }
}

/**
 * The door the website widget calls after it stores a visitor's question. A question with no consumer FAQ costs nothing (no
 * read). Otherwise the tenant's own window is read, the floor applied, and — at or above it — ONE anonymized idea goes to the
 * intake (a re-ask merges into the same topic by its dedup key). Never throws; a refused read stores nothing and says so.
 */
export async function considerWebsiteQuestion(db: Db, a: { brokerageId: string | null; text: string; now?: Date }, deps: WebsiteQuestionDeps = {}): Promise<WebsiteQuestionOutcome> {
  try {
    const cls = classifyQuestion(a.text)
    if (!cls || !CONSUMER_FAQ_TITLES[cls.topic]) return { status: "not_a_topic" }
    if (!a.brokerageId) return { status: "refused", reason: "no tenant on the widget session — nothing is published" }
    const now = a.now ?? new Date()
    const since = new Date(now.getTime() - FIRST_PARTY_WINDOW_DAYS * 86_400_000).toISOString()
    const read = await (deps.readQuestions ?? defaultReadQuestions)(db, { brokerageId: a.brokerageId, since })
    if ("error" in read) return { status: "refused", reason: `website questions read refused: ${read.error}` }
    const { ideas, belowFloor } = websiteQuestionTopicIdeas(read.rows, { now })
    const idea = ideas.find((i) => i.dedupKey === `${WEBSITE_QUESTION_SOURCE_KIND}:${cls.topic}`)
    if (!idea) return { status: "below_floor", topic: cls.topic, askers: belowFloor.find((b) => b.topic === cls.topic)?.askers ?? 0 }
    const intake = deps.intake ?? (async (d: Db, x: { brokerageId: string; ideas: TopicIdea[]; now?: Date }) => (await import("@/lib/content-intel/topic-intake")).intakeTopicIdeas(d as never, x))
    const r = await intake(db, { brokerageId: a.brokerageId, ideas: [idea], now })
    const askers = idea.evidence.value ?? 0
    if (!r.ok && r.inserted === 0 && r.merged === 0 && r.excluded.length === 0) return { status: "refused", reason: "the topic intake stored nothing" }
    return { status: "submitted", topic: cls.topic, askers, inserted: r.inserted, merged: r.merged, excluded: r.excluded.length }
  } catch (e) {
    return { status: "refused", reason: e instanceof Error ? e.message : String(e) }
  }
}
