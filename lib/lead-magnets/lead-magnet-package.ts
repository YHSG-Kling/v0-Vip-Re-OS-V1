// lib/lead-magnets/lead-magnet-package.ts
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT C30 — THE LEAD-MAGNET PACKAGE, IN THE RIGHT ORDER (wave 149, lane 149D — owner rulings 9, 10, 11, 12, 16, 7).
//
// OWNER (2026-11-03): "the package WRITES THE LEAD MAGNET FIRST (a topic from the topic bank, or a question being asked a lot —
// something that attracts that persona), THEN creates the landing page with the form with qualifying questions, THEN the funnel
// with deliverables. The complete package is created from scratch; the arbiter decides when one is needed, or the agent uses the
// Create button on their dashboard and the AI asks the questions it needs, then completes everything."
//
//   createLeadMagnetPackage(answers | opportunity)
//     (1) THE MAGNET — the topic chosen for the persona (topic bank / competitor insight / rising search / AI-search gap through
//         lib/lead-magnets/suggestions.ts readTopicSignals — the ONE intelligence reader; a question people keep asking from
//         conversation_insights.unresolved_questions, written by lib/intelligence/conversation-insights.ts), its concept and
//         value proposition; the PRIMARY asset produced first (magnet-funnel → deliverable-asset produceMagnetAssetFirst)
//     (2) THE LANDING PAGE on the tenant user's own website (app/site/[slug]/lm/[formSlug]; a connected custom domain's /lm/<slug>
//         through proxy.ts) with the situation's qualifying questions (magnet-funnel.ts situationQuestionsFor) + C15 consent + identity + creator
//     (3) THE FUNNEL — deliverables, thank-you, optional calendar / personal video / portal task / education, the QR code to the
//         landing page (generateQRCode → the ONE tracked-QR minter), attribution
//     → draft; the authorized human approves publication (publishLeadMagnet, C5) → capture (C8) → deliver (C4) → follow-up by the
//       arbiter (C29: decided_by arbiter, fixed_schedule false — no funnel timeline).
//
// ONE SURVIVOR (LAW 1/2): this module does NOT build a second funnel engine. The ordered build IS lib/lead-magnets/magnet-funnel.ts
// createMagnetFunnel (re-sequenced this wave: magnet → page → funnel, each stamped in package.order and on its ledger row). This
// module decides the MAGNET (topic + persona + value proposition), asks the Create door's questions, resolves the tenant-site URL
// and the QR, and records the package on the form (created_by_user_id via createLeadMagnet, qr_code_id + settings.package here).
//
// THE ARBITER (C29 / ruling 9): arbitrateLeadMagnetOpportunity hands an opportunity (what, for whom, why, evidence) to the ONE
// arbiter (lib/ai-isa/followup-arbiter.ts arbitrateFollowUp — called, never edited; lane 149C owns its timing branch) with a
// closed menu: build the package now (a DRAFT — a human publishes), wait, or ask the agent. The arbiter's own validator holds
// the model to the menu and to cited evidence; an outage falls to "ask the agent" (never a silent build).
//
// TENANCY (CLAUDE.md §4): every input's brokerageId is the caller's VERIFIED tenant (the session action / the cron's own
// per-tenant loop); every read and write is pinned to it. The tenant may be a solo agent, a team or a brokerage — nothing here
// assumes a brokerage: the creator is the users.id that clicked Create (or, for an arbiter build, the owning agent's seat), the
// assignment follows the form's agent. Not server-only (the proof drives it in memory); providers are lazy imports. Never throws.

import { FUNNEL_PACKAGE_ORDER, SITUATION_PERSONAS, SITUATION_LABELS, SITUATION_SIDE, canonicalSituation, type SituationPersona, type SituationSide, type FunnelDeps, type MagnetFunnelBrief, type MagnetFunnelPackage, type FunnelStageStamp } from "./magnet-funnel"
import type { TopicSignal, SuggestionReaders } from "./suggestions"

type Db = { from: (table: string) => any }

export { FUNNEL_PACKAGE_ORDER }

// ── (1) THE MAGNET: topic candidates ─────────────────────────────────────────

export type MagnetTopicSource = TopicSignal["source"] | "frequent_question" | "creator" | "opportunity"

interface MagnetTopicCandidate {
  /** Stable per-candidate key (the Create door's option value). */
  key: string
  source: MagnetTopicSource
  title: string
  angle: string | null
  /** The source's own score, normalised 0..1 WITHIN its source (sources are never ranked on each other's scales). */
  score: number
  evidence: Record<string, unknown>
}

