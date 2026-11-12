// lib/kernel/conversation-memory.ts
//
// THE CONTEXT SPINE — one shared, durable memory of a contact, so every manager
// (AI ISA, the agent, the concierges, the Director) acts on the SAME running
// summary and nobody "forgets what was discussed." In a great office the team
// keeps ONE living note per client — last touch, what they said they want, the
// open commitment, the mood — and reads it before they reach out. This is that
// note, persisted.
//
// What it is NOT: a second state machine. buyer_stage / contact_type /
// contact_persona remain the canonical journey (JOURNEY_PROGRESS_CONTRACT owns
// those). The spine SUMMARIZES the conversation + stated preferences +
// commitments; it never contradicts or duplicates canonical state.
//
// Where it lives: contacts.metadata->'context_spine' (jsonb) — REUSED, no new
// table. metadata is already a first-class jsonb on contacts (tenant-scoped via
// the contact's brokerage_id, FK + RLS already on the row). One contact, one
// spine, updated in place.
//
// Honesty: composeContextSummary reads ONLY real interaction rows. No
// interactions → an honest empty spine (never an invented fact). The AI
// summarizer is an injectable seam (like ai-copy.ts) — production routes through
// the gateway, tests/fallback compose deterministically from the rows. The AI
// may only RE-PHRASE the deterministic facts; it can add nothing not in the rows.
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import { LANGUAGE_NAMES } from "@/lib/video/language-vocabulary"

type Svc = ReturnType<typeof createServiceClient>

/** One normalized interaction row, distilled from conversations/activities/ai_isa_activities. */
export interface InteractionRow {
  /** ISO timestamp of the touch. */
  at: string
  /** "conversation" | "activity" | "ai_isa" — the source lane. */
  source: "conversation" | "activity" | "ai_isa"
  /** "inbound" | "outbound" | null — who reached out, when known. */
  direction?: "inbound" | "outbound" | null
  /** sms | email | call | portal | … (best-effort). */
  channel?: string | null
  /** the durable line: a summary/title/description from the real row. */
  text?: string | null
  /** positive | neutral | negative | mixed (best-effort, from the row). */
  sentiment?: string | null
  /** the row's outcome, when present (e.g. "appointment_set", "no_answer"). */
  outcome?: string | null
}

/** Stated criteria / commitments the team already knows — read from canonical fields, never invented. */
export interface ContactFacts {
  /** canonical journey labels (NOT re-derived here — surfaced for the summary). */
  contactType?: string | null
  buyerStage?: string | null
  persona?: string | null
  /** stated preferences/criteria already captured (e.g. "3bd under $600k", "wants a yard"). */
  preferences?: string[]
  /** the next agreed step, if one is on record (e.g. "tour Saturday", "send pre-approval doc"). */
  openNextStep?: string | null
  /** Lane 97B: the structured facts the canonical columns state right now — the
   *  memory compiler records them into the spine's facts ledger. */
  observed?: Array<{ key: MemoryFactKey; value: string; confidence: number; source: string }>
}

/** The persisted running summary — the spine. */
export interface ContextSpine {
  /** the one-paragraph running summary the whole team reads. */
  summary: string
  /** ISO timestamp of the most recent real touch (null when none). */
  lastTouch: string | null
  /** the stated preferences/criteria carried forward. */
  preferences: string[]
  /** the open commitment / next step on record (null when none). */
  openNextStep: string | null
  /** the latest sentiment read from the rows ("unknown" when none). */
  sentiment: string
  /** durable key facts distilled from the interactions (deduped, capped). */
  keyFacts: string[]
  /** how many real interaction rows this spine was composed from. */
  interactionCount: number
  /** ISO timestamp this spine was last (re)composed. */
  updatedAt: string
  /** Lane 97B MEMORY COMPILER: the facts ledger (current + superseded), carried
   *  forward across recompositions. Absent on spines written before lane 97B. */
  facts?: MemoryFact[]
}

// ─── MEMORY COMPILER: facts with confidence + expiry (lane 97B, blueprint row 19) ──
//
// The spine's keyFacts are free text with no age, no confidence and no expiry — a
// timeline stated in March reads exactly like one stated this morning, and a new
// price silently replaced the old one (or sat beside it, contradicting it). This is
// the structured half, IN the same jsonb (contacts.metadata.context_spine.facts —
// no migration, no new table):
//   · every fact carries observed_at, confidence (0-1) and review_by;
//   · a CONTRADICTING NEWER fact SUPERSEDES the older one — the old row is KEPT and
//     marked superseded (never overwritten), so history survives;
//   · the AI context reads ONLY current, unexpired facts (memoryContextBlock) —
//     cheaper context and no stale fact presented as true.
// Deterministic; the model never decides what is current.

export type MemoryFactKey =
  | "timeline" | "price_expectation" | "channel_preference" | "motivation"
  // WAVE 150 (lane 150QTV, directive 150Q — preference memory from the person's OWN words; survivor first: this ledger, not a
  // second store). Written by rememberStatedPreferences (end of this file) (the inbound chain,
  // lib/communications/inbound-record.ts) only from a first-person statement; read by the arbiter (ARBITER_MEMORY_KEYS) and every
  // AI surface through memoryContextBlock. `preferred_contact_time` / `language` are the arbiter's existing memory spellings (§6).
  | "preferred_contact_time" | "language" | "communication_format" | "contact_frequency" | "barrier" | "explanation_style" | "scenario_choice"

export interface MemoryFact {
  key: MemoryFactKey
  value: string
  /** ISO — when this value was observed. */
  observedAt: string
  /** 0-1. */
  confidence: number
  /** ISO — after this the fact is due for re-confirmation and leaves the AI context. */
  reviewBy: string
  /** Where it came from (a column name, a tool, a conversation id). */
  source: string
  /** ISO — set when a newer contradicting fact replaced this one. */
  supersededAt?: string | null
  /** The value that replaced it. */
  supersededBy?: string | null
}

/** Days until a fact must be re-confirmed. A price expectation moves with the market;
 *  a channel preference is stable. */
