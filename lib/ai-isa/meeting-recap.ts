// lib/ai-isa/meeting-recap.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT MEETING RECAP (owner round 41, rec 4) — "what we discussed, what
// happens next" as a portal-visible, HUMAN-APPROVED card. Closes the client-
// transparency loop on the round-39/40 conversation lane: the transcript landed
// (zoom-transcripts), the insights landed (call_analyses), the ISA acted
// (meeting-followthrough) — this module tells the CLIENT, in the tenant's own
// voice, once a human signs off.
//
// COMPOSITION INVARIANTS:
//   • WHAT WE DISCUSSED is grounded: every recap point pairs a call_analyses
//     key topic with a VERBATIM transcript line that evidences it (the round-40
//     grounding gate — a topic with no transcript evidence is DROPPED, never
//     paraphrased into existence). No grounded point → no recap.
//   • WHAT HAPPENS NEXT cites ONLY real artifacts: the follow-through proposals
//     actually created for THIS call (rationale-tag match, client-facing kinds
//     only — the agent coaching note is internal and never surfaces) plus a
//     follow-up actually scheduled at the stated horizon. Zero artifacts → the
//     recap honestly says nothing is needed, it never invents a next step.
//   • CLIENT COPY is authored via the brand-voice idiom (generateClientMessage
//     — gateway + compliance redraft gate) with this module's deterministic,
//     jargon-free fallback as the floor; the SUBJECT is always deterministic so
//     the meeting date is guaranteed on the card. The transcript itself is
//     NEVER handed to the author or the client — only topics + derived steps.
//   • PROPOSED, NEVER SENT: output enters the proposeClientMessage rail
//     (entity_type 'meeting_recap', channel 'portal', status 'proposed');
//     approval renders it as the portal's distinct "Meeting recap" card
//     (agent-client-messages maps entity_type → transparency update_type).
//   • ONE recap per meeting: deduped by the [MEETING_RECAP] [<voice_call_id>]
//     rationale tag across ALL statuses — a redelivery, a sweep re-run, or a
//     re-approval can never re-propose.
//   • MEETING gate, conservative: Zoom meetings always; a phone call only when
//     it is tied to a calendar appointment near the call time.
//
// NOT server-only (simulator-driven, like meeting-followthrough); the brand-
// voice author is dynamically imported and failure falls to the floor.

import {
  MEETING_FOLLOWTHROUGH_TAG,
  followthroughTag,
  findEvidenceLine,
  type FollowthroughKind,
} from "./meeting-followthrough"

// ─── Tags + constants ────────────────────────────────────────────────────────

/** The rationale marker every recap proposal carries (dedupe key prefix). */
export const MEETING_RECAP_TAG = "[MEETING_RECAP]"

/** Pure: the per-meeting dedupe tag — START of the proposal rationale so an
 *  ilike prefix check finds it (the followthrough/HOT_CALL idiom). */
export function meetingRecapTag(voiceCallId: string): string {
  return `${MEETING_RECAP_TAG} [${voiceCallId}]`
}

/** entity_type on the proposal — the approval flow maps it to the portal's
 *  distinct 'meeting_recap' transparency card. */
export const MEETING_RECAP_ENTITY_TYPE = "meeting_recap"

/** Recap points cap — a card, not minutes. */
export const MAX_RECAP_POINTS = 5

/** CONSERVATIVE phone-call meeting linkage: the client-facing consultation
 *  event_types (the appointment-noshow vocabulary, minus drive-by types) —
 *  a phone call is a MEETING only when one of these sits near the call time. */
export const MEETING_EVENT_TYPES = [
  "isa_appointment",
  "buyer_consultation",
  "listing_consultation",
  "listing_presentation",
  "consultation",
  "appointment",
] as const

/** How close (hours, either side) a calendar appointment must sit to the call
 *  start for the call to count as that meeting. */
const MEETING_EVENT_LINK_WINDOW_HOURS = 3

