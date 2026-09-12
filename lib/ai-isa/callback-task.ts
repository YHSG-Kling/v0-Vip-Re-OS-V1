// lib/ai-isa/callback-task.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CALLBACK TASK — owner ruling (wave 55), verbatim: "the ai assistant or
// receptionist needs to be able to make a task to call a person back and then
// do the call back when it is time." This is the WRITER half: one function
// that turns "call me back at 3pm" into a real `tasks` row, called from every
// surface that can hear that request — the reception <Gather> turn route, the
// ConversationRelay plan route (same brain, two transports), and the post-call
// outcome backstop (lib/ai-isa/post-call-outcome.ts) for a callback ask the
// live turn model missed. lib/voice/twilio-voice.ts:createCallbackTaskFromCall
// is the call-context wrapper every voice route actually imports; this module
// holds the transport-agnostic pieces so post-call-outcome (which has a
// voice_calls row, not an InboundCallContext) can call the same writer.
//
// SCHEMA AUDIT (before writing a single line): scripts/schema-snapshot.ts's
// `tasks` row carries no phone/notes-structured column and scripts/
// check-vocabularies.ts carries NO entry for `tasks` at all — machine-generated
// from every live single-column CHECK constraint (436 tables measured), so its
// absence means the live `tasks` table has NO CHECK constraint on `source`,
// `assignee_type` or `status` today. Two consequences: (1) no migration is
// needed to add the `ai_callback` source or the `ai_isa` assignee_type value —
// there is no vocabulary to widen; (2) there is nowhere to put a callback
// phone number as a real column without one. Rather than a migration for a
// single nullable text column (the orphan doctrine's "build the missing half"
// read literally would mean widening the live table), this reuses the EXACT
// idiom lib/voice/twilio-outbound.ts already uses for the same problem
// (voice_calls.ai_notes carries the outbound call brief as compact JSON) —
// tasks.description carries the callback's structured note as a `[CALLBACK]`
// prefix + JSON blob, decoded by the executor cron via decodeCallbackNote
// below. One idiom, not a second one (CLAUDE.md §6).

import { resolveSpokenDate } from "@/lib/voice/spoken-values"

export interface CallbackNote {
  /** E.164-ish as given; the executor re-validates before dialing. */
  phone: string
  reason: string | null
  /** The caller's own words for when — kept for the task's human-readable audit trail. */
  rawPhrase: string
  /** The voice_calls row this callback was requested on, when there is one. */
  voiceCallId: string | null
  /** How many times the executor cron has already tried to place this call.
   *  The claim/attempt stamp the executor needs to be idempotent AND bounded —
   *  without it a transiently-failing dial (no active tenant number, Twilio
   *  5xx) would retry every tick forever with no record that anything had
   *  been tried at all. Absent/undefined reads as 0 (a freshly written task). */
  attempts?: number
}

const CALLBACK_NOTE_TAG = "[CALLBACK]"

/** PURE: encode the structured note into `tasks.description`. Human-readable
 *  prefix + a JSON blob the executor parses — never fabricates the note as an
 *  agent could read while glancing at the tasks board. */
export function encodeCallbackNote(note: CallbackNote): string {
  const human = `Call back ${note.phone}${note.reason ? ` — ${note.reason}` : ""}. Requested: "${note.rawPhrase}".`
  const blob = JSON.stringify({
    phone: note.phone.slice(0, 30),
    reason: note.reason?.slice(0, 200) ?? null,
    rawPhrase: note.rawPhrase.slice(0, 120),
    voiceCallId: note.voiceCallId,
    attempts: note.attempts ?? 0,
  })
  return `${CALLBACK_NOTE_TAG} ${human}\n${blob}`.slice(0, 2000)
}

/** PURE: decode a `tasks.description` written by encodeCallbackNote. A
 *  description that does not carry the tag or whose JSON tail does not parse
 *  returns null — never a crash on a task some other writer created (this
 *  function is used to FIND callback tasks among all of `tasks`, not just to
 *  read ones this module wrote). */