export const MEMORY_FACT_REVIEW_DAYS: Readonly<Record<MemoryFactKey, number>> = Object.freeze({
  timeline: 60,
  price_expectation: 45,
  channel_preference: 180,
  motivation: 120,
  // Wave 150 (150Q): how the person asked to be reached / spoken to is stable; a stated barrier or a "fewer messages" request is
  // re-confirmed sooner, because circumstances move and the person should not be held to an old sentence.
  preferred_contact_time: 180,
  language: 365,
  communication_format: 180,
  contact_frequency: 60,
  barrier: 45,
  explanation_style: 180,
  scenario_choice: 90,
})
/** History kept per key (current + superseded) — bounded so the jsonb cannot grow forever. */
export const MEMORY_FACT_HISTORY_CAP = 5
const MEMORY_FACT_KEYS: readonly MemoryFactKey[] = Object.keys(MEMORY_FACT_REVIEW_DAYS) as MemoryFactKey[]

const normFactValue = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ")

/** Read a facts ledger out of a spine-shaped value (or a bare array). Tolerates junk. */
function readFactsLedger(spineOrFacts: unknown): MemoryFact[] {
  const raw = Array.isArray(spineOrFacts) ? spineOrFacts
    : (spineOrFacts && typeof spineOrFacts === "object" && Array.isArray((spineOrFacts as { facts?: unknown }).facts))
      ? (spineOrFacts as { facts: unknown[] }).facts : []
  return raw.filter((f): f is MemoryFact => !!f && typeof f === "object"
    && MEMORY_FACT_KEYS.includes((f as MemoryFact).key)
    && typeof (f as MemoryFact).value === "string"
    && typeof (f as MemoryFact).observedAt === "string"
    && typeof (f as MemoryFact).reviewBy === "string")
}

/**
 * PURE. Record an observed fact into the ledger and return the NEW ledger.
 *   · same value as the current fact → the current one is RE-CONFIRMED (observed_at,
 *     review_by and confidence move forward; no new row);
 *   · different value, observed at/after the current one → the current one is marked
 *     superseded (kept) and the new one becomes current;
 *   · different value observed BEFORE the current one → kept as history, already
 *     superseded — an old statement arriving late never displaces a newer one.
 */
/** @proofSeam exported so scripts/conversation-memory-simulator.ts asserts the fact rules (supersede, expiry, review) on the pure function directly. */
export function recordMemoryFact(
  ledgerIn: readonly MemoryFact[],
  incoming: { key: MemoryFactKey; value: string; observedAt: string; confidence: number; source: string; reviewDays?: number },
): MemoryFact[] {
  const value = (incoming.value ?? "").trim()
  const t = new Date(incoming.observedAt).getTime()
  if (!value || !Number.isFinite(t)) return [...ledgerIn]
  const confidence = Math.max(0, Math.min(1, incoming.confidence > 1 ? incoming.confidence / 100 : incoming.confidence))
  const reviewBy = new Date(t + (incoming.reviewDays ?? MEMORY_FACT_REVIEW_DAYS[incoming.key]) * 86_400_000).toISOString()
  const fresh: MemoryFact = { key: incoming.key, value, observedAt: new Date(t).toISOString(), confidence, reviewBy, source: incoming.source, supersededAt: null, supersededBy: null }

  const ledger = ledgerIn.map((f) => ({ ...f }))
  const current = ledger.find((f) => f.key === incoming.key && !f.supersededAt)
  if (!current) {
    ledger.push(fresh)
  } else if (normFactValue(current.value) === normFactValue(value)) {
    if (t >= new Date(current.observedAt).getTime()) {
      current.observedAt = fresh.observedAt
      current.reviewBy = fresh.reviewBy
      current.confidence = Math.max(current.confidence, confidence)
      current.source = incoming.source
    }
  } else if (t >= new Date(current.observedAt).getTime()) {
    current.supersededAt = fresh.observedAt
    current.supersededBy = value
    ledger.push(fresh)
  } else {
    ledger.push({ ...fresh, supersededAt: current.observedAt, supersededBy: current.value })
  }

  // Bound the history per key: keep the current fact + the newest superseded ones.
  const out: MemoryFact[] = []
  for (const key of MEMORY_FACT_KEYS) {
    const rows = ledger.filter((f) => f.key === key)
      .sort((a, b) => (a.supersededAt ? 1 : 0) - (b.supersededAt ? 1 : 0) || new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())
    out.push(...rows.slice(0, MEMORY_FACT_HISTORY_CAP))
  }
  return out
}

/** PURE. The facts the AI may rely on now: not superseded, review_by still ahead. */
export function currentMemoryFacts(spineOrFacts: unknown, now: Date = new Date()): MemoryFact[] {
  return readFactsLedger(spineOrFacts)
    .filter((f) => !f.supersededAt && new Date(f.reviewBy).getTime() > now.getTime())
}

/** PURE. The facts that EXPIRED (still current, but past review_by) — what to re-confirm. */
/** @proofSeam exported so scripts/conversation-memory-simulator.ts asserts the fact rules (supersede, expiry, review) on the pure function directly. */
export function factsDueForReview(spineOrFacts: unknown, now: Date = new Date()): MemoryFact[] {
  return readFactsLedger(spineOrFacts)
    .filter((f) => !f.supersededAt && new Date(f.reviewBy).getTime() <= now.getTime())
}

const FACT_LABEL: Readonly<Record<MemoryFactKey, string>> = {
  timeline: "timeline", price_expectation: "price expectation", channel_preference: "preferred channel", motivation: "motivation",
  preferred_contact_time: "best time to reach them", language: "language", communication_format: "preferred format",
  contact_frequency: "how often they want to hear from us", barrier: "what is in the way", explanation_style: "how they like things explained",
  scenario_choice: "the path they chose",
}

/**
 * PURE. The compiled memory an AI surface puts in its context: the running summary
 * plus ONLY current, unexpired facts (with how sure we are), plus the keys that are
 * due for a gentle re-confirm — never the stale value itself.
 */
export function memoryContextBlock(spine: unknown, now: Date = new Date()): string {
  const s = (spine && typeof spine === "object") ? spine as Partial<ContextSpine> : {}
  const lines: string[] = []
  if (typeof s.summary === "string" && s.summary.trim()) lines.push(s.summary.trim().slice(0, 1200))
  const current = currentMemoryFacts(spine, now)
  if (current.length > 0) {
    lines.push(`Known facts: ${current.map((f) => `${FACT_LABEL[f.key]}: ${f.value} (${f.confidence >= 0.75 ? "confirmed" : "tentative"})`).join("; ")}.`)
  }
  const due = factsDueForReview(spine, now)
  if (due.length > 0) lines.push(`Worth re-confirming naturally (older info, not shown): ${due.map((f) => FACT_LABEL[f.key]).join(", ")}.`)
  return lines.join("\n")
}

