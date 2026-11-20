// lib/open-house/event-attendance.ts
// ─────────────────────────────────────────────────────────────────────────────
// C22 — REGISTRATION, VERIFIED ATTENDANCE, OUTCOME AND DELIVERABLES for every event kind (wave 148, lane 148H; owner rulings
// 12, 14, 20). The registry (./event-registry.ts) says WHAT each kind requires; this module DOES it, on an injected client:
//
//   registerForEvent          the consented registration (C15 shape → C8 captureConsentedContact: identity + situation + the
//                             creating agent as owner) → ONE open_house_rsvp_tracking row per (event, contact) → for a Zoom event,
//                             the person's own Zoom registrant (ledgered) → the branded confirmation (governed dispatchEmail).
//   recordZoomParticipantEvent a verified Zoom participant join/leave → event_attendance_evidence (idempotent) → identity matched
//                             ONLY by registrant id / exact e-mail of THIS event's registration → presence computed from the
//                             matched pairs → attendance VERIFIED (ledgered) only at the kind's minimum → the attendee row, person
//                             identity, the OPEN_HOUSE_ATTENDEE_CAPTURED fan-out (the arbiter's reader) and — when appropriate —
//                             the agent's follow-up task. An unmatched join is evidence, never anyone's attendance.
//   finalizeEventAttendance   at the meeting's end / the post-event sweep: still-open sessions closed at the end, the remaining
//                             registrants of a VERIFIABLE event marked no_show (never on an unverifiable host), the outcome stored.
//   deliverEventReplay        the promised replay, once per registrant, ONLY when the recording exists (never "delivered" without
//                             the asset), in the approved copy, through the governed dispatcher (consent / suppression / ledger).
//
// Tenant: ALWAYS the event row's brokerage_id (a webhook and a public form never name one). Not server-only: the proof
// (scripts/event-producer-registry-guard.ts) drives it on the in-memory client; heavy rails are lazy imports behind `deps`.

import { createHash } from "node:crypto"
import { fromZonedTime } from "date-fns-tz"
import type { ConsentGrantInput } from "@/lib/contact-pipeline/contact-capture"
import {
  EVENT_PRODUCER_REGISTRY, CONTACT_TYPE_FOR_INTENT,
  attendanceVerdict, attendanceVerifiability, computeAttendanceWindow, eventOutcome, isEventKind, isOnlineEvent,
  matchParticipantIdentity, normalizeEmail, sanitizeEventSituation, shouldNotifyAgent,
  type EventSituation, type RegistrationForMatch,
} from "./event-registry"

type Db = { from: (table: string) => any }

export const EVENT_EVENT_COLUMNS =
  "id, brokerage_id, agent_id, created_by, listing_id, event_type, status, title, description, property_address, event_date, start_time, end_time, timezone, check_in_url, virtual_provider, provider_meeting_id, provider_meta, replay_url, marketing_assets, is_published"

export interface EventRow {
  id: string; brokerage_id: string | null; agent_id: string | null; created_by: string | null; listing_id: string | null
  event_type: string | null; status: string | null; title: string | null; description: string | null; property_address: string | null
  event_date: string | null; start_time: string | null; end_time: string | null; timezone: string | null; check_in_url: string | null
  virtual_provider: string | null; provider_meeting_id: string | null; provider_meta: Record<string, any> | null
  replay_url: string | null; marketing_assets: Record<string, any> | null; is_published: boolean | null
}

const RSVP_COLUMNS = "id, event_id, contact_id, brokerage_id, rsvp_status, registered_at, situation, provider_registrant_id, provider_join_url, attendance_verified_by, attended_seconds, first_joined_at, last_left_at, created_by_user_id"

async function readEvent(svc: Db, eventId: string): Promise<{ event: EventRow | null; error: string | null }> {
  const { data, error } = await svc.from("open_house_events").select(EVENT_EVENT_COLUMNS).eq("id", eventId).maybeSingle()
  if (error) return { event: null, error: error.message ?? "event read refused" }
  return { event: (data as EventRow | null) ?? null, error: null }
}

/**
 * The event's scheduled window as INSTANTS: event_date + start/end wall-clock time read in the EVENT's own timezone (the column
 * defaults to America/New_York) — never the server's zone. Null when the row cannot say.
 */
export function eventWindow(ev: Pick<EventRow, "event_date" | "start_time" | "end_time"> & { timezone?: string | null }): { start: Date | null; end: Date | null } {
  const day = String(ev.event_date ?? "").slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { start: null, end: null }
  const tz = (ev.timezone ?? "").trim() || "America/New_York"
  const at = (t: string | null) => {
    if (!t || !/^\d{2}:\d{2}/.test(t)) return null
    try { const d = fromZonedTime(`${day}T${t.slice(0, 5)}:00`, tz); return Number.isNaN(d.getTime()) ? null : d } catch { return null }
  }
  return { start: at(ev.start_time), end: at(ev.end_time) }
}

// ─── REGISTRATION (C15 → C8) ─────────────────────────────────────────────────

// WAVE 148 (148Z — lane 148H Outside-lane 1, ruling 3 "all forms need to have the same consent boxes"): THE REGISTRATION
// CONSENT IS THE ONE COMPONENT'S. TOMBSTONE: `EventConsentSubmission` ({ serviceDelivery, textReminders, marketing }), the
// `event_registration:v1` version and `eventConsentWording` (three boxes worded here) stood in this spot — a second consent
// vocabulary beside C15. SURVIVOR: lib/kernel/compliance/consent-component.ts (door `event_registration`: service delivery
// REQUIRED — "the event I registered for", purposes requested_information + event_followup, which the phone box covers for
// text reminders; marketing OPTIONAL per channel) rendered by app/components/forms/ConsentBoxes.tsx, re-rendered and hashed
// server-side by lib/contact-pipeline/contact-capture.ts consentGrantsFromComponent with the brand resolveConsentBrand reads.
// The registration page renders the boxes with that same brand, so the words read and the words stored are identical.

export interface RegisterInput {
  eventId: string
  firstName: string
  lastName: string
  email: string
  phone?: string | null
  situation?: Partial<Record<string, unknown>> | null
  /** The ONE consent component's submission exactly as posted (C15) — parsed and re-rendered server-side, never believed. */
  consent: unknown
  /** When the person submitted (the route stamps it). */
  consentCapturedAt?: string | null
  evidence: { ip?: string | null; userAgent?: string | null; sourceUrl?: string | null }
  language?: string | null
}

export type RegisterResult =
  | { ok: true; contactId: string; rsvpId: string; replay: boolean; joinPath: string | null; zoomRegistered: boolean; warnings: string[] }
  | { ok: false; status: number; error: string }