export function decodeCallbackNote(description: string | null | undefined): CallbackNote | null {
  if (!description || !description.startsWith(CALLBACK_NOTE_TAG)) return null
  const nl = description.indexOf("\n")
  if (nl < 0) return null
  try {
    const p = JSON.parse(description.slice(nl + 1)) as Partial<CallbackNote>
    if (typeof p.phone !== "string" || !p.phone) return null
    return {
      phone: p.phone,
      reason: typeof p.reason === "string" ? p.reason : null,
      rawPhrase: typeof p.rawPhrase === "string" ? p.rawPhrase : "",
      voiceCallId: typeof p.voiceCallId === "string" ? p.voiceCallId : null,
      attempts: typeof p.attempts === "number" && p.attempts >= 0 ? p.attempts : 0,
    }
  } catch {
    return null
  }
}

/** PURE: the note with its attempt count incremented by one — the executor's
 *  claim stamp on a retry. Re-encodes through encodeCallbackNote so the two
 *  never drift (§6 — one vocabulary for the blob shape). */
export function bumpCallbackAttempt(note: CallbackNote): CallbackNote {
  return { ...note, attempts: (note.attempts ?? 0) + 1 }
}

/** The executor gives up after this many failed dial attempts — a callback
 *  that cannot be placed after this many tries needs a human, not an infinite
 *  cron loop quietly re-trying a number that will never answer or a gate that
 *  will never clear on its own. */
export const MAX_CALLBACK_ATTEMPTS = 3

// ── Deterministic time parsing (the pure, free, positive-controllable layer) ─

/** Minutes since local midnight for a spoken "3pm" / "3:30 pm" / "15:00" style
 *  time. Returns null on anything that doesn't parse as a clock time. PURE. */
function parseClockToMinutes(text: string): number | null {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3]?.toLowerCase()
  if (hour > 23 || minute > 59) return null
  if (meridiem === "pm" && hour < 12) hour += 12
  if (meridiem === "am" && hour === 12) hour = 0
  if (!meridiem && hour <= 7) hour += 12 // "call me at 3" during a business call means 3pm, not 3am
  if (hour > 23) return null
  return hour * 60 + minute
}

/**
 * PURE, deterministic, free: resolves the common phrasing without paying for
 * a model call. Returns an ISO string in UTC computed from `nowMs`, or null
 * when the phrase needs real language understanding (resolveCallbackDueDate
 * below falls back to the AI gateway for those). Never throws.
 *
 * Deliberately conservative: a phrase this cannot confidently place is left
 * for the gateway rather than guessed at — a wrong regex match would silently
 * mis-time a callback, which is worse than the extra AI call.
 */
export function regexParseCallbackPhrase(phrase: string, nowMs: number): string | null {
  const text = phrase.trim().toLowerCase()
  if (!text) return null
  const now = new Date(nowMs)

  // "right away" / "asap" / "now" / "immediately" → 5 minutes out (never truly
  // instant — the executor cron polls on its own cadence).
  if (/\b(right away|asap|immediately|now)\b/.test(text)) {
    return new Date(nowMs + 5 * 60_000).toISOString()
  }

  // "in N minutes/hours"
  const inMatch = text.match(/\bin\s+(\d+)\s*(minute|min|hour|hr)s?\b/)
  if (inMatch) {
    const n = Number(inMatch[1])
    const unitMs = inMatch[2].startsWith("h") ? 60 * 60_000 : 60_000
    return new Date(nowMs + n * unitMs).toISOString()
  }

  // vague part-of-day → a fixed, sane clock time (never "sometime"). Computed
  // BEFORE day offset below so a named weekday is only trusted when the
  // phrase also carries a real time signal — see the weekday branch's
  // comment for why that gate matters.
  let minutesOfDay: number | null = null
  if (/\bmorning\b/.test(text)) minutesOfDay = 9 * 60
  else if (/\bafternoon\b/.test(text)) minutesOfDay = 14 * 60
  else if (/\b(evening|tonight)\b/.test(text)) minutesOfDay = 18 * 60

  // an explicit clock time overrides the vague part-of-day guess
  const clock = parseClockToMinutes(text)
  if (clock !== null) minutesOfDay = clock

  // day offset: today / tonight (0), tomorrow (1), a named weekday (n), else
  // undetermined
  let dayOffset: number | null = null
  if (/\btomorrow\b/.test(text)) dayOffset = 1
  else if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(text)) dayOffset = 0
  else if (minutesOfDay !== null) {
    // BUG FIX (wave 56 capability check, scripts/ai-callback-loop-simulator.ts
    // §1b): a bare weekday name ("Friday morning") was previously matched by
    // NEITHER the tomorrow/today branch NOR anything else — "Friday" was
    // silently dropped, dayOffset stayed null, and the function fell through
    // to the "no day named" default (today, rolling to tomorrow if the vague
    // time had already passed), landing on the WRONG day with no error and no
    // degrade. Gated on minutesOfDay !== null (a real time signal already
    // present) so a bare day name with NO time ("sometime after my shift
    // ends Thursday") still returns null below and defers to the gateway
    // rather than guessing a default 9am for a day whose time was never
    // given — same conservative rule this function uses everywhere else.
    // Reuses the ONE canonical weekday resolver (lib/voice/spoken-values.ts
    // resolveSpokenDate — already used by parse-team-command.ts and the voice
    // backends) instead of writing a second day-of-week regex (§6).
    const todayISO = new Date(nowMs).toISOString().slice(0, 10)
    const spokenDate = resolveSpokenDate(text, todayISO)
    if (spokenDate) {
      const todayMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      const spokenMidnightMs = new Date(`${spokenDate}T00:00:00Z`).getTime()
      dayOffset = Math.round((spokenMidnightMs - todayMidnightMs) / 86_400_000)
    }
  }

  if (dayOffset === null && minutesOfDay === null) return null // needs real NLU
  const targetDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (dayOffset ?? 0)))
  const mins = minutesOfDay ?? 9 * 60 // "tomorrow" alone → 9am, a reasonable default
  targetDay.setUTCHours(0, 0, 0, 0)
  const target = new Date(targetDay.getTime() + mins * 60_000)
  // "3pm" with no day named and 3pm already passed today → tomorrow, not
  // an hour that already happened.
  if (dayOffset === null && target.getTime() <= nowMs) target.setUTCDate(target.getUTCDate() + 1)
  return target.toISOString()
}