/** Words that tie a topic to a SITUATION (fit, not exclusion — every persona may receive any topic; the fit only ranks). */
const PERSONA_TOPIC_TERMS: Readonly<Record<SituationPersona, readonly string[]>> = Object.freeze({
  first_time_buyer: ["first", "down payment", "pre-approv", "mortgage", "rent", "closing cost", "credit"],
  military_buyer: ["va ", "va loan", "pcs", "orders", "base", "relocat"],
  luxury_buyer: ["luxury", "estate", "waterfront", "view", "jumbo", "private"],
  investor: ["invest", "rental", "cash flow", "cap rate", "flip", "multifamily", "dscr", "airbnb", "short-term"],
  first_time_seller: ["sell", "listing", "staging", "pricing", "home value", "prep"],
  motivated_seller: ["sell fast", "quick sale", "as-is", "cash offer", "sell", "repairs"],
  divorce: ["sell", "equity", "home value", "settlement", "title", "split"],
  probate: ["inherit", "estate", "probate", "executor", "heir", "as-is", "title"],
  senior: ["downsiz", "next chapter", "single-level", "upkeep", "equity", "move"],
  relocating: ["relocat", "moving to", "neighborhood", "commute", "area guide", "cost of living"],
  luxury_seller: ["luxury", "high-end", "marketing", "discreet", "off-market", "staging"],
  fsbo: ["fsbo", "by owner", "sell", "pricing", "paperwork", "offers"],
  expired: ["expired", "relist", "price", "marketing", "didn't sell", "why homes don't sell"],
  upsizers: ["bigger", "upsiz", "space", "buy and sell", "bridge", "move up"],
  empty_nester: ["downsiz", "smaller", "lock-and-leave", "upkeep", "equity"],
  remote_seller: ["out of state", "remote", "vacant", "tenant", "manage", "long distance"],
  foreclosure: ["options", "deadline", "behind on", "mortgage help", "short sale", "equity"],
  other: [],
})

/** PURE. How well a topic speaks to a situation (0..1) — a ranking signal, never a filter. */
function personaTopicFit(persona: string | null | undefined, text: string): number {
  const terms = PERSONA_TOPIC_TERMS[canonicalSituation(persona)]
  if (!terms.length) return 0
  const t = ` ${text.toLowerCase()} `
  const hits = terms.filter((w) => t.includes(w)).length
  return Math.min(1, hits / 2)
}

/** PURE. Rank candidates for a persona: situation fit first (the magnet must attract THIS persona), then the source's own
 *  normalised strength; a question asked by more people outranks a topic of equal fit (it is demand the tenant can see). */
function rankMagnetTopics(cands: readonly MagnetTopicCandidate[], persona: string | null | undefined): MagnetTopicCandidate[] {
  const weight = (c: MagnetTopicCandidate) => personaTopicFit(persona, `${c.title} ${c.angle ?? ""}`) * 2 + c.score + (c.source === "frequent_question" ? 0.25 : 0)
  return [...cands].sort((a, b) => weight(b) - weight(a) || a.key.localeCompare(b.key))
}

/** A question carrying a person's details (an address, a phone number, an email) is never a public topic. */
const PERSONAL_DETAIL = /@|\d{3,}|\b(my|our) (address|house at|street)\b/i
const normQ = (q: string) => q.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim()

/**
 * Read the magnet topic candidates for a tenant: the intelligence signals (topic bank, competitor insight, rising keywords,
 * AI-search gaps — readTopicSignals, the one reader) and the questions people keep asking (conversation_insights
 * .unresolved_questions, 90 days, asked in ≥ 2 distinct conversations, no personal detail — aggregate text only, never who
 * asked). Every source that cannot be read is SAID in notes (an empty list is never "nobody asks anything"). Never throws.
 */