/** Injectable seam: re-phrase the deterministic summary into one warm paragraph, or null to fall back. */
export type SummaryRewriter = (input: {
  /** the deterministic facts the rewriter may use — and NOTHING else. */
  facts: string[]
  /** the deterministic summary it is rewriting. */
  draft: string
}) => Promise<string | null>

/** The real rewriter — routes through the AI gateway. Returns null on any failure so the
 *  deterministic draft stands. The system prompt forbids adding any fact not provided. */
export const realSummaryRewriter: SummaryRewriter = async ({ facts, draft }) => {
  if (facts.length === 0) return null
  const { gatewayChat } = await import("@/lib/ai/gateway-chat")
  const sys = [
    "You maintain a real-estate team's shared note on a client. Rewrite the draft into ONE warm, concise paragraph (<=70 words).",
    "Rules you must NEVER break:",
    "1. Use ONLY the facts listed — invent nothing (no prices, dates, names, or claims not given).",
    "2. Do not contradict or restate the client's journey stage as if it were new; summarize the conversation and commitments.",
    "3. Plain, factual, no fluff. Return ONLY the paragraph, no preamble.",
  ].join("\n")
  const usr = `Facts you may use:\n${facts.map((f) => `- ${f}`).join("\n")}\n\nDraft to tighten:\n${draft}`
  const res = await gatewayChat({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    maxTokens: 220, temperature: 0.3,
  }).catch(() => null)
  if (!res?.ok || !res.content) return null
  const out = res.content.trim()
  return out.length > 0 ? out : null
}

const MAX_PREFS = 8
const MAX_FACTS = 8

function dedupeCap(items: Array<string | null | undefined>, cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const v = (raw ?? "").trim()
    if (!v) continue
    const k = v.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
    if (out.length >= cap) break
  }
  return out
}

function relTime(iso: string | null, now: Date): string {
  if (!iso) return "never"
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000)
  if (Number.isNaN(days)) return "recently"
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

/**
 * PURE: compose a running summary from REAL interaction rows + already-known facts.
 * Deterministic by default; the injectable rewriter may only re-phrase these same
 * facts. Honest empty when there are no interactions. Never invents a fact.
 */
export async function composeContextSummary(
  interactions: InteractionRow[],
  facts: ContactFacts = {},
  opts: { now?: Date; rewriter?: SummaryRewriter } = {},
): Promise<ContextSpine> {
  const now = opts.now ?? new Date()
  // Most-recent first; only rows with a real timestamp count as a "touch".
  const rows = [...interactions]
    .filter((r) => r && typeof r.at === "string" && r.at.length > 0)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  const lastTouch = rows[0]?.at ?? null
  const preferences = dedupeCap(facts.preferences ?? [], MAX_PREFS)
  // open next step: prefer the explicit canonical commitment, else the latest outbound "next" cue.
  const openNextStep = (facts.openNextStep ?? "").trim() || null

  // sentiment: the most recent row that actually carries one.
  const sentiment = rows.find((r) => (r.sentiment ?? "").trim())?.sentiment?.trim() || "unknown"

  // key facts: the most recent real lines, deduped (these are the durable "what was discussed").
  const keyFacts = dedupeCap(rows.map((r) => (r.text ?? "").trim()).filter(Boolean), MAX_FACTS)

  // Honest empty: nothing real to summarize.
  if (rows.length === 0 && preferences.length === 0 && !openNextStep) {
    return {
      summary: "No interactions on record yet — the team has nothing to summarize.",
      lastTouch: null, preferences: [], openNextStep: null, sentiment: "unknown",
      keyFacts: [], interactionCount: 0, updatedAt: now.toISOString(),
    }
  }

  // Deterministic draft — every clause backed by a real row/field.
  const parts: string[] = []
  if (lastTouch) {
    const top = rows[0]
    const via = [top.channel, top.direction].filter(Boolean).join(" ")
    parts.push(`Last touch ${relTime(lastTouch, now)}${via ? ` (${via})` : ""}${top.text ? `: ${top.text}` : ""}.`)
  }
  const journey = [facts.contactType, facts.buyerStage].filter(Boolean).join(" · ")
  if (journey) parts.push(`Journey: ${journey}.`)
  if (preferences.length > 0) parts.push(`Stated preferences: ${preferences.join("; ")}.`)
  if (openNextStep) parts.push(`Open next step: ${openNextStep}.`)
  if (sentiment !== "unknown") parts.push(`Sentiment: ${sentiment}.`)
  if (keyFacts.length > 1) parts.push(`Also discussed: ${keyFacts.slice(1).join("; ")}.`)

  const draft = parts.join(" ").trim()

  // The facts the rewriter is allowed to use — exactly the deterministic clauses.
  const rewriter = opts.rewriter
  let summary = draft
  if (rewriter) {
    const rewritten = await rewriter({ facts: parts, draft }).catch(() => null)
    if (rewritten && rewritten.trim()) summary = rewritten.trim()
  }

  return {
    summary,
    lastTouch,
    preferences,
    openNextStep,
    sentiment,
    keyFacts,
    interactionCount: rows.length,
    updatedAt: now.toISOString(),
  }
}

