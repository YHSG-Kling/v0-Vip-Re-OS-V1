// NOT a server-action module (2026-09-03, integrator, lane R3-A's sweep — this
// file was held back because lane H2 was converting its lifecycle_events
// insert at the same time). The module-level "use server" that stood here
// made calculateFatigue(contactId, brokerageId) and calculateAllBuyerFatigue
// public HTTP doors onto a service client with the tenant taken from the
// PARAMETER — CLAUDE.md §4's IDOR shape. Every caller is in-process server
// code: app/actions/buyer-fatigue.ts (session-gated actions) and
// app/api/fatigue/cron/route.ts (verifyCronAuth before calling). The sweep takes
// a declared TenantScope (lane 86G2); calculateFatigue's brokerageId is an
// in-process contract, not a public one.
// `server-only` makes a future client import fail at build time.
import "server-only"

import { createServiceClient } from "@/lib/supabase/service"
// agents.id → { users.id, users.brokerage_id }. The ONE crossing helper: both
// `fatigue_alerts.agent_user_id` (a users FK) and the tenant this file's
// smart_assistant_suggestions row must carry come from it.
import { resolveAgentRecipient } from "@/lib/notifications/recipient-tenant"
import { BUYER_CONCLUDED_STAGES } from "@/lib/contacts/buyer-stage"
import { generateTextRouted }  from "@/lib/ai/models"
import { KernelEvent }         from "@/lib/kernel/events"
import { deriveRiskLevel, describeFatigueFactors, UNANSWERED_FOLLOW_UP_FLOOR, type FatigueRiskLevel } from "./fatigue-display"
import { generateRecoveryPlan } from "./recovery-generator"
import { applyTenantScope, describeTenantScope, tenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"
// THE over-contact capability (lib/kernel/deconflict — "over contacting is already built", owner,
// wave 88): fatigue reads the engine's own touch ledgers, timestamps, channel words and cap.
import {
  CONTACT_TOUCH_LEDGERS,
  DEFAULT_DECONFLICT_POLICY,
  saturatedChannels,
  touchChannelOf,
  touchTimestampColumn,
  type ContactTouchLedger,
} from "@/lib/kernel/deconflict/lead-channel"

type Svc = ReturnType<typeof createServiceClient>

// ─── TYPES ───────────────────────────────────────────────────────────────────

/** ONE vocabulary (§6): the same literal union the display module speaks. */
export type RiskLevel = FatigueRiskLevel

export interface FatigueFactors {
  total_showings:            number
  total_tour_days:           number
  days_searching:            number
  offers_rejected:           number
  engagement_decline_factor: number // 0 | 1 | 2
  /** The buyer_fatigue_scores.engagement_trend CHECK word: increasing | stable | declining | stopped. */
  engagement_trend:          string
  /** The human reading behind the trend word ("no recent activity", "sharp decline", …) — for copy. */
  engagement_detail:         string
  // ── Wave 88 (lane 88A) — responsiveness to follow-up, missed appointments, unsigned sellers ──
  /** Outbound touches in the follow-up window, from the over-touch engine's own ledgers. */
  follow_ups_sent:           number
  /** Replies (inbound messages / portal messages / inbound calls / logged ISA replies) in the window. */
  replies_received:          number
  /** Follow-ups sent AFTER the most recent reply in the window (all of them when nobody replied). */
  unanswered_follow_ups:     number
  /** Engine channels at / over the over-touch cap right now (the next send would be suppressed). */
  saturated_channels:        string[]
  /** No-shows in the missed-appointment window (calendar_events marked 'no_show' on this contact). */
  missed_appointments:       number
  /** A seller (contact_type seller | both) with no signed listing agreement. */
  unsigned_seller:           boolean
  /** …who is also not answering follow-up — the owner's "unresponsive to follow up". */
  seller_unresponsive:       boolean
}

export interface FatigueResult {
  score:       number
  risk_level:  RiskLevel
  factors:     FatigueFactors
  contact_id:  string
  brokerage_id: string
  /** TRUE only when THIS call raised a new fatigue_alerts row (no undismissed alert existed).
   *  The sweep attaches a recovery plan only then — one AI plan per alert, never per run. */
  alert_raised: boolean
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// TOMBSTONE (§6, wave 26, lane L4): `toRiskLevel` DELETED. It was a byte-identical
// second spelling of the cut points (critical>=75 / high>=50 / moderate>=25) that
// lib/fatigue/fatigue-display.ts:deriveRiskLevel already owns — and whose header
// explicitly claims to MIRROR this file. Two copies of one threshold set is the
// defect §6 names: a change to one silently desynchronises the badge from the
// scorer. SURVIVOR: lib/fatigue/fatigue-display.ts:deriveRiskLevel (imported above).

function riskLabel(r: RiskLevel): string {
  return r.charAt(0).toUpperCase() + r.slice(1)
}

// ─── THE INPUTS — and therefore THE POPULATION (wave 87, lane 87A) ────────────
//
// Owner, verbatim: "fatigue sweeps run for the platform on tenants and brokerage
// on leads and contacts which is user run. should be run on how the fatigue
// calculation is derived."
//
// As of lane 87A, calculateFatigue derived a score from FOUR inputs (wave 88 adds three families —
// see below; the rule is unchanged) — completed
// showings (count + days searching), completed tours (distinct tour days),
// rejected offers, and the buyer_behavior_log engagement trend. So the people a
// sweep scores are exactly the people who HAVE at least one of those inputs; a
// stage list is not the definition (lane 86G2's BUYER_ACTIVE_STAGES population
// skipped BUYER_DISENGAGED and BUYER_ON_HOLD — the two states fatigue exists to
// catch — and scored ladder members with no input at all, each to a flat 40
// "no recent activity").
//
// ONE place names the inputs, and BOTH the calculator and the population loader
// read through it (fatigueInput below), so the population can never drift from
// the formula. The CHECK literals stay inline in each `.from(...)` chain so the
// check-vocabulary guard still sees them.
//
// LEADS. Every input FKs contacts.id (live FK map: showings / tours / offers /
// buyer_behavior_log .contact_id → contacts.id). A lead reaches the calculation
// only through its conversion contact (leads.contact_id — the ONE conversion
// marker, lib/contact-promotion/conversion-finality.ts); an unconverted lead
// cannot have a single input row, so it is COUNTED (`leadsWithoutInputs`), never
// scored and never faked. After conversion the owner's ruling applies ("once a
// lead converts … only contacts get the actions") — the score lands on the contact.

//
// ── WAVE 88 (lane 88A) — THE SAME CALCULATOR, MORE INPUTS ─────────────────────
// Owner, verbatim: "Need fatigue also for agents. Calculating fatigue should also take into
// consideration responses to follow up, Fatigue for sellers that haven't signed a listing agreement
// meaning unresponsive to follow up, missed appointments, etc." · "I feel like over contacting is
// already built."
//
// Extended, not rewritten: the four buyer-search inputs and their formula are unchanged, and three
// input families join them — declared HERE, so the population keeps deriving from the formula:
//   · FOLLOW-UP TOUCHES — the over-touch engine's own ledgers (CONTACT_TOUCH_LEDGERS from
//     lib/kernel/deconflict/lead-channel.ts, the "already built" over-contact capability), dated by
//     the engine's own columns, inside the engine's longest window. Not a second touch list.
//   · MISSED APPOINTMENTS — calendar_events marked 'no_show' (the appointment-noshow autopilot's
//     mark, entity_type 'contact', entity_id = contacts.id) — the one appointment ledger.
//   · RESPONSES (FATIGUE_RESPONSE_SOURCES below) TEMPER, never raise: a reply resets the
//     unanswered-follow-up count. They are read through their own one reader and do not make a
//     person on their own (someone who only wrote in has nothing to be fatigued by).
// A seller's unsigned listing agreement is a QUALIFIER on the follow-up signal (it raises only when
// that seller is also not answering), read from listing_agreements for sellers only.

/** The buyer-search inputs (lane 87A's four), in formula order. */
const BUYER_SEARCH_SOURCES = ["showings", "tours", "offers", "buyer_behavior_log"] as const
/** The missed-appointment input: calendar_events is THE appointment ledger (the listing-appointment
 *  engine books into it; the no-show autopilot marks it). `appointments` also carries a 'no_show'
 *  status but NOTHING in the tree writes that table (test:writerless-reads) — reading it would be a
 *  dead feature wearing a working query, so it is deliberately not an input. */
const MISSED_APPOINTMENT_SOURCES = ["calendar_events"] as const

/** Every source calculateFatigue derives a RAISING term from — buyer search, the over-touch
 *  engine's follow-up ledgers, missed appointments. The population is exactly who these name. */
export const FATIGUE_INPUT_SOURCES = [
  ...BUYER_SEARCH_SOURCES,
  ...CONTACT_TOUCH_LEDGERS,
  ...MISSED_APPOINTMENT_SOURCES,
] as const
export type FatigueInputSource = (typeof FATIGUE_INPUT_SOURCES)[number]

/** The follow-up window: the over-touch engine's LONGEST channel window (mail, 30d) — derived, so
 *  every channel's cap window fits inside the rows read. */
export const FOLLOW_UP_WINDOW_DAYS = Math.max(...Object.values(DEFAULT_DECONFLICT_POLICY).map((p) => p.windowDays))
/** The missed-appointment window — the coaching horizon lib/kernel/agent-coaching.ts reads no-shows over. */
const MISSED_APPOINTMENT_WINDOW_DAYS = 90
// UNANSWERED_FOLLOW_UP_FLOOR (unanswered follow-ups start to count at 2 — one is ordinary) lives in
// the pure ./fatigue-display beside deriveRiskLevel, so the card's words and the score agree.

const DAY_MS = 86_400_000
const sinceIso = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()

/** The column naming the person in each input (calendar_events keys its subject on entity_id). */
function fatiguePersonColumn(source: FatigueInputSource): "contact_id" | "entity_id" {
  return source === "calendar_events" ? "entity_id" : "contact_id"
}

/** THE one reader of a fatigue input: the source's table + the row filter the formula counts,
 *  TENANT-SCOPED BY CONSTRUCTION (wave 88, lane 88A): every case applies the caller's TenantScope
 *  itself, so no read of an input can leave the tenant — the calculator passes tenantScope(its
 *  brokerage), the sweep passes its own scope (platform → no predicate, by declaration). Before,
 *  the four buyer-search reads were pinned only through the person (the contact was tenant-checked
 *  first); the tenant is now on every input row read as well. Keyed on the person by every caller. */
function fatigueInput(supabase: Svc, scope: TenantScope, source: FatigueInputSource, columns: string, count?: "exact") {
  const opts = count ? { count } : undefined
  const followUpSince = sinceIso(FOLLOW_UP_WINDOW_DAYS)
  const missedSince = sinceIso(MISSED_APPOINTMENT_WINDOW_DAYS)
  switch (source) {
    case "showings":           { const q = supabase.from("showings").select(columns, opts).eq("status", "completed"); applyTenantScope(q, scope); return q }
    case "tours":              { const q = supabase.from("tours").select(columns, opts).eq("status", "completed"); applyTenantScope(q, scope); return q }
    case "offers":             { const q = supabase.from("offers").select(columns, opts).eq("status", "rejected"); applyTenantScope(q, scope); return q }
    case "buyer_behavior_log": { const q = supabase.from("buyer_behavior_log").select(columns, opts); applyTenantScope(q, scope); return q }
    // Follow-up touches — the over-touch engine's ledgers, windowed on its own timestamp columns.
    case "email_sends":                    { const q = supabase.from("email_sends").select(columns, opts).gte(touchTimestampColumn("email_sends"), followUpSince); applyTenantScope(q, scope); return q }
    case "direct_mail_recipients":         { const q = supabase.from("direct_mail_recipients").select(columns, opts).gte(touchTimestampColumn("direct_mail_recipients"), followUpSince); applyTenantScope(q, scope); return q }
    case "isa_outreach_log":               { const q = supabase.from("isa_outreach_log").select(columns, opts).gte(touchTimestampColumn("isa_outreach_log"), followUpSince); applyTenantScope(q, scope); return q }
    case "marketing_campaign_touchpoints": { const q = supabase.from("marketing_campaign_touchpoints").select(columns, opts).gte(touchTimestampColumn("marketing_campaign_touchpoints"), followUpSince); applyTenantScope(q, scope); return q }
    case "lifetime_customer_touchpoints":  { const q = supabase.from("lifetime_customer_touchpoints").select(columns, opts).gte(touchTimestampColumn("lifetime_customer_touchpoints"), followUpSince); applyTenantScope(q, scope); return q }
    // Missed appointments.
    case "calendar_events":    { const q = supabase.from("calendar_events").select(columns, opts).eq("entity_type", "contact").eq("status", "no_show").gte("start_at", missedSince); applyTenantScope(q, scope); return q }
  }
}

/** The replies that answer a follow-up — the INBOUND lanes the one inbox reader
 *  (lib/kernel/communications.ts) already treats as inbound, plus the ISA log's own reply stamp. */
export const FATIGUE_RESPONSE_SOURCES = ["isa_outreach_log", "messages", "client_portal_messages", "voice_calls"] as const
type FatigueResponseSource = (typeof FATIGUE_RESPONSE_SOURCES)[number]

/** THE one reader of a reply: `at` is when the person answered. Windowed like the follow-ups and
 *  tenant-scoped by construction, like fatigueInput. */
function fatigueResponse(supabase: Svc, scope: TenantScope, source: FatigueResponseSource) {
  const since = sinceIso(FOLLOW_UP_WINDOW_DAYS)
  switch (source) {
    case "isa_outreach_log":       { const q = supabase.from("isa_outreach_log").select("at:replied_at").not("replied_at", "is", null).gte("replied_at", since); applyTenantScope(q, scope); return q }
    case "messages":               { const q = supabase.from("messages").select("at:created_at").eq("direction", "inbound").gte("created_at", since); applyTenantScope(q, scope); return q }
    case "client_portal_messages": { const q = supabase.from("client_portal_messages").select("at:created_at").eq("direction", "client_to_agent").gte("created_at", since); applyTenantScope(q, scope); return q }
    case "voice_calls":            { const q = supabase.from("voice_calls").select("at:created_at").eq("direction", "inbound").gte("created_at", since); applyTenantScope(q, scope); return q }
  }
}

/** Rows read per ledger per person (a contact touched more than this in 30 days is saturated anyway). */
const PER_PERSON_READ_LIMIT = 200

// ── Weights of the wave-88 terms (the buyer-search weights above them are unchanged) ──
/** Per unanswered follow-up past the floor, up to UNANSWERED_CAP. */
const W_UNANSWERED = 4
const UNANSWERED_CAP = 8
/** Per channel at / over the over-touch cap. */
const W_SATURATED_CHANNEL = 8
/** Per missed appointment, up to MISSED_CAP. */
const W_MISSED_APPOINTMENT = 15
const MISSED_CAP = 3
/** A seller with no signed listing agreement who is not answering follow-up. */
const W_SELLER_UNRESPONSIVE = 20

/** PURE — follow-up responsiveness from dated touches and replies. `unanswered` counts the touches
 *  AFTER the latest reply (all of them when nobody replied). */
export function followUpResponsiveness(
  touches: ReadonlyArray<{ at: string | null }>,
  replies: ReadonlyArray<{ at: string | null }>,
): { sent: number; replies: number; unanswered: number; lastReplyAt: string | null } {
  const ms = (s: string | null) => (s ? Date.parse(s) : NaN)
  const replyTimes = replies.map((r) => ms(r.at)).filter(Number.isFinite)
  const last = replyTimes.length ? Math.max(...replyTimes) : null
  const dated = touches.map((t) => ms(t.at)).filter(Number.isFinite)
  return {
    sent: dated.length,
    replies: replyTimes.length,
    unanswered: last === null ? dated.length : dated.filter((t) => t > last).length,
    lastReplyAt: last === null ? null : new Date(last).toISOString(),
  }
}

/** PURE — the wave-88 points, so the proof drives every term with no DB. */
export function responsivenessPoints(f: Pick<FatigueFactors, "unanswered_follow_ups" | "saturated_channels" | "missed_appointments" | "seller_unresponsive">): number {
  const unanswered = f.unanswered_follow_ups >= UNANSWERED_FOLLOW_UP_FLOOR
    ? Math.min(f.unanswered_follow_ups, UNANSWERED_CAP) * W_UNANSWERED
    : 0
  return unanswered
    + f.saturated_channels.length * W_SATURATED_CHANNEL
    + Math.min(f.missed_appointments, MISSED_CAP) * W_MISSED_APPOINTMENT
    + (f.seller_unresponsive ? W_SELLER_UNRESPONSIVE : 0)
}

// ─── MAIN CALCULATOR ─────────────────────────────────────────────────────────

export async function calculateFatigue(
  contactId:   string,
  brokerageId: string,
): Promise<FatigueResult> {
  const supabase = createServiceClient()

  // ── 0. The person, pinned to THIS tenant (§4 — fail closed) ───────────────
  // Every write below stamps brokerageId; a contact that is not this tenant's
  // (or is soft-deleted) is refused BEFORE any read or write, never scored
  // under the wrong tenant.
  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id, contact_type")
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .maybeSingle()
  if (contactErr) throw new Error(`[fatigue] contact read refused: ${contactErr.message}`)
  if (!contact) throw new Error(`[fatigue] contact ${contactId} is not a live contact of brokerage ${brokerageId}`)
  // Every input read below goes through the tenant-scoped readers with THIS brokerage.
  const scope = tenantScope(brokerageId, "fatigue calculate")

  // ── 1. Load all raw stats ──────────────────────────────────────────────────

  const [showingsRes, toursRes, offersRes, signalsRes] = await Promise.all([
    // Total completed showings for this buyer
    fatigueInput(supabase, scope, "showings", "id, scheduled_at", "exact").eq("contact_id", contactId),
    // Distinct tour days
    fatigueInput(supabase, scope, "tours", "tour_date").eq("contact_id", contactId),
    // Rejected offers
    fatigueInput(supabase, scope, "offers", "id, created_at", "exact").eq("contact_id", contactId),
    // Behavior log signals with timestamps for engagement trend
    fatigueInput(supabase, scope, "buyer_behavior_log", "created_at, signal_value")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(200),
  ])

  // supabase-js RESOLVES a refusal (§3). A refused input used to read as ZERO —
  // a lower score than the truth, and a "fresh" badge nobody earned. Now the
  // person is not scored and the sweep counts the error.
  for (const [source, res] of [["showings", showingsRes], ["tours", toursRes], ["offers", offersRes], ["buyer_behavior_log", signalsRes]] as const) {
    if (res.error) throw new Error(`[fatigue] ${source} read refused for ${contactId}: ${res.error.message}`)
  }

  const showingRows = (showingsRes.data ?? []) as unknown as Array<{ id: string; scheduled_at: string }>
  const tourRows    = (toursRes.data ?? []) as unknown as Array<{ tour_date: string | null }>
  const signals     = (signalsRes.data ?? []) as unknown as Array<{ created_at: string; signal_value: number | null }>

  const totalShowings  = showingsRes.count ?? 0
  const tourDates      = new Set(tourRows.map(t => t.tour_date).filter(Boolean))
  const totalTourDays  = tourDates.size
  const offersRejected = offersRes.count ?? 0

  // Days searching = days since earliest showing or first offer attempt
  let daysSearching = 0
  if (showingRows.length > 0) {
    const earliest = showingRows.reduce((min, s) =>
      s.scheduled_at < min ? s.scheduled_at : min,
      showingRows[0].scheduled_at
    )
    daysSearching = Math.floor(
      (Date.now() - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24)
    )
  }

  // Engagement decline factor from behavior log
  const now = Date.now()
  const ms14d = 14 * 24 * 60 * 60 * 1000
  const ms7d  =  7 * 24 * 60 * 60 * 1000

  const recent14Sum = signals
    .filter(s => now - new Date(s.created_at).getTime() <= ms14d)
    .reduce((acc, s) => acc + Number(s.signal_value ?? 1), 0)

  const prior14Sum = signals
    .filter(s => {
      const age = now - new Date(s.created_at).getTime()
      return age > ms14d && age <= ms14d * 2
    })
    .reduce((acc, s) => acc + Number(s.signal_value ?? 1), 0)

  const noSignals7d = !signals.some(
    s => now - new Date(s.created_at).getTime() <= ms7d
  )

  // The buyer-engagement term applies to a person with a BUYER SEARCH on file (any of the four
  // buyer-search inputs). Before wave 88 every scored person had one; now a seller or sphere contact
  // can be scored on follow-up alone, and "no behavior-log signal in 7 days" says nothing about them —
  // it would hand every such contact a flat +40 (lane 87A's "flat 40" defect, reborn).
  const hasBuyerSearch = totalShowings > 0 || totalTourDays > 0 || offersRejected > 0 || signals.length > 0

  let engagementDeclineFactor = 0
  // engagementTrend is the buyer_fatigue_scores.engagement_trend CHECK word (increasing | stable |
  // declining | stopped); engagementDetail is the human reading. Lane 88A: the trend used to carry
  // "no recent activity" / "sharp decline" — words the CHECK refuses, so every such upsert was
  // REFUSED (23514) and the person was never scored (live had 0 rows, so nobody saw it).
  let engagementTrend = "stable"
  let engagementDetail = hasBuyerSearch ? "stable" : "no buyer search on file"

  if (hasBuyerSearch && (noSignals7d || (prior14Sum > 0 && recent14Sum / prior14Sum <= 0.4))) {
    engagementDeclineFactor = 2
    engagementTrend = noSignals7d ? "stopped" : "declining"
    engagementDetail = noSignals7d ? "no recent activity" : "sharp decline"
  } else if (hasBuyerSearch && prior14Sum > 0 && recent14Sum / prior14Sum <= 0.7) {
    engagementDeclineFactor = 1
    engagementTrend = "declining"
    engagementDetail = "declining"
  } else if (hasBuyerSearch && recent14Sum >= prior14Sum) {
    engagementTrend = "increasing"
    engagementDetail = "increasing"
  }

  // ── 1b. Follow-up responsiveness, missed appointments, unsigned sellers (wave 88, lane 88A) ──
  // Touches come from the over-touch engine's own ledgers (CONTACT_TOUCH_LEDGERS), replies from the
  // inbound lanes (FATIGUE_RESPONSE_SOURCES); both tenant-scoped by their readers, every refusal
  // thrown (§3).
  const [touchRes, replyRes, calNoShowRes] = await Promise.all([
    Promise.all(CONTACT_TOUCH_LEDGERS.map((ledger: ContactTouchLedger) => {
      const ts = touchTimestampColumn(ledger)
      const columns = ledger === "email_sends" || ledger === "direct_mail_recipients" ? `at:${ts}` : `at:${ts}, channel`
      return fatigueInput(supabase, scope, ledger, columns)
        .eq("contact_id", contactId)
        .limit(PER_PERSON_READ_LIMIT)
    })),
    Promise.all(FATIGUE_RESPONSE_SOURCES.map((source) =>
      fatigueResponse(supabase, scope, source)
        .eq("contact_id", contactId)
        .limit(PER_PERSON_READ_LIMIT),
    )),
    fatigueInput(supabase, scope, "calendar_events", "id", "exact").eq("entity_id", contactId),
  ])

  const touches: Array<{ at: string | null; channel: ReturnType<typeof touchChannelOf> }> = []
  touchRes.forEach((res, i) => {
    const ledger = CONTACT_TOUCH_LEDGERS[i]
    if (res.error) throw new Error(`[fatigue] ${ledger} read refused for ${contactId}: ${res.error.message}`)
    for (const r of (res.data ?? []) as unknown as Array<{ at: string | null; channel?: string | null }>) {
      touches.push({ at: r.at, channel: touchChannelOf(ledger, r.channel ?? null) })
    }
  })
  const replies: Array<{ at: string | null }> = []
  replyRes.forEach((res, i) => {
    if (res.error) throw new Error(`[fatigue] ${FATIGUE_RESPONSE_SOURCES[i]} reply read refused for ${contactId}: ${res.error.message}`)
    replies.push(...((res.data ?? []) as unknown as Array<{ at: string | null }>))
  })
  if (calNoShowRes.error) throw new Error(`[fatigue] calendar_events no-show read refused for ${contactId}: ${calNoShowRes.error.message}`)

  const responsiveness = followUpResponsiveness(touches, replies)
  const saturated = saturatedChannels(touches, now)
  const missedAppointments = calNoShowRes.count ?? 0

  // A SELLER who has not signed a listing agreement (contacts.contact_type seller | both — the
  // listing_agreements row is the seller's signature: seller_signed_at, or esign_status fully_signed).
  let unsignedSeller = false
  const contactType = (contact as { contact_type?: string | null }).contact_type ?? null
  if (contactType === "seller" || contactType === "both") {
    const { data: agreements, error: agreementsErr } = await supabase
      .from("listing_agreements")
      .select("seller_signed_at, esign_status")
      .eq("seller_contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .eq("agreement_type", "listing")
    if (agreementsErr) throw new Error(`[fatigue] listing agreement read refused for ${contactId}: ${agreementsErr.message}`)
    unsignedSeller = !((agreements ?? []) as Array<{ seller_signed_at: string | null; esign_status: string | null }>)
      .some((a) => !!a.seller_signed_at || a.esign_status === "fully_signed")
  }
  const sellerUnresponsive = unsignedSeller && responsiveness.unanswered >= UNANSWERED_FOLLOW_UP_FLOOR

  // ── 2. Apply formula ───────────────────────────────────────────────────────

  const factors: FatigueFactors = {
    total_showings:            totalShowings,
    total_tour_days:           totalTourDays,
    days_searching:            daysSearching,
    offers_rejected:           offersRejected,
    engagement_decline_factor: engagementDeclineFactor,
    engagement_trend:          engagementTrend,
    engagement_detail:         engagementDetail,
    follow_ups_sent:           responsiveness.sent,
    replies_received:          responsiveness.replies,
    unanswered_follow_ups:     responsiveness.unanswered,
    saturated_channels:        saturated.map((s) => s.channel),
    missed_appointments:       missedAppointments,
    unsigned_seller:           unsignedSeller,
    seller_unresponsive:       sellerUnresponsive,
  }

  const searchPoints =
    (totalShowings   * 3) +
    (totalTourDays   * 8) +
    (daysSearching   / 10) +
    (offersRejected  * 15) +
    (engagementDeclineFactor * 20)
  const followUpPoints = responsivenessPoints(factors)
  const rawScore = searchPoints + followUpPoints

  const score     = Math.min(100, Math.round(rawScore))
  const riskLevel = deriveRiskLevel(score)
  // The ONE factor sentence (fatigue-display) — the same words the contact card shows.
  const summary   = describeFatigueFactors(factors)

  // ── 3. Upsert buyer_fatigue_scores — COUNTED (§3) ──────────────────────────
  // The upsert's result was never read, so a refused write reported a score that
  // had never persisted. Now: read the error AND count the row that came back.

  const { data: written, error: writeErr } = await supabase
    .from("buyer_fatigue_scores")
    .upsert(
      {
        contact_id:           contactId,
        brokerage_id:         brokerageId,
        // The OWNING AGENT (agents.id — the column FKs agents). Was never written, so no reader could
        // ask "which of my contacts are fatigued" by agent; lane 88A builds the missing writer
        // (agent coaching's fatigued-book count and the agent's own list read it).
        agent_id:             contact.agent_id ?? null,
        fatigue_score:        score,
        risk_level:           riskLevel,
        total_showings:       totalShowings,
        total_tour_days:      totalTourDays,
        days_searching:       daysSearching,
        offers_rejected:      offersRejected,
        engagement_trend:     engagementTrend,
        contributing_factors: factors,
        last_calculated_at:   new Date().toISOString(),
      },
      { onConflict: "contact_id" }
    )
    .select("contact_id")
  if (writeErr) throw new Error(`[fatigue] score write refused for ${contactId}: ${writeErr.message}`)
  if ((written ?? []).length !== 1) throw new Error(`[fatigue] score write for ${contactId} landed ${(written ?? []).length} rows, expected 1`)

  // ── 4. Alert logic for high/critical ──────────────────────────────────────

  let alertRaised = false
  if (riskLevel === "high" || riskLevel === "critical") {
    // Check for existing unresolved fatigue alert (tenant-pinned; a refused read
    // is NOT "no alert" — raising a duplicate alert + AI note is the cost we avoid).
    const { data: existingAlert, error: existingErr } = await supabase
      .from("fatigue_alerts")
      .select("id")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .eq("dismissed", false)
      .limit(1)
      .maybeSingle()
    if (existingErr) throw new Error(`[fatigue] open-alert read refused for ${contactId}: ${existingErr.message}`)

    if (!existingAlert) {
      const buyerName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "This contact"
      // Who this person is to the agent — a buyer's SEARCH fatigue and a quiet seller's follow-up
      // fatigue need different coaching (wave 88).
      const role = contactType === "seller" ? "seller" : contactType === "both" ? "buyer and seller" : hasBuyerSearch ? "buyer" : "contact"

      // AI-generated reinvigoration message (non-blocking on failure)
      let alertMessage = `${buyerName} has a fatigue score of ${score} (${riskLabel(riskLevel)}). ${summary}.`

      // Routed + booked (§5: ai_tool_usage is the cost ledger). Was a raw
      // generateText pinned to claude-opus-4-5 with no ledger row — the most
      // expensive model for a two-sentence internal note, billed to nobody.
      try {
        const { text } = await generateTextRouted({
          feature: "buyer_fatigue_coaching",
          brokerageId,
          system:
            "You are a real estate agent coach. Write a single concise action recommendation (2 sentences max) for an agent whose client is showing signs of fatigue — search fatigue, unanswered follow-up, missed appointments, or a seller who has gone quiet before signing. Be specific and actionable, and never recommend contacting them MORE often when follow-up is going unanswered.",
          prompt:
            `Client (${role}): ${buyerName}. Score: ${score}/100 (${riskLevel}). ${summary}. ` +
            `What should the agent do?`,
          maxTokens: 120,
        })
        if (text.trim()) alertMessage = text.trim()
      } catch {
        // Keep fallback message
      }

      // Insert fatigue_alert. pass 13: fatigue_alerts.agent_user_id FKs users(id)
      // but contacts.agent_id is agents.id — the raw stamp FK-threw and every
      // fatigue alert died unnoticed. Resolve to the owning agent's auth user id.
      //
      // ONE RESOLVER, TWO ANSWERS, RESOLVED ONCE. The ad-hoc `agents.select
      // ("user_id")` this replaced destructured no `error`, so a refused lookup
      // arrived as "this agent has no user" and was indistinguishable from it.
      // The shared resolver returns the crossing (`agents.id` → `users.id`) AND
      // that user's `users.brokerage_id`, which is the value the suggestion below
      // has to carry.
      const owningAgent = await resolveAgentRecipient(supabase, contact.agent_id ?? null)
      const fatigueAgentUserId: string | null = owningAgent.ok ? owningAgent.userId : null
      const { data: alert, error: alertErr } = await supabase
        .from("fatigue_alerts")
        .insert({
          contact_id:               contactId,
          brokerage_id:             brokerageId,
          agent_user_id:            fatigueAgentUserId,
          // Which kind of fatigue crossed the line (CHECK-legal words): mostly unanswered follow-up /
          // missed appointments → 'disengagement_risk'; mostly the buyer search → as before.
          alert_type:               followUpPoints > searchPoints ? "disengagement_risk" : "fatigue_threshold_crossed",
          fatigue_score_at_trigger: score,
          risk_level:               riskLevel,
          message:                  alertMessage,
          dismissed:                false,
        })
        .select("id")
        .single()
      if (alertErr) {
        // Counted by the caller as a scored person whose alert did not land —
        // the score row above is real; the alert is reported, never assumed.
        console.error(`[fatigue] fatigue_alerts insert refused for ${contactId}:`, alertErr.message)
      } else {
        alertRaised = true
      }

      // Insert smart_assistant_suggestion.
      //
      // TENANT: the OWNING AGENT'S `users.brokerage_id` — deliberately not this
      // function's `brokerageId` argument, even though the two agree on every
      // live row today. `getContactCopilotSuggestions` reads this table
      // `.eq("agent_id", ctx.agentId).eq("brokerage_id", ctx.brokerageId)` with
      // both halves from one `getAgentContext()`, and that context's brokerage IS
      // `users.brokerage_id`. Stamping the anchor's brokerage instead would be
      // stamping a value the reader does not compute — wave 23's badge-count
      // lesson, which is that a wrong tenant hides the row exactly as NULL does.
      //
      // NO AGENT (or an unreadable one) → NO ROW. Both readers filter `agent_id`,
      // so an unattributed suggestion is invisible whatever it is stamped with.
      // An AGENT only ever receives this for a CONTACT on their own book — the
      // person is a contacts row by construction (every input FKs contacts.id).
      if (!owningAgent.ok) {
        console.error(`[fatigue] suggestion skipped — agent tenant unresolved: ${owningAgent.reason}`)
      } else if (!contact.agent_id || !owningAgent.brokerageId) {
        console.error(
          `[fatigue] suggestion skipped for contact ${contactId} — ` +
          "the contact has no agent, or that agent has no users.brokerage_id; a suggestion nobody can read was not written",
        )
      } else {
        const { error: suggestionError } = await supabase.from("smart_assistant_suggestions").insert({
          agent_id:           contact.agent_id,
          brokerage_id:       owningAgent.brokerageId,
          title:              followUpPoints > searchPoints
            ? `${buyerName} is going quiet on follow-up`
            : `${buyerName} showing signs of search fatigue`,
          description:        alertMessage,
          context_type:       "buyer_fatigue",
          action_type:        "view_buyer",
          action_payload_json: JSON.stringify({ contact_id: contactId }),
          priority:           riskLevel === "critical" ? "high" : "medium",
          status:             "pending",
        })
        if (suggestionError) {
          console.error("[fatigue] smart_assistant_suggestions insert refused:", suggestionError.message)
        }
      }

      // Kernel sub-event — audit row + reactor (the bare insert reached nothing).
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      await emitKernelEvent({
        brokerageId,
        entityType:   "buyer_lifecycle",
        entityId:     contactId,
        event:        KernelEvent.BUYER_FATIGUE_DETECTED,
        contactId,
        // lifecycle_events.actor_user_id FKs users(id) — contact.agent_id is an
        // agents.id, so the raw stamp FK-threw and the sub-event was lost even
        // though the alert beside it landed. Reuse the id already resolved above.
        actorUserId:  fatigueAgentUserId,
        metadata: {
          fatigue_score:   score,
          risk_level:      riskLevel,
          alert_id:        alert?.id ?? null,
        },
      })
    }
  }

  return { score, risk_level: riskLevel, factors, contact_id: contactId, brokerage_id: brokerageId, alert_raised: alertRaised }
}

// ─── THE POPULATION ──────────────────────────────────────────────────────────

/** Rows per page when collecting the people an input names (PostgREST max-rows default). */
const INPUT_PAGE_SIZE = 1000
/** Hard page cap PER SOURCE per run — a runaway table is reported (`inputsCapped`), never silently truncated. */
const INPUT_MAX_PAGES = 200
/** Ids per `.in()` when anchoring people to contacts / leads / prior scores (URL-length safe). */
const ANCHOR_CHUNK = 200
/** Default per-run cap on people scored — stalest first; the remainder is counted `deferred`
 *  and goes first next run (never-scored, then oldest last_calculated_at). */
export const FATIGUE_SWEEP_DEFAULT_MAX_PERSONS = 2000
/** Default people scored in parallel — each is ~16 bounded reads (1 anchor, 4 buyer-search, 5 touch
 *  ledgers, 4 reply lanes, 1 no-show count, +1 listing-agreement read for a seller) + 1 counted
 *  write; AI only on a NEW alert. */
const DEFAULT_CONCURRENCY = 4

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export interface FatigueSweepPerson {
  contactId:   string
  brokerageId: string
  /** The contact is the conversion of a lead in scope (leads.contact_id). */
  fromLead:    boolean
  /** Prior buyer_fatigue_scores.last_calculated_at — null when never scored. */
  lastCalculatedAt: string | null
}

export interface FatigueSweepPopulation {
  persons: FatigueSweepPerson[]
  /** Distinct people with ≥1 input row, before anchoring. */
  withInputs: number
  /** Dropped by the anchor: soft-deleted, tenantless, outside the scope, or search concluded. */
  excluded: number
  /** Leads in scope with NO contact — no input can exist for them (every input FKs contacts.id). */
  leadsWithoutInputs: number
  /** A source hit INPUT_MAX_PAGES — the population may be incomplete (reported, not hidden). */
  inputsCapped: FatigueInputSource[]
}

/**
 * WHO the calculation can score, derived from its inputs (see FATIGUE_INPUT_SOURCES).
 *
 *   1. every person named by ≥1 input row (paged; tenant scope narrows each source
 *      by its own brokerage_id — a source row stamped NULL is seen only by the
 *      platform sweep, which scores it under the CONTACT's tenant);
 *   2. anchored on contacts — live (deleted_at IS NULL), tenanted, inside the
 *      scope, and not past a concluded search (BUYER_CLOSED / BUYER_LIFETIME:
 *      "days searching" means nothing after the close). NULL buyer_stage stays IN;
 *   3. tagged when the contact is a lead's conversion, and the scope's unconverted
 *      leads counted — they have nothing the formula derives from.
 *   (wave 88) The inputs now include the over-touch engine's follow-up ledgers and the
 *   no-show marks, so a SELLER or sphere contact who is being followed up is IN even
 *   with no buyer search; `filter.bookAgentId` narrows to ONE AGENT'S BOOK (and skips
 *   the lead count — agents never see leads).
 *
 * Every read is error-checked; a refusal throws (the run fails, never "nobody to score").
 */
export async function loadFatigueSweepPopulation(
  scope: TenantScope,
  client?: Svc,
  filter: { bookAgentId?: string | null } = {},
): Promise<FatigueSweepPopulation> {
  const supabase = client ?? createServiceClient()
  const where = describeTenantScope(scope) + (filter.bookAgentId ? ` · agent book ${filter.bookAgentId}` : "")

  // ── 1. people named by an input ──
  const named = new Set<string>()
  const inputsCapped: FatigueInputSource[] = []
  for (const source of FATIGUE_INPUT_SOURCES) {
    for (let page = 0; ; page++) {
      if (page >= INPUT_MAX_PAGES) { inputsCapped.push(source); break }
      // The person column: contact_id everywhere but calendar_events (entity_id, entity_type 'contact').
      const person = fatiguePersonColumn(source)
      // The reader applies the scope itself (tenant → brokerage_id predicate; platform → none).
      const q = fatigueInput(supabase, scope, source, person)
        .not(person, "is", null)
        .order("id", { ascending: true })
        .range(page * INPUT_PAGE_SIZE, page * INPUT_PAGE_SIZE + INPUT_PAGE_SIZE - 1)
      const { data, error } = await q
      if (error) throw new Error(`[fatigue-sweep] ${source} read refused (${where}): ${error.message}`)
      const rows = (data ?? []) as unknown as Array<Record<string, string | null>>
      for (const r of rows) { const id = r[person]; if (id) named.add(id) }
      if (rows.length < INPUT_PAGE_SIZE) break
    }
  }

  // ── 2. anchor on contacts (tenant-pinned) ──
  const concluded = BUYER_CONCLUDED_STAGES as readonly string[]
  const anchored = new Map<string, FatigueSweepPerson>()
  for (const ids of chunk([...named], ANCHOR_CHUNK)) {
    const q = supabase
      .from("contacts")
      .select("id, brokerage_id, buyer_stage")
      .in("id", ids)
      .is("deleted_at", null)
      .not("brokerage_id", "is", null)
    // Mutates the builder in place (the lib/property-alerts/alert-engine.ts shape —
    // the generic return form instantiates too deeply here, TS2589).
    applyTenantScope(q, scope)
    // AN AGENT'S OWN BOOK (wave 88, lane 88A — "Need fatigue also for agents"): contacts.agent_id is
    // an agents.id; the caller resolved it from the SESSION (never a parameter a browser chose).
    if (filter.bookAgentId) q.eq("agent_id", filter.bookAgentId)
    const { data, error } = await q
    if (error) throw new Error(`[fatigue-sweep] contact anchor read refused (${where}): ${error.message}`)
    for (const c of (data ?? []) as Array<{ id: string; brokerage_id: string; buyer_stage: string | null }>) {
      if (c.buyer_stage && concluded.includes(c.buyer_stage)) continue
      anchored.set(c.id, { contactId: c.id, brokerageId: c.brokerage_id, fromLead: false, lastCalculatedAt: null })
    }
  }

  // ── 3a. leads: which anchored contacts are a lead's conversion ──
  for (const ids of chunk([...anchored.keys()], ANCHOR_CHUNK)) {
    const q = supabase.from("leads").select("contact_id").in("contact_id", ids)
    applyTenantScope(q, scope)
    const { data, error } = await q
    if (error) throw new Error(`[fatigue-sweep] lead link read refused (${where}): ${error.message}`)
    for (const l of (data ?? []) as Array<{ contact_id: string | null }>) {
      const p = l.contact_id ? anchored.get(l.contact_id) : undefined
      if (p) p.fromLead = true
    }
  }

  // ── 3b. leads with nothing to derive from (unconverted) — counted, not scored ──
  // An agent's book run skips this: leads belong to the BROKERAGE (CLAUDE.md §5) and an agent
  // never sees them — not even as a count.
  let leadsWithoutInputs: number | null = 0
  if (!filter.bookAgentId) {
    const lq = supabase.from("leads").select("id", { count: "exact", head: true }).is("contact_id", null)
    applyTenantScope(lq, scope)
    const { count, error: leadsErr } = await lq
    if (leadsErr) throw new Error(`[fatigue-sweep] unconverted-lead count refused (${where}): ${leadsErr.message}`)
    leadsWithoutInputs = count
  }

  // ── 4. staleness, for the per-run cap (never-scored first, then oldest) ──
  for (const ids of chunk([...anchored.keys()], ANCHOR_CHUNK)) {
    const q = supabase.from("buyer_fatigue_scores").select("contact_id, last_calculated_at").in("contact_id", ids)
    applyTenantScope(q, scope)
    const { data, error } = await q
    if (error) throw new Error(`[fatigue-sweep] prior-score read refused (${where}): ${error.message}`)
    for (const s of (data ?? []) as Array<{ contact_id: string; last_calculated_at: string | null }>) {
      const p = anchored.get(s.contact_id)
      if (p) p.lastCalculatedAt = s.last_calculated_at
    }
  }

  const persons = [...anchored.values()].sort((a, b) => {
    if (a.lastCalculatedAt === b.lastCalculatedAt) return a.contactId < b.contactId ? -1 : 1
    if (a.lastCalculatedAt === null) return -1
    if (b.lastCalculatedAt === null) return 1
    return a.lastCalculatedAt < b.lastCalculatedAt ? -1 : 1
  })

  return {
    persons,
    withInputs: named.size,
    excluded: named.size - anchored.size,
    leadsWithoutInputs: leadsWithoutInputs ?? 0,
    inputsCapped,
  }
}

// ─── THE SWEEP ───────────────────────────────────────────────────────────────

/** What one sweep did — counted, so a caller can tell "scored nobody" from "refused". */
export interface FatigueSweepResult {
  /** "platform" (the cron, every tenant) or "tenant" (a brokerage's Recalculate). */
  scope: TenantScope["kind"]
  /** Distinct people with ≥1 calculation input, before anchoring. */
  withInputs: number
  /** Dropped by the anchor (deleted / tenantless / outside scope / search concluded). */
  excluded: number
  /** People eligible this run (after anchoring). */
  total: number
  /** Of `total`: contacts that are a lead's conversion. */
  fromLeads: number
  /** Leads in scope with no contact — nothing to derive from; counted, never scored. */
  leadsWithoutInputs: number
  /** calculateFatigue completed (score written AND counted). */
  scored: number
  /** Eligible but past the per-run cap — scored first next run (stalest-first). */
  deferred: number
  /** New high/critical alerts raised this run. */
  alertsRaised: number
  /** New alerts that got a recovery plan attached (one plan per NEW alert, never per run). */
  recovered: number
  /** People whose score threw — counted, never swallowed silently. */
  errors: number
  /** Sources that hit the page cap — the population may be incomplete. */
  inputsCapped: FatigueInputSource[]
}

/** TOMBSTONE (lane 87A) — the name `BuyerFatigueSweepResult` (lane 86G2) is retired with
 *  calculateAllBuyerFatigue; survivor: FatigueSweepResult above (a superset — total /
 *  scored / recovered / errors keep their meaning). */

export interface FatigueSweepOptions {
  /** Max people scored this run (default FATIGUE_SWEEP_DEFAULT_MAX_PERSONS). */
  maxPersons?: number
  /** An AGENT'S OWN BOOK only (contacts.agent_id = this agents.id) — resolved by the caller from
   *  the session (app/actions/buyer-fatigue.ts recalculateBrokerageFatigue's agent path). */
  bookAgentId?: string | null
  /** People scored in parallel (default 4). */
  concurrency?: number
}

/**
 * THE fatigue sweep — ONE core, TWO scopes (wave 87, lane 87A):
 *   · PLATFORM — app/api/fatigue/cron (CRON_SECRET-verified, every 12h through
 *     lib/kernel/cron-dispatch.ts) passes platformScope(reason): every tenant;
 *   · BROKERAGE — app/actions/buyer-fatigue.ts recalculateBrokerageFatigue (a
 *     tenant admin's "Recalculate") passes tenantScope(SESSION brokerage).
 * The population is loadFatigueSweepPopulation — the people the formula's inputs
 * name — never a stage list.
 *
 * TOMBSTONE (lane 87A): `calculateAllBuyerFatigue` (lane 86G2) — its population was
 * the shared active-buyer ladder BUYER_ACTIVE_STAGES, i.e. not derived from the
 * calculation, and it regenerated an AI recovery plan for EVERY high/critical buyer
 * on EVERY 12h run (overwriting the last one). Survivor: runFatigueSweep (here),
 * which carries its tenant scope, its thrown read refusal, deleted_at IS NULL and
 * brokerage_id NOT NULL, and attaches a plan once per NEW alert.
 *
 * COST-AWARE: people are scored stalest-first up to `maxPersons` (the rest are
 * counted `deferred`) with bounded concurrency; each person is ~16 bounded reads + 1
 * counted write (see DEFAULT_CONCURRENCY); the only model calls happen when a NEW alert is raised (the alert note and
 * its recovery plan, both routed + booked under `buyer_fatigue_coaching`).
 */
export async function runFatigueSweep(scope: TenantScope, opts: FatigueSweepOptions = {}): Promise<FatigueSweepResult> {
  const maxPersons = Math.max(0, Math.floor(opts.maxPersons ?? FATIGUE_SWEEP_DEFAULT_MAX_PERSONS))
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY))

  const pop = await loadFatigueSweepPopulation(scope, undefined, { bookAgentId: opts.bookAgentId ?? null })
  const batch = pop.persons.slice(0, maxPersons)

  const result: FatigueSweepResult = {
    scope: scope.kind,
    withInputs: pop.withInputs,
    excluded: pop.excluded,
    total: pop.persons.length,
    fromLeads: pop.persons.filter((p) => p.fromLead).length,
    leadsWithoutInputs: pop.leadsWithoutInputs,
    scored: 0,
    deferred: pop.persons.length - batch.length,
    alertsRaised: 0,
    recovered: 0,
    errors: 0,
    inputsCapped: pop.inputsCapped,
  }

  for (const slice of chunk(batch, concurrency)) {
    const settled = await Promise.allSettled(slice.map(async (person) => {
      // calculateFatigue re-pins the contact to person.brokerageId (read from the
      // tenant-scoped anchor, never from a caller) before any write.
      const scored = await calculateFatigue(person.contactId, person.brokerageId)
      let recovered = false
      if (scored.alert_raised) {
        // Best-effort: a plan failure never un-counts the score.
        try {
          const recovery = await generateRecoveryPlan(scored)
          recovered = recovery.success
        } catch (planErr) {
          console.warn("[fatigue-sweep] recovery plan failed for", person.contactId, planErr)
        }
      }
      return { scored, recovered }
    }))
    settled.forEach((s, i) => {
      if (s.status === "rejected") {
        console.error("[fatigue-sweep] score failed for", slice[i].contactId, s.reason)
        result.errors++
        return
      }
      result.scored++
      if (s.value.scored.alert_raised) result.alertsRaised++
      if (s.value.recovered) result.recovered++
    })
  }

  return result
}
