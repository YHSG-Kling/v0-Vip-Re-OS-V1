// lib/ai-isa/meeting-followthrough.ts
// ─────────────────────────────────────────────────────────────────────────────
// MEETING-TO-ACTION LOOP (owner round 40, rec 2). Round 39 landed Zoom
// transcripts in the SAME conversation-intel ledger voice calls use
// (voice_calls → extractVoiceIntel → call_analyses, provenance
// 'zoom_transcript'). This module is the CONSUMER that makes the ISA ACT on
// those insights — ONE consumer, TWO sources:
//   • the Zoom transcript lane calls it the moment a meeting analysis completes
//     (lib/connections/zoom-transcripts.ts post-analysis hook), and
//   • the hourly voice-intel sweep calls it for every phone-call analysis it
//     writes (lib/voice/call-analysis.ts) — so a phone call and a video meeting
//     produce the same follow-through, never a per-channel fork.
//
// EXTRACTED INTENT → PROPOSED ACTION, always through the governed rails:
//   'needs to sell first'   → the listing-side conversation: ONE drafted,
//                             approval-gated seller outreach (proposeClientMessage
//                             — the gate; a human approves before anything sends)
//   'asked about financing' → the pre-qual education proposal (gated buyer message)
//   'mentioned a timeline'  → a follow-up scheduled at the STATED horizon
//                             (contacts.next_followup_at via the canonical
//                             schedule-followup — the reactivation cadences honor it)
//   'objection detected'    → a coaching note to the AGENT (audience 'agent' on
//                             the same gate rail — the HOT_CALL idiom)
//
// GROUNDING + SAFETY INVARIANTS:
//   • Every consumer-facing proposal carries the VERBATIM transcript line that
//     triggered it (no transcript evidence → no proposal, even when the LLM
//     summary hints at the intent).
//   • Deduped PER MEETING per action kind via a rationale tag
//     ([MEETING_FOLLOWTHROUGH] [<voice_call_id>] [<kind>]) — a webhook
//     redelivery or a sweep re-run can never double-propose.
//   • NEVER a direct send: this module must not touch any provider dispatch
//     helper (the email/SMS/mail senders in lib/providers — the simulator greps
//     this file for their names). Consumer-facing text only ever enters
//     agent_client_messages status='proposed' (human-approval-gated); the
//     timeline action only writes an internal follow-up date.
//
// Derivation is PURE (deriveMeetingIntents + parseStatedHorizon) so the
// simulator drives it without I/O; the runner takes a caller-supplied client.

// ─── Pure types ──────────────────────────────────────────────────────────────

export type FollowthroughKind =
  | "sell_first"        // buyer who must sell their current home first → listing-side conversation
  | "financing_prequal" // asked about financing/pre-approval → pre-qual education
  | "timeline_followup" // stated a horizon → follow-up scheduled at that horizon
  | "objection_coaching"// objection heard → coaching note to the agent

export interface MeetingAnalysisInput {
  summary: string | null
  intentPrimary: string | null
  objections: string[]
  keyTopics: string[]
}

export interface MeetingIntent {
  kind: FollowthroughKind
  /** The VERBATIM transcript line (or extractor objection phrase) that grounds it. */
  evidence: string
  /** timeline_followup only — the stated horizon resolved to days from now. */
  horizonDays?: number
  /** timeline_followup only — the phrase that stated it ("in three months"). */
  horizonPhrase?: string
}

/** The rationale marker every proposal from this consumer carries (dedupe key prefix). */
export const MEETING_FOLLOWTHROUGH_TAG = "[MEETING_FOLLOWTHROUGH]"

/** Pure: the per-(meeting, action-kind) dedupe tag — lives at the START of the
 *  proposal rationale so an ilike prefix check finds it (the HOT_CALL idiom). */
export function followthroughTag(voiceCallId: string, kind: FollowthroughKind): string {
  return `${MEETING_FOLLOWTHROUGH_TAG} [${voiceCallId}] [${kind}]`
}

// ─── Pure: intent detection over the REAL transcript ─────────────────────────

/** Buyer-side "I need to sell my current place first" — the listing-side opening. */
export const SELL_FIRST_RE =
  /\b(?:need|needs|have|has|got|want|wants|plan|plans|planning|hoping|hope)\s+to\s+sell\b|\bsell\s+(?:my|our|the)\s+(?:house|home|condo|townhouse|place|property|current)\b|\bsell\s+(?:first|before)\b|\b(?:once|after|until)\s+(?:we|i)\s+sell\b|\blist\s+(?:my|our)\s+(?:house|home|place|property)\b/i