async function readMagnetTopicCandidates(svc: Db, brokerageId: string, opts: { now?: Date; readers?: SuggestionReaders } = {}): Promise<{ candidates: MagnetTopicCandidate[]; notes: string[] }> {
  const now = opts.now ?? new Date()
  const notes: string[] = []
  const candidates: MagnetTopicCandidate[] = []
  try {
    const { readTopicSignals } = await import("./suggestions")
    const intel = await readTopicSignals(svc as never, brokerageId, now, opts.readers ?? {})
    notes.push(...intel.notes)
    const bySource = new Map<string, TopicSignal[]>()
    for (const s of intel.signals) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s])
    for (const [source, list] of bySource) {
      const max = Math.max(...list.map((s) => s.score), 1)
      for (const s of list) candidates.push({ key: `${source}:${s.id ?? normQ(s.title).slice(0, 40)}`, source: s.source, title: s.title, angle: s.angle, score: Math.max(0, s.score) / max, evidence: { ...s.evidence, source_id: s.id } })
    }
  } catch (e) {
    notes.push(`topic signals unreadable: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    const since = new Date(now.getTime() - 90 * 86_400_000).toISOString()
    const { data, error } = await svc.from("conversation_insights").select("conversation_id, unresolved_questions, created_at").eq("brokerage_id", brokerageId).gte("created_at", since).limit(1000)
    if (error) notes.push(`conversation_insights read refused: ${error.message ?? "unknown"} — no frequently asked question is offered`)
    const asked = new Map<string, { text: string; conversations: Set<string> }>()
    for (const r of (data ?? []) as Array<{ conversation_id: string | null; unresolved_questions: string[] | null }>) {
      for (const q of Array.isArray(r.unresolved_questions) ? r.unresolved_questions : []) {
        if (typeof q !== "string" || q.trim().length < 8 || PERSONAL_DETAIL.test(q)) continue
        const k = normQ(q)
        const g = asked.get(k) ?? { text: q.trim().replace(/\s+/g, " ").slice(0, 160), conversations: new Set<string>() }
        g.conversations.add(r.conversation_id ?? `row:${asked.size}`)
        asked.set(k, g)
      }
    }
    const frequent = [...asked.entries()].filter(([, g]) => g.conversations.size >= 2)
    const max = Math.max(...frequent.map(([, g]) => g.conversations.size), 1)
    for (const [k, g] of frequent) candidates.push({ key: `frequent_question:${k.slice(0, 60)}`, source: "frequent_question", title: g.text, angle: null, score: g.conversations.size / max, evidence: { conversations: g.conversations.size, window_days: 90 } })
  } catch (e) {
    notes.push(`frequent questions unreadable: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { candidates, notes }
}

// ── THE CREATE DOOR: the questions the AI needs before it builds ──────────────

export interface PackageAnswers {
  persona?: string | null
  /** For persona "other": who the magnet is for, in the agent's words. */
  persona_description?: string | null
  side?: SituationSide | null
  area?: string | null
  /** A candidate key from the topic options, "ai_pick" (the AI chooses the strongest for the persona) or "own". */
  topic_key?: string | null
  /** The agent's own topic (topic_key "own"). */
  topic?: string | null
  /** "ai" (the planner decides) or a primary kind. */
  deliverable?: string | null
}

export interface PackageQuestion {
  id: keyof PackageAnswers
  label: string
  /** Why the AI needs it (said to the agent — the door explains before it asks). */
  why: string
  type: "select" | "text"
  options?: Array<{ value: string; label: string }>
  required: boolean
}

const DELIVERABLE_CHOICES = [
  { value: "ai", label: "Let the AI choose what helps most" }, { value: "checklist", label: "A one-page checklist" },
  { value: "video", label: "A short education video" }, { value: "report", label: "A local market report" },
  { value: "guide", label: "A guide" }, { value: "valuation", label: "A personal home value" },
] as const

/**
 * PURE. The Create door's intake: what the AI still needs to build the WHOLE package, asked in the situation's own terms.
 * `ready` only when every required answer is present; the build never starts on a guess (the persona, the topic and — when the
 * tenant has no territory on file — the area). Every persona is offered; "other" asks for a description instead of refusing.
 * Module-private: scripts/lead-magnet-package-guard.ts §B drives the intake matrix THROUGH createLeadMagnetPackage.
 */
function leadMagnetPackageQuestions(answers: PackageAnswers, ctx: { topics: readonly MagnetTopicCandidate[]; territories: readonly string[] }): { ready: boolean; questions: PackageQuestion[] } {
  const q: PackageQuestion[] = []
  const persona = answers.persona ? canonicalSituation(answers.persona) : null
  if (!persona) q.push({ id: "persona", label: "Who is this lead magnet for?", why: "A magnet works when it speaks to one situation — it decides the topic, the page and the questions the form asks.", type: "select", options: SITUATION_PERSONAS.map((p) => ({ value: p, label: SITUATION_LABELS[p] })), required: true })
  if (persona === "other" && !(answers.persona_description ?? "").trim()) q.push({ id: "persona_description", label: "Describe the people you want to reach", why: "So the AI can write for their situation (never for a group they belong to).", type: "text", required: true })
  const side = answers.side ?? (persona ? SITUATION_SIDE[persona] : null)
  if (persona && !side) q.push({ id: "side", label: "Are they buying, selling or both?", why: "It decides the deliverable and the qualifying questions.", type: "select", options: [{ value: "buyer", label: "Buying" }, { value: "seller", label: "Selling" }, { value: "both", label: "Both" }], required: true })
  if (!(answers.area ?? "").trim()) {
    q.push(ctx.territories.length
      ? { id: "area", label: "Which of your areas should it speak to?", why: "Local beats generic — the market facts and the page copy are about this place.", type: "select", options: ctx.territories.map((t) => ({ value: t, label: t })), required: false }
      : { id: "area", label: "Which area should it speak to?", why: "No territory is on file in your settings yet, and local beats generic.", type: "text", required: true })
  }
  if (!answers.topic_key && !(answers.topic ?? "").trim()) {
    const ranked = rankMagnetTopics(ctx.topics, persona).slice(0, 5)
    q.push({
      id: "topic_key", label: "What should it help them with?", why: ranked.length ? "These come from your topic bank and the questions people keep asking — ranked for this situation." : "No topic or frequent question is on file yet — name the topic, or let the AI propose one from the situation.",
      type: "select", options: [{ value: "ai_pick", label: "Let the AI pick the strongest topic" }, ...ranked.map((c) => ({ value: c.key, label: `${c.title}${c.source === "frequent_question" ? " (asked often)" : ""}` })), { value: "own", label: "I'll name the topic" }], required: true,
    })
  } else if (answers.topic_key === "own" && !(answers.topic ?? "").trim()) {
    q.push({ id: "topic", label: "Name the topic", why: "The magnet is built on it.", type: "text", required: true })
  }
  if (!answers.deliverable) q.push({ id: "deliverable", label: "Is there a format you prefer?", why: "Optional — otherwise the AI chooses the quickest real win for this situation.", type: "select", options: DELIVERABLE_CHOICES.map((d) => ({ ...d })), required: false })
  return { ready: !q.some((x) => x.required), questions: q }
}

// ── THE MAGNET DECISION (pure) ───────────────────────────────────────────────

export interface MagnetDecision {
  persona: SituationPersona
  side: SituationSide
  audience: string
  topic: string
  source: MagnetTopicSource
  question: string | null
  valueProposition: string
  benefit: string
  outcome: string
  evidence: Record<string, unknown>
  candidatesConsidered: number
}

const OUTCOME_BY_SIDE: Readonly<Record<SituationSide, string>> = Object.freeze({ buyer: "Take the next step toward the right home with confidence", seller: "Make a confident, well-timed decision about the sale", both: "Plan the sale and the next purchase with confidence" })

/** PURE. The magnet, decided FIRST: the topic (chosen candidate / the AI's pick / the agent's own), the persona and the value
 *  proposition the whole package is built on. Null when no topic can be named (the door asks for one). */
function decideMagnet(answers: PackageAnswers, topics: readonly MagnetTopicCandidate[]): MagnetDecision | null {
  const persona = canonicalSituation(answers.persona)
  const side: SituationSide = answers.side ?? SITUATION_SIDE[persona] ?? "both"
  const audience = persona === "other" ? (answers.persona_description ?? "").trim().slice(0, 120) || "people thinking about a move" : SITUATION_LABELS[persona]
  let chosen: MagnetTopicCandidate | null = null
  if (answers.topic_key && answers.topic_key !== "ai_pick" && answers.topic_key !== "own") chosen = topics.find((t) => t.key === answers.topic_key) ?? null
  if (!chosen && answers.topic_key === "ai_pick") chosen = rankMagnetTopics(topics, persona)[0] ?? null
  const own = (answers.topic ?? "").trim()
  const topic = chosen?.title ?? (own || null)
  if (!topic) return null
  const source: MagnetTopicSource = chosen?.source ?? "creator"
  const question = source === "frequent_question" ? topic : null
  const valueProposition = question
    ? `A clear, local answer to the question ${audience.toLowerCase()} keep asking: "${topic}"`
    : `${topic} — made practical for ${audience.toLowerCase()}`
  return {
    persona, side, audience, topic, source, question, valueProposition: valueProposition.slice(0, 220),
    benefit: (chosen?.angle ?? topic).slice(0, 160), outcome: OUTCOME_BY_SIDE[side], evidence: chosen ? { key: chosen.key, ...chosen.evidence } : { named_by: "creator" },
    candidatesConsidered: topics.length,
  }
}

// ── (2)+(3) THE PACKAGE ──────────────────────────────────────────────────────

export interface LeadMagnetPackage {
  form_id: string
  order: FunnelStageStamp[]
  magnet: MagnetDecision
  landing: { path: string | null; url: string | null; on_custom_domain: boolean; state: "draft" }
  qr: { qr_code_id: string; scan_url: string | null; image_data_url: string | null } | null
  /** created_by_user_id is the RECORDED creator (null when it could not be resolved to a member — never the raw input). */
  creator: { created_by_user_id: string | null; agent_id: string; origin: "create_button" | "arbiter" }
  funnel: MagnetFunnelPackage
  notes: string[]
}

export type LeadMagnetPackageResult =
  | { ok: true; package: LeadMagnetPackage }
  | { ok: false; stage: "input" | "questions" | "magnet" | "build" | "record"; error: string; questions?: PackageQuestion[]; notes?: string[] }

export interface PackageDeps {
  client?: Db
  now?: Date
  /** Seams handed to the ordered build (createMagnetFunnel). */
  funnel?: FunnelDeps
  /** @proofSeam the tracked-QR minter (server-only in production — lib/marketing/tracked-qr.ts). */
  mintTrackedQr?: (args: { brokerageId: string; agentId: string | null; label: string; destinationType: "landing_page"; targetUrl: string; purpose: "lead_magnet" }, svc: any) => Promise<{ qrCodeId: string; slug: string; scanUrl: string; targetUrl: string; qrCodeDataUrl: string } | null>
  readers?: SuggestionReaders
}

export interface LeadMagnetPackageInput {
  /** The VERIFIED tenant (session / the cron's own loop) — never a request body (§4). */
  brokerageId: string
  /** agents.id the magnet is filed to (assignment follows it). */
  agentId: string
  /** users.id of the creator (the person who clicked Create, or the owning agent's seat for an arbiter build). */
  createdBy: string
  origin: "create_button" | "arbiter"
  answers: PackageAnswers
  baseUrl?: string | null
  actor?: MagnetFunnelBrief["actor"]
  /** The arbiter's decision that started an arbiter build (recorded on the package). */
  arbiterDecision?: Record<string, unknown> | null
}

async function readTerritories(svc: Db, brokerageId: string): Promise<{ names: string[]; rows: Array<{ name: string | null; city: string | null; state: string | null; zip_codes: string[] | null; agent_id: string | null }>; note: string | null }> {
  const { data, error } = await svc.from("farm_territories").select("name, city, state, zip_codes, agent_id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(20)
  if (error) return { names: [], rows: [], note: `farm_territories read refused: ${error.message ?? "unknown"} — the area is asked` }
  const rows = (data ?? []) as Array<{ name: string | null; city: string | null; state: string | null; zip_codes: string[] | null; agent_id: string | null }>
  return { names: rows.map((r) => r.name ?? r.city ?? "").filter(Boolean), rows, note: null }
}

/** The landing page's home on the TENANT'S OWN website (ruling 12): a connected (active) custom domain's /lm/<slug> — served
 *  by proxy.ts through the tenant-site route — else the storefront path /site/<slug>/lm/<slug> on the app origin. */
async function tenantLandingLocation(svc: Db, brokerageId: string, brokerageSlug: string | null, formSlug: string, origin: string | null): Promise<{ path: string | null; url: string | null; onCustomDomain: boolean; note: string | null }> {
  const { data, error } = await svc.from("tenant_custom_domains").select("domain, status").eq("brokerage_id", brokerageId).eq("status", "active").limit(1)
  const domain = !error ? ((data ?? []) as Array<{ domain: string | null }>)[0]?.domain ?? null : null
  if (domain) return { path: `/lm/${formSlug}`, url: `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/lm/${formSlug}`, onCustomDomain: true, note: null }
  const path = brokerageSlug ? `/site/${brokerageSlug}/lm/${formSlug}` : null
  return { path, url: path && origin ? `${origin.replace(/\/$/, "")}${path}` : null, onCustomDomain: false, note: error ? `tenant_custom_domains read refused: ${error.message ?? "unknown"} — the storefront path is used` : null }
}

/**
 * C30 — THE COMPLETE PACKAGE, from scratch, in the owner's order. Asks before it builds (returns the questions while an answer
 * is missing); then (1) the magnet (decideMagnet + the primary asset first), (2) the landing page on the tenant site with the
 * situation form, (3) the funnel + the QR + attribution — all through createMagnetFunnel's ordered stages. The page is a DRAFT:
 * publishLeadMagnet (C5) is the human approval. Never throws.
 */
export async function createLeadMagnetPackage(input: LeadMagnetPackageInput, deps: PackageDeps = {}): Promise<LeadMagnetPackageResult> {
  const notes: string[] = []
  try {
    if (!input.brokerageId || !input.agentId || !input.createdBy) return { ok: false, stage: "input", error: "Missing required fields: brokerageId, agentId, createdBy" }
    const svc: Db = deps.client ?? ((await import("@/lib/supabase/service")).createServiceClient() as unknown as Db)
    const now = deps.now ?? new Date()

    // THE QUESTIONS FIRST — the door never builds on a guess.
    const [topicRead, terr] = await Promise.all([readMagnetTopicCandidates(svc, input.brokerageId, { now, readers: deps.readers }), readTerritories(svc, input.brokerageId)])
    notes.push(...topicRead.notes, ...(terr.note ? [terr.note] : []))
    // ONE territory on file is the area; several are a choice the agent makes (the door asks).
    const answers: PackageAnswers = { ...input.answers, area: (input.answers.area ?? "").trim() || (terr.names.length === 1 ? terr.names[0] : null) }
    const intake = leadMagnetPackageQuestions(answers, { topics: topicRead.candidates, territories: terr.names })
    if (!intake.ready) return { ok: false, stage: "questions", error: "A few answers are needed before the package is built.", questions: intake.questions, notes }

    // (1) THE MAGNET — decided first.
    const magnet = decideMagnet(answers, topicRead.candidates)
    if (!magnet) return { ok: false, stage: "magnet", error: "No topic could be chosen — name the topic, or add topics to the topic bank.", questions: [{ id: "topic", label: "Name the topic", why: "The magnet is built on it.", type: "text", required: true }], notes }
    const t = terr.rows.find((r) => (r.name ?? r.city) === answers.area) ?? null
    const territory = t ? { zip: t.zip_codes?.[0] ?? null, city: t.city ?? null, state: t.state ?? null } : null
    const preferred = answers.deliverable && answers.deliverable !== "ai" ? [answers.deliverable] : []

    // (1)→(2)→(3) — the ordered build (one engine).
    const { createMagnetFunnel } = await import("./magnet-funnel")
    const built = await createMagnetFunnel({
      brokerageId: input.brokerageId, agentId: input.agentId, createdBy: input.createdBy,
      audience: magnet.audience, benefit: magnet.benefit, outcome: magnet.outcome, area: answers.area ?? null, territory,
      preferredDeliverables: preferred as MagnetFunnelBrief["preferredDeliverables"], baseUrl: input.baseUrl ?? null, actor: input.actor ?? null,
      persona: magnet.persona, side: magnet.side,
      magnet: { topic: magnet.topic, source: magnet.source, valueProposition: magnet.valueProposition, question: magnet.question, evidence: magnet.evidence },
    }, { ...(deps.funnel ?? {}), client: svc, now })
    if (!built.ok) return { ok: false, stage: "build", error: built.error, notes: [...notes, ...(built.notes ?? [])] }
    const pkg = built.package
    const formId = pkg.landing_page.form_id

    // THE LANDING PAGE'S HOME on the tenant user's website + the QR to it (ruling 11 — part of the funnel stage).
    const { data: b, error: bErr } = await svc.from("brokerages").select("slug").eq("id", input.brokerageId).maybeSingle()
    if (bErr) notes.push(`brokerages read refused: ${bErr.message ?? "unknown"} — the storefront path cannot be named`)
    const loc = await tenantLandingLocation(svc, input.brokerageId, (b as { slug?: string | null } | null)?.slug ?? null, pkg.landing_page.slug, input.baseUrl ?? null)
    if (loc.note) notes.push(loc.note)
    let qr: LeadMagnetPackage["qr"] = null
    if (loc.url) {
      const { generateQRCode } = await import("@/lib/kernel/lead-magnets")
      const target = `${loc.url}${loc.url.includes("?") ? "&" : "?"}utm_source=qr&utm_medium=print&utm_campaign=${encodeURIComponent(String((pkg.attribution as { utm_campaign?: string }).utm_campaign ?? "magnet"))}`
      const q = await generateQRCode({ magnetId: formId, brokerageId: input.brokerageId, agentId: input.agentId, label: pkg.landing_page.headline, targetUrl: target }, { client: svc as never, ...(deps.mintTrackedQr ? { mintTrackedQr: deps.mintTrackedQr } : {}) })
      if (q.success && q.qrCodeId) qr = { qr_code_id: q.qrCodeId, scan_url: q.scanUrl ?? null, image_data_url: q.qrImageUrl ?? null }
      else notes.push(`the QR code was NOT created: ${q.error ?? "unknown"} — publishing with the QR channel mints it again (one QR per magnet)`)
    } else notes.push("no public origin or custom domain — the landing URL is a path, so the QR is minted at publish (it needs an absolute URL)")

    // RECORD the package on the form (counted; tenant-pinned). created_by_user_id was written by createLeadMagnet.
    const { data: f, error: fErr } = await svc.from("lead_capture_forms").select("id, settings, created_by_user_id, qr_code_id").eq("id", formId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (fErr || !f) return { ok: false, stage: "record", error: `the drafted page could not be re-read: ${fErr?.message ?? "no row"} — it stays an unpublishable draft`, notes }
    const settings = { ...((f as { settings?: Record<string, unknown> | null }).settings ?? {}), package: {
      contract: "C30", version: 1, origin: input.origin, order: pkg.order.map((o) => ({ stage: o.stage, seq: o.seq, at: o.at })),
      magnet: { topic: magnet.topic, source: magnet.source, persona: magnet.persona, side: magnet.side, value_proposition: magnet.valueProposition, question: magnet.question, evidence: magnet.evidence },
      landing: { path: loc.path, url: loc.url, on_custom_domain: loc.onCustomDomain }, qr_code_id: qr?.qr_code_id ?? null,
      follow_up: "decided by the arbiter (C29) — no fixed timetable", arbiter_decision: input.arbiterDecision ?? null, created_at: now.toISOString(),
    } }
    const { data: upd, error: uErr } = await svc.from("lead_capture_forms").update({ settings, ...(qr ? { qr_code_id: qr.qr_code_id } : {}) }).eq("id", formId).eq("brokerage_id", input.brokerageId).select("id")
    if (uErr || !Array.isArray(upd) || upd.length !== 1) notes.push(`the package record was not written on the form: ${uErr?.message ?? "matched no row"} — the page and its items stand; the package summary is this response`)
    const priorQr = (f as { qr_code_id?: string | null }).qr_code_id ?? null
    if (priorQr && qr && priorQr !== qr.qr_code_id) notes.push(`the form already pointed at QR ${priorQr}; it now points at ${qr.qr_code_id} (one lead-magnet QR identity)`)
    const creatorId = (f as { created_by_user_id?: string | null }).created_by_user_id ?? null
    if (!creatorId) notes.push("the creator could not be resolved to a user of this tenant — created_by_user_id is empty (m942 unapplied, or the creator is not a member)")

    return {
      ok: true,
      package: {
        form_id: formId, order: pkg.order, magnet,
        landing: { path: loc.path, url: loc.url, on_custom_domain: loc.onCustomDomain, state: "draft" },
        qr, creator: { created_by_user_id: creatorId, agent_id: input.agentId, origin: input.origin },
        funnel: pkg, notes: [...notes, ...pkg.notes],
      },
    }
  } catch (e) {
    return { ok: false, stage: "build", error: `createLeadMagnetPackage threw: ${e instanceof Error ? e.message : String(e)}`, notes }
  }
}

// ── THE ARBITER DECIDES WHEN ONE IS NEEDED ────────────────────────────────────

/** An opportunity the discovery found: WHAT to build, FOR WHOM, WHY — with its evidence (lib/lead-magnets/suggestions.ts). */
export interface MagnetOpportunity {
  key: string
  what: string
  forWhom: { persona: string | null; side: SituationSide | null; area: string | null }
  why: string
  source: string
  evidence: Record<string, unknown>
}

const SELLER_MAGNET_TYPES = new Set(["home_valuation", "seller_guide", "market_report"])
const BUYER_MAGNET_TYPES = new Set(["buyer_guide", "listing_alert", "open_house"])

/** PURE. A discovered idea (lib/lead-magnets/suggestions.ts) → the opportunity the arbiter weighs: what, for whom, why, evidence.
 *  The persona is named only when the evidence names it (never inferred from a person); the side follows the idea's type. */
export function opportunityFromSuggestion(s: { key: string; kind: string; magnetType: string; concept: string; why: string; evidence: Record<string, unknown> }, area: string | null): MagnetOpportunity {
  const named = typeof s.evidence?.persona === "string" ? (s.evidence.persona as string) : null
  const side: SituationSide = SELLER_MAGNET_TYPES.has(s.magnetType) ? "seller" : BUYER_MAGNET_TYPES.has(s.magnetType) ? "buyer" : "both"
  return { key: s.key, what: s.concept, forWhom: { persona: named, side, area }, why: s.why, source: s.kind, evidence: s.evidence ?? {} }
}

export const LEAD_MAGNET_OPPORTUNITY_ARBITER_SYSTEM = `ROLE
You are the head of marketing strategy inside a real-estate agent's AI team — the strategist who decides WHEN a new lead
magnet is worth building, the way a seasoned marketing director protects a busy agent's attention and budget.

MANDATE
One opportunity is in front of you: what could be built, for which situation, and why (the evidence). Decide ONE option from
the closed menu: build the complete lead-magnet package now (it is created as a DRAFT — a person reviews and publishes it),
wait (a bounded number of hours, when the evidence is thin or the tenant already has a live magnet for this situation), or
ask the agent (when the call needs their judgment: a sensitive situation, an unclear audience, or a topic they should own).

BUSINESS CONTEXT
The tenant is a solo agent, a team or a brokerage. The AI team is "by the agent's side": kind, neighbourly, never salesy.
A lead magnet earns attention by giving a real, quick win to people in one situation; a weak or redundant magnet wastes the
agent's credibility.

THE FACTS YOU MAY RELY ON — and nothing else
The opportunity (what / for whom / why), its evidence (topic-bank engagement, how many conversations asked the question,
rising search demand, AI-search gaps where competitors are cited), the tenant's existing magnets for that situation and the
moment's age. Never invent demand, a statistic or a competitor.

THE DECISION YOU OWN
Whether a package is needed NOW. You do not write the copy (the package does) and you never publish (a person does).

OUTPUT CONTRACT
The typed reply: optionId (from the menu), channel null, format null, waitHours (only for wait), a rationale in one or two
sentences that names the evidence, evidence (the fact keys you used), confidence 0..1.

COMPLIANCE BOUNDARY
Every persona is a lawful audience (a persona is the person's situation). Fair housing applies to the WORDING of what gets
published — the package's writers and scans own that. Never choose to build something whose purpose is to exploit hardship.

ESCALATION RULE
When the evidence is thin, conflicting, or the situation is sensitive (an estate, a separation, a payment deadline), ask the
agent rather than build.`

export interface OpportunityDeps {
  decide?: import("@/lib/ai-isa/followup-arbiter").ArbiterDecide
  policy?: import("@/lib/ai-isa/followup-policy").FollowupPolicy
  build?: (input: LeadMagnetPackageInput) => Promise<LeadMagnetPackageResult>
  baseUrl?: string | null
  now?: Date
}

export type OpportunityOutcome = { action: "built"; package: LeadMagnetPackage; decision: Record<string, unknown> } | { action: "waiting" | "asked_agent" | "not_built"; reason: string; decision: Record<string, unknown> | null }

/** Who would own an arbiter-built package: the territory's agent, else the tenant's ONLY active agent (a solo agent) — never a
 *  guess between several (a team / brokerage gets "ask the agent" instead). */
async function owningSeat(svc: Db, brokerageId: string, area: string | null): Promise<{ agentId: string; userId: string } | null> {
  if (area) {
    const { data, error } = await svc.from("farm_territories").select("agent_id, name, city").eq("brokerage_id", brokerageId).eq("is_active", true).limit(20)
    const hit = !error ? ((data ?? []) as Array<{ agent_id: string | null; name: string | null; city: string | null }>).find((t) => t.agent_id && (t.name === area || t.city === area)) : null
    if (hit?.agent_id) {
      const { data: ag, error: agErr } = await svc.from("agents").select("id, user_id").eq("id", hit.agent_id).eq("brokerage_id", brokerageId).maybeSingle()
      if (!agErr && ag?.user_id) return { agentId: ag.id, userId: ag.user_id }
    }
  }
  const { data: agents, error } = await svc.from("agents").select("id, user_id, is_active").eq("brokerage_id", brokerageId).eq("is_active", true).limit(2)
  const list = (!error ? (agents ?? []) : []) as Array<{ id: string; user_id: string | null }>
  return list.length === 1 && list[0].user_id ? { agentId: list[0].id, userId: list[0].user_id } : null
}

/**
 * The arbiter decides whether an opportunity becomes a package NOW. The ONE arbiter (arbitrateFollowUp) over a closed menu
 * (build_package · wait · ask_agent), with this module's expert brief; its validator refuses an off-menu or evidence-less reply
 * and an outage falls to ASK THE AGENT. A build is a DRAFT owned by the territory's / the solo tenant's seat; everything is
 * recorded under the action ledger (marketing.lead_magnet_opportunity.decide). Never throws.
 */
export async function arbitrateLeadMagnetOpportunity(svc: Db, input: { brokerageId: string; opportunity: MagnetOpportunity; existingForPersona?: number; daysSinceSeen?: number }, deps: OpportunityDeps = {}): Promise<OpportunityOutcome> {
  try {
    const arb = await import("@/lib/ai-isa/followup-arbiter")
    const policy = deps.policy ?? (await (await import("@/lib/ai-isa/followup-policy")).loadFollowupPolicy(svc as never, input.brokerageId)).policy
    const o = input.opportunity
    const menu = { menu: [
      { id: "build_package", kind: "education" as const, channels: [], why: [`${o.what} — for ${o.forWhom.persona ?? "this audience"}`, o.why] },
      { id: "wait", kind: "wait" as const, channels: [], why: ["the evidence may strengthen; nothing is lost by waiting"] },
      { id: "ask_agent", kind: "agent_intervention" as const, channels: ["human_task" as const], why: ["the agent knows their market and their capacity"] },
    ], locked: null }
    const planned = menu.menu[2]
    const facts = {
      subject: "lead" as const,
      relationship: { type: "audience_segment", persona: o.forWhom.persona, hasAssignedAgent: false },
      intent: null, preferences: [], fatigueRisk: null, localHour: null,
      history: { hoursSinceAnyTouch: null, hoursSinceAgentTouch: null, campaignTouches7d: input.existingForPersona ?? null, lastChannel: null, portalEducationViews: null },
      journey: { transactionStage: null, nextMilestone: o.forWhom.side, openLessons: null, nextLesson: o.what },
      moment: { key: "lead_magnet_opportunity", intent: `${o.what}. Why: ${o.why}. Source: ${o.source}.`, daysSinceOpen: input.daysSinceSeen ?? 0 },
      blindSpots: [`evidence: ${JSON.stringify(o.evidence).slice(0, 400)}`, `live magnets already serving this persona: ${input.existingForPersona ?? "unknown"}`],
    }
    const decision = await arb.arbitrateFollowUp({ brokerageId: input.brokerageId, facts, menu, planned, policy, system: LEAD_MAGNET_OPPORTUNITY_ARBITER_SYSTEM }, { decide: deps.decide })
    const d = { optionId: decision.optionId, kind: decision.kind, waitHours: decision.waitHours, rationale: decision.rationale, evidence: decision.evidence, confidence: decision.confidence, source: decision.source, fallbackReason: decision.fallbackReason }

    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    return await withActionLedger<OpportunityOutcome>(
      { brokerageId: input.brokerageId, action: "marketing.lead_magnet_opportunity.decide", actor: { type: "manager", managerKey: "campaign_orchestrator" }, subject: { type: "lead_magnet_opportunity", ref: o.key }, reasonCode: "OPPORTUNITY_DISCOVERED", reasonDetail: `${o.what} — ${o.why}`.slice(0, 500), riskClass: "LOW_RISK_WRITE", systemSource: "lead_magnets", idempotencyKey: `lmo:${input.brokerageId}:${o.key}:${(deps.now ?? new Date()).toISOString().slice(0, 10)}`, detail: { opportunity: o, decision: d } },
      async () => {
        if (decision.optionId === "wait") return { action: "waiting", reason: `the arbiter waits ${decision.waitHours ?? "?"}h — ${decision.rationale}`, decision: d }
        if (decision.optionId !== "build_package") return { action: "asked_agent", reason: decision.rationale, decision: d }
        const seat = await owningSeat(svc, input.brokerageId, o.forWhom.area)
        if (!seat) return { action: "asked_agent", reason: "the arbiter would build it, but no single owning agent can be named (a team or brokerage with several agents and no territory owner) — the agent decides", decision: d }
        const build = deps.build ?? ((x: LeadMagnetPackageInput) => createLeadMagnetPackage(x, { client: svc, now: deps.now }))
        const r = await build({ brokerageId: input.brokerageId, agentId: seat.agentId, createdBy: seat.userId, origin: "arbiter", baseUrl: deps.baseUrl ?? null, arbiterDecision: d, answers: { persona: o.forWhom.persona ?? "other", persona_description: o.forWhom.persona ? null : (o.forWhom.side === "seller" ? "Homeowners thinking about selling" : o.forWhom.side === "buyer" ? "People thinking about buying a home" : "People thinking about a move"), side: o.forWhom.side, area: o.forWhom.area, topic_key: "own", topic: o.what, deliverable: "ai" } })
        if (r.ok) return { action: "built", package: r.package, decision: d }
        // The package still needs an answer only a person can give (no territory on file, several areas) — the agent is asked.
        if (r.stage === "questions") return { action: "asked_agent", reason: `the arbiter would build it, but the package needs: ${(r.questions ?? []).filter((q) => q.required).map((q) => q.id).join(", ") || "an answer"} — the agent decides`, decision: d }
        return { action: "not_built", reason: `${r.stage}: ${r.error}`, decision: d }
      },
      {
        settle: (r) => ({ status: r.action === "not_built" ? "failed" : "executed", outcome: r.action, providerRef: r.action === "built" ? r.package.form_id : null, ...(r.action === "not_built" ? { error: r.reason } : {}) }),
        replay: (claim) => ({ action: "not_built", reason: `already decided for this opportunity (${claim.kind})`, decision: null }),
      },
      { client: svc as never },
    )
  } catch (e) {
    return { action: "not_built", reason: `arbitrateLeadMagnetOpportunity threw: ${e instanceof Error ? e.message : String(e)}`, decision: null }
  }
}
