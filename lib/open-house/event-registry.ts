// lib/open-house/event-registry.ts
// ─────────────────────────────────────────────────────────────────────────────
// C22 — THE EVENT PRODUCER REGISTRY (wave 148, lane 148H). PURE: no I/O, safe for guards, server code and client bundles.
//
// OWNER (2026-11-01), verbatim: "any event needs producers or one place all feeds into"; "we use Zoom so maybe use that for
// virtual open house? or YouTube Live?"
//
// ONE PLACE EVERYTHING FEEDS INTO: every event kind is a row of open_house_events (m924 widened its CHECK to the five kinds
// below — it already carried the producer, invitations, RSVPs, attendees, feedback, the kiosk, the join door and the reminder /
// follow-up crons). This module is the TABLE that says, per kind, who PRODUCES it, how a person REGISTERS (the C15/C8
// consented form with identity + situation fields + the creating agent), how attendance is VERIFIED (and what is never
// attendance), what DELIVERABLES it promises, who FOLLOWS UP, when the AGENT is told, and what OUTCOME is recorded.
// scripts/event-producer-registry-guard.ts holds it against the live CHECK (the generated cache ∪ the newest migration's list),
// the ONE scheduling door's refusing list, and the doors named here (each must exist in the file it names).
//
// THE ATTENDANCE RULE (owner ruling 20): attendance is a VERIFIED fact about an IDENTIFIED person —
//   · in person: a consented kiosk sign-in, or an agent's walk-in check-in (both file the person through C8 / the kernel);
//   · Zoom: participant join/leave webhooks matched to a registration of THIS event by Zoom's registrant id (the key our own
//     registration minted) or by the exact e-mail of that registration — and present at least `minVerifiedSeconds`;
//   · NEVER a click: a join-link click, a watch-link open or an unmatched participant (display name only, an outside Zoom user
//     with an empty e-mail — Zoom returns `email` only for signed-in participants, developers.zoom.us meeting events,
//     read 2026-11-01) is recorded as evidence and never becomes a person's attendance;
//   · YouTube Live exposes no per-viewer identity at all (the liveBroadcasts resource carries only an aggregate chat count —
//     developers.google.com/youtube/v3/live/docs/liveBroadcasts, read 2026-11-01), so a YouTube event's attendance is
//     UNVERIFIABLE by construction: its registration is consented and its watch link is personal, but "watched" is never claimed.
//   · an external meeting link (Meet, Teams, a pasted URL) has no participant feed here: unverifiable, said so.

/**
 * The live open_house_events.event_type vocabulary after m924 — ONE spelling each (CLAUDE.md §6).
 * @proofSeam scripts/event-producer-registry-guard.ts holds this list = the m924 CHECK = the ONE producer's refusing list
 */
export const EVENT_KINDS = ["open_house", "broker_open", "virtual_open_house", "webinar", "education_session"] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/**
 * open_house_events.virtual_provider (m924 CHECK).
 * @proofSeam scripts/event-producer-registry-guard.ts holds this list equal to the m924 CHECK
 */
export const VIRTUAL_PROVIDERS = ["zoom", "youtube", "external_link"] as const
export type VirtualProvider = (typeof VIRTUAL_PROVIDERS)[number]

/**
 * open_house_rsvp_tracking.attendance_verified_by (m925 CHECK) — the only ways attendance is VERIFIED. A join-link click, a
 * watch-link open, an unmatched participant and the host's own join are evidence (event_attendance_evidence) and never here.
 * @proofSeam scripts/event-producer-registry-guard.ts holds this list equal to the m925 CHECK and proves no click is in it
 */
export const ATTENDANCE_VERIFIERS = ["kiosk_signin", "agent_walk_in", "zoom_participant"] as const
export type AttendanceVerifier = (typeof ATTENDANCE_VERIFIERS)[number]

/**
 * event_attendance_evidence.identity_match (m925 CHECK).
 * @proofSeam scripts/event-producer-registry-guard.ts holds this list equal to the m925 CHECK
 */
export const IDENTITY_MATCHES = ["registrant_id", "email_exact", "registration_token", "unmatched", "host"] as const
export type IdentityMatch = (typeof IDENTITY_MATCHES)[number]