export interface RegisterDeps {
  capture?: (params: any) => Promise<{ ok: boolean; refused?: string; reason?: string; contactId?: string; action?: string; replay?: boolean; consentEventIds: { phone: string | null; email: string | null }; warnings: string[] }>
  addRegistrant?: (svc: Db, args: { hostOwnerType: any; hostOwnerId: string; meetingId: string; email: string; firstName: string; lastName?: string | null }) => Promise<{ added: true; registrantId: string; joinUrl: string } | { added: false; reason: string; detail: string }>
  ledger?: <T>(ctx: any, run: () => Promise<T>, hooks: any, opts?: any) => Promise<T>
  sendEmail?: (p: { brokerageId: string; to: string; contactId: string; subject: string; html: string; text: string; userId?: string; metadata?: Record<string, unknown> }) => Promise<{ success: boolean; error?: string }>
  now?: () => Date
}

// WAVE 149 (149F, ruling 16): TOMBSTONE — `sanitizeSituation` (intent / timeline / agent + a free-text `question` kept verbatim)
// stood here. SURVIVOR: lib/open-house/event-registry.ts sanitizeEventSituation — the kind's OWN closed questions
// (REGISTRATION_QUESTIONS), so a registration can carry only answers that question asked.

/** PURE — the situation in one line for the contact's notes (APPENDED on a merge by C8, never overwritten). */
function situationNote(eventTitle: string, s: EventSituation): string {
  const bits = [
    s.intent ? `intent: ${s.intent}` : null,
    s.timeline ? `timeline: ${s.timeline.replace(/_/g, " ")}` : null,
    s.workingWithAgent === true ? "already working with an agent" : s.workingWithAgent === false ? "not working with an agent" : null,
    s.interests?.length ? `wants covered: ${s.interests.join(", ").replace(/_/g, " ")}` : null,
    s.requests?.length ? `asked the host to: ${s.requests.join(", ").replace(/_/g, " ")}` : null,
    s.guests != null ? `guests: ${s.guests}` : null,
    s.accessibility === true ? "asked about an accessibility accommodation" : null,
  ].filter(Boolean)
  return `Registered for ${eventTitle}${bits.length ? ` — ${bits.join("; ")}` : ""}.`
}

/** The ONE display title (the registration page renders the consent wording from it, and the server hashes the same words). */
export function eventDisplayTitle(ev: Pick<EventRow, "title" | "property_address" | "event_type">): string {
  const label = isEventKind(ev.event_type) ? EVENT_PRODUCER_REGISTRY[ev.event_type].label : "Open house"
  return ev.title?.trim() || (ev.property_address ? `${label} at ${ev.property_address}` : label)
}
const EVENT_LABEL = eventDisplayTitle