/** Pure meeting gate: zoom meetings ALWAYS; phone calls ONLY when tied to a
 *  calendar appointment (be conservative — an unlinked phone call gets
 *  follow-through, not a portal recap). */
export function isMeetingConversation(callType: string | null | undefined, hasLinkedCalendarEvent: boolean): boolean {
  if ((callType ?? "") === "zoom_meeting") return true
  return hasLinkedCalendarEvent
}

// ─── Pure: grounded "what we discussed" ──────────────────────────────────────

export interface DiscussedPoint {
  /** The extractor's key topic (short client-safe phrase). */
  topic: string
  /** The VERBATIM transcript line evidencing it (internal — approver-visible, never client-visible). */
  evidence: string
}

/** Pure: a topic → a transcript-evidence regex over its significant words.
 *  Each word is matched as a light STEM prefix (last few chars dropped for
 *  longer words) so "pre-approval" evidences "getting pre-approved" — an
 *  inflection is the same topic; a different word is not. Returns null when
 *  the topic has nothing matchable (→ topic is dropped). */
export function topicEvidenceRegex(topic: string): RegExp | null {
  const t = (topic ?? "").trim().toLowerCase()
  if (t.length === 0) return null
  let terms = t.split(/[^a-z0-9-]+/).filter((w) => w.length >= 4)
  if (terms.length === 0 && t.length >= 3) terms = [t]
  if (terms.length === 0) return null
  const esc = terms
    .map((w) => w.slice(0, Math.max(4, w.length - 3))) // light stem: prefix match
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`\\b(?:${esc.join("|")})`, "i")
}

/**
 * PURE GROUNDING GATE: key topics → recap points, each carrying the verbatim
 * transcript line that evidences it. A topic with NO matching transcript line
 * derives NOTHING (the round-40 invariant — the summary hinting at it is not
 * evidence). Duplicate evidence lines collapse to one point; capped.
 */
export function deriveDiscussedPoints(
  transcript: string,
  keyTopics: Array<string | null | undefined>,
  max: number = MAX_RECAP_POINTS,
): DiscussedPoint[] {
  const points: DiscussedPoint[] = []
  const usedEvidence = new Set<string>()
  const usedTopics = new Set<string>()
  for (const raw of keyTopics ?? []) {
    if (points.length >= max) break
    const topic = (raw ?? "").trim()
    if (!topic || usedTopics.has(topic.toLowerCase())) continue
    const re = topicEvidenceRegex(topic)
    if (!re) continue
    const evidence = findEvidenceLine(transcript ?? "", re)
    if (!evidence || usedEvidence.has(evidence)) continue
    usedTopics.add(topic.toLowerCase())
    usedEvidence.add(evidence)
    points.push({ topic, evidence })
  }
  return points
}

// ─── Pure: "what happens next" — ONLY from real artifacts ────────────────────

export interface RecapNextStep {
  /** Which real artifact this step cites. */
  source: FollowthroughKind | "scheduled_followup"
  /** Client-toned phrasing (no jargon, no system talk, no figures). */
  text: string
}

/** Client-facing phrasings for the follow-through kinds a client may see.
 *  objection_coaching is an INTERNAL agent note — never surfaced. */
const CLIENT_STEP_TEXT: Partial<Record<FollowthroughKind, string>> = {
  sell_first:
    "We'll map out the sale of your current home — what the move looks like and how the timing works — so you're never stuck between homes.",
  financing_prequal:
    "We'll walk through getting your financing squared away, step by step, so you know exactly where you stand.",
}

/** Deterministic month-year label for a scheduled follow-up (UTC-stable). */
export function followupWhenLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  } catch {
    return "the timing you mentioned"
  }
}