/**
 * The situation a registration form asks (ruling 12: "identity and situation fields"). The timeline is the live
 * contacts_timeline_check vocabulary — BUCKETS only (CLAUDE.md §5, never 30/60/90); the guard holds this list equal to
 * scripts/check-vocabularies.ts contacts.timeline.
 */
export const EVENT_TIMELINE_BUCKETS = ["immediate", "1-3_months", "3-6_months", "6-12_months", "12+_months", "researching"] as const
export type EventTimelineBucket = (typeof EVENT_TIMELINE_BUCKETS)[number]
export const EVENT_INTENTS = ["buying", "selling", "buying_and_selling", "investing", "learning"] as const
export type EventIntent = (typeof EVENT_INTENTS)[number]
/** Intent → the contacts.contact_type a NEW contact is filed as (live CHECK values; a merge never overwrites a stored type). */
export const CONTACT_TYPE_FOR_INTENT: Readonly<Record<EventIntent, string>> = Object.freeze({
  buying: "buyer", selling: "seller", buying_and_selling: "both", investing: "buyer", learning: "prospect",
})

export interface EventSituation {
  intent: EventIntent | null
  timeline: EventTimelineBucket | null
  workingWithAgent: boolean | null
  /** In their own words — what they want answered (kept verbatim, never re-written). */
  question: string | null
}

export type EventDeliverable = "property_packet" | "comparable_homes" | "replay_recording" | "session_handout"

export interface DoorRef { file: string; fn: string }

export interface EventProducerSpec {
  kind: EventKind
  label: string
  /** Who attends: consumers (C8 contacts) or cooperating agents (a professional visit — never a consumer contact). */
  audience: "consumer" | "cooperating_agent"
  venue: "in_person" | "online" | "either"
  listing: "required" | "none"
  /** THE ONE scheduling door (no twin producer — the guard reads its refusing list). */
  producer: DoorRef
  registration: {
    /** True when a person must register before they can attend (every online kind: the join link is personal). */
    required: boolean
    door: DoorRef | null
    /** The consented form (C15 → C8 captureConsentedContact) or an agent's professional sign-in (no consumer consent). */
    form: "c15_consented" | "agent_sign_in"
    consentPurposes: readonly ("event_followup" | "real_estate_services" | "requested_information")[]
    identityFields: readonly string[]
    situationFields: readonly (keyof EventSituation)[]
    /** Ruling 12: the registrant is assigned back to the event's creating agent / user. */
    assignsToCreator: boolean
  }
  attendance: {
    verifiedBy: readonly AttendanceVerifier[]
    checkInDoors: readonly DoorRef[]
    /** Online hosts this kind may use, and whether each can VERIFY attendance. */
    providers: Partial<Record<VirtualProvider, "verified" | "unverifiable">>
    /** Seconds present before an identified participant counts as having attended (online kinds only). */
    minVerifiedSeconds: number | null
  }
  /** The capability the producer routes through (routeCapability) — never a vendor named by the caller (law 3). */
  capability: { hosting: "virtual_event_hosting" | null; broadcast: "live_broadcast" | null }
  deliverables: readonly EventDeliverable[]
  followUp: {
    /** The manager that decides what happens next for an attendee (the arbiter path), and the door that hands them over. */
    owner: "ai_isa"
    door: DoorRef
    /** A registrant who did not attend: re-engaged with the replay where one exists — never told they were "seen". */
    noShow: "offer_replay" | "none"
  }
  outcome: { recordedOn: "open_house_rsvp_tracking"; attendeeRow: "open_house_attendees"; evidence: "event_attendance_evidence" | null }
  /** Why the rules are what they are — rendered by the guard and the schedule dialog. */
  rationale: string
}

const SCHEDULER: DoorRef = { file: "app/actions/open-house.ts", fn: "createOpenHouse" }
const REGISTRATION: DoorRef = { file: "app/api/open-house/register/route.ts", fn: "POST" }
const KIOSK: DoorRef = { file: "app/api/open-house/attend/route.ts", fn: "POST" }
const WALK_IN: DoorRef = { file: "app/actions/open-house-kernel.ts", fn: "completeOpenHouseCheckInAction" }
const ZOOM_WEBHOOK: DoorRef = { file: "app/api/webhooks/zoom/route.ts", fn: "POST" }
const FOLLOW_UP: DoorRef = { file: "app/actions/open-house-automation.ts", fn: "processEventFollowups" }
const CONSUMER_IDENTITY = ["first_name", "last_name", "email", "phone"] as const
const SITUATION: readonly (keyof EventSituation)[] = ["intent", "timeline", "workingWithAgent", "question"]
const OUTCOME = { recordedOn: "open_house_rsvp_tracking", attendeeRow: "open_house_attendees", evidence: "event_attendance_evidence" } as const