export async function registerForEvent(svc: Db, input: RegisterInput, deps: RegisterDeps = {}): Promise<RegisterResult> {
  const now = (deps.now ?? (() => new Date()))()
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID.test(input.eventId)) return { ok: false, status: 404, error: "Event not found" }
  const { event: ev, error } = await readEvent(svc, input.eventId)
  if (error) return { ok: false, status: 500, error: "This event could not be loaded" }
  if (!ev || !ev.brokerage_id || !isEventKind(ev.event_type)) return { ok: false, status: 404, error: "Event not found" }
  const spec = EVENT_PRODUCER_REGISTRY[ev.event_type]
  // The registration door serves the kinds the registry routes to it — a kiosk kind is signed in at the door, not here.
  if (spec.registration.door?.file !== "app/api/open-house/register/route.ts") return { ok: false, status: 404, error: "Event not found" }
  if (!ev.is_published) return { ok: false, status: 404, error: "Registration for this event is not open yet" }
  if (ev.status === "cancelled" || ev.status === "completed") return { ok: false, status: 410, error: "Registration for this event has closed" }

  const firstName = (input.firstName ?? "").trim().slice(0, 80), lastName = (input.lastName ?? "").trim().slice(0, 80)
  const email = normalizeEmail(input.email)
  const phoneDigits = (input.phone ?? "").replace(/\D/g, "")
  if (!firstName || !lastName || !email) return { ok: false, status: 400, error: "First name, last name and a valid email are required" }
  // C15: the submission is parsed strictly and the words are re-rendered HERE from the brand the server reads (THE one brand
  // rule — the event's brokerage, else its agent, else "our brokerage"). No submission, or the required box unticked → refused.
  const { consentGrantsFromComponent, resolveConsentBrand } = await import("@/lib/contact-pipeline/contact-capture")
  const brandName = await resolveConsentBrand(svc as never, { brokerageId: ev.brokerage_id, agentId: ev.agent_id ?? null })
  const c15 = consentGrantsFromComponent(input.consent, { door: "event_registration", brandName, provided: { email: true, phone: phoneDigits.length >= 10 } })
  if (!c15.submission || c15.submission.service_delivery !== true) return { ok: false, status: 400, error: "Please agree to receive your confirmation and join link — it is how you get into the event" }
  const situation = sanitizeEventSituation(ev.event_type, input.situation)
  const title = EVENT_LABEL(ev)
  const consents: ConsentGrantInput[] = c15.grants

  const capture = deps.capture ?? (await import("@/lib/contact-pipeline/contact-capture")).captureConsentedContact
  const intake = await capture({
    brokerageId: ev.brokerage_id,
    // Ruling 12: the registrant is assigned back to the event's creating agent (agents.id); a broker-created event with no
    // agent row falls back to the creating USER (users.id — the capture's own owner hint).
    ownerAgentId: ev.agent_id ?? null,
    ...(ev.agent_id ? {} : { agentUserId: ev.created_by ?? null }),
    source: "event_registration",
    first_name: firstName, last_name: lastName, email, phone: phoneDigits || null,
    // Ruling 3: buyer | seller | both, or nothing — never `prospect` (a platform word). A merge never overwrites a stored type.
    ...(situation.intent ? { contact_type: CONTACT_TYPE_FOR_INTENT[situation.intent] } : {}),
    preferred_channel: "email",
    language: input.language ?? null,
    notes: situationNote(title, situation),
    consents,
    intake: {
      channel: "event_registration",
      capturedAt: input.consentCapturedAt ?? now.toISOString(),
      sourceUrl: input.evidence.sourceUrl ?? `/open-house/${ev.id}/register`,
      evidence: { event_id: ev.id, event_type: ev.event_type, ip: input.evidence.ip ?? null, user_agent: input.evidence.userAgent ?? null, ...c15.evidence, consent_wording_hash: c15.wordingHash, situation },
      formOwner: { table: "open_house_events", id: ev.id },
    },
  })
  if (!intake.ok || !intake.contactId) {
    const status = intake.refused === "not_identifiable" ? 400 : intake.refused === "cross_tenant_form" ? 403 : 500
    return { ok: false, status, error: intake.reason ?? "The registration could not be recorded" }
  }
  const contactId = intake.contactId
  const warnings = [...(intake.warnings ?? [])]

  // ── ONE registration row per (event, contact) — UNIQUE (event_id, contact_id) live ──
  const prior = await svc.from("open_house_rsvp_tracking").select(RSVP_COLUMNS).eq("event_id", ev.id).eq("contact_id", contactId).maybeSingle()
  if (prior.error) return { ok: false, status: 500, error: `registration read refused: ${prior.error.message}` }
  let rsvp = prior.data as Record<string, any> | null
  const replay = !!rsvp?.registered_at
  const regPatch = {
    registered_at: rsvp?.registered_at ?? now.toISOString(),
    situation,
    consent_event_id: intake.consentEventIds?.email ?? rsvp?.consent_event_id ?? null,
    created_by_user_id: rsvp?.created_by_user_id ?? ev.created_by ?? null,
    rsvp_updated_at: now.toISOString(),
  }
  if (rsvp) {
    const keepStatus = rsvp.rsvp_status === "attended" ? "attended" : "yes"
    const { data: upd, error: updErr } = await svc.from("open_house_rsvp_tracking").update({ ...regPatch, rsvp_status: keepStatus })
      .eq("id", rsvp.id).eq("brokerage_id", ev.brokerage_id).select(RSVP_COLUMNS)
    if (updErr || !Array.isArray(upd) || upd.length !== 1) return { ok: false, status: 500, error: `registration not recorded: ${updErr?.message ?? "matched no row"}` }
    rsvp = upd[0]
  } else {
    const { data: ins, error: insErr } = await svc.from("open_house_rsvp_tracking").insert({
      event_id: ev.id, contact_id: contactId, brokerage_id: ev.brokerage_id, rsvp_status: "yes", source: "web_registration", ...regPatch,
    }).select(RSVP_COLUMNS).maybeSingle()
    if (insErr?.code === "23505") {
      const again = await svc.from("open_house_rsvp_tracking").select(RSVP_COLUMNS).eq("event_id", ev.id).eq("contact_id", contactId).maybeSingle()
      rsvp = again.data ?? null
    } else if (insErr || !ins) return { ok: false, status: 500, error: `registration not recorded: ${insErr?.message ?? "no row"}` }
    else rsvp = ins
  }
  if (!rsvp?.id) return { ok: false, status: 500, error: "registration not recorded" }

  // ── The person's own Zoom registrant (the key attendance is verified on) — ledgered, once per registration ──
  let zoomRegistered = !!rsvp.provider_registrant_id
  const meta = (ev.provider_meta ?? {}) as Record<string, any>
  if (ev.virtual_provider === "zoom" && ev.provider_meeting_id && !zoomRegistered) {
    if (meta.registration_enabled !== true) {
      warnings.push("Zoom registration is not enabled on this meeting (Zoom answered approval_type 2) — this registrant's attendance can be verified only if they join signed in with the same email")
    } else if (!meta.host_owner_type || !meta.host_owner_id) {
      warnings.push("the event does not record which Zoom account hosts it — no personal Zoom link was minted")
    } else {
      const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
      const addRegistrant = deps.addRegistrant ?? (await import("@/lib/connections/zoom")).addZoomMeetingRegistrant
      const rsvpId = rsvp.id as string
      const outcome = await ledger(
        {
          brokerageId: ev.brokerage_id, action: "open_house.zoom_registrant.add",
          actor: { type: "system", userId: null }, subject: { type: "open_house_rsvp", id: rsvpId }, cycle: ev.provider_meeting_id,
          reasonCode: "CONVERSATION_RESPONSE", reasonDetail: "the person registered for the event on its consented form",
          channel: "zoom", systemSource: "event_registration", detail: { event_id: ev.id, provider: "zoom" },
        },
        () => addRegistrant(svc as never, { hostOwnerType: meta.host_owner_type, hostOwnerId: String(meta.host_owner_id), meetingId: String(ev.provider_meeting_id), email, firstName, lastName }),
        {
          settle: (r: any) => (r.added ? { status: "executed", outcome: "zoom_registrant_added", provider: "zoom", providerRef: r.registrantId } : { status: "failed", outcome: r.reason, provider: "zoom", error: r.detail }),
          replay: (claim: any) => (claim.kind === "refused" ? { added: false, reason: "ledger_refused", detail: `the action ledger refused: ${claim.error}` } : { added: false, reason: "replayed", detail: "already attempted for this registration" }),
        },
      ) as { added: boolean; registrantId?: string; joinUrl?: string; reason?: string; detail?: string }
      if (outcome.added && outcome.registrantId && typeof outcome.joinUrl === "string" && outcome.joinUrl.startsWith("https://")) {
        const { data: z, error: zErr } = await svc.from("open_house_rsvp_tracking").update({ provider_registrant_id: outcome.registrantId, provider_join_url: outcome.joinUrl })
          .eq("id", rsvpId).eq("brokerage_id", ev.brokerage_id).select("id")
        if (zErr || !Array.isArray(z) || z.length !== 1) warnings.push(`the Zoom registrant was added but not stored: ${zErr?.message ?? "matched no row"}`)
        else zoomRegistered = true
      } else if (!outcome.added) warnings.push(`no personal Zoom link: ${outcome.detail ?? outcome.reason}`)
    }
  }

  const joinPath = isOnlineEvent(ev.event_type, ev.virtual_provider) ? `/open-house/${ev.id}/join?r=${rsvp.id}` : null

  // ── The branded confirmation (service delivery the person just asked for) — only for a NEW registration ──
  if (!replay) {
    const copy = renderEventCopy(ev, "confirmation", { firstName, joinLink: joinPath ? absoluteUrl(joinPath) : null })
    if (!copy) warnings.push("no approved confirmation copy on the event — the confirmation was not sent (the page shows the join link)")
    else {
      const send = deps.sendEmail ?? defaultSendEmail
      const r = await send({ brokerageId: ev.brokerage_id, to: email, contactId, subject: copy.subject, html: copy.html, text: copy.text, metadata: { event_id: ev.id, kind: "event_registration_confirmation" } })
      if (!r.success) warnings.push(`the confirmation email did not send: ${r.error ?? "unknown"}`)
    }
  }
  return { ok: true, contactId, rsvpId: rsvp.id as string, replay, joinPath, zoomRegistered, warnings }
}

// ─── COPY (AI-drafted, human-approved — lib/open-house/event-marketing.ts) ────