/** Read a contact's REAL interactions from the live tables, normalized to InteractionRow[]. */
async function loadContactInteractions(
  supabase: Svc, contactId: string, opts: { limit?: number } = {},
): Promise<InteractionRow[]> {
  const limit = opts.limit ?? 20
  const [convs, acts, isa] = await Promise.all([
    // SENTIMENT COMES FROM THE THREAD ANALYSER, NOT FROM `conversations`.
    // `conversations.sentiment` was READ BY CODE AND WRITTEN BY NOBODY (census
    // 1b) — neither writer of a conversations row
    // (lib/kernel/conversation-thread.ts:63, app/api/webhooks/meta-dm/route.ts)
    // names it — so every conversation-sourced interaction row below carried a
    // null sentiment, and the contact memory this feeds concluded that no thread
    // had ever had a mood.
    // SURVIVOR: `conversation_insights.overall_sentiment`, written for every
    // analysed thread at lib/intelligence/conversation-insights.ts:429 (insert)
    // and :459 (update). The embed is unambiguous — conversation_insights has
    // exactly one FK to conversations — so it cannot hit PGRST201.
    supabase.from("conversations")
      .select("last_message_at, updated_at, type, intent_primary, last_ai_context_summary, conversation_insights(overall_sentiment)")
      .eq("contact_id", contactId).order("updated_at", { ascending: false }).limit(limit),
    supabase.from("activities")
      .select("created_at, completed_at, activity_type, title, description, channel, outcome")
      .eq("contact_id", contactId).order("created_at", { ascending: false }).limit(limit),
    supabase.from("ai_isa_activities")
      .select("created_at, activity_type, summary, outcome, channel")
      .eq("contact_id", contactId).order("created_at", { ascending: false }).limit(limit),
  ])

  const rows: InteractionRow[] = []
  for (const c of (convs.data ?? []) as any[]) {
    const at = c.last_message_at ?? c.updated_at
    if (!at) continue
    // PostgREST returns the embed as an array even for a one-row relation; an
    // unanalysed thread has none, and null is the honest reading for it.
    const insight = Array.isArray(c.conversation_insights) ? c.conversation_insights[0] : c.conversation_insights
    rows.push({
      at, source: "conversation", channel: c.type ?? null, sentiment: insight?.overall_sentiment ?? null,
      text: (c.last_ai_context_summary ?? c.intent_primary ?? c.type ?? null) || null,
    })
  }
  for (const a of (acts.data ?? []) as any[]) {
    const at = a.completed_at ?? a.created_at
    if (!at) continue
    rows.push({
      at, source: "activity", channel: a.channel ?? null, outcome: a.outcome ?? null,
      text: (a.title ?? a.description ?? a.activity_type ?? null) || null,
    })
  }
  for (const i of (isa.data ?? []) as any[]) {
    const at = i.created_at
    if (!at) continue
    rows.push({
      at, source: "ai_isa", channel: i.channel ?? null, outcome: i.outcome ?? null,
      text: (i.summary ?? i.activity_type ?? null) || null,
    })
  }
  return rows
}

/** Read the already-known canonical facts for the contact (NOT re-derived — surfaced as-is). */
async function loadContactFacts(supabase: Svc, contactId: string): Promise<ContactFacts> {
  const { data: c } = await supabase.from("contacts")
    .select("contact_type, buyer_stage, contact_persona, metadata, preferred_name, name_pronunciation, last_promise, timeline, preferred_channel, motivation_type, motivation_confidence, budget_max")
    .eq("id", contactId).maybeSingle()
  if (!c) return {}
  const md = ((c as any).metadata ?? {}) as Record<string, any>
  // Preferences may already be captured in metadata.preferences (string[]) — read, never invent.
  const prefs = Array.isArray(md.preferences)
    ? (md.preferences as any[]).map((p) => String(p)).filter(Boolean)
    : []
  // ADDRESSING MEMORY leads the shared note — "nothing important said twice"
  // starts with never getting their name wrong (columns from l48-s01).
  const preferredName = ((c as any).preferred_name as string | null)?.trim() || null
  const pronunciation = ((c as any).name_pronunciation as string | null)?.trim() || null
  if (preferredName || pronunciation) {
    prefs.unshift(
      [
        preferredName ? `prefers to be called "${preferredName}"` : null,
        pronunciation ? `name pronounced "${pronunciation}"` : null,
      ].filter(Boolean).join("; "),
    )
  }
  // Lane 97B: what the canonical columns state NOW, for the facts ledger. A stated
  // price expectation (metadata.price_expectation) outranks the buyer budget ceiling.
  const observed: NonNullable<ContactFacts["observed"]> = []
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "")
  if (str((c as any).timeline)) observed.push({ key: "timeline", value: str((c as any).timeline), confidence: 0.8, source: "contacts.timeline" })
  if (str((c as any).preferred_channel)) observed.push({ key: "channel_preference", value: str((c as any).preferred_channel), confidence: 0.8, source: "contacts.preferred_channel" })
  if (str((c as any).motivation_type)) {
    const mc = Number((c as any).motivation_confidence)
    observed.push({ key: "motivation", value: str((c as any).motivation_type), confidence: Number.isFinite(mc) && mc > 0 ? mc : 0.6, source: "contacts.motivation_type" })
  }
  if (str(md.price_expectation)) observed.push({ key: "price_expectation", value: str(md.price_expectation), confidence: 0.7, source: "contacts.metadata.price_expectation" })
  else if (str((c as any).budget_max)) observed.push({ key: "price_expectation", value: `up to ${str((c as any).budget_max)}`, confidence: 0.7, source: "contacts.budget_max" })
  return {
    observed,
    contactType: (c as any).contact_type ?? null,
    buyerStage: (c as any).buyer_stage ?? null,
    persona: (c as any).contact_persona ?? null,
    preferences: prefs,
    // The FIRST-CLASS promise (l50-s01) outranks the legacy metadata note —
    // "last promise made" is the commitment the whole team honors.
    openNextStep: ((c as any).last_promise as string | null)
      ?? (typeof md.open_next_step === "string" ? md.open_next_step : null),
  }
}

/**
 * LIVE: read the contact's real interactions, compose the spine, and PERSIST it into
 * contacts.metadata.context_spine. Idempotent — overwrites the single spine in place
 * (no row growth). Honest empty when there are no interactions. Never invents a fact.
 */
export async function updateContactContext(
  contactId: string,
  client?: Svc,
  opts: { now?: Date; rewriter?: SummaryRewriter; limit?: number } = {},
): Promise<ContextSpine> {
  const supabase = client ?? createServiceClient()
  const [interactions, facts] = await Promise.all([
    loadContactInteractions(supabase, contactId, { limit: opts.limit }),
    loadContactFacts(supabase, contactId),
  ])
  const spine = await composeContextSummary(interactions, facts, { now: opts.now, rewriter: opts.rewriter })

  // Merge into existing metadata in place — preserve sibling keys, overwrite the one spine.
  const { data: cur } = await supabase.from("contacts").select("metadata").eq("id", contactId).maybeSingle()
  const prior = (((cur as any)?.metadata ?? {}) as Record<string, any>).context_spine
  spine.facts = compileObservedFacts(prior, facts.observed ?? [], opts.now ?? new Date())
  const metadata = { ...(((cur as any)?.metadata ?? {}) as Record<string, any>), context_spine: spine }
  // The error is READ. This returns the freshly composed spine either way, so a
  // refusal handed the caller a summary that was never persisted — and every
  // later loadContactContext read the STALE one, or none at all.
  const { error: spineWriteError } = await supabase.from("contacts").update({ metadata }).eq("id", contactId)
  if (spineWriteError) {
    console.error(`[conversation-memory] context_spine write REFUSED for contact ${contactId}:`, spineWriteError.message)
  }
  return spine
}