export const EVENT_PRODUCER_REGISTRY: Readonly<Record<EventKind, EventProducerSpec>> = Object.freeze({
  open_house: {
    kind: "open_house", label: "Open house", audience: "consumer", venue: "in_person", listing: "required",
    producer: SCHEDULER,
    registration: { required: false, door: KIOSK, form: "c15_consented", consentPurposes: ["event_followup"], identityFields: CONSUMER_IDENTITY, situationFields: ["workingWithAgent"], assignsToCreator: true },
    attendance: { verifiedBy: ["kiosk_signin", "agent_walk_in"], checkInDoors: [KIOSK, WALK_IN], providers: {}, minVerifiedSeconds: null },
    capability: { hosting: null, broadcast: null },
    deliverables: ["property_packet", "comparable_homes"],
    followUp: { owner: "ai_isa", door: FOLLOW_UP, noShow: "none" },
    outcome: { ...OUTCOME, evidence: null },
    rationale: "A visitor at the door signs in on the kiosk (consented, through C8) or is checked in by the agent; the sign-in IS the attendance.",
  },
  broker_open: {
    kind: "broker_open", label: "Broker open (agents)", audience: "cooperating_agent", venue: "in_person", listing: "required",
    producer: SCHEDULER,
    registration: { required: false, door: KIOSK, form: "agent_sign_in", consentPurposes: [], identityFields: CONSUMER_IDENTITY, situationFields: [], assignsToCreator: false },
    attendance: { verifiedBy: ["kiosk_signin"], checkInDoors: [KIOSK], providers: {}, minVerifiedSeconds: null },
    capability: { hosting: null, broadcast: null },
    deliverables: ["property_packet"],
    followUp: { owner: "ai_isa", door: FOLLOW_UP, noShow: "none" },
    outcome: { ...OUTCOME, evidence: null },
    rationale: "Cooperating agents preview the listing for their buyers: the visit is recorded, and no consumer contact, consent or greeting is created for a colleague.",
  },
  virtual_open_house: {
    kind: "virtual_open_house", label: "Virtual open house", audience: "consumer", venue: "online", listing: "required",
    producer: SCHEDULER,
    registration: { required: true, door: REGISTRATION, form: "c15_consented", consentPurposes: ["event_followup"], identityFields: CONSUMER_IDENTITY, situationFields: SITUATION, assignsToCreator: true },
    attendance: { verifiedBy: ["zoom_participant"], checkInDoors: [ZOOM_WEBHOOK], providers: { zoom: "verified", youtube: "unverifiable", external_link: "unverifiable" }, minVerifiedSeconds: 120 },
    capability: { hosting: "virtual_event_hosting", broadcast: "live_broadcast" },
    deliverables: ["replay_recording", "property_packet"],
    followUp: { owner: "ai_isa", door: FOLLOW_UP, noShow: "offer_replay" },
    outcome: OUTCOME,
    rationale: "A live walkthrough online. Zoom is primary: the registration mints a personal Zoom link, and the participant webhook proves who stayed. Two minutes present is attendance; a click is not.",
  },
  webinar: {
    kind: "webinar", label: "Webinar", audience: "consumer", venue: "online", listing: "none",
    producer: SCHEDULER,
    registration: { required: true, door: REGISTRATION, form: "c15_consented", consentPurposes: ["event_followup", "requested_information"], identityFields: CONSUMER_IDENTITY, situationFields: SITUATION, assignsToCreator: true },
    attendance: { verifiedBy: ["zoom_participant"], checkInDoors: [ZOOM_WEBHOOK], providers: { zoom: "verified", youtube: "unverifiable", external_link: "unverifiable" }, minVerifiedSeconds: 300 },
    capability: { hosting: "virtual_event_hosting", broadcast: "live_broadcast" },
    deliverables: ["replay_recording", "session_handout"],
    followUp: { owner: "ai_isa", door: FOLLOW_UP, noShow: "offer_replay" },
    outcome: OUTCOME,
    rationale: "A teaching session for buyers, sellers or owners (first-time buyer, selling in this market, financing). Five minutes present is attendance; the replay is offered to everyone registered who missed it.",
  },
  education_session: {
    kind: "education_session", label: "Education session", audience: "consumer", venue: "either", listing: "none",
    producer: SCHEDULER,
    registration: { required: true, door: REGISTRATION, form: "c15_consented", consentPurposes: ["event_followup", "requested_information"], identityFields: CONSUMER_IDENTITY, situationFields: SITUATION, assignsToCreator: true },
    attendance: { verifiedBy: ["kiosk_signin", "agent_walk_in", "zoom_participant"], checkInDoors: [KIOSK, WALK_IN, ZOOM_WEBHOOK], providers: { zoom: "verified", youtube: "unverifiable", external_link: "unverifiable" }, minVerifiedSeconds: 300 },
    capability: { hosting: "virtual_event_hosting", broadcast: "live_broadcast" },
    deliverables: ["session_handout", "replay_recording"],
    followUp: { owner: "ai_isa", door: FOLLOW_UP, noShow: "offer_replay" },
    outcome: OUTCOME,
    rationale: "A seminar at the office or online. In person it is attended at the sign-in kiosk; online it is verified exactly like a webinar.",
  },
})