/** The app's public origin, or null (never the literal "undefined/…"). */
export function absoluteUrl(path: string): string | null {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
  return base ? `${base}${path}` : null
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * Fill APPROVED copy with facts (deterministic: the model wrote the words, the code supplies the date, the link and the name).
 * Null when the event carries no approved copy for this touchpoint — nothing static stands in for the approved words.
 */
type EventTouchpoint = "confirmation" | "reminder" | "replay_attended" | "replay_missed" | "handout"

/** @proofSeam lib/open-house/event-touches.ts renders the arbiter-released reminder through this same filler */
export function renderEventCopy(
  ev: Pick<EventRow, "marketing_assets" | "title" | "event_date" | "start_time" | "end_time" | "timezone" | "property_address" | "event_type">,
  touchpoint: EventTouchpoint,
  facts: { firstName: string; joinLink?: string | null; replayLink?: string | null; handoutLink?: string | null },
): { subject: string; text: string; html: string } | null {
  const m = (ev.marketing_assets ?? {}) as Record<string, any>
  if (m.status !== "approved") return null
  const d = (m.approved ?? m.draft ?? {}) as Record<string, string>
  const subject = d[`${touchpoint}_subject`], body = d[`${touchpoint}_body`]
  if (typeof subject !== "string" || typeof body !== "string" || !subject.trim() || !body.trim()) return null
  if ((touchpoint === "confirmation" || touchpoint === "reminder") && body.includes("{{join_link}}") && !facts.joinLink && isOnlineEvent(ev.event_type, null)) return null
  if ((touchpoint === "replay_attended" || touchpoint === "replay_missed") && !facts.replayLink) return null
  if (touchpoint === "handout" && !facts.handoutLink) return null
  const when = [ev.event_date ? new Date(`${String(ev.event_date).slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : null, ev.start_time ? `${String(ev.start_time).slice(0, 5)}${ev.end_time ? `–${String(ev.end_time).slice(0, 5)}` : ""}` : null, ev.timezone ?? null].filter(Boolean).join(" · ")
  const fill = (s: string) => s
    .replace(/\{\{first_name\}\}/g, facts.firstName || "there")
    .replace(/\{\{event_title\}\}/g, ev.title?.trim() || ev.property_address || "the event")
    .replace(/\{\{date_time\}\}/g, when || "the scheduled time")
    .replace(/\{\{join_link\}\}/g, facts.joinLink ?? "")
    .replace(/\{\{replay_link\}\}/g, facts.replayLink ?? "")
    .replace(/\{\{handout_link\}\}/g, facts.handoutLink ?? "")
  const text = fill(body)
  return { subject: fill(subject).slice(0, 180), text, html: `<div style="font-family:system-ui,sans-serif;line-height:1.55">${esc(text).replace(/\n/g, "<br/>").replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div>` }
}

async function defaultSendEmail(p: { brokerageId: string; to: string; contactId: string; subject: string; html: string; text: string; metadata?: Record<string, unknown> }): Promise<{ success: boolean; error?: string }> {
  const { dispatchEmail } = await import("@/lib/providers/dispatch")
  const kind = String(p.metadata?.kind ?? "event_service_notice")
  // WHY: service delivery the person asked for (their confirmation / the promised recording) — at most once per registration
  // per touchpoint (the cycle names both), on the governed dispatcher's consent / suppression gates.
  const cycle = `${kind}:${String(p.metadata?.rsvp_id ?? p.contactId)}:${String(p.metadata?.event_id ?? "")}`
  const r = await dispatchEmail({
    brokerageId: p.brokerageId, to: p.to, contactId: p.contactId, subject: p.subject, html: p.html, text: p.text,
    channelPurpose: "transactional", systemSource: "event_registration", metadata: p.metadata,
    ledger: { reasonCode: "SERVICE_NOTICE", reasonDetail: kind, cycle },
  })
  return { success: !!r.success, error: r.error }
}

// ─── ZOOM PARTICIPANT → VERIFIED ATTENDANCE ──────────────────────────────────

export interface AttendanceDeps {
  ledger?: RegisterDeps["ledger"]
  linkIdentity?: (svc: Db, input: { brokerageId: string; contactId: string; attendeeId: string; eventId: string; firstName: string; lastName?: string | null; email?: string | null; phone?: string | null; source: string }) => Promise<unknown>
  emit?: (p: { event: any; brokerageId: string; entityType: string; entityId: string; contactId?: string; metadata?: Record<string, unknown> }) => Promise<unknown>
  notifyAgent?: (p: { contact_id: string; attendee_id: string; agent_id: string; brokerage_id: string; open_house_id: string; first_name: string; email?: string; interest_level: number }) => Promise<{ success: boolean; error?: string }>
}

export type ParticipantResult =
  | { handled: false; reason: string }
  | { handled: true; replay?: boolean; match: string; contactId: string | null; attended: boolean; seconds?: number; reason: string; agentNotified?: boolean }

const dedupeKey = (parts: Array<string | null | undefined>) => createHash("sha256").update(parts.map((p) => p ?? "").join("|")).digest("hex").slice(0, 48)

export async function recordZoomParticipantEvent(svc: Db, payload: unknown, deps: AttendanceDeps = {}): Promise<ParticipantResult> {
  const { parseZoomParticipantEvent } = await import("@/lib/connections/zoom")
  const p = parseZoomParticipantEvent(payload)
  if (!p) return { handled: false, reason: "not a participant join/leave with a meeting id and a time" }
  const { data: evRow, error: evErr } = await svc.from("open_house_events").select(EVENT_EVENT_COLUMNS).eq("virtual_provider", "zoom").eq("provider_meeting_id", p.meetingId).maybeSingle()
  if (evErr) return { handled: false, reason: `event read refused: ${evErr.message}` }
  const ev = evRow as EventRow | null
  if (!ev || !ev.brokerage_id) return { handled: false, reason: `no event is hosted on Zoom meeting ${p.meetingId} (an appointment meeting, or not ours)` }

  const regs = await loadRegistrations(svc, ev)
  if (regs.error) return { handled: false, reason: regs.error }
  const who = matchParticipantIdentity(
    { registrantId: p.registrantId, email: p.email, accountUserId: p.accountUserId, sessionUserId: p.sessionUserId, displayName: p.displayName },
    regs.forMatch, { hostId: p.hostId },
  )
  const row = {
    brokerage_id: ev.brokerage_id, event_id: ev.id, contact_id: who.contactId, provider: "zoom", provider_event: p.kind,
    provider_meeting_uuid: p.meetingUuid, participant_key: p.participantKey, registrant_id: p.registrantId,
    email_normalized: normalizeEmail(p.email), identity_match: who.match, occurred_at: p.at, leave_reason: p.leaveReason,
    dedupe_key: dedupeKey(["zoom", p.meetingUuid ?? p.meetingId, p.kind, p.participantKey ?? p.registrantId ?? p.email ?? p.displayName, p.at]),
  }
  // THE DEDUPE KEY IS READ BEFORE IT IS WRITTEN: Zoom redelivers a webhook it did not hear an ack for; a key already on file is a
  // replay and is answered without a second insert (the UNIQUE index below stays the race net for two deliveries in flight).
  const dup = await svc.from("event_attendance_evidence").select("id").eq("event_id", ev.id).eq("dedupe_key", row.dedupe_key).maybeSingle()
  if (dup.error) return { handled: false, reason: `evidence read refused: ${dup.error.message}` }
  if (dup.data) return { handled: true, replay: true, match: who.match, contactId: who.contactId, attended: false, reason: "already recorded (Zoom redelivery)" }
  const ins = await svc.from("event_attendance_evidence").insert(row).select("id").maybeSingle()
  if (ins.error) {
    if (ins.error.code === "23505") return { handled: true, replay: true, match: who.match, contactId: who.contactId, attended: false, reason: "already recorded (Zoom redelivery)" }
    return { handled: false, reason: `evidence not recorded: ${ins.error.message}` }
  }
  if (!who.contactId) return { handled: true, match: who.match, contactId: null, attended: false, reason: `${who.match}: ${who.reason} — recorded as evidence, never attendance` }
  const r = await recomputeAttendance(svc, ev, who.contactId, regs, null, deps)
  return { handled: true, match: who.match, contactId: who.contactId, attended: r.attended, seconds: r.seconds, reason: r.reason, agentNotified: r.agentNotified }
}

interface LoadedRegistrations { forMatch: RegistrationForMatch[]; byContact: Map<string, Record<string, any>>; emails: Map<string, string>; names: Map<string, { first: string; last: string }>; error: string | null }

async function loadRegistrations(svc: Db, ev: EventRow): Promise<LoadedRegistrations> {
  const empty: LoadedRegistrations = { forMatch: [], byContact: new Map(), emails: new Map(), names: new Map(), error: null }
  const { data, error } = await svc.from("open_house_rsvp_tracking").select(RSVP_COLUMNS).eq("event_id", ev.id).eq("brokerage_id", ev.brokerage_id)
  if (error) return { ...empty, error: `registrations read refused: ${error.message}` }
  const rows = ((data ?? []) as Array<Record<string, any>>).filter((r) => !!r.registered_at && !!r.contact_id)
  if (!rows.length) return empty
  const ids = rows.map((r) => r.contact_id as string)
  const { data: cs, error: cErr } = await svc.from("contacts").select("id, email, first_name, last_name").in("id", ids).eq("brokerage_id", ev.brokerage_id)
  if (cErr) return { ...empty, error: `registrant contacts read refused: ${cErr.message}` }
  const emails = new Map<string, string>(), names = new Map<string, { first: string; last: string }>()
  for (const c of (cs ?? []) as Array<Record<string, any>>) { if (c.email) emails.set(c.id, c.email); names.set(c.id, { first: c.first_name ?? "", last: c.last_name ?? "" }) }
  return {
    forMatch: rows.map((r) => ({ contactId: r.contact_id, providerRegistrantId: r.provider_registrant_id ?? null, email: emails.get(r.contact_id) ?? null })),
    byContact: new Map(rows.map((r) => [r.contact_id as string, r])), emails, names, error: null,
  }
}

async function recomputeAttendance(
  svc: Db, ev: EventRow, contactId: string, regs: LoadedRegistrations, closeAt: string | null, deps: AttendanceDeps,
): Promise<{ attended: boolean; seconds: number; reason: string; agentNotified?: boolean }> {
  const rsvp = regs.byContact.get(contactId)
  if (!rsvp) return { attended: false, seconds: 0, reason: "no registration row" }
  // Only the verifiable host's evidence pairs into presence: provider = zoom. A YouTube watch_link_opened row for the same
  // person is evidence of a click, never of attendance (the census reads the provider column for exactly this filter).
  const { data: evs, error } = await svc.from("event_attendance_evidence").select("provider_event, occurred_at, participant_key, provider_meeting_uuid, leave_reason")
    .eq("event_id", ev.id).eq("contact_id", contactId).eq("provider", "zoom")
  if (error) return { attended: false, seconds: 0, reason: `evidence read refused: ${error.message}` }
  const rows = (evs ?? []) as Array<Record<string, any>>
  // A join is closed only by a leave from the SAME meeting instance: a re-started or recurring Zoom meeting keeps its meeting id
  // and mints a new uuid, so the pairing key is instance + participant (provider_meeting_uuid is read for exactly this).
  const window = computeAttendanceWindow(rows
    .filter((e) => e.provider_event === "participant_joined" || e.provider_event === "participant_left")
    .map((e) => ({ kind: e.provider_event, at: e.occurred_at, participantKey: `${e.provider_meeting_uuid ?? "-"}:${e.participant_key ?? "_"}` })), closeAt)
  // The last reason Zoom gave for a leave rides the verdict — "dropped by the network" and "left the meeting" are different
  // facts for the agent who reads the attendance line.
  const lastLeaveReason: string | null = rows
    .filter((e) => e.provider_event === "participant_left" && typeof e.leave_reason === "string" && e.leave_reason.length)
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)).pop()?.leave_reason ?? null
  const withLeave = (reason: string) => (lastLeaveReason ? `${reason} (last leave: ${lastLeaveReason.slice(0, 80)})` : reason)
  const verdict = attendanceVerdict({ kind: ev.event_type ?? "", provider: ev.virtual_provider, matched: true, seconds: window.seconds })
  const progress = { first_joined_at: window.firstJoinedAt, last_left_at: window.lastLeftAt, attended_seconds: window.seconds }
  if (rsvp.attendance_verified_by || !verdict.attended) {
    const { error: pErr } = await svc.from("open_house_rsvp_tracking").update(progress).eq("id", rsvp.id).eq("brokerage_id", ev.brokerage_id)
    if (pErr) console.warn("[event-attendance] presence progress not stored:", pErr.message)
    if (rsvp.attendance_verified_by) await syncAttendeeDeparture(svc, ev, contactId, window.lastLeftAt)
    return { attended: !!rsvp.attendance_verified_by, seconds: window.seconds, reason: withLeave(rsvp.attendance_verified_by ? "already verified — presence updated" : verdict.reason) }
  }
  const out = await verifyAttendance(svc, ev, contactId, rsvp, regs, window, deps)
  return { attended: out.verified, seconds: window.seconds, reason: withLeave(out.verified ? verdict.reason : out.reason), agentNotified: out.agentNotified }
}

async function syncAttendeeDeparture(svc: Db, ev: EventRow, contactId: string, lastLeftAt: string | null): Promise<void> {
  if (!lastLeftAt) return
  const { error } = await svc.from("open_house_attendees").update({ departure_time: lastLeftAt }).eq("event_id", ev.id).eq("contact_id", contactId).eq("brokerage_id", ev.brokerage_id)
  if (error) console.warn("[event-attendance] attendee departure not stored:", error.message)
}

/** The consequential act: a registrant's attendance becomes a verified fact (and the follow-up it triggers). Ledgered, once. */
async function verifyAttendance(
  svc: Db, ev: EventRow, contactId: string, rsvp: Record<string, any>, regs: LoadedRegistrations,
  window: { firstJoinedAt: string | null; lastLeftAt: string | null; seconds: number }, deps: AttendanceDeps,
): Promise<{ verified: boolean; reason: string; agentNotified?: boolean }> {
  const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
  const brokerageId = ev.brokerage_id as string
  return ledger(
    {
      brokerageId, action: "open_house.attendance.verify", actor: { type: "system", userId: null },
      subject: { type: "open_house_rsvp", id: rsvp.id }, cycle: "verified",
      reasonCode: "CONVERSATION_RESPONSE", reasonDetail: `verified online attendance (${window.seconds}s present, identified through this event's registration)`,
      channel: "zoom", systemSource: "zoom_participant_webhook", detail: { event_id: ev.id, contact_id: contactId, seconds: window.seconds },
    },
    async () => {
      const { data: upd, error: uErr } = await svc.from("open_house_rsvp_tracking").update({
        rsvp_status: "attended", attendance_verified_by: "zoom_participant", rsvp_updated_at: new Date().toISOString(),
        first_joined_at: window.firstJoinedAt, last_left_at: window.lastLeftAt, attended_seconds: window.seconds,
      }).eq("id", rsvp.id).eq("brokerage_id", brokerageId).select("id")
      if (uErr || !Array.isArray(upd) || upd.length !== 1) return { verified: false, reason: `attendance not recorded: ${uErr?.message ?? "matched no row"}` }
      const name = regs.names.get(contactId) ?? { first: "", last: "" }
      const email = regs.emails.get(contactId) ?? null
      let attendeeId: string | null = null
      const att = await svc.from("open_house_attendees").insert({
        event_id: ev.id, contact_id: contactId, brokerage_id: brokerageId, name: `${name.first} ${name.last}`.trim() || null, email,
        check_in_time: window.firstJoinedAt, arrival_time: window.firstJoinedAt, departure_time: window.lastLeftAt, tcpa_consent: false,
        notes: `Verified online attendance — Zoom participant webhook, ${Math.round(window.seconds / 60)} min present`,
      }).select("id").maybeSingle()
      if (att.error?.code === "23505") {
        const ex = await svc.from("open_house_attendees").select("id").eq("event_id", ev.id).eq("contact_id", contactId).maybeSingle()
        attendeeId = (ex.data as { id?: string } | null)?.id ?? null
      } else if (att.error) console.warn("[event-attendance] attendee row not filed:", att.error.message)
      else attendeeId = (att.data as { id?: string } | null)?.id ?? null
      if (attendeeId) {
        // THE ONE check-in identity helper every door uses (lib/open-house/instant-greeting.ts) — a seam only for the proof.
        const linkIdentity = deps.linkIdentity ?? (async (s: Db, i: Parameters<NonNullable<AttendanceDeps["linkIdentity"]>>[1]) => (await import("@/lib/open-house/instant-greeting")).linkOpenHouseCheckInIdentity(s, i))
        await linkIdentity(svc, { brokerageId, contactId, attendeeId, eventId: ev.id, firstName: name.first, lastName: name.last, email, phone: null, source: "event_zoom_attendance" })
      }
      const emit = deps.emit ?? (async (q: Parameters<NonNullable<AttendanceDeps["emit"]>>[0]) => (await import("@/lib/kernel/notification-engine")).processKernelEvent(q as never))
      const { KernelEvent } = await import("@/lib/kernel/events")
      try {
        await emit({ event: KernelEvent.OPEN_HOUSE_ATTENDEE_CAPTURED, brokerageId, entityType: ev.listing_id ? "listing_stage_machine" : "open_house", entityId: ev.listing_id ?? ev.id, contactId,
          metadata: { contactId, eventId: ev.id, attendeeId, verified_by: "zoom_participant", event_type: ev.event_type, attended_seconds: window.seconds } })
      } catch (e) { console.warn("[event-attendance] capture fan-out failed (attendance stands):", e instanceof Error ? e.message : String(e)) }
      // When appropriate — never for a click, and only when the agent has something to act on.
      const { start, end } = eventWindow(ev)
      const scheduled = start && end && end > start ? (end.getTime() - start.getTime()) / 1000 : null
      const decision = shouldNotifyAgent({ verified: true, engagementRatio: scheduled ? Math.min(1, window.seconds / scheduled) : null, situation: (rsvp.situation ?? null) as Partial<EventSituation> | null, audience: EVENT_PRODUCER_REGISTRY[ev.event_type as keyof typeof EVENT_PRODUCER_REGISTRY]?.audience ?? "consumer" })
      let agentNotified = false
      if (decision.notify && ev.agent_id && attendeeId) {
        const notify = deps.notifyAgent ?? (await import("@/lib/kernel/open-house")).notifyAssignedAgentForOpenHouseLead
        const r = await notify({ contact_id: contactId, attendee_id: attendeeId, agent_id: ev.agent_id, brokerage_id: brokerageId, open_house_id: ev.id, first_name: name.first || "A registrant", email: email ?? undefined, interest_level: 4 })
        agentNotified = r.success
        if (!r.success) console.warn("[event-attendance] agent follow-up task not queued:", r.error)
      }
      return { verified: true, reason: decision.reason, agentNotified }
    },
    {
      settle: (r: { verified: boolean; reason: string }) => (r.verified ? { status: "executed", outcome: "attendance_verified", provider: "zoom" } : { status: "failed", outcome: "attendance_not_recorded", error: r.reason }),
      replay: (claim: { kind: string; error?: string }) => (claim.kind === "refused" ? { verified: false, reason: `the action ledger refused: ${claim.error}` } : { verified: true, reason: "already verified (replay)" }),
    },
  )
}

// ─── FINALIZE: close sessions, no-shows on a verifiable event, the outcome ───

export interface FinalizeResult { finalized: boolean; reason: string; outcome?: ReturnType<typeof eventOutcome>; noShowsMarked?: number; verifiedNow?: number }

export async function finalizeEventAttendance(svc: Db, eventId: string, deps: AttendanceDeps & { now?: () => Date } = {}): Promise<FinalizeResult> {
  const { event: ev, error } = await readEvent(svc, eventId)
  if (error) return { finalized: false, reason: error }
  if (!ev || !ev.brokerage_id || !isEventKind(ev.event_type)) return { finalized: false, reason: "event not found" }
  if (!isOnlineEvent(ev.event_type, ev.virtual_provider)) return { finalized: false, reason: "in-person event — attendance was taken at the sign-in" }
  const regs = await loadRegistrations(svc, ev)
  if (regs.error) return { finalized: false, reason: regs.error }
  const verifiability = attendanceVerifiability(ev.event_type, ev.virtual_provider)
  let noShowsMarked = 0, verifiedNow = 0
  if (verifiability === "verified") {
    const { data: ended } = await svc.from("event_attendance_evidence").select("occurred_at").eq("event_id", ev.id).eq("provider_event", "meeting_ended").order("occurred_at", { ascending: false }).limit(1)
    const closeAt = ((ended ?? []) as Array<{ occurred_at?: string }>)[0]?.occurred_at ?? eventWindow(ev).end?.toISOString() ?? null
    for (const [contactId, rsvp] of regs.byContact) {
      if (rsvp.attendance_verified_by) continue
      const r = await recomputeAttendance(svc, ev, contactId, regs, closeAt, deps)
      if (r.attended) { verifiedNow++; continue }
      if (["yes", "invited", "maybe"].includes(String(rsvp.rsvp_status))) {
        const { data: ns, error: nsErr } = await svc.from("open_house_rsvp_tracking").update({ rsvp_status: "no_show", rsvp_updated_at: (deps.now ?? (() => new Date()))().toISOString() })
          .eq("id", rsvp.id).eq("brokerage_id", ev.brokerage_id).select("id")
        if (!nsErr && Array.isArray(ns) && ns.length === 1) noShowsMarked++
        else console.warn("[event-attendance] no-show not recorded:", nsErr?.message ?? "matched no row")
      }
    }
  }
  const { data: fresh } = await svc.from("open_house_rsvp_tracking").select("rsvp_status, attendance_verified_by, registered_at").eq("event_id", ev.id).eq("brokerage_id", ev.brokerage_id)
  // Unmatched joins are read WITH their normalised e-mail: an e-mail Zoom reported that matched no registrant is the one fact an
  // agent can reconcile by hand (a registrant who joined under another address) — the outcome carries the count, never the addresses.
  const { data: anon } = await svc.from("event_attendance_evidence").select("participant_key, email_normalized, registrant_id").eq("event_id", ev.id).eq("identity_match", "unmatched").eq("provider_event", "participant_joined")
  const outcome = eventOutcome({ kind: ev.event_type, provider: ev.virtual_provider, rsvps: (fresh ?? []) as never[], unmatchedJoins: new Set(((anon ?? []) as Array<{ participant_key?: string | null }>).map((a, i) => a.participant_key ?? `anon-${i}`)).size })
  const anonRows = (anon ?? []) as Array<{ email_normalized?: string | null; registrant_id?: string | null }>
  const unmatchedWithEmail = new Set(anonRows.map((a) => a.email_normalized).filter((e): e is string => !!e)).size
  // A registrant id our registration form never minted (a Zoom-side registration outside the OS) is its own count: the agent
  // reconciles those against the Zoom registrant list, not against the CRM.
  const unmatchedWithForeignRegistrantId = new Set(anonRows.map((a) => a.registrant_id).filter((r): r is string => !!r)).size
  const meta = { ...((ev.provider_meta ?? {}) as Record<string, unknown>), attendance_outcome: { ...outcome, unmatched_with_email: unmatchedWithEmail, unmatched_with_foreign_registrant_id: unmatchedWithForeignRegistrantId, computed_at: new Date().toISOString() } }
  const { error: oErr } = await svc.from("open_house_events").update({ provider_meta: meta }).eq("id", ev.id).eq("brokerage_id", ev.brokerage_id)
  if (oErr) console.warn("[event-attendance] outcome not stored on the event:", oErr.message)
  return { finalized: true, reason: verifiability === "verified" ? "verifiable host — no-shows marked" : `${ev.virtual_provider ?? "this host"} cannot verify attendance — no one is marked a no-show`, outcome, noShowsMarked, verifiedNow }
}

/** Zoom meeting.ended → the matching event's meeting_ended evidence (idempotent) + finalize. */
export async function recordZoomMeetingEnded(svc: Db, payload: unknown, deps: AttendanceDeps = {}): Promise<FinalizeResult | { finalized: false; reason: string }> {
  const obj = ((payload as { payload?: { object?: Record<string, any> } } | null)?.payload?.object ?? {}) as Record<string, any>
  const meetingId = obj.id != null ? String(obj.id) : null
  const endedAt = typeof obj.end_time === "string" && !Number.isNaN(Date.parse(obj.end_time)) ? new Date(obj.end_time).toISOString() : null
  if (!meetingId || !endedAt) return { finalized: false, reason: "meeting.ended without a meeting id and end time" }
  const { data: ev, error } = await svc.from("open_house_events").select("id, brokerage_id").eq("virtual_provider", "zoom").eq("provider_meeting_id", meetingId).maybeSingle()
  if (error) return { finalized: false, reason: `event read refused: ${error.message}` }
  if (!ev?.brokerage_id) return { finalized: false, reason: `no event is hosted on Zoom meeting ${meetingId}` }
  const ins = await svc.from("event_attendance_evidence").insert({
    brokerage_id: ev.brokerage_id, event_id: ev.id, contact_id: null, provider: "zoom", provider_event: "meeting_ended",
    provider_meeting_uuid: obj.uuid ? String(obj.uuid) : null, identity_match: "host", occurred_at: endedAt, dedupe_key: dedupeKey(["zoom", obj.uuid ?? meetingId, "meeting_ended", endedAt]),
  }).select("id").maybeSingle()
  if (ins.error && ins.error.code !== "23505") return { finalized: false, reason: `meeting end not recorded: ${ins.error.message}` }
  return finalizeEventAttendance(svc, ev.id, deps)
}

// ─── THE PROMISED REPLAY ─────────────────────────────────────────────────────

export interface ReplayDeliveryResult { delivered: number; skipped: number; reason: string; errors: string[] }

/**
 * Deliver the replay every registration was promised — ONLY once the recording exists (replay_url, https) and the approved copy
 * exists for the touchpoint; once per registration (the dispatcher's ledger cycle keys on the rsvp id), through dispatchEmail's
 * consent / suppression gates. An attendee gets the "thanks for joining" words, a no-show the "sorry we missed you" words.
 */
export async function deliverEventReplay(svc: Db, eventId: string, deps: { sendEmail?: RegisterDeps["sendEmail"]; ledger?: RegisterDeps["ledger"] } = {}): Promise<ReplayDeliveryResult> {
  const { event: ev, error } = await readEvent(svc, eventId)
  if (error || !ev?.brokerage_id) return { delivered: 0, skipped: 0, reason: error ?? "event not found", errors: [] }
  if (!isEventKind(ev.event_type) || !EVENT_PRODUCER_REGISTRY[ev.event_type].deliverables.includes("replay_recording")) return { delivered: 0, skipped: 0, reason: "this kind promises no replay", errors: [] }
  if (!ev.replay_url || !/^https:\/\//.test(ev.replay_url)) return { delivered: 0, skipped: 0, reason: "no recording yet — nothing is sent until it exists", errors: [] }
  const regs = await loadRegistrations(svc, ev)
  if (regs.error) return { delivered: 0, skipped: 0, reason: regs.error, errors: [] }
  const send = deps.sendEmail ?? defaultSendEmail
  const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
  let delivered = 0, skipped = 0
  const errors: string[] = []
  for (const [contactId, rsvp] of regs.byContact) {
    const email = regs.emails.get(contactId)
    if (!email) { skipped++; continue }
    const touch = rsvp.rsvp_status === "attended" ? "replay_attended" : "replay_missed"
    const copy = renderEventCopy(ev, touch, { firstName: regs.names.get(contactId)?.first ?? "", replayLink: ev.replay_url })
    if (!copy) { skipped++; continue }
    // ONCE per registration: the ledger's cycle is the replay itself, so a second sweep / a re-saved replay link re-reads, never re-sends.
    const r = await ledger(
      {
        brokerageId: ev.brokerage_id, action: "open_house.replay.deliver", actor: { type: "system", userId: null },
        subject: { type: "open_house_rsvp", id: rsvp.id }, cycle: "replay", channel: "email",
        reasonCode: "SERVICE_NOTICE", reasonDetail: `the recording the registration was promised (${touch})`, systemSource: "event_replay",
        detail: { event_id: ev.id, contact_id: contactId, touchpoint: touch },
      },
      () => send({ brokerageId: ev.brokerage_id as string, to: email, contactId, subject: copy.subject, html: copy.html, text: copy.text, metadata: { event_id: ev.id, rsvp_id: rsvp.id, kind: `event_${touch}` } }),
      {
        settle: (s: { success: boolean; error?: string }) => (s.success ? { status: "executed", outcome: "replay_sent", provider: "email" } : { status: "failed", outcome: "replay_not_sent", error: s.error ?? null }),
        replay: (claim: { kind: string; error?: string }) => (claim.kind === "refused" ? { success: false, error: `the action ledger refused: ${claim.error}` } : { success: false, error: "already delivered" }),
      },
    ) as { success: boolean; error?: string }
    if (r.success) delivered++
    else if (r.error === "already delivered") skipped++
    else errors.push(`${contactId}: ${r.error ?? "not sent"}`)
  }
  return { delivered, skipped, reason: "sent where a recording, approved copy and an e-mail all exist", errors }
}

// ─── THE PROMISED SESSION HANDOUT (wave 149, lane 149F — lane 148H Still open 3) ─────────────────────────────────────────
//
// The registry declared `session_handout` on webinars and education sessions with NO delivery path. It now has the replay's:
// nothing is sent until the handout EXISTS (open_house_events.handout_url, https — m948; set by setEventHandout), then ONCE per
// registration in the APPROVED handout words (event-marketing.ts handout_subject / handout_body, {{handout_link}}), through the
// governed dispatcher's consent / suppression gates, ledgered `open_house.handout.deliver`. Before m948 is applied the column is
// absent: the read refuses and NOTHING is sent (said in the reason) — never a handout "delivered" without the asset.

/** One event's handout link, read on its own (the column is m948's; absent → refused, never guessed). */
async function readHandoutUrl(svc: Db, ev: EventRow): Promise<{ url: string | null; error: string | null }> {
  const { data, error } = await svc.from("open_house_events").select("handout_url").eq("id", ev.id).eq("brokerage_id", ev.brokerage_id).maybeSingle()
  if (error) return { url: null, error: `handout link unreadable (${error.message}) — m948 may not be applied yet` }
  const url = (data as { handout_url?: string | null } | null)?.handout_url ?? null
  return { url: url && /^https:\/\//.test(url) ? url : null, error: null }
}

export async function deliverEventHandout(svc: Db, eventId: string, deps: { sendEmail?: RegisterDeps["sendEmail"]; ledger?: RegisterDeps["ledger"] } = {}): Promise<ReplayDeliveryResult> {
  const { event: ev, error } = await readEvent(svc, eventId)
  if (error || !ev?.brokerage_id) return { delivered: 0, skipped: 0, reason: error ?? "event not found", errors: [] }
  if (!isEventKind(ev.event_type) || !EVENT_PRODUCER_REGISTRY[ev.event_type].deliverables.includes("session_handout")) return { delivered: 0, skipped: 0, reason: "this kind promises no handout", errors: [] }
  const h = await readHandoutUrl(svc, ev)
  if (h.error) return { delivered: 0, skipped: 0, reason: h.error, errors: [] }
  if (!h.url) return { delivered: 0, skipped: 0, reason: "no handout yet — nothing is sent until it exists", errors: [] }
  const regs = await loadRegistrations(svc, ev)
  if (regs.error) return { delivered: 0, skipped: 0, reason: regs.error, errors: [] }
  const send = deps.sendEmail ?? defaultSendEmail
  const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
  let delivered = 0, skipped = 0
  const errors: string[] = []
  for (const [contactId, rsvp] of regs.byContact) {
    const email = regs.emails.get(contactId)
    if (!email) { skipped++; continue }
    const copy = renderEventCopy(ev, "handout", { firstName: regs.names.get(contactId)?.first ?? "", handoutLink: h.url })
    if (!copy) { skipped++; continue }
    const r = await ledger(
      {
        brokerageId: ev.brokerage_id, action: "open_house.handout.deliver", actor: { type: "system", userId: null },
        subject: { type: "open_house_rsvp", id: rsvp.id }, cycle: "handout", channel: "email",
        reasonCode: "SERVICE_NOTICE", reasonDetail: "the session handout the registration was promised", systemSource: "event_handout",
        detail: { event_id: ev.id, contact_id: contactId },
      },
      () => send({ brokerageId: ev.brokerage_id as string, to: email, contactId, subject: copy.subject, html: copy.html, text: copy.text, metadata: { event_id: ev.id, rsvp_id: rsvp.id, kind: "event_handout" } }),
      {
        settle: (s: { success: boolean; error?: string }) => (s.success ? { status: "executed", outcome: "handout_sent", provider: "email" } : { status: "failed", outcome: "handout_not_sent", error: s.error ?? null }),
        replay: (claim: { kind: string; error?: string }) => (claim.kind === "refused" ? { success: false, error: `the action ledger refused: ${claim.error}` } : { success: false, error: "already delivered" }),
      },
    ) as { success: boolean; error?: string }
    if (r.success) delivered++
    else if (r.error === "already delivered") skipped++
    else errors.push(`${contactId}: ${r.error ?? "not sent"}`)
  }
  return { delivered, skipped, reason: "sent where a handout, approved copy and an e-mail all exist", errors }
}

/** The registrations of one event with each person's e-mail and first name — read by the arbiter-owned touches (event-touches.ts). */
export async function loadEventRegistrations(svc: Db, eventId: string): Promise<{ event: EventRow | null; rows: Array<{ contactId: string; rsvp: Record<string, any>; email: string | null; firstName: string }>; error: string | null }> {
  const { event: ev, error } = await readEvent(svc, eventId)
  if (error || !ev?.brokerage_id) return { event: null, rows: [], error: error ?? "event not found" }
  const regs = await loadRegistrations(svc, ev)
  if (regs.error) return { event: ev, rows: [], error: regs.error }
  return { event: ev, rows: [...regs.byContact].map(([contactId, rsvp]) => ({ contactId, rsvp, email: regs.emails.get(contactId) ?? null, firstName: regs.names.get(contactId)?.first ?? "" })), error: null }
}

/** The governed service-notice e-mail every event touch uses (consent / suppression / ledger at the dispatcher). */
export const sendEventServiceEmail = defaultSendEmail