/** Financing / pre-approval curiosity — the pre-qual education opening. */
export const FINANCING_RE =
  /\bpre-?approv\w*|\bpre-?qual\w*|\bmortgage\b|\blender\b|\bfinanc\w*|\bdown\s?payment\b|\binterest\s+rates?\b|\bloan\b|\b(?:can|could|what\s+(?:can|could))\s+(?:we|i)\s+afford\b/i

/** Find the ONE verbatim transcript line matching a pattern — the carried quote.
 *  Returns null when no line matches (no evidence → no proposal). */
export function findEvidenceLine(transcript: string, re: RegExp, maxLen = 240): string | null {
  for (const raw of (transcript ?? "").split("\n")) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (re.test(line)) return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line
  }
  return null
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  couple: 2, few: 3,
}
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 }
/** Season → first day of its starting month (meteorological — deterministic math). */
const SEASON_START_MONTH: Record<string, number> = { spring: 2, summer: 5, fall: 8, autumn: 8, winter: 11 }

/** Stated-horizon floor/ceiling: never schedule same-instant or past a 2-year horizon. */
const HORIZON_MIN_DAYS = 1
export const HORIZON_MAX_DAYS = 730

const clampHorizon = (d: number) => Math.min(HORIZON_MAX_DAYS, Math.max(HORIZON_MIN_DAYS, Math.round(d)))

/**
 * Pure: parse a STATED timeline out of conversational text → days from `now`.
 *   "in six months" / "within 2 weeks" / "3 months from now" → count × unit
 *   "next week|month|year"                                   → one unit out
 *   "next spring" / "this summer" / "in the fall"            → days until that
 *     season's start month (next occurrence; deterministic given `now`)
 * Minutes/hours are deliberately NOT horizons. Returns null when nothing is stated.
 */
export function parseStatedHorizon(text: string, now: Date = new Date()): { days: number; phrase: string } | null {
  const t = text ?? ""

  // "in/within/about N days|weeks|months|years" and "N months from now/out/away"
  const numbered =
    t.match(/\b(?:in|within|about|around)\s+(?:the\s+next\s+)?(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few|\d{1,2})(?:\s+(?:of|or)\s+(?:so|two|three))?\s+(day|week|month|year)s?\b/i) ??
    t.match(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few|\d{1,2})\s+(day|week|month|year)s?\s+(?:from\s+now|out|away)\b/i)
  if (numbered) {
    const n = WORD_NUMBERS[numbered[1].toLowerCase()] ?? Number.parseInt(numbered[1], 10)
    const unit = UNIT_DAYS[numbered[2].toLowerCase()]
    if (Number.isFinite(n) && n > 0 && unit) return { days: clampHorizon(n * unit), phrase: numbered[0] }
  }

  // "next week/month/year"
  const nextUnit = t.match(/\bnext\s+(week|month|year)\b/i)
  if (nextUnit) return { days: clampHorizon(UNIT_DAYS[nextUnit[1].toLowerCase()]), phrase: nextUnit[0] }

  // "next spring" / "this summer" / "in the fall" — days until that season starts.
  const season = t.match(/\b(?:next|this|in\s+the|by)\s+(spring|summer|fall|autumn|winter)\b/i)
  if (season) {
    const startMonth = SEASON_START_MONTH[season[1].toLowerCase()]
    let start = new Date(Date.UTC(now.getUTCFullYear(), startMonth, 1))
    if (start.getTime() <= now.getTime()) start = new Date(Date.UTC(now.getUTCFullYear() + 1, startMonth, 1))
    return { days: clampHorizon((start.getTime() - now.getTime()) / 86_400_000), phrase: season[0] }
  }

  return null
}

/**
 * PURE: extracted analysis + REAL transcript → the meeting's follow-through
 * intents, at most one per kind, each grounded in a verbatim quote. A hinted
 * intent WITHOUT a matching transcript line derives nothing — the evidence
 * requirement is the grounding gate, not a formality.
 */