// ─── pure predicates ─────────────────────────────────────────────────────────

export function isEventKind(v: unknown): v is EventKind {
  return typeof v === "string" && (EVENT_KINDS as readonly string[]).includes(v)
}

export function isVirtualProvider(v: unknown): v is VirtualProvider {
  return typeof v === "string" && (VIRTUAL_PROVIDERS as readonly string[]).includes(v)
}

/** Is this event held online (and so needs a host)? An education session is online only when it names a provider. */
export function isOnlineEvent(kind: string | null | undefined, provider: string | null | undefined): boolean {
  if (!isEventKind(kind)) return false
  const v = EVENT_PRODUCER_REGISTRY[kind].venue
  return v === "online" || (v === "either" && isVirtualProvider(provider))
}

/** Can attendance at this event be VERIFIED at all? In person: the sign-in. Online: only a provider the registry marks verified. */
export function attendanceVerifiability(kind: string | null | undefined, provider: string | null | undefined): "verified" | "unverifiable" | "unknown_kind" {
  if (!isEventKind(kind)) return "unknown_kind"
  if (!isOnlineEvent(kind, provider)) return "verified"
  const p = isVirtualProvider(provider) ? EVENT_PRODUCER_REGISTRY[kind].attendance.providers[provider] : undefined
  return p === "verified" ? "verified" : "unverifiable"
}

export const normalizeEmail = (e: string | null | undefined): string | null => {
  const s = (e ?? "").trim().toLowerCase()
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null
}

/** A registration of THIS event the matcher may file a participant against. */
export interface RegistrationForMatch { contactId: string; providerRegistrantId: string | null; email: string | null }

/** One provider participant, normalised (lib/connections/zoom.ts parseZoomParticipantEvent). */
export interface ParticipantIdentity {
  registrantId: string | null
  email: string | null
  /** Zoom's participant_user_id / id — set only for a signed-in user of the HOST's account. */
  accountUserId: string | null
  /** The meeting-session user id Zoom issues to every participant (host included). */
  sessionUserId: string | null
  displayName: string | null
}

/**
 * PURE — WHO is this participant? Ordered, conservative, and never by display name:
 *   1. the host (Zoom's host_id equals the participant's account user id) → `host`, filed as nobody;
 *   2. Zoom's registrant id equals a registration OUR form minted for this event → that contact;
 *   3. the participant's e-mail (present only when signed in to Zoom) equals EXACTLY ONE registration's e-mail → that contact;
 *   4. anything else (a display name, an outside user with an empty e-mail, a registrant id that is not ours, an e-mail two
 *      registrations share) → `unmatched`: recorded as evidence that someone joined, never anyone's attendance.
 */
