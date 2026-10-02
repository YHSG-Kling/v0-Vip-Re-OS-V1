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

export type MemoryFactKey = "timeline" | "price_expectation" | "channel_preference" | "motivation"

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
})
/** History kept per key (current + superseded) — bounded so the jsonb cannot grow forever. */
export const MEMORY_FACT_HISTORY_CAP = 5
const MEMORY_FACT_KEYS: readonly MemoryFactKey[] = ["timeline", "price_expectation", "channel_preference", "motivation"]

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

/** LIVE: the stored running summary for any manager to read. Null when none has been composed yet. */
export async function loadContactContext(contactId: string, client?: Svc): Promise<ContextSpine | null> {
  const supabase = client ?? createServiceClient()
  const { data: c } = await supabase.from("contacts").select("metadata").eq("id", contactId).maybeSingle()
  const spine = (((c as any)?.metadata ?? {}) as Record<string, any>).context_spine
  if (!spine || typeof spine !== "object" || typeof spine.summary !== "string") return null
  return spine as ContextSpine
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