/**
 * PURE: next steps derived ONLY from the follow-through artifacts that
 * actually exist for THIS call — the gated proposals created (matched by the
 * [MEETING_FOLLOWTHROUGH] [callId] [kind] rationale prefix; client-facing
 * kinds only) and a follow-up actually scheduled at the stated horizon
 * (contacts.next_followup_reason carrying this call's timeline tag, date in
 * the future). Proposals for OTHER calls never leak in; nothing is invented.
 */
export function deriveNextSteps(input: {
  voiceCallId: string
  /** agent_client_messages rows tagged for this call (rationale + audience). */
  proposals: Array<{ rationale: string | null; audience?: string | null }>
  followupAt: string | null
  followupReason: string | null
  now?: Date
}): RecapNextStep[] {
  const steps: RecapNextStep[] = []
  const now = input.now ?? new Date()

  for (const kind of Object.keys(CLIENT_STEP_TEXT) as FollowthroughKind[]) {
    const tag = followthroughTag(input.voiceCallId, kind)
    if ((input.proposals ?? []).some((p) => (p.rationale ?? "").startsWith(tag))) {
      steps.push({ source: kind, text: CLIENT_STEP_TEXT[kind]! })
    }
  }

  const tlTag = followthroughTag(input.voiceCallId, "timeline_followup")
  if (
    input.followupAt &&
    (input.followupReason ?? "").includes(tlTag) &&
    new Date(input.followupAt).getTime() > now.getTime()
  ) {
    steps.push({
      source: "scheduled_followup",
      text: `We'll reconnect around ${followupWhenLabel(input.followupAt)} — the timing you told us works for you.`,
    })
  }

  return steps
}

// ─── Pure: the deterministic brand-voice floor ───────────────────────────────

/** Deterministic meeting-date label (UTC-stable — "Jul 18"). */
export function meetingDateLabel(iso: string | null | undefined): string {
  try {
    if (!iso) return "our recent conversation"
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  } catch {
    return "our recent conversation"
  }
}

/**
 * PURE FLOOR: the neutral, client-toned recap used when brand-voice authoring
 * is unavailable or fails its compliance gate. No jargon, no system talk, no
 * transcript lines, no figures — and honest when there are no next steps.
 */
export function buildRecapFallback(args: {
  firstName: string | null
  meetingWord: "meeting" | "call"
  dateLabel: string
  points: DiscussedPoint[]
  nextSteps: RecapNextStep[]
}): { subject: string; body: string } {
  const hi = args.firstName ? `Hi ${args.firstName} — ` : "Hi — "
  const topics = args.points.map((p) => p.topic).join(", ")
  const nextBlock =
    args.nextSteps.length > 0
      ? `What happens next:\n${args.nextSteps.map((s) => `• ${s.text}`).join("\n")}`
      : "Nothing is needed from you right now — we'll be in touch when there's something worth your time."
  return {
    subject: `Recap of our ${args.meetingWord} — ${args.dateLabel}`,
    body: `${hi}thank you for the time on ${args.dateLabel}. Here's a quick recap so we're on the same page.\n\nWhat we discussed: ${topics}.\n\n${nextBlock}`,
  }
}

// ─── IO: compose + propose (caller-supplied client; proposal only) ───────────

export interface MeetingRecapResult {
  ok: boolean
  /** True when a recap proposal landed on the gate this run. */
  proposed: boolean
  reason?: string
}

const skip = (reason: string): MeetingRecapResult => ({ ok: true, proposed: false, reason })
const failr = (reason: string): MeetingRecapResult => ({ ok: false, proposed: false, reason })

/** IO: does a client-facing consultation sit near this call on the calendar?
 *  (The conservative phone-call meeting linkage.) */