export interface ResolvedCallbackTime {
  ok: boolean
  dueIso: string
  method: "regex" | "gateway" | "fallback"
  error?: string
}

/** How far in the future a resolved callback may reasonably sit before it is
 *  treated as a parse failure rather than a real request — protects against a
 *  hallucinated gateway date landing a callback task years out that then never
 *  fires within any human's expectation. */
const MAX_CALLBACK_HORIZON_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
/** A callback resolved to more than this far in the PAST is a parse miss, not
 *  a real "call me back yesterday" — floors it forward instead of dropping it. */
const PAST_GRACE_MS = 5 * 60_000

/**
 * Resolve a caller's own words for a callback time into a real due timestamp.
 * Tries the deterministic layer FIRST (free, instant, exhaustively testable);
 * only pays for an AI gateway call when the phrase needs real language
 * understanding ("Thursday after my shift", "sometime next week"). Uses
 * lib/ai/gateway-chat directly (never lib/ai/models.ts's generateTextRouted)
 * because this is pure extraction — the Them-First / compliance post-
 * processing layer generateTextRouted applies must NOT run on a date string.
 *
 * Never throws, and never returns an unusable date: a gateway failure or an
 * out-of-bounds result falls back to "2 hours from now" so a callback the
 * caller asked for is NEVER silently dropped for want of a parseable time —
 * the honest degraded case still gets a task, just not at their exact word.
 */
export async function resolveCallbackDueDate(phrase: string, nowIso: string): Promise<ResolvedCallbackTime> {
  const nowMs = new Date(nowIso).getTime()
  const viaRegex = regexParseCallbackPhrase(phrase, nowMs)
  if (viaRegex) return { ok: true, dueIso: viaRegex, method: "regex" }

  try {
    const { gatewayChatJSON } = await import("@/lib/ai/gateway-chat")
    const model = process.env.AI_GATEWAY_EXTRACTION_MODEL || "openai/gpt-4o-mini"
    const r = await gatewayChatJSON<{ iso: string | null }>({
      model,
      messages: [
        {
          role: "system",
          content:
            "Extract the ONE future timestamp a caller means, in ISO 8601 UTC. " +
            `The current moment is ${nowIso}. Respond with JSON ONLY: {"iso": "<ISO 8601 UTC timestamp>"}. ` +
            'If the phrase names no usable time, respond {"iso": null}. Never explain, never add prose.',
        },
        { role: "user", content: phrase.slice(0, 200) },
      ],
      temperature: 0,
      maxTokens: 60,
    })
    const iso = r.ok ? r.data?.iso ?? null : null
    if (iso) {
      const t = new Date(iso).getTime()
      if (!Number.isNaN(t) && t > nowMs - PAST_GRACE_MS && t < nowMs + MAX_CALLBACK_HORIZON_MS) {
        return { ok: true, dueIso: new Date(t).toISOString(), method: "gateway" }
      }
    }
  } catch (e: any) {
    // fall through to the honest default below — a callback request must
    // never be dropped for want of a parseable time.
    return {
      ok: false,
      dueIso: new Date(nowMs + 2 * 60 * 60_000).toISOString(),
      method: "fallback",
      error: e?.message ?? "gateway extraction failed",
    }
  }
  return {
    ok: false,
    dueIso: new Date(nowMs + 2 * 60 * 60_000).toISOString(),
    method: "fallback",
    error: "no usable timestamp resolved",
  }
}