export function deriveMeetingIntents(
  transcript: string,
  analysis: MeetingAnalysisInput,
  now: Date = new Date(),
): MeetingIntent[] {
  const intents: MeetingIntent[] = []
  const t = transcript ?? ""

  const sellLine = findEvidenceLine(t, SELL_FIRST_RE)
  if (sellLine) intents.push({ kind: "sell_first", evidence: sellLine })

  const finLine = findEvidenceLine(t, FINANCING_RE)
  if (finLine) intents.push({ kind: "financing_prequal", evidence: finLine })

  // Timeline: scan line-by-line so the carried quote is the line that stated it.
  for (const raw of t.split("\n")) {
    const line = raw.trim()
    if (line.length === 0) continue
    const horizon = parseStatedHorizon(line, now)
    if (horizon) {
      intents.push({
        kind: "timeline_followup",
        evidence: line.length > 240 ? `${line.slice(0, 239)}…` : line,
        horizonDays: horizon.days,
        horizonPhrase: horizon.phrase,
      })
      break
    }
  }

  // Objections come from the extractor's own vocabulary (short phrases pulled
  // from this transcript). Anchor the coaching note to a transcript line when
  // one contains the objection's words; the extractor phrase is the floor.
  const objections = (analysis.objections ?? []).map((o) => (o ?? "").trim()).filter((o) => o.length > 0)
  if (objections.length > 0) {
    const firstWord = objections[0].split(/\s+/).find((w) => w.length >= 4)
    const anchored = firstWord ? findEvidenceLine(t, new RegExp(firstWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")) : null
    intents.push({ kind: "objection_coaching", evidence: anchored ?? objections.join(" · ").slice(0, 240) })
  }

  return intents
}

// ─── IO: the consumer (caller-supplied client; proposals only) ───────────────

export interface FollowthroughResult {
  ok: boolean
  derived: number
  /** Gated proposals landed (agent_client_messages status 'proposed'). */
  proposed: number
  /** Follow-ups scheduled at a stated horizon (internal date, no client message). */
  scheduled: number
  skipped: string[]
  reason?: string
}

const emptyResult = (reason: string): FollowthroughResult =>
  ({ ok: false, derived: 0, proposed: 0, scheduled: 0, skipped: [], reason })

/** One open/gated proposal per (meeting, kind) — the rationale-tag prefix check. */
async function alreadyProposed(svc: any, brokerageId: string, tag: string): Promise<boolean> {
  const { data } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", brokerageId).ilike("rationale", `${tag}%`).limit(1).maybeSingle()
  return !!data
}

/**
 * THE consumer: act on one analyzed conversation (phone call OR Zoom meeting —
 * the voice_calls id keys both). Reads the call_analyses insight row the
 * extractor wrote, derives grounded intents, and maps each to its governed
 * action. Never throws; never dispatches.
 */
export async function runMeetingFollowthroughForCall(svc: any, voiceCallId: string): Promise<FollowthroughResult> {
  try {
    const { data: call } = await svc.from("voice_calls")
      .select("id, brokerage_id, contact_id, agent_id, transcription")
      .eq("id", voiceCallId).maybeSingle()
    if (!call) return emptyResult("no voice_calls row")
    const c = call as { id: string; brokerage_id: string | null; contact_id: string | null; agent_id: string | null; transcription: string | null }
    if (!c.brokerage_id) return emptyResult("no brokerage on the call")
    if (!c.contact_id) return emptyResult("no linked contact — follow-through needs a person to serve")
    const transcript = (c.transcription ?? "").trim()
    if (transcript.length === 0) return emptyResult("no transcript")

    // The insight row the extractor wrote (either provenance — one vocabulary).
    const { data: analysisRow } = await svc.from("call_analyses")
      .select("id, summary, intent_primary, objections, key_topics, analyzed_by")
      .eq("voice_call_id", voiceCallId)
      .order("analyzed_at", { ascending: false }).limit(1).maybeSingle()
    if (!analysisRow) return emptyResult("no call_analyses insight row yet")
    const a = analysisRow as { id: string; summary: string | null; intent_primary: string | null; objections: string[] | null; key_topics: string[] | null; analyzed_by: string | null }
    const provenance = a.analyzed_by ?? "voice_intel_sweep"
    const meetingWord = provenance === "zoom_transcript" ? "meeting" : "call"

    const intents = deriveMeetingIntents(transcript, {
      summary: a.summary, intentPrimary: a.intent_primary,
      objections: (a.objections ?? []) as string[], keyTopics: (a.key_topics ?? []) as string[],
    })
    const result: FollowthroughResult = { ok: true, derived: intents.length, proposed: 0, scheduled: 0, skipped: [] }
    if (intents.length === 0) return result

    const { data: contact } = await svc.from("contacts")
      .select("first_name, last_name, next_followup_at").eq("id", c.contact_id).maybeSingle()
    const who = [((contact as any)?.first_name ?? "").trim(), ((contact as any)?.last_name ?? "").trim()]
      .filter(Boolean).join(" ") || "This client"
    const firstName = ((contact as any)?.first_name ?? "").trim() || "there"

    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")

    for (const intent of intents) {
      const tag = followthroughTag(c.id, intent.kind)
      const quote = intent.evidence

      if (intent.kind === "timeline_followup") {
        // A STATED horizon → the canonical follow-up date the reactivation
        // cadences honor. Internal scheduling only — no client message. Never
        // clobbers a follow-up a human (or an earlier meeting) already set.
        const existing = (contact as any)?.next_followup_at as string | null | undefined
        if (existing && new Date(existing).getTime() > Date.now()) {
          result.skipped.push(`${intent.kind}: a future follow-up is already scheduled`)
          continue
        }
        const at = new Date(Date.now() + (intent.horizonDays ?? 30) * 86_400_000).toISOString()
        // The SAME columns lib/lead-pipeline/schedule-followup.ts owns
        // (next_followup_at / next_followup_reason — the reactivation runners
        // honor them via followupSuppresses). Written directly here because
        // that module is server-only and this consumer is simulator-driven.
        const { error: fuErr } = await svc.from("contacts")
          .update({ next_followup_at: at, next_followup_reason: `${tag} they said: "${quote}"`.slice(0, 500) })
          .eq("id", c.contact_id)
        if (!fuErr) result.scheduled += 1
        else result.skipped.push(`${intent.kind}: ${fuErr.message ?? "follow-up write failed"}`)
        continue
      }

      // The three proposal kinds — all gated, all deduped per (meeting, kind).
      if (await alreadyProposed(svc, c.brokerage_id, tag)) {
        result.skipped.push(`${intent.kind}: already proposed (deduped)`)
        continue
      }

      let p: { ok: boolean; id?: string } = { ok: false }
      if (intent.kind === "sell_first") {
        // The LISTING-SIDE conversation — a drafted seller outreach the agent
        // approves (never a direct send). Grounded in their own words.
        p = await proposeClientMessage({
          brokerageId: c.brokerage_id, agentKind: "ai_isa", entityType: "contact",
          entityId: c.contact_id, recipientContactId: c.contact_id, audience: "seller",
          channel: "portal",
          subject: "Selling first? Let's map the sell-then-buy path",
          body: `Hi ${firstName} — when we spoke, you mentioned needing to sell your current place as part of the move. That's the piece worth getting ahead of: I can pull together what your home would likely bring in today's market and walk you through how people time the sale and the purchase so you're never stuck between homes. Want me to put that together?`,
          rationale: `${tag} — the ${meetingWord} surfaced a sell-first situation. They said: "${quote}". Opening the listing-side conversation (approval-gated; nothing sends without you).`.slice(0, 900),
        }, svc)
      } else if (intent.kind === "financing_prequal") {
        // Pre-qual EDUCATION — value-forward, no lender steering, gated.
        p = await proposeClientMessage({
          brokerageId: c.brokerage_id, agentKind: "ai_isa", entityType: "contact",
          entityId: c.contact_id, recipientContactId: c.contact_id, audience: "buyer",
          channel: "portal",
          subject: "Getting pre-approval ready — a quick primer",
          body: `Hi ${firstName} — financing came up in our conversation, so here's the short version of how to get ahead of it: a pre-approval (not just pre-qualification) tells sellers you're real, locks in what you can comfortably spend, and usually takes a few days with recent pay stubs, tax returns, and bank statements. Happy to walk you through it or connect you with a couple of lenders to compare — no obligation either way.`,
          rationale: `${tag} — they asked about financing in the ${meetingWord}. They said: "${quote}". Pre-qual education proposal (approval-gated).`.slice(0, 900),
        }, svc)
      } else if (intent.kind === "objection_coaching") {
        // COACHING NOTE to the AGENT — audience 'agent' on the same gate rail
        // (the HOT_CALL idiom); never client-facing.
        const objList = (a.objections ?? []).slice(0, 5).join(" · ") || quote
        p = await proposeClientMessage({
          brokerageId: c.brokerage_id, agentKind: "ai_isa", entityType: "contact",
          entityId: c.contact_id, audience: "agent",
          subject: `Coaching note — objections ${who} raised in the ${meetingWord}`,
          body: `${who} voiced pushback worth addressing on the next touch: ${objList}. From the transcript: "${quote}". Acknowledge it directly before pitching next steps — naming the concern first is what keeps this one moving.`,
          rationale: `${tag} — objection detected in the analyzed ${meetingWord} (provenance ${provenance}). They said: "${quote}".`.slice(0, 900),
        }, svc)
      }

      if (p.ok) result.proposed += 1
      else result.skipped.push(`${intent.kind}: proposal insert failed`)
    }

    return result
  } catch (e: any) {
    return emptyResult(e?.message ?? "follow-through failed")
  }
}