/**
 * PURE. Carry the prior facts ledger forward and record what the columns state now.
 * Re-reading an UNCHANGED column is not a re-statement, so it does not refresh
 * observed_at / review_by — only a changed value (which supersedes) or an explicit
 * recordMemoryFact from a conversation does.
 */
/** @proofSeam exported so scripts/conversation-memory-simulator.ts asserts the fact rules (supersede, expiry, review) on the pure function directly. */
export function compileObservedFacts(
  priorSpine: unknown,
  observed: ReadonlyArray<{ key: MemoryFactKey; value: string; confidence: number; source: string }>,
  now: Date,
): MemoryFact[] {
  let ledger = readFactsLedger(priorSpine)
  for (const o of observed) {
    const current = ledger.find((f) => f.key === o.key && !f.supersededAt)
    if (current && normFactValue(current.value) === normFactValue(o.value)) continue
    ledger = recordMemoryFact(ledger, { ...o, observedAt: now.toISOString() })
  }
  return ledger
}

/**
 * PURE (wave 98, lane 98B). What a qualification answer states, as memory facts — in the SAME
 * value spelling the spine's column observer uses (loadContactFacts), so the two writers agree:
 * timeline = the bucket; channel_preference = the parsed preferred_channel; price_expectation =
 * "up to <max>" (or "from <min>"); motivation = the reason for moving in their words (the
 * recorder drops it when the typed motivation_type column is set — a column value would otherwise
 * supersede the words on every refresh and the two would flip-flop).
 */
/** @proofSeam exported so scripts/conversation-memory-simulator.ts asserts the qualification → fact mapping on the pure function directly. */
export function factsFromQualification(q: {
  timeline?: string | null
  preferredChannel?: string | null
  minPrice?: number | null
  maxPrice?: number | null
  reasonForMove?: string | null
}): Array<{ key: MemoryFactKey; value: string; confidence: number }> {
  const out: Array<{ key: MemoryFactKey; value: string; confidence: number }> = []
  if (q.timeline?.trim()) out.push({ key: "timeline", value: q.timeline.trim(), confidence: 0.85 })
  if (q.preferredChannel?.trim()) out.push({ key: "channel_preference", value: q.preferredChannel.trim(), confidence: 0.85 })
  if (typeof q.maxPrice === "number" && Number.isFinite(q.maxPrice) && q.maxPrice > 0) out.push({ key: "price_expectation", value: `up to ${q.maxPrice}`, confidence: 0.75 })
  else if (typeof q.minPrice === "number" && Number.isFinite(q.minPrice) && q.minPrice > 0) out.push({ key: "price_expectation", value: `from ${q.minPrice}`, confidence: 0.6 })
  if (q.reasonForMove?.trim()) out.push({ key: "motivation", value: q.reasonForMove.trim().slice(0, 160), confidence: 0.7 })
  return out
}

/**
 * LIVE (wave 98, lane 98B — the CONVERSATION-SIDE fact writer 97B left open). When a conversation
 * states a fact (the record_qualification tool every AI surface shares: portal chat, ISA email
 * reply, widget, D-ID, voice), it is recorded into the facts ledger IMMEDIATELY through
 * recordMemoryFact — not only on the ~6-hourly spine refresh — so a re-statement of the SAME value
 * refreshes observed_at / review_by now, and a changed value supersedes the old one now.
 * Writes ONLY context_spine.facts (sibling spine keys and metadata keys preserved) and, for a stated
 * price, metadata.price_expectation — the column the spine's own observer reads
 * (loadContactFacts), so the next refresh sees an UNCHANGED value and does not flip it back.
 * Tenant-pinned read + write; every refusal is read and returned. Never throws.
 */
export async function recordConversationFacts(
  contactId: string,
  brokerageId: string,
  facts: ReadonlyArray<{ key: MemoryFactKey; value: string; confidence: number }>,
  opts: { client?: Svc; now?: Date; source?: string } = {},
): Promise<{ recorded: number; error?: string }> {
  let usable = facts.filter((f) => typeof f.value === "string" && f.value.trim())
  if (!contactId || !brokerageId || usable.length === 0) return { recorded: 0 }
  try {
    const supabase = opts.client ?? createServiceClient()
    const now = opts.now ?? new Date()
    const { data: cur, error: readErr } = await supabase.from("contacts")
      .select("metadata, motivation_type").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
    if (readErr) return { recorded: 0, error: `contact read refused: ${readErr.message}` }
    if (!cur) return { recorded: 0, error: "contact not found in this brokerage" }
    // A typed motivation_type column wins on the spine refresh; recording free words beside it
    // would flip-flop the ledger every ~6h, so the column's value stands.
    if (typeof (cur as any).motivation_type === "string" && (cur as any).motivation_type.trim()) usable = usable.filter((f) => f.key !== "motivation")
    if (usable.length === 0) return { recorded: 0 }
    const md = (((cur as any).metadata ?? {}) as Record<string, any>)
    const prior = (md.context_spine && typeof md.context_spine === "object") ? md.context_spine as Record<string, unknown> : {}
    let ledger = readFactsLedger(prior)
    for (const f of usable) {
      ledger = recordMemoryFact(ledger, { key: f.key, value: f.value, confidence: f.confidence, observedAt: now.toISOString(), source: opts.source ?? "conversation" })
    }
    const priceFact = usable.find((f) => f.key === "price_expectation")
    const metadata = {
      ...md,
      ...(priceFact ? { price_expectation: priceFact.value.trim() } : {}),
      context_spine: { ...prior, facts: ledger },
    }
    const { data: upd, error: writeErr } = await supabase.from("contacts")
      .update({ metadata }).eq("id", contactId).eq("brokerage_id", brokerageId).select("id")
    if (writeErr) return { recorded: 0, error: `facts write refused: ${writeErr.message}` }
    if (!Array.isArray(upd) || upd.length !== 1) return { recorded: 0, error: "facts write matched no contact" }
    return { recorded: usable.length }
  } catch (e) {
    return { recorded: 0, error: (e as Error).message }
  }
}

/** LIVE: the stored running summary for any manager to read. Null when none has been composed yet. */
export async function loadContactContext(contactId: string, client?: Svc): Promise<ContextSpine | null> {
  const supabase = client ?? createServiceClient()
  const { data: c } = await supabase.from("contacts").select("metadata").eq("id", contactId).maybeSingle()
  const spine = (((c as any)?.metadata ?? {}) as Record<string, any>).context_spine
  if (!spine || typeof spine !== "object" || typeof spine.summary !== "string") return null
  return spine as ContextSpine
}