export function matchParticipantIdentity(
  p: ParticipantIdentity,
  registrations: readonly RegistrationForMatch[],
  host: { hostId: string | null },
): { contactId: string | null; match: IdentityMatch; reason: string } {
  if (host.hostId && p.accountUserId && p.accountUserId === host.hostId) return { contactId: null, match: "host", reason: "the meeting host" }
  if (p.registrantId) {
    const hits = registrations.filter((r) => r.providerRegistrantId && r.providerRegistrantId === p.registrantId)
    if (hits.length === 1) return { contactId: hits[0].contactId, match: "registrant_id", reason: "Zoom registrant id minted by this event's registration" }
    if (hits.length === 0) return { contactId: null, match: "unmatched", reason: "a Zoom registrant id this event's registrations never minted (registered outside our consented form)" }
  }
  const email = normalizeEmail(p.email)
  if (email) {
    const hits = registrations.filter((r) => normalizeEmail(r.email) === email)
    if (hits.length === 1) return { contactId: hits[0].contactId, match: "email_exact", reason: "the signed-in participant's e-mail equals one registration's e-mail" }
    if (hits.length > 1) return { contactId: null, match: "unmatched", reason: "the e-mail matches more than one registration — ambiguous, filed as nobody" }
  }
  return { contactId: null, match: "unmatched", reason: p.displayName ? "only a display name — a name is never an identity" : "no registrant id and no e-mail (an outside or anonymous participant)" }
}

/** A matched join / leave the attendance window is computed from. */
export interface AttendanceEvidence { kind: "participant_joined" | "participant_left"; at: string; participantKey: string | null }

/**
 * PURE — the time an identified person was actually present: each join paired with the next leave of the SAME participant
 * session (a rejoin is a new pair), overlapping intervals merged (two devices are not double time), a join with no leave
 * closed at `closeAt` (the meeting's end) or left open (counted as zero — presence is never assumed).
 */