// ── The writer ────────────────────────────────────────────────────────────

export interface CreateCallbackTaskParams {
  brokerageId: string
  contactId: string | null
  leadId?: string | null
  phone: string
  whenPhrase: string
  reason: string | null
  voiceCallId: string | null
  /** 'ai_isa' (default): the ISA itself places the callback autonomously via
   *  the executor cron. 'agent': the caller explicitly asked for a human — the
   *  existing task-due notification + click-to-call surface handle it, no
   *  autonomous dial. */
  assigneeType?: "ai_isa" | "agent"
  assignedToAgentId?: string | null
}

export interface CreateCallbackTaskResult {
  ok: boolean
  taskId?: string
  dueIso?: string
  error?: string
}

/**
 * THE WRITER every surface calls: reception <Gather> turn, ConversationRelay
 * plan, and the post-call-outcome backstop. One tasks row, `source:
 * 'ai_callback'` (free text — see the schema-audit note above; no CHECK to
 * satisfy), due_date resolved from the caller's own words, assignee_type
 * decides who executes it. `auto_generated: true` — nobody typed this task by
 * hand. Never throws; a refused insert is reported, never swallowed (CLAUDE.md
 * §3 — supabase-js resolves refusals, so the error is always read here).
 */
export async function createCallbackTask(svc: any, params: CreateCallbackTaskParams): Promise<CreateCallbackTaskResult> {
  const phone = params.phone.trim()
  if (!phone) return { ok: false, error: "no callback phone number available" }

  const resolved = await resolveCallbackDueDate(params.whenPhrase, new Date().toISOString())
  const assigneeType = params.assigneeType ?? "ai_isa"

  const description = encodeCallbackNote({
    phone,
    reason: params.reason,
    rawPhrase: params.whenPhrase,
    voiceCallId: params.voiceCallId,
  })

  const { data, error } = await svc
    .from("tasks")
    .insert({
      brokerage_id: params.brokerageId,
      contact_id: params.contactId,
      assigned_to_agent_id: params.assignedToAgentId ?? null,
      title: `Call back${params.reason ? ` — ${params.reason}` : ""}`.slice(0, 200),
      description,
      due_date: resolved.dueIso,
      status: "pending",
      priority: "high",
      assignee_type: assigneeType,
      source: "ai_callback",
      auto_generated: true,
    })
    .select("id")
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data?.id) return { ok: false, error: "callback task insert returned no row" }
  return { ok: true, taskId: data.id, dueIso: resolved.dueIso }
}

// ── The post-call transcript backstop (used by lib/ai-isa/post-call-outcome.ts) ─

const CALLBACK_ASK = /\b(call (me|him|her|them) back|callback|give (me|him|her|them) a call back|return (my|the) call)\b/i

/**
 * PURE: does a caller turn ask for a callback? Used ONLY as a backstop after
 * the call has already ended, to catch a callback ask the live turn model
 * missed (chose 'continue' instead of the 'callback' action mid-call) — never
 * the primary path, which is the live turn action wired in the voice routes.
 * Deliberately narrow (word-boundaried, no greedy `.*`) — the same caution
 * post-call-outcome.ts already applies to its opt-out detector, because a
 * false positive here would file a phantom callback task, not just miss one.
 */
export function detectCallbackRequest(turns: string[]): { requested: boolean; phrase: string | null } {
  for (const t of turns) {
    if (CALLBACK_ASK.test(t)) return { requested: true, phrase: t.slice(0, 120) }
  }
  return { requested: false, phrase: null }
}