// ─── THE ONE READ EVERY CONVERSING AI SURFACE USES (lane 99B) ─────────────────
//
// Writes reached every surface; reads reached only the portal chat. This is the
// read side, on the SAME store (contacts.metadata.context_spine — no new memory
// store, OWNER LAW 1/2), consumed by: app/api/did/custom-llm/route.ts,
// app/actions/ai-isa/handle-inbound-email.ts, lib/voice/twilio-voice.ts (reception
// turn) + app/api/voice/twilio/turn/route.ts (outbound brief turn),
// lib/ai-reply-coach/reply-draft-core.ts (the ISA SMS reply), app/api/internal/
// ai-chat/route.ts (copilot open on a contact) and app/api/widget/message/route.ts.
//   · TENANT: the contact must belong to the brokerage the caller resolved from its
//     session/event (`.eq("brokerage_id", …)`) — a foreign contact reads as nothing.
//   · LEADS have no spine: a null contactId is a clean skip (null), never a leads read.
//   · FAIL CLOSED: a refused read injects NOTHING (logged), never a guessed memory.
//   · `spine` is passed as the playbook's `known.memory` (the "already on file — do
//     not re-ask" path); `block` is memoryContextBlock — current facts only, plus the
//     re-confirm cue for expired ones.

export interface ContactMemoryForPrompt {
  /** The raw spine — hand it to buildQualificationPrompt / knownFactsBlock as `known.memory`. */
  spine: unknown
  /** memoryContextBlock(spine) — summary + current facts + re-confirm cue. May be "". */
  block: string
}