export function computeAttendanceWindow(
  evidence: readonly AttendanceEvidence[],
  closeAt: string | null = null,
): { firstJoinedAt: string | null; lastLeftAt: string | null; seconds: number; openSessions: number } {
  const sorted = [...evidence].filter((e) => !Number.isNaN(Date.parse(e.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const open = new Map<string, number>()
  const intervals: Array<[number, number]> = []
  for (const e of sorted) {
    const key = e.participantKey ?? "_"
    const t = Date.parse(e.at)
    if (e.kind === "participant_joined") { if (!open.has(key)) open.set(key, t) }
    else if (open.has(key)) { intervals.push([open.get(key)!, t]); open.delete(key) }
  }
  const close = closeAt && !Number.isNaN(Date.parse(closeAt)) ? Date.parse(closeAt) : null
  let openSessions = 0
  for (const start of open.values()) { if (close != null && close > start) intervals.push([start, close]); else openSessions++ }
  intervals.sort((a, b) => a[0] - b[0])
  let total = 0, curS = -1, curE = -1
  for (const [s, e] of intervals) {
    if (e <= s) continue
    if (curE < 0 || s > curE) { if (curE > curS) total += curE - curS; curS = s; curE = e }
    else curE = Math.max(curE, e)
  }
  if (curE > curS && curS >= 0) total += curE - curS
  const joins = sorted.filter((e) => e.kind === "participant_joined")
  const leaves = sorted.filter((e) => e.kind === "participant_left")
  return {
    firstJoinedAt: joins[0]?.at ?? null,
    lastLeftAt: leaves.length ? leaves[leaves.length - 1].at : (close != null && joins.length ? new Date(close).toISOString() : null),
    seconds: Math.round(total / 1000),
    openSessions,
  }
}

/** PURE — does this identified presence count as attendance for this kind? */
export function attendanceVerdict(input: { kind: string; provider: string | null; matched: boolean; seconds: number }): { attended: boolean; verifiedBy: AttendanceVerifier | null; reason: string } {
  if (!isEventKind(input.kind)) return { attended: false, verifiedBy: null, reason: `unknown event kind ${input.kind}` }
  if (!input.matched) return { attended: false, verifiedBy: null, reason: "an unidentified participant is never attendance" }
  if (attendanceVerifiability(input.kind, input.provider) !== "verified" || input.provider !== "zoom") {
    return { attended: false, verifiedBy: null, reason: `${input.provider ?? "this host"} cannot verify attendance — recorded as evidence only` }
  }
  const min = EVENT_PRODUCER_REGISTRY[input.kind].attendance.minVerifiedSeconds ?? 0
  if (input.seconds < min) return { attended: false, verifiedBy: null, reason: `present ${input.seconds}s — under the ${min}s this kind requires` }
  return { attended: true, verifiedBy: "zoom_participant", reason: `present ${input.seconds}s (≥ ${min}s), identified through a registration of this event` }
}

/**
 * PURE — WHEN THE AGENT IS TOLD (owner: "agent notification when appropriate"). The agent hears about a PERSON, never a
 * click: verified attendance only, and only when there is something the agent can act on — a stated near timeline, a question
 * they asked in their own words, or deep engagement. Everyone else is the AI ISA's to nurture through the arbiter, and the
 * agent sees them on the event's outcome rather than as a ping.
 */
export function shouldNotifyAgent(input: { verified: boolean; engagementRatio: number | null; situation: Partial<EventSituation> | null; audience: EventProducerSpec["audience"] }): { notify: boolean; reason: string } {
  if (!input.verified) return { notify: false, reason: "not verified attendance — the agent is never pinged about a click or an unidentified join" }
  if (input.audience === "cooperating_agent") return { notify: true, reason: "a cooperating agent previewed the listing — the listing agent hears about colleagues directly" }
  const s = input.situation ?? {}
  if (s.timeline === "immediate" || s.timeline === "1-3_months") return { notify: true, reason: `stated timeline ${s.timeline}` }
  if (typeof s.question === "string" && s.question.trim().length >= 8) return { notify: true, reason: "they asked a question in their own words" }
  if (typeof input.engagementRatio === "number" && input.engagementRatio >= 0.75) return { notify: true, reason: `stayed for ${Math.round(input.engagementRatio * 100)}% of the session` }
  return { notify: false, reason: "verified attendance with no near timeline, question or deep engagement — the AI ISA nurtures; the agent sees it on the outcome" }
}

/** One per-(event, contact) row's attendance state, as the outcome rollup reads it. */
export interface RsvpForOutcome { rsvp_status: string | null; attendance_verified_by: string | null; registered_at: string | null }

/**
 * PURE — THE OUTCOME of one event, recorded honestly: registrations, verified attendance, no-shows (only where attendance was
 * verifiable — an unverifiable host never yields a "no-show" it cannot know), unverifiable registrations, and the anonymous joins
 * the evidence saw. Rates are null when their denominator is zero (never a fake 0%).
 */
export function eventOutcome(input: { kind: string; provider: string | null; rsvps: readonly RsvpForOutcome[]; unmatchedJoins: number }): {
  registered: number; attendedVerified: number; noShow: number; unverifiable: number; anonymousJoins: number; attendanceRate: number | null; verifiability: string
} {
  const verifiability = attendanceVerifiability(input.kind, input.provider)
  const registered = input.rsvps.filter((r) => !!r.registered_at).length
  const attendedVerified = input.rsvps.filter((r) => r.rsvp_status === "attended" && !!r.attendance_verified_by).length
  const noShow = input.rsvps.filter((r) => r.rsvp_status === "no_show").length
  const unverifiable = verifiability === "verified" ? 0 : input.rsvps.filter((r) => !!r.registered_at && r.rsvp_status !== "attended").length
  return {
    registered, attendedVerified, noShow, unverifiable, anonymousJoins: Math.max(0, input.unmatchedJoins),
    attendanceRate: verifiability === "verified" && registered > 0 ? attendedVerified / registered : null,
    verifiability,
  }
}

// ─── what a host ANSWERED (read by the provider adapter, lib/connections/zoom.ts) ─────────────────────────────────────────

/**
 * PURE — is registration on, as Zoom ANSWERED it? `settings.approval_type` 0 (automatic) and 1 (manual) register; 2 / absent is
 * "no registration". Zoom is reported to answer 2 for a request that asked 0 on an account that cannot register attendees (a free
 * plan), so the registry's "verified" promise for Zoom holds only when this reads true — otherwise attendance can be matched
 * only by a signed-in participant's exact e-mail.
 */
export function zoomRegistrationEnabled(approvalType: number | null | undefined): boolean {
  return approvalType === 0 || approvalType === 1
}

// THE CENSUS lives in scripts/event-producer-registry-guard.ts (censusEventProducers there): the guard IS the census the
// contract names ("a census proves no type lacks a producer"); this module carries the data it judges.