async function hasLinkedMeetingEvent(svc: any, call: {
  brokerage_id: string; contact_id: string; started_at: string | null
}): Promise<boolean> {
  if (!call.started_at) return false
  const t = new Date(call.started_at).getTime()
  if (!Number.isFinite(t)) return false
  const windowMs = MEETING_EVENT_LINK_WINDOW_HOURS * 3_600_000
  const { data } = await svc.from("calendar_events").select("id")
    .eq("brokerage_id", call.brokerage_id)
    .eq("entity_type", "contact").eq("entity_id", call.contact_id)
    .in("event_type", MEETING_EVENT_TYPES as unknown as string[])
    .gte("start_at", new Date(t - windowMs).toISOString())
    .lte("start_at", new Date(t + windowMs).toISOString())
    .limit(1).maybeSingle()
  return !!data
}

/**
 * Compose ONE client-facing meeting recap for an analyzed conversation and
 * land it on the human-approval gate (proposed, channel 'portal'). Call AFTER
 * meeting-followthrough so "what happens next" can cite the real proposals it
 * created. Enforces its own conservative meeting gate, so both triggers (zoom
 * lane + voice sweep) can call it unconditionally. Never throws; never sends.
 */
export async function composeMeetingRecap(svc: any, voiceCallId: string, opts?: { now?: Date }): Promise<MeetingRecapResult> {
  try {
    const now = opts?.now ?? new Date()

    const { data: call } = await svc.from("voice_calls")
      .select("id, brokerage_id, contact_id, agent_id, call_type, started_at, transcription")
      .eq("id", voiceCallId).maybeSingle()
    if (!call) return failr("no voice_calls row")
    const c = call as { id: string; brokerage_id: string | null; contact_id: string | null; agent_id: string | null; call_type: string | null; started_at: string | null; transcription: string | null }
    if (!c.brokerage_id) return failr("no brokerage on the call")
    if (!c.contact_id) return skip("no linked contact — a recap needs a client to read it")
    const transcript = (c.transcription ?? "").trim()
    if (transcript.length === 0) return skip("no transcript")

    // MEETING GATE (conservative): zoom always; phone only with a calendar link.
    const isZoom = (c.call_type ?? "") === "zoom_meeting"
    const linked = isZoom ? false : await hasLinkedMeetingEvent(svc, { brokerage_id: c.brokerage_id, contact_id: c.contact_id, started_at: c.started_at })
    if (!isMeetingConversation(c.call_type, linked)) {
      return skip("not a meeting-length conversation (no zoom lane, no linked calendar appointment)")
    }

    // DEDUPE — one recap per meeting, across ALL statuses: an approved, sent,
    // or even rejected recap blocks forever (re-approval never re-proposes).
    const tag = meetingRecapTag(c.id)
    const { data: dup } = await svc.from("agent_client_messages").select("id")
      .eq("brokerage_id", c.brokerage_id).ilike("rationale", `${tag}%`).limit(1).maybeSingle()
    if (dup) return skip("recap already proposed for this meeting (deduped)")

    // The insight row the extractor wrote — the recap's topic vocabulary.
    const { data: analysisRow } = await svc.from("call_analyses")
      .select("id, summary, key_topics, analyzed_by")
      .eq("voice_call_id", voiceCallId)
      .order("analyzed_at", { ascending: false }).limit(1).maybeSingle()
    if (!analysisRow) return skip("no call_analyses insight row yet")
    const a = analysisRow as { id: string; summary: string | null; key_topics: string[] | null; analyzed_by: string | null }
    const meetingWord: "meeting" | "call" = (a.analyzed_by ?? "") === "zoom_transcript" || isZoom ? "meeting" : "call"

    // WHAT WE DISCUSSED — grounded points only.
    const points = deriveDiscussedPoints(transcript, (a.key_topics ?? []) as string[])
    if (points.length === 0) return skip("no discussed point grounded in a transcript line — nothing honest to recap")

    // WHAT HAPPENS NEXT — only the real follow-through artifacts for THIS call.
    const { data: ftRows } = await svc.from("agent_client_messages")
      .select("rationale, audience")
      .eq("brokerage_id", c.brokerage_id)
      .ilike("rationale", `${MEETING_FOLLOWTHROUGH_TAG} [${c.id}]%`)
    const { data: contactRow } = await svc.from("contacts")
      .select("first_name, contact_type, agent_id, next_followup_at, next_followup_reason")
      .eq("id", c.contact_id).maybeSingle()
    const contact = contactRow as { first_name: string | null; contact_type: string | null; agent_id: string | null; next_followup_at: string | null; next_followup_reason: string | null } | null
    const nextSteps = deriveNextSteps({
      voiceCallId: c.id,
      proposals: ((ftRows ?? []) as Array<{ rationale: string | null; audience: string | null }>),
      followupAt: contact?.next_followup_at ?? null,
      followupReason: contact?.next_followup_reason ?? null,
      now,
    })

    // Audience matches the contact's side (the portal-invite mapping).
    const side = (contact?.contact_type ?? "").toLowerCase()
    const audience: "seller" | "buyer" = ["seller", "motivated_seller"].includes(side) ? "seller" : "buyer"
    const firstName = (contact?.first_name ?? "").trim() || null
    const dateLabel = meetingDateLabel(c.started_at)

    // BRAND-VOICE AUTHORING with the deterministic floor. The author receives
    // ONLY the topics + derived steps — NEVER the transcript — so raw
    // conversation lines can't reach the client even in a model slip.
    const fallback = buildRecapFallback({ firstName, meetingWord, dateLabel, points, nextSteps })
    let body = fallback.body
    try {
      const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
      let agentUserId: string | null = null
      if (contact?.agent_id) {
        const { data: ag } = await svc.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
        agentUserId = (ag as { user_id: string | null } | null)?.user_id ?? null
      }
      const authored = await generateClientMessage({
        brokerageId: c.brokerage_id,
        agentUserId,
        audience,
        purpose: `Recap our ${meetingWord} on ${dateLabel} for the client: warmly restate what we discussed and what happens next. Mention ONLY the discussed topics and next steps listed below — if no next step is listed, say nothing is needed from them right now. Plain language, no jargon.`,
        recipientFirstName: firstName,
        facts: [
          { label: "What we discussed", value: points.map((p) => p.topic).join(", ") },
          ...nextSteps.map((s, i) => ({ label: `Next step ${i + 1}`, value: s.text })),
          ...(nextSteps.length === 0 ? [{ label: "Next steps", value: "none scheduled — do not invent any" }] : []),
        ],
        fallback,
      })
      if (authored?.body?.trim()) body = authored.body
    } catch {
      /* gateway unavailable → the deterministic floor stands */
    }

    // The SUBJECT stays deterministic — the meeting date is guaranteed on the card.
    const subject = fallback.subject

    // PROPOSED, NEVER SENT — the human-approval gate; approval renders the
    // distinct portal 'Meeting recap' card. Rationale (internal) carries the
    // grounding evidence so the approver can verify every point.
    const grounding = points.map((p) => `${p.topic} ← "${p.evidence.slice(0, 80)}"`).join(" · ")
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const p = await proposeClientMessage({
      brokerageId: c.brokerage_id,
      agentKind: "ai_isa",
      entityType: MEETING_RECAP_ENTITY_TYPE,
      entityId: c.id,
      recipientContactId: c.contact_id,
      audience,
      channel: "portal",
      subject,
      body,
      rationale: `${tag} — client-facing recap of the ${dateLabel} ${meetingWord}. Every discussed point is grounded in a transcript line: ${grounding}. Next steps cite only the real follow-through artifacts (${nextSteps.length}). Approval publishes the portal card; the transcript itself is never shown to the client.`.slice(0, 900),
      // outreachReason inferred by the canonical registry (lands milestone_update).
    }, svc)
    if (!p.ok) return failr(p.error ?? "recap proposal insert failed")
    return { ok: true, proposed: true }
  } catch (e: any) {
    return failr(e?.message ?? "meeting recap failed")
  }
}