/** LIVE: the tenant-scoped memory read for an AI surface. Null = inject nothing. */
export async function loadContactMemoryForPrompt(input: {
  contactId: string | null | undefined
  brokerageId: string | null | undefined
  client?: Svc
  now?: Date
}): Promise<ContactMemoryForPrompt | null> {
  if (!input.contactId || !input.brokerageId) return null
  try {
    const supabase = input.client ?? createServiceClient()
    const { data, error } = await supabase
      .from("contacts")
      .select("metadata")
      .eq("id", input.contactId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (error) {
      console.error(`[conversation-memory] memory read REFUSED for contact ${input.contactId}:`, error.message)
      return null
    }
    const spine = (((data as any)?.metadata ?? {}) as Record<string, any>).context_spine
    if (!spine || typeof spine !== "object") return null
    return { spine, block: memoryContextBlock(spine, input.now ?? new Date()).slice(0, 1600) }
  } catch (e) {
    console.error(`[conversation-memory] memory read failed for contact ${input.contactId}:`, (e as Error).message)
    return null
  }
}

/** PURE. The one prompt section a surface appends — "" when there is nothing to say. */
export function contactMemoryPromptSection(mem: ContactMemoryForPrompt | null | undefined): string {
  if (!mem || !mem.block.trim()) return ""
  return `WHAT WE ALREADY KNOW ABOUT THIS CONTACT (reference naturally; never read it back verbatim):\n${mem.block}`
}

// ─── REFRESH SWEEP (the write side the cron drives) ───────────────────────────
//
// The spine is only useful if it's kept current. This bounded sweep refreshes the
// context spine for contacts that had a RECENT interaction (a conversation touched
// within the lookback window), so the team always reads a fresh running note. The
// "update-on-write" intent without scattering update calls across every logging
// site: one idempotent sweep, gated by recency + a hard cap, every contact updated
// in place. Honest no-op when nothing was active.
export interface ContextSpineRefreshResult {
  contactsConsidered: number
  spinesRefreshed: number
  errors: string[]
}

export async function refreshRecentContactSpines(
  brokerageId: string,
  opts: { now?: Date; lookbackHours?: number; limit?: number; rewriter?: SummaryRewriter } = {},
  client?: Svc,
): Promise<ContextSpineRefreshResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const lookbackHours = opts.lookbackHours ?? 6
  const cap = opts.limit ?? 500
  const since = new Date(now.getTime() - lookbackHours * 3_600_000).toISOString()
  const result: ContextSpineRefreshResult = { contactsConsidered: 0, spinesRefreshed: 0, errors: [] }

  // Recently-active contacts: a conversation updated within the window. updated_at is
  // the touch column on conversations (last_message_at is nullable); fall back gracefully.
  const { data: rows, error } = await supabase
    .from("conversations")
    .select("contact_id")
    .eq("brokerage_id", brokerageId)
    .gte("updated_at", since)
    .not("contact_id", "is", null)
    .limit(cap * 4)
  if (error) { result.errors.push(`conversations: ${error.message}`); return result }

  const contactIds = Array.from(new Set(((rows ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id))).slice(0, cap)
  result.contactsConsidered = contactIds.length
  for (const id of contactIds) {
    try {
      await updateContactContext(id, supabase, { now: now, rewriter: opts.rewriter })
      result.spinesRefreshed += 1
    } catch (e: any) {
      result.errors.push(`${id}: ${e?.message ?? String(e)}`)
    }
  }
  return result
}

// ─── PREFERENCE MEMORY FROM THE PERSON'S OWN WORDS (wave 150, lane 150QTV — directive 150Q) ───────────────────────────────
//
// "language / communication-preference memory from the person's own words, accessible explanations, friction / barriers,
// scenario choices, fatigue, care-first response". SURVIVOR FIRST: this IS the one per-contact memory, so the reader lives here
// (folded in rather than a new module — the crm page graph is at its 1300-module budget). It only READS A SENTENCE THE PERSON
// WROTE and records the preferences they STATED on the facts ledger above, through recordConversationFacts. The arbiter reads
// them back (lib/ai-isa/followup-arbiter.ts ARBITER_MEMORY_KEYS → evidence.preferences; lib/communications/inbound-responder.ts
// merges them over the stored columns); every conversing surface reads them through memoryContextBlock. The accessibility FIELDS
// the person set in the portal stay where they are (lib/contacts/accessibility-preferences.ts — explicit, user-controlled).
//
// THE RULE OF THE WORDS. A preference is recorded ONLY from a first-person statement about how THEY want to be reached or spoken
// to ("please text me", "evenings are best", "en español por favor", "too many messages", "can you explain it simply", "we have
// to sell our house first"). Never inferred from a demographic, an age, a name, a language guess, the channel the message
// happened to arrive on, or contact_type (owner ruling R2). A sentence that only MENTIONS a channel records nothing. Each fact
// keeps its source (person_words:<channel>:<provider ref>). CARE FIRST: `contact_frequency` fewer / pause and a stated `barrier`
// tell the arbiter to slow down or explain (ARBITER_SYSTEM) — never push harder. A full STOP is not handled here:
// lib/ai-isa/opt-out-utils.ts detectOptOutIntent runs first in the inbound chain and suppression is the answer.

export interface StatedPreference {
  key: Extract<MemoryFactKey, "channel_preference" | "preferred_contact_time" | "language" | "communication_format" | "contact_frequency" | "barrier" | "explanation_style" | "scenario_choice">
  /** One spelling per key (the arbiter channel names; the accessibility format words; the language CODE of LANGUAGE_NAMES). */
  value: string
  /** A first-person statement is the person's own word: 0.9. */
  confidence: number
  /** The words that carried it, trimmed — evidence, never shown to an ad platform. */
  quote: string
}

/** First person + a wish or a preference — the gate every rule below sits behind (a sentence about US is not about them). */
const FIRST_PERSON = /\b(i|i'd|i'm|i’d|i’m|we|we'd|we're|we’d|we’re|me|us|my|our|please|pls|prefer|rather|best|better|easier|por favor|prefiero|preferimos|quiero|queremos|tenemos|mi|nos)\b/i

/** PURE. The word (one sentence) that matched, trimmed for evidence. */
function quoteOf(text: string, idx: number): string {
  const start = Math.max(0, text.lastIndexOf(".", idx) + 1)
  const endDot = text.indexOf(".", idx)
  return text.slice(start, endDot === -1 ? undefined : endDot + 1).trim().slice(0, 160)
}

const CHANNEL_RULES: ReadonlyArray<{ value: string; re: RegExp }> = [
  { value: "sms", re: /\b(?:please\s+)?(?:text|txt|sms)\s+(?:me|us)\b|\b(?:texting|texts?)\s+(?:is|are|works?)\s+(?:best|better|easier)\b|\bprefer\s+(?:a\s+)?(?:text|texts|texting)\b/i },
  { value: "email", re: /\b(?:please\s+)?e-?mail\s+(?:me|us)\b|\be-?mail\s+(?:is|works?)\s+(?:best|better|easier)\b|\bprefer\s+(?:an?\s+)?e-?mails?\b|\brather\s+you\s+e-?mailed\b/i },
  { value: "phone", re: /\b(?:please\s+)?(?:call|phone|ring)\s+(?:me|us)\b|\b(?:a\s+)?(?:call|phone\s+call)\s+(?:is|works?)\s+(?:best|better|easier)\b|\bprefer\s+(?:a\s+)?(?:call|phone)\b/i },
  { value: "in_app", re: /\b(?:message|reach)\s+(?:me|us)\s+(?:in|through|on)\s+the\s+(?:portal|app)\b|\bprefer\s+the\s+(?:portal|app)\b/i },
  { value: "direct_mail", re: /\b(?:mail|post)\s+(?:it|them|me)\s+(?:to\s+me|to\s+my\s+(?:house|home|address))\b|\bprefer\s+(?:paper|a\s+letter|mail)\b/i },
]

const TIME_RULES: ReadonlyArray<{ value: string; re: RegExp }> = [
  { value: "mornings", re: /\b(?:mornings?|before\s+(?:noon|work))\s+(?:is|are|work)\s+(?:best|better)\b|\b(?:call|text|reach)\s+(?:me|us)\s+(?:in\s+the\s+)?mornings?\b/i },
  { value: "afternoons", re: /\bafternoons?\s+(?:is|are|work)\s+(?:best|better)\b|\b(?:call|text|reach)\s+(?:me|us)\s+(?:in\s+the\s+)?afternoons?\b/i },
  { value: "evenings", re: /\b(?:evenings?|after\s+work|after\s+[5-9]\s*(?:pm|p\.m\.)?)\s+(?:is|are|works?)\s+(?:best|better)\b|\b(?:call|text|reach)\s+(?:me|us)\s+(?:in\s+the\s+evenings?|after\s+(?:work|[5-9]\s*(?:pm|p\.m\.)?))\b/i },
  { value: "weekends", re: /\bweekends?\s+(?:is|are|work)\s+(?:best|better)\b|\b(?:call|text|reach)\s+(?:me|us)\s+on\s+(?:the\s+)?weekends?\b/i },
]

const FORMAT_RULES: ReadonlyArray<{ value: string; re: RegExp }> = [
  { value: "video", re: /\b(?:send|prefer|rather\s+have)\s+(?:me\s+)?(?:a\s+)?videos?\b|\bvideos?\s+(?:is|are|work)\s+(?:best|better|easier)\b/i },
  { value: "audio", re: /\b(?:send|prefer|rather\s+have)\s+(?:me\s+)?(?:a\s+)?(?:voice\s*(?:note|message)|audio|recording)s?\b/i },
  { value: "text", re: /\b(?:in\s+writing|written\s+down)\s+(?:is|works?)\s+(?:best|better|easier)\b|\bprefer\s+(?:it\s+)?(?:in\s+writing|written)\b/i },
]

const FREQUENCY_RULES: ReadonlyArray<{ value: string; re: RegExp }> = [
  { value: "pause", re: /\b(?:give\s+(?:me|us)\s+(?:a\s+)?(?:few\s+)?(?:weeks?|months?|break|some\s+time)|check\s+back\s+(?:in|after)|not\s+right\s+now,?\s+(?:maybe\s+)?later)\b/i },
  { value: "fewer", re: /\b(?:too\s+many\s+(?:messages|texts|emails|calls)|(?:less|fewer)\s+(?:often|messages|texts|emails|calls)|(?:please\s+)?(?:slow\s+down|stop\s+(?:texting|emailing|calling)\s+so\s+much))\b/i },
]

const BARRIER_RULES: ReadonlyArray<{ value: string; re: RegExp }> = [
  { value: "must_sell_first", re: /\b(?:have|need)\s+to\s+sell\s+(?:our|my)\s+(?:house|home|place)\s+first\b/i },
  { value: "financing", re: /\b(?:waiting\s+on|need\s+to\s+get|don't\s+have|do\s+not\s+have)\s+(?:a\s+)?(?:pre-?approval|financing|a\s+loan|mortgage)\b|\b(?:can't|cannot)\s+get\s+(?:a\s+)?(?:loan|mortgage)\b/i },
  { value: "lease", re: /\b(?:my|our)\s+lease\s+(?:runs|ends|is\s+up)\b|\bstuck\s+in\s+(?:a|my|our)\s+lease\b/i },
  { value: "cost", re: /\b(?:can't|cannot)\s+afford\b|\b(?:too|very)\s+expensive\s+(?:for\s+(?:me|us))\b|\bprices?\s+(?:are|is)\s+too\s+high\s+for\s+(?:me|us)\b/i },
  { value: "timing", re: /\b(?:not\s+(?:ready|in\s+a\s+rush)\s+yet|(?:i|we)'?m?\s+not\s+ready)\b/i },
]

const EXPLANATION_RULES: ReadonlyArray<{ value: string; re: RegExp }> = [
  { value: "plain_language", re: /\b(?:i\s+don'?t\s+understand|confus(?:ed|ing)|(?:explain|say)\s+(?:it|that)\s+(?:simply|in\s+plain\s+(?:english|words)|more\s+simply)|what\s+does\s+that\s+mean|too\s+much\s+jargon)\b/i },
  { value: "step_by_step", re: /\b(?:step\s+by\s+step|one\s+step\s+at\s+a\s+time|walk\s+(?:me|us)\s+through)\b/i },
  { value: "detailed", re: /\b(?:send|give)\s+(?:me|us)\s+(?:all\s+)?the\s+details\b|\bi\s+(?:like|want)\s+(?:the\s+)?(?:numbers|details)\b/i },
]

const SCENARIO_RULES: ReadonlyArray<{ value: string; re: RegExp }> = [
  { value: "sell_first", re: /\b(?:we|i)(?:'d|\s+would|\s+want\s+to|\s+will|'ll)?\s+(?:rather\s+)?sell\s+(?:first|before\s+(?:we|i)\s+buy)\b/i },
  { value: "buy_first", re: /\b(?:we|i)(?:'d|\s+would|\s+want\s+to|\s+will|'ll)?\s+(?:rather\s+)?buy\s+(?:first|before\s+(?:we|i)\s+sell)\b/i },
  { value: "rent_first", re: /\b(?:we|i)(?:'d|\s+would|\s+will|'ll|\s+plan\s+to)?\s+rent\s+(?:first|for\s+a\s+while)\b/i },
  { value: "stay_put", re: /\b(?:we|i)(?:'re|\s+are|'m|\s+am)?\s+(?:staying\s+put|not\s+moving|going\s+to\s+stay)\b/i },
]

/** PURE. The language CODE (LANGUAGE_NAMES — the ONE vocabulary) the person asked to be spoken to in, or null. */
function statedLanguage(text: string): { code: string; idx: number } | null {
  if (/\ben\s+español\b|\bhabla(?:s)?\s+español\b|\bpor\s+favor\s+en\s+español\b/i.test(text)) return { code: "es", idx: text.search(/español/i) }
  for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
    if (code === "en") continue
    const re = new RegExp(`\\b(?:(?:speak|write|talk)\\s+(?:to\\s+(?:me|us)\\s+)?in|prefer|in)\\s+${name}\\b|\\b${name}\\s+(?:is|would\\s+be)\\s+(?:better|easier|best)\\b|\\bmy\\s+(?:first|native)\\s+language\\s+is\\s+${name}\\b`, "i")
    const m = re.exec(text)
    if (m) return { code, idx: m.index }
  }
  return null
}

/**
 * PURE. Every preference a person STATED in one message. Empty when none — and empty for a sentence without a first-person
 * wish, a public post, or an empty body. One value per key (the first rule that matched in the list order above).
 */
/** @proofSeam read by scripts/two-way-channels-guard.ts (150Q — first-person statements only; positive and negative cases). */
export function preferencesFromOwnWords(body: string): StatedPreference[] {
  const text = String(body ?? "").replace(/\s+/g, " ").trim().slice(0, 2000)
  if (text.length < 3 || !FIRST_PERSON.test(text)) return []
  const out: StatedPreference[] = []
  const take = (key: StatedPreference["key"], rules: ReadonlyArray<{ value: string; re: RegExp }>) => {
    for (const r of rules) {
      const m = r.re.exec(text)
      if (m) { out.push({ key, value: r.value, confidence: 0.9, quote: quoteOf(text, m.index) }); return }
    }
  }
  take("channel_preference", CHANNEL_RULES)
  take("preferred_contact_time", TIME_RULES)
  const lang = statedLanguage(text)
  if (lang) out.push({ key: "language", value: lang.code, confidence: 0.9, quote: quoteOf(text, Math.max(0, lang.idx)) })
  take("communication_format", FORMAT_RULES)
  take("contact_frequency", FREQUENCY_RULES)
  take("barrier", BARRIER_RULES)
  take("explanation_style", EXPLANATION_RULES)
  take("scenario_choice", SCENARIO_RULES)
  return out
}

export type PreferenceWriter = (
  contactId: string, brokerageId: string,
  facts: ReadonlyArray<{ key: MemoryFactKey; value: string; confidence: number }>,
  opts: { client?: unknown; now?: Date; source?: string },
) => Promise<{ recorded: number; error?: string }>

/**
 * Record what the person said about how they want to be reached, on the ONE memory ledger. Tenant-pinned (the survivor writer
 * reads and writes `.eq("brokerage_id", …)` and counts the updated row). Never throws; a refusal comes back as `error`.
 */
export async function rememberStatedPreferences(
  svc: unknown,
  input: { brokerageId: string; contactId: string; body: string; channel: string; providerRef?: string | null; now?: Date },
  writer?: PreferenceWriter,
): Promise<{ stated: StatedPreference[]; recorded: number; error?: string }> {
  const stated = preferencesFromOwnWords(input.body)
  if (stated.length === 0 || !input.brokerageId || !input.contactId) return { stated, recorded: 0 }
  try {
    const write: PreferenceWriter = writer ?? ((c, b, f, o) => recordConversationFacts(c, b, f, o as never))
    const r = await write(input.contactId, input.brokerageId, stated.map(({ key, value, confidence }) => ({ key, value, confidence })), {
      client: svc, now: input.now, source: `person_words:${input.channel}${input.providerRef ? `:${input.providerRef}` : ""}`,
    })
    return { stated, recorded: r.recorded, ...(r.error ? { error: r.error } : {}) }
  } catch (e) {
    return { stated, recorded: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
