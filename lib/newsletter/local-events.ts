// lib/newsletter/local-events.ts
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL EVENTS AS NEWSLETTER INPUT AND BROAD CONTENT OPPORTUNITY (wave 154, lane 154G3 — directive G8, owner ruling R8).
//
// NOT A SECOND EVENTS ENGINE. The survivors this composes (named, none replaced):
//   · lib/content-intel/local-intel.ts — the verified local-fact pass (web search / news / a tenant's own feeds) and the ONE
//     reader the newsletter writer grounds on (loadLocalFacts, read by lib/kernel/content-creators.ts). Its steering screen
//     (EXCLUDED_TOPIC_RULES) and parseIcsEvents are reused here. What it did NOT do, and this module adds: per-source RIGHTS
//     (a typed source class with its permitted access), cancellation / reschedule (parseIcsEvents skips CANCELLED events, so a
//     cancellation was invisible), a time zone, a virtual location, tenant-created events, one event → several ORIGINAL
//     opportunities, and correction of already-derived drafts.
//   · lib/content-intel/topic-intake.ts — THE ONE typed insert into content_topic_bank (intakeTopicIdeas) and its retirement
//     door (reevaluateRemovedTopicSource). Nothing here inserts into content_topic_bank directly.
//   · content_topic_uses — the topic → asset lineage every producer writes (lib/content-intel/performance-aggregator.ts
//     logTopicUses). A correction walks it to the newsletter_campaigns / social_posts rows that carry the obsolete date.
//   · lib/ai-isa/followup-arbiter.ts arbitrateFollowUp — THE arbiter door (lane 154H owns the file; called, never edited),
//     over a closed menu, the way lib/lead-magnets/lead-magnet-package.ts arbitrateLeadMagnetOpportunity calls it.
//   · approval_items item_type local_campaign_idea (local-intel LOCAL_CAMPAIGN_IDEA_ITEM_TYPE) — the existing queue a chosen
//     opportunity is filed into; loadApprovedLocalCampaignIdeas is its existing reader.
//   · lib/lead-pipeline/scrape-territories.ts resolveActivePullGate — the ONE territory gate (relevance to the territory).
//   · lib/kernel/action-ledger.ts withActionLedger — every pass, decision and correction is evidence (LAW 5).
//
// EVENTS ARE CONTEXT, NEVER PROOF OF A PERSON. No RSVP, attendee, registrant, Contact or Lead is read or written here; a
// listing is a neutral community listing unless the tenant HOSTS or SPONSORS the event (then, and only then, an invitation
// opportunity exists and the brief says so). Each tenant's opportunities carry only that tenant's brand owner.
//
// Not server-only: scripts/events-and-circles-guard.ts drives everything with recording fakes; every provider / ledger /
// arbiter / intake edge is an injectable dep and the real survivor loads lazily.

import type { TopicIdea, TopicIntakeResult, TopicRights } from "@/lib/content-intel/topic-intake"

type Db = { from: (table: string) => any }

// ── Source classes and their rights (one generic scraper is authorized for nothing) ─────────────────────────────────

const EVENT_SOURCE_CLASSES = [
  "city_county_calendar", "parks_calendar", "library_calendar", "chamber_of_commerce", "tourism_or_venue_organizer",
  "tenant_created", "licensed_event_feed",
] as const
type EventSourceClass = (typeof EVENT_SOURCE_CLASSES)[number]

/** How a source may be read. There is deliberately no "web page scrape" access: an event page is never scraped. */
const EVENT_SOURCE_ACCESS = ["publisher_syndication_feed", "licensed_api", "tenant_owned"] as const
type EventSourceAccess = (typeof EVENT_SOURCE_ACCESS)[number]

const CLASS_ACCESS: Readonly<Record<EventSourceClass, readonly EventSourceAccess[]>> = {
  city_county_calendar: ["publisher_syndication_feed"],
  parks_calendar: ["publisher_syndication_feed"],
  library_calendar: ["publisher_syndication_feed"],
  chamber_of_commerce: ["publisher_syndication_feed"],
  tourism_or_venue_organizer: ["publisher_syndication_feed"],
  tenant_created: ["tenant_owned"],
  licensed_event_feed: ["licensed_api"],
}
/** The topic-intake rights each access stores under (the stored title is always the system's reworded topic). */
const ACCESS_RIGHTS: Readonly<Record<EventSourceAccess, TopicRights>> = {
  publisher_syndication_feed: "public_read_reworded",
  licensed_api: "licensed",
  tenant_owned: "own_content",
}

export interface EventSource {
  id: string
  brokerageId: string
  label: string
  sourceClass: EventSourceClass | string
  access: EventSourceAccess | string
  /** The feed the publisher offers (syndication) or the API endpoint (licensed). */
  url: string | null
  /** The recorded access right: who recorded it, when, and the terms it rests on. */
  rights: { termsNote: string | null; recordedBy: string | null; recordedAt: string | null; licenseRef: string | null }
  /** The place the source itself covers (a virtual event is relevant only through it). */
  territory: { city: string | null; state: string | null; zip: string | null } | null
  lastRunAt: string | null
}

/** PURE — may this source be read at all, and under which rights? A refusal names its reason. */
export function authorizeEventSource(s: EventSource): { ok: true; rights: TopicRights } | { ok: false; reason: string } {
  if (!(EVENT_SOURCE_CLASSES as readonly string[]).includes(s.sourceClass)) return { ok: false, reason: "unknown_source_class" }
  if (!(EVENT_SOURCE_ACCESS as readonly string[]).includes(s.access)) return { ok: false, reason: "access_not_authorized" }
  const cls = s.sourceClass as EventSourceClass, acc = s.access as EventSourceAccess
  if (!CLASS_ACCESS[cls].includes(acc)) return { ok: false, reason: `access_not_authorized_for_class:${cls}` }
  if (acc === "licensed_api" && !s.rights.licenseRef) return { ok: false, reason: "license_not_on_record" }
  if (acc === "publisher_syndication_feed") {
    if (!s.url) return { ok: false, reason: "no_feed_url" }
    if (!s.rights.termsNote || !s.rights.recordedAt) return { ok: false, reason: "rights_not_recorded" }
  }
  return { ok: true, rights: ACCESS_RIGHTS[acc] }
}

// ── The event record (what a transport hands back) ───────────────────────────────────────────────────────────────

const EVENT_STATUSES = ["scheduled", "rescheduled", "postponed", "canceled"] as const
type EventStatus = (typeof EVENT_STATUSES)[number]

export interface RawEvent {
  /** Stable within its source: an iCalendar UID, an API id, the tenant's own event id. */
  sourceEventKey: string
  /** The official event page (or the feed entry identifier). Required: no identifier, no topic. */
  url: string | null
  title: string
  location: { kind: "physical" | "virtual" | "unknown"; venue: string | null; city: string | null; state: string | null; zip: string | null; virtualUrl: string | null }
  start: { date: string | null; time: string | null; timeZone: string | null }
  end: { date: string | null; time: string | null; timeZone: string | null } | null
  status: EventStatus | string
  /** The tenant hosts / sponsors it — only then may an invitation exist or sponsorship be implied. */
  hostedByTenant?: boolean
  sponsoredByTenant?: boolean
}

type EventTransport = (s: EventSource, ctx: { brokerageId: string; now: Date }) => Promise<{ ok: true; events: RawEvent[] } | { ok: false; reason: string }>

const YMD = /^\d{4}-\d{2}-\d{2}$/
const HM = /^\d{2}:\d{2}$/
const DAY_MS = 86_400_000
const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim()
const validYmd = (v: string | null | undefined): v is string => !!v && YMD.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`))

interface VerifiedEvent {
  source: EventSource
  rights: TopicRights
  ev: RawEvent
  identity: string
  startDate: string
  endDate: string | null
  /** A time is stated only with its zone; a time without a zone is dropped (the date stands). */
  startTime: string | null
  timeZone: string | null
  timeNote: string | null
  area: { city: string | null; state: string | null; zip: string | null }
  listingKind: "neutral_community_listing" | "tenant_hosted" | "tenant_sponsored"
  expiresAt: string
}

const STOP = new Set(["the", "a", "an", "and", "of", "in", "at", "on", "for", "to", "with", "annual", "presents"])
/** PURE — one real-world event, however many calendars syndicate it: its date + place + leading title words. */
function eventIdentity(title: string, startDate: string, city: string | null): string {
  const toks = clean(title).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((t) => t.length > 1 && !STOP.has(t)).slice(0, 6)
  return `${startDate}|${clean(city).toLowerCase()}|${toks.join(" ")}`
}

/**
 * PURE — the verification gate. Nothing is generated or sent on an unverified date or location, a canceled / postponed event,
 * a past event, an event outside the tenant's territory, or a steering topic. Returns the counted reason otherwise.
 * `screen` is local-intel's steering screen + the fair-housing scan (injected; production default loads them lazily).
 */
function verifyEvent(
  ev: RawEvent, s: EventSource, rights: TopicRights,
  ctx: { now: Date; inTerritory: (a: { city: string | null; state: string | null; zip: string | null }) => boolean; screen: (text: string) => string | null },
): { ok: true; event: VerifiedEvent } | { ok: false; reason: string } {
  const status = clean(ev.status).toLowerCase()
  if (status === "canceled" || status === "cancelled") return { ok: false, reason: "canceled" }
  if (status === "postponed") return { ok: false, reason: "postponed_no_date" }
  if (!(EVENT_STATUSES as readonly string[]).includes(status)) return { ok: false, reason: "unknown_status" }
  const title = clean(ev.title)
  if (!title) return { ok: false, reason: "no_title" }
  if (!clean(ev.url) || !/^https?:\/\//i.test(clean(ev.url))) return { ok: false, reason: "no_event_url" }
  if (!validYmd(ev.start?.date)) return { ok: false, reason: "unverified_date" }
  const startDate = ev.start.date
  const endDate = validYmd(ev.end?.date) && ev.end!.date! >= startDate ? ev.end!.date! : null
  const loc = ev.location ?? { kind: "unknown", venue: null, city: null, state: null, zip: null, virtualUrl: null }
  if (loc.kind === "unknown") return { ok: false, reason: "unverified_location" }
  if (loc.kind === "physical" && !clean(loc.city) && !clean(loc.zip)) return { ok: false, reason: "unverified_location" }
  if (loc.kind === "virtual" && !/^https?:\/\//i.test(clean(loc.virtualUrl))) return { ok: false, reason: "unverified_location" }
  const lastDay = endDate ?? startDate
  const expiresAt = new Date(Date.parse(`${lastDay}T00:00:00Z`) + DAY_MS + 12 * 3_600_000).toISOString()
  if (ctx.now.getTime() >= Date.parse(expiresAt)) return { ok: false, reason: "past" }
  // A virtual event belongs to a place only through the source that covers that place.
  const area = loc.kind === "virtual"
    ? { city: s.territory?.city ?? null, state: s.territory?.state ?? null, zip: s.territory?.zip ?? null }
    : { city: clean(loc.city) || null, state: clean(loc.state).toUpperCase() || s.territory?.state || null, zip: clean(loc.zip) || null }
  if (!area.city && !area.zip) return { ok: false, reason: "outside_territory" }
  if (!ctx.inTerritory(area)) return { ok: false, reason: "outside_territory" }
  const screened = ctx.screen(`${title} ${clean(loc.venue)}`)
  if (screened) return { ok: false, reason: screened }
  let startTime: string | null = null, timeZone: string | null = null, timeNote: string | null = null
  if (ev.start.time && HM.test(ev.start.time)) {
    if (ev.start.timeZone && clean(ev.start.timeZone)) { startTime = ev.start.time; timeZone = clean(ev.start.timeZone) }
    else timeNote = "the source states a time without a time zone — name the date only"
  }
  const listingKind = ev.hostedByTenant ? "tenant_hosted" : ev.sponsoredByTenant ? "tenant_sponsored" : "neutral_community_listing"
  return { ok: true, event: { source: s, rights, ev: { ...ev, title }, identity: eventIdentity(title, startDate, area.city ?? area.zip), startDate, endDate, startTime, timeZone, timeNote, area, listingKind, expiresAt } }
}

// ── One verified event → several ORIGINAL opportunities ──────────────────────────────────────────────────────────

const EVENT_OPPORTUNITY_FORMATS = [
  "newsletter_listing", "weekend_roundup", "what_to_know_reel", "neighborhood_guide", "relocation_guide", "event_resource_page", "tenant_invitation",
] as const
type EventOpportunityFormat = (typeof EVENT_OPPORTUNITY_FORMATS)[number]

/** The channel each format rides when the arbiter chooses it (arbiter channel vocabulary; a web resource has none). */
const FORMAT_CHANNEL: Readonly<Record<EventOpportunityFormat, "email" | "social" | null>> = {
  newsletter_listing: "email", weekend_roundup: "social", what_to_know_reel: "social", neighborhood_guide: null,
  relocation_guide: null, event_resource_page: null, tenant_invitation: "email",
}

function fmtDay(ymd: string): string {
  return new Date(`${ymd}T12:00:00.000Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
}

/** PURE — the topic ideas one verified event yields. Each is a REWORDED topic (the event's name is a fact; no source copy is
 *  stored — not its description, not its blurb). The newsletter listing alone carries `local_fact`, so the newsletter
 *  writer's existing grounding reader (loadLocalFacts) sees ONE row per event, not seven. An invitation exists only for an
 *  event the tenant hosts or sponsors. */
function eventOpportunityIdeas(v: VerifiedEvent, brokerageId: string, now: Date): TopicIdea[] {
  const name = v.ev.title.slice(0, 70)
  const place = v.area.city ?? v.area.zip ?? "the area"
  const when = v.endDate ? `${fmtDay(v.startDate)}–${fmtDay(v.endDate)}` : fmtDay(v.startDate)
  const titles: Record<EventOpportunityFormat, string> = {
    newsletter_listing: `Community calendar: ${name} in ${place} (${when})`,
    weekend_roundup: `What's happening around ${place} the weekend of ${fmtDay(v.startDate)}`,
    what_to_know_reel: `Going to ${name}? What to know before you go`,
    neighborhood_guide: `Exploring ${place} around ${name}: a neighborhood guide`,
    relocation_guide: `New to ${place}? Community events like ${name} worth knowing`,
    event_resource_page: `${name} (${when}): getting there, timing and local tips`,
    tenant_invitation: `You're invited: ${name} (${when})`,
  }
  const sponsorship = v.listingKind === "neutral_community_listing"
    ? "NEUTRAL COMMUNITY LISTING — the brokerage does not host or sponsor this event; never imply endorsement or sponsorship"
    : v.listingKind === "tenant_hosted" ? "the brokerage HOSTS this event" : "the brokerage SPONSORS this event (say so plainly)"
  const formats = EVENT_OPPORTUNITY_FORMATS.filter((f) => f !== "tenant_invitation" || v.listingKind !== "neutral_community_listing")
  const localEvent = {
    source_event_key: `${v.source.id}:${v.ev.sourceEventKey}`, identity: v.identity, source_id: v.source.id, source_class: v.source.sourceClass,
    source_label: v.source.label, access: v.source.access, url: v.ev.url, status: clean(v.ev.status).toLowerCase(),
    start_date: v.startDate, end_date: v.endDate, start_time: v.startTime, time_zone: v.timeZone, time_note: v.timeNote,
    location_kind: v.ev.location.kind, venue: v.ev.location.venue ?? null, virtual_url: v.ev.location.kind === "virtual" ? v.ev.location.virtualUrl : null,
    area: v.area, listing_kind: v.listingKind, last_verified_at: now.toISOString(),
  }
  return formats.map((fmt): TopicIdea => ({
    sourceKind: "local_event",
    title: titles[fmt].slice(0, 220),
    angle: `${fmt.replace(/_/g, " ")} — an ORIGINAL piece in the agent's own voice about a verified local event (${when}${v.startTime ? ` ${v.startTime} ${v.timeZone}` : ""}, per ${v.source.label}); credit and link the source; ${sponsorship}. Events are context, never a claim about who attends.`,
    categories: ["neighborhood", "local_event", `event_format:${fmt}`, ...(fmt === "newsletter_listing" ? ["local_intel"] : [])],
    geo: { city: v.area.city, state: v.area.state, zip: v.area.zip, label: place },
    sourceUrl: v.ev.url,
    publishedAt: null,
    observedAt: now.toISOString(),
    expiresAt: v.expiresAt,
    evidence: { kind: "unknown", note: "an event listing carries no popularity measure" },
    rights: v.rights,
    dedupKey: `evt:${v.identity}|fmt:${fmt}`,
    brief: {
      observation_key: `${v.source.id}:${v.ev.sourceEventKey}`,
      transport: v.source.access,
      topic_concept: titles[fmt],
      format_pattern: fmt,
      suggested_original_formats: [fmt],
      localization_opportunity: place,
      proof_needed: "the official date, time zone and location from the source — re-verified before anything is published",
      brand_owner_brokerage_id: brokerageId,
      local_event: localEvent,
      ...(fmt === "newsletter_listing" ? {
        local_fact: {
          kind: "local_event", publisher: v.source.label, host: hostOf(v.ev.url), provider: "event_source", source_class: v.source.sourceClass,
          published_at: null, event_start: v.startDate, event_end: v.endDate, date_basis: "source_calendar", venue: v.ev.location.venue ?? null,
          territory: { city: v.area.city, state: v.area.state, zipCodes: v.area.zip ? [v.area.zip] : [] }, confidence: null,
          rights: "title, date, place and link only — never the source's description",
        },
      } : {}),
    },
  }))
}

function hostOf(u: string | null): string | null { try { return u ? new URL(u).hostname.replace(/^www\./, "") : null } catch { return null } }

// ── Corrections: a reschedule or a cancellation propagates through the same lineage ─────────────────────────────

interface CorrectionResult {
  topicsRetired: number
  topicsCorrected: number
  newslettersHeld: number
  socialPostsHeld: number
  alreadyDelivered: number
  notHoldable: Record<string, number>
  errors: string[]
}

/**
 * Hold every draft derived from an event's topics (content_topic_uses → newsletter_campaigns / social_posts) so nothing goes
 * out carrying an obsolete date. A held newsletter is 'deferred' + 'pending_review' (the senders select only 'scheduled' +
 * 'approved'); a held social post is 'draft' + 'pending'. Something already sent / publishing is counted, never pretended
 * unsent. Tenant-pinned; every write `.select("id")`s and counts (CLAUDE.md §3). Never throws.
 */
async function holdDerivedDrafts(db: Db, brokerageId: string, topicIds: readonly string[], reason: string): Promise<Omit<CorrectionResult, "topicsRetired" | "topicsCorrected">> {
  const out = { newslettersHeld: 0, socialPostsHeld: 0, alreadyDelivered: 0, notHoldable: {} as Record<string, number>, errors: [] as string[] }
  if (!brokerageId || topicIds.length === 0) return out
  const { data: uses, error } = await db.from("content_topic_uses").select("asset_type, asset_id").eq("brokerage_id", brokerageId).in("topic_id", [...topicIds])
  if (error) { out.errors.push(`content_topic_uses read refused — nothing held: ${error.message ?? "unknown"}`); return out }
  const byType = new Map<string, string[]>()
  for (const u of (uses ?? []) as Array<{ asset_type: string; asset_id: string | null }>) if (u.asset_id) byType.set(u.asset_type, [...(byType.get(u.asset_type) ?? []), u.asset_id])
  const hold = async (table: "newsletter_campaigns" | "social_posts", ids: string[], holdable: string[], patch: Record<string, unknown>) => {
    const { data: rows, error: rErr } = await db.from(table).select("id, status").eq("brokerage_id", brokerageId).in("id", ids)
    if (rErr) { out.errors.push(`${table} read refused: ${rErr.message ?? "unknown"}`); return 0 }
    const list = (rows ?? []) as Array<{ id: string; status: string | null }>
    out.alreadyDelivered += list.filter((r) => !holdable.includes(String(r.status))).length
    const target = list.filter((r) => holdable.includes(String(r.status))).map((r) => r.id)
    if (target.length === 0) return 0
    const { data: upd, error: uErr } = await db.from(table).update(patch).eq("brokerage_id", brokerageId).in("id", target).in("status", holdable).select("id")
    if (uErr) { out.errors.push(`${table} hold refused: ${uErr.message ?? "unknown"}`); return 0 }
    const n = (upd ?? []).length
    if (n !== target.length) out.errors.push(`${table} hold matched ${n} of ${target.length}`)
    return n
  }
  for (const [type, ids] of byType) {
    if (type === "newsletter_campaign") out.newslettersHeld += await hold("newsletter_campaigns", ids, ["draft", "scheduled", "deferred"], { status: "deferred", approval_status: "pending_review", defer_reason: reason.slice(0, 300) })
    else if (type === "social_post") out.socialPostsHeld += await hold("social_posts", ids, ["draft", "scheduled", "failed"], { status: "draft", approval_status: "pending", error_message: reason.slice(0, 300) })
    else out.notHoldable[type] = (out.notHoldable[type] ?? 0) + ids.length
  }
  return out
}

export interface EventDeps {
  now?: Date
  intake?: (db: Db, args: { brokerageId: string; ideas: readonly TopicIdea[]; now?: Date }) => Promise<TopicIntakeResult>
  retire?: (db: Db, args: { brokerageId: string; sourceUrl: string; disposition: "deleted" | "superseded"; now?: Date }) => Promise<{ ok: boolean; retired: number; kept: number; error: string | null }>
  ledger?: <T>(ctx: { brokerageId: string; action: string; key: string; detail: Record<string, unknown>; reason: string }, run: () => Promise<T>, replay: (refused: boolean) => T) => Promise<T>
  transports?: Partial<Record<EventSourceAccess, EventTransport>>
  inTerritory?: (brokerageId: string) => Promise<(a: { city: string | null; state: string | null; zip: string | null }) => boolean>
  screen?: () => Promise<(text: string) => string | null>
  decide?: import("@/lib/ai-isa/followup-arbiter").ArbiterDecide
  arbiter?: typeof import("@/lib/ai-isa/followup-arbiter").arbitrateFollowUp
  policy?: import("@/lib/ai-isa/followup-policy").FollowupPolicy
  /** The syndication transport's fetch (default: the connector gateway's rss connector). Proofs inject it; it is counted by the pass. */
  fetchText?: (url: string, brokerageId: string) => Promise<{ ok: boolean; status: number | null; text: string | null }>
}

const defaultIntake: NonNullable<EventDeps["intake"]> = async (db, a) => (await import("@/lib/content-intel/topic-intake")).intakeTopicIdeas(db, a)
const defaultRetire: NonNullable<EventDeps["retire"]> = async (db, a) => (await import("@/lib/content-intel/topic-intake")).reevaluateRemovedTopicSource(db, a)
function defaultLedger(db: Db): NonNullable<EventDeps["ledger"]> {
  return async (c, run, replay) => {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    return withActionLedger(
      { brokerageId: c.brokerageId, action: c.action, actor: { type: "manager", managerKey: "campaign_orchestrator" }, subject: { type: "brokerage", id: c.brokerageId }, idempotencyKey: c.key, riskClass: "LOW_RISK_WRITE", systemSource: "local_events", reasonCode: "CAMPAIGN_STEP", reasonDetail: c.reason.slice(0, 500), detail: c.detail },
      run,
      { settle: () => ({ status: "executed" as const, outcome: "done" }), replay: (claim) => replay(claim.kind === "refused") },
      { client: db as never },
    )
  }
}

/**
 * A RESCHEDULE OR CANCELLATION of one event (by its source key), through the same lineage it was produced on:
 *   1. each topic row of the event is re-observed through the ONE intake with its status and `local_fact: null` — so the
 *      newsletter writer's grounding reader stops naming it (a 'used' row keeps its status, but loses its fact);
 *   2. its URL leaves the pool through reevaluateRemovedTopicSource ('deleted' for a cancellation, 'superseded' for a
 *      reschedule — the new date is a NEW event identity, intaken on its own);
 *   3. every draft derived from those topics is HELD (holdDerivedDrafts) — revised before it may go, never sent wrong.
 * Ledgered (marketing.local_event.correct, idempotent per event / status / new date). Never throws.
 */
async function correctEvent(db: Db, brokerageId: string, change: { sourceEventKey: string; status: "canceled" | "rescheduled"; newStartDate?: string | null; note?: string | null }, deps: EventDeps = {}): Promise<CorrectionResult> {
  const out: CorrectionResult = { topicsRetired: 0, topicsCorrected: 0, newslettersHeld: 0, socialPostsHeld: 0, alreadyDelivered: 0, notHoldable: {}, errors: [] }
  const now = deps.now ?? new Date()
  try {
    if (!brokerageId) { out.errors.push("no tenant"); return out }
    const { data, error } = await db.from("content_topic_bank").select("id, topic_title, status, source_url, raw_data")
      .eq("brokerage_id", brokerageId).eq("raw_data->local_event->>source_event_key", change.sourceEventKey)
    if (error) { out.errors.push(`content_topic_bank read refused — nothing corrected: ${error.message ?? "unknown"}`); return out }
    const rows = ((data ?? []) as Array<{ id: string; topic_title: string; status: string; source_url: string | null; raw_data: Record<string, any> | null }>)
      .filter((r) => { const le = r.raw_data?.local_event; return !!le && !le.corrected_at && (change.status === "canceled" || le.start_date !== change.newStartDate) })
    if (rows.length === 0) return out
    const ledger = deps.ledger ?? defaultLedger(db)
    const reason = change.status === "canceled" ? `event_canceled:${change.sourceEventKey}` : `event_rescheduled:${rows[0].raw_data!.local_event.start_date}->${change.newStartDate ?? "unknown"}`
    return await ledger({ brokerageId, action: "marketing.local_event.correct", key: `local_event_correct:${brokerageId}:${change.sourceEventKey}:${change.status}:${change.newStartDate ?? ""}`, reason, detail: { change, topics: rows.map((r) => r.id) } }, async () => {
      const intake = deps.intake ?? defaultIntake
      const retire = deps.retire ?? defaultRetire
      const ideas: TopicIdea[] = rows.map((r) => ({
        sourceKind: "local_event", title: r.topic_title, observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + DAY_MS).toISOString(),
        sourceUrl: r.source_url, evidence: { kind: "unknown", note: `event ${change.status}` }, rights: (r.raw_data?.intake?.rights as TopicRights) ?? "public_read_reworded",
        dedupKey: typeof r.raw_data?.dedup_key === "string" ? r.raw_data.dedup_key : null,
        brief: { observation_key: `correction:${change.sourceEventKey}:${change.status}`, local_fact: null, local_event: { ...r.raw_data!.local_event, status: change.status, corrected_at: now.toISOString(), rescheduled_to: change.newStartDate ?? null, correction_note: change.note ?? null } },
      }))
      const res = await intake(db, { brokerageId, ideas, now })
      out.topicsCorrected = res.merged
      out.errors.push(...res.errors, ...res.excluded.map((e) => `correction refused by intake (${e.title}): ${e.reason}`))
      for (const url of new Set(rows.map((r) => r.source_url).filter((u): u is string => !!u))) {
        const r = await retire(db, { brokerageId, sourceUrl: url, disposition: change.status === "canceled" ? "deleted" : "superseded", now })
        out.topicsRetired += r.retired
        if (r.error) out.errors.push(r.error)
      }
      const held = await holdDerivedDrafts(db, brokerageId, rows.map((r) => r.id), reason)
      Object.assign(out, { ...held, errors: [...out.errors, ...held.errors] })
      return out
    }, (refused) => ({ ...out, errors: [refused ? "the action ledger refused the correction — nothing changed" : "already corrected (replay)"] }))
  } catch (e) {
    out.errors.push(`correctEvent threw: ${(e as Error)?.message ?? String(e)}`)
    return out
  }
}

// ── The arbiter decides which channel (or none) a verified event earns now ──────────────────────────────────────

interface EventDecision { optionId: string; channel: string | null; source: string; rationale: string; filed: boolean; error: string | null }

const EVENT_ARBITER_SYSTEM = `You are the brokerage's content arbiter for ONE verified local event. Choose ONE option from the menu: the original
content format that serves the brokerage's community best right now, or decline. A neutral community listing never implies
the brokerage sponsors the event. An event is context: never claim who attends. Output the typed reply (optionId from the menu,
channel null, format null, waitHours only for wait, a one-sentence rationale naming the evidence, evidence keys, confidence 0..1).`

/**
 * THE ARBITER'S CHOICE for one verified event, through its existing door (arbitrateFollowUp) over a closed menu of the formats
 * actually intaken + decline. The planned verdict (outage / refusal / arbiter off) is the newsletter listing — what the newsletter
 * writer already does with a verified local fact. A chosen non-decline format is filed as a PENDING local_campaign_idea approval
 * item on the event's listing row (the existing queue + reader); a person approves before anything is produced. Ledgered.
 */
async function decideEventOpportunity(db: Db, brokerageId: string, v: { identity: string; title: string; listingTopicId: string; formats: EventOpportunityFormat[]; listingKind: VerifiedEvent["listingKind"]; startDate: string; area: string }, deps: EventDeps = {}): Promise<EventDecision> {
  const now = deps.now ?? new Date()
  try {
    const A = deps.arbiter ?? (await import("@/lib/ai-isa/followup-arbiter")).arbitrateFollowUp
    const policy = deps.policy ?? (await (await import("@/lib/ai-isa/followup-policy")).loadFollowupPolicy(db as never, brokerageId)).policy
    const menu = [
      ...v.formats.map((f) => ({ id: f, kind: "education" as const, channels: FORMAT_CHANNEL[f] ? [FORMAT_CHANNEL[f]!] : [], why: [`${f.replace(/_/g, " ")} for "${v.title}" (${v.startDate}, ${v.area})`, v.listingKind.replace(/_/g, " ")] })),
      { id: "decline", kind: "wait" as const, channels: [], why: ["the event may not serve this audience; nothing is lost by declining"] },
    ]
    const planned = menu.find((m) => m.id === "newsletter_listing") ?? menu[menu.length - 1]
    const facts = {
      subject: "lead" as const, relationship: { type: "community_audience", persona: null, hasAssignedAgent: false }, intent: null, preferences: [], fatigueRisk: null, localHour: null,
      history: { hoursSinceAnyTouch: null, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: null, portalEducationViews: null },
      journey: { transactionStage: null, nextMilestone: `event on ${v.startDate}`, openLessons: null, nextLesson: null },
      moment: { key: "local_event_opportunity", intent: `A verified local event ("${v.title}", ${v.startDate}, ${v.area}) entered the topic pool. Choose the original format worth producing, or decline.`, daysSinceOpen: 0 },
      blindSpots: ["event attendance is never known and never implied", "audience engagement with past event pieces is not read here"],
    }
    const ledger = deps.ledger ?? defaultLedger(db)
    return await ledger({ brokerageId, action: "marketing.local_event_opportunity.decide", key: `local_event_decide:${brokerageId}:${v.identity}`, reason: `verified local event "${v.title}" (${v.startDate})`, detail: { identity: v.identity, formats: v.formats } }, async (): Promise<EventDecision> => {
      const d = await A({ brokerageId, facts: facts as never, menu: { menu, locked: null }, planned, policy, system: EVENT_ARBITER_SYSTEM }, { decide: deps.decide })
      const opt = menu.find((m) => m.id === d.optionId)
      if (!opt || d.optionId === "decline") return { optionId: "decline", channel: null, source: d.source, rationale: d.rationale, filed: false, error: null }
      const { LOCAL_CAMPAIGN_IDEA_ITEM_TYPE } = await import("@/lib/content-intel/local-intel")
      const { data: prior, error: pErr } = await db.from("approval_items").select("id").eq("brokerage_id", brokerageId).eq("item_type", LOCAL_CAMPAIGN_IDEA_ITEM_TYPE).eq("item_id", v.listingTopicId)
      if (pErr) return { optionId: d.optionId, channel: opt.channels[0] ?? null, source: d.source, rationale: d.rationale, filed: false, error: `approval_items read refused: ${pErr.message ?? "unknown"}` }
      if ((prior ?? []).length > 0) return { optionId: d.optionId, channel: opt.channels[0] ?? null, source: d.source, rationale: d.rationale, filed: false, error: null }
      const { data: ins, error: iErr } = await db.from("approval_items").insert({
        brokerage_id: brokerageId, agent_id: null, item_type: LOCAL_CAMPAIGN_IDEA_ITEM_TYPE, item_id: v.listingTopicId, status: "pending", submitted_at: now.toISOString(),
        review_notes: JSON.stringify({ violations: [], excerpt: `${d.optionId.replace(/_/g, " ")}: ${v.title} (${v.startDate}) — ${d.rationale}`.slice(0, 500) }),
      }).select("id")
      const filed = !iErr && (ins ?? []).length === 1
      return { optionId: d.optionId, channel: opt.channels[0] ?? null, source: d.source, rationale: d.rationale, filed, error: iErr ? `approval_items insert refused: ${iErr.message ?? "unknown"}` : filed ? null : "approval_items insert returned no row" }
    }, (refused) => ({ optionId: "decline", channel: null, source: "replay", rationale: refused ? "the action ledger refused the decision" : "already decided for this event", filed: false, error: refused ? "ledger_refused" : null }))
  } catch (e) {
    return { optionId: "decline", channel: null, source: "deterministic", rationale: "the arbiter could not be asked", filed: false, error: `decideEventOpportunity threw: ${(e as Error)?.message ?? String(e)}` }
  }
}

// ── The pass ───────────────────────────────────────────────────────────────────────────────────────────────────

interface EventPassResult {
  brokerageId: string
  sources: number
  unconfigured: Array<{ sourceId: string; reason: string }>
  transportCalls: Record<string, number>
  events: number
  verified: number
  dropped: Record<string, number>
  inserted: number
  merged: number
  corrections: number
  decisions: EventDecision[]
  /** Sources whose transport answered this pass (their last_run_at may be advanced to the pass's `now`). */
  ranSourceIds: string[]
  errors: string[]
}

/** Read the tenant's typed event sources: content_topic_sources rows whose source_config carries `local_event_source`. */
export async function loadEventSources(db: Db, brokerageId: string): Promise<{ sources: EventSource[]; error: string | null }> {
  const { data, error } = await db.from("content_topic_sources").select("id, brokerage_id, label, source_type, source_config, is_active, last_run_at")
    .eq("brokerage_id", brokerageId).eq("is_active", true).not("source_config->local_event_source", "is", null)
  if (error) return { sources: [], error: `content_topic_sources read refused: ${error.message ?? "unknown"}` }
  const sources = ((data ?? []) as Array<{ id: string; label: string | null; source_config: Record<string, any> | null; last_run_at: string | null }>).map((r): EventSource => {
    const c = (r.source_config?.local_event_source ?? {}) as Record<string, any>
    return {
      id: r.id, brokerageId, label: clean(r.label) || clean(c.publisher) || "event source", sourceClass: String(c.class ?? ""), access: String(c.access ?? ""),
      url: typeof r.source_config?.feed_url === "string" ? r.source_config.feed_url : (typeof c.url === "string" ? c.url : null),
      rights: { termsNote: c.terms_note ?? null, recordedBy: c.rights_recorded_by ?? null, recordedAt: c.rights_recorded_at ?? null, licenseRef: c.license_ref ?? null },
      territory: c.territory ? { city: c.territory.city ?? null, state: c.territory.state ?? null, zip: c.territory.zip ?? null } : null,
      lastRunAt: r.last_run_at,
    }
  })
  return { sources, error: null }
}

/**
 * ONE tenant's event pass: typed sources → authorized → the injected transport for its access (an unconfigured transport says
 * so and returns nothing; every call is counted) → corrections for events whose stored date / status changed → verification →
 * opportunities through the ONE intake → the arbiter's choice for each newly verified event. Tenant from the caller's session
 * or cron scope only. Never throws.
 */
export async function runLocalEventsPass(db: Db, brokerageId: string, deps: EventDeps & { extraEvents?: Array<{ source: EventSource; events: RawEvent[] }>; onlyExtra?: boolean; markRun?: boolean } = {}): Promise<EventPassResult> {
  const now = deps.now ?? new Date()
  const out: EventPassResult = { brokerageId, sources: 0, unconfigured: [], transportCalls: {}, events: 0, verified: 0, dropped: {}, inserted: 0, merged: 0, corrections: 0, decisions: [], ranSourceIds: [], errors: [] }
  const drop = (r: string) => { out.dropped[r] = (out.dropped[r] ?? 0) + 1 }
  try {
    if (!brokerageId) { out.errors.push("no tenant"); return out }
    const loaded = deps.onlyExtra ? { sources: [] as EventSource[], error: null } : await loadEventSources(db, brokerageId)
    if (loaded.error) { out.errors.push(loaded.error); return out }
    const batches: Array<{ source: EventSource; events: RawEvent[] }> = [...(deps.extraEvents ?? [])]
    for (const s of loaded.sources) {
      out.sources++
      const auth = authorizeEventSource(s)
      if (!auth.ok) { out.unconfigured.push({ sourceId: s.id, reason: auth.reason }); continue }
      const transport = (deps.transports ?? defaultTransports(deps.fetchText))[s.access as EventSourceAccess]
      if (!transport) { out.unconfigured.push({ sourceId: s.id, reason: `no transport configured for ${s.access}` }); continue }
      out.transportCalls[s.access] = (out.transportCalls[s.access] ?? 0) + 1
      const r = await transport(s, { brokerageId, now }).catch((e) => ({ ok: false as const, reason: `transport threw: ${(e as Error)?.message ?? e}` }))
      if (!r.ok) { out.unconfigured.push({ sourceId: s.id, reason: r.reason }); continue }
      batches.push({ source: s, events: r.events })
      out.ranSourceIds.push(s.id)
    }
    if (batches.length === 0) return out
    const inTerritory = await (deps.inTerritory ?? defaultInTerritory(db))(brokerageId)
    const screen = await (deps.screen ?? defaultScreen)()
    const intake = deps.intake ?? defaultIntake
    for (const b of batches) {
      const auth = authorizeEventSource(b.source)
      if (!auth.ok) { out.unconfigured.push({ sourceId: b.source.id, reason: auth.reason }); continue }
      const verifiedHere: VerifiedEvent[] = []
      for (const ev of b.events.slice(0, 200)) {
        out.events++
        const key = `${b.source.id}:${ev.sourceEventKey}`
        const status = clean(ev.status).toLowerCase()
        // A stored event whose status or date moved is corrected FIRST, through its own lineage.
        const { data: prior, error: pErr } = await db.from("content_topic_bank").select("id, raw_data").eq("brokerage_id", brokerageId).eq("raw_data->local_event->>source_event_key", key).limit(20)
        if (pErr) { out.errors.push(`prior read refused (${key}): ${pErr.message ?? "unknown"}`); continue }
        const was = ((prior ?? []) as Array<{ raw_data: Record<string, any> | null }>).map((p) => p.raw_data?.local_event).find((le) => le && !le.corrected_at)
        if (was && (status === "canceled" || status === "cancelled" || status === "postponed")) {
          const c = await correctEvent(db, brokerageId, { sourceEventKey: key, status: "canceled", note: status }, deps)
          out.corrections++; out.errors.push(...c.errors.filter((e) => !e.startsWith("already")))
        } else if (was && validYmd(ev.start?.date) && (was.start_date !== ev.start.date || (was.start_time ?? null) !== (ev.start.time ?? null))) {
          const c = await correctEvent(db, brokerageId, { sourceEventKey: key, status: "rescheduled", newStartDate: ev.start.date }, deps)
          out.corrections++; out.errors.push(...c.errors.filter((e) => !e.startsWith("already")))
        }
        const v = verifyEvent(ev, b.source, auth.rights, { now, inTerritory, screen })
        if (!v.ok) { drop(v.reason); continue }
        out.verified++
        verifiedHere.push(v.event)
      }
      if (verifiedHere.length === 0) continue
      const res = await intake(db, { brokerageId, ideas: verifiedHere.flatMap((v) => eventOpportunityIdeas(v, brokerageId, now)), now })
      out.inserted += res.inserted; out.merged += res.merged
      out.errors.push(...res.errors)
      for (const e of res.excluded) drop(`intake:${e.reason}`)
      for (const v of verifiedHere) {
        const listing = res.rows.find((r) => r.dedupKey === `evt:${v.identity}|fmt:newsletter_listing`)
        if (!listing?.isNew) continue
        const formats = EVENT_OPPORTUNITY_FORMATS.filter((f) => res.rows.some((r) => r.dedupKey === `evt:${v.identity}|fmt:${f}`))
        out.decisions.push(await decideEventOpportunity(db, brokerageId, { identity: v.identity, title: v.ev.title, listingTopicId: listing.id, formats, listingKind: v.listingKind, startDate: v.startDate, area: v.area.city ?? v.area.zip ?? "" }, deps))
      }
    }
    // The run mark a vanished listing reads STALE against (loadEventOpportunities). It is the pass's own `now`, so what this
    // pass verified is not stale. Ledgered (marketing.local_events.pass); only sources whose transport answered are marked.
    if (deps.markRun && out.ranSourceIds.length) {
      const ledger = deps.ledger ?? defaultLedger(db)
      const marked = await ledger({ brokerageId, action: "marketing.local_events.pass", key: `local_events_pass:${brokerageId}:${now.toISOString()}`, reason: "typed event sources read", detail: { sources: out.ranSourceIds, verified: out.verified, corrections: out.corrections } }, async () => {
        const { data, error } = await db.from("content_topic_sources").update({ last_run_at: now.toISOString() }).eq("brokerage_id", brokerageId).in("id", out.ranSourceIds).select("id")
        return error ? `last_run_at not advanced: ${error.message ?? "unknown"}` : (data ?? []).length === out.ranSourceIds.length ? null : `last_run_at advanced on ${(data ?? []).length} of ${out.ranSourceIds.length}`
      }, (refused) => (refused ? "the action ledger refused the run mark" : null))
      if (marked) out.errors.push(marked)
    }
    return out
  } catch (e) {
    out.errors.push(`runLocalEventsPass threw: ${(e as Error)?.message ?? String(e)}`)
    return out
  }
}

/** A tenant-created event, as a RawEvent of the tenant's own (tenant_owned) source. */
export function tenantEventSource(brokerageId: string, brokerageLabel: string, userId: string, now: Date): EventSource {
  return { id: `tenant:${brokerageId}`, brokerageId, label: brokerageLabel, sourceClass: "tenant_created", access: "tenant_owned", url: null, rights: { termsNote: "the brokerage's own event", recordedBy: userId, recordedAt: now.toISOString(), licenseRef: null }, territory: null, lastRunAt: null }
}

// ── Readers ───────────────────────────────────────────────────────────────────────────────────────────────────

interface EventOpportunityView { topicId: string; title: string; format: string; startDate: string | null; status: string; listingKind: string | null; sourceLabel: string | null; url: string | null; stale: boolean }

/**
 * The tenant's live event opportunities, every format. A canceled / rescheduled event is withheld; a listing its source no longer
 * carries (last verified before the source's last successful run) is marked STALE and never offered for production. Tenant-pinned;
 * a refused read is an error, never "nothing is happening".
 */
export async function loadEventOpportunities(db: Db, brokerageId: string, opts: { now?: Date } = {}): Promise<{ rows: EventOpportunityView[]; error: string | null }> {
  const now = opts.now ?? new Date()
  if (!brokerageId) return { rows: [], error: "no tenant" }
  const { data, error } = await db.from("content_topic_bank").select("id, topic_title, status, source_url, categories, raw_data")
    .eq("brokerage_id", brokerageId).contains("categories", ["local_event"]).gt("expires_at", now.toISOString()).neq("status", "rejected").limit(200)
  if (error) return { rows: [], error: `content_topic_bank read refused: ${error.message ?? "unknown"}` }
  const src = await loadEventSources(db, brokerageId)
  const lastRun = new Map(src.sources.map((s) => [s.id, s.lastRunAt]))
  const rows = ((data ?? []) as Array<{ id: string; topic_title: string; status: string; source_url: string | null; categories: string[] | null; raw_data: Record<string, any> | null }>)
    .filter((r) => r.raw_data?.local_event && (r.raw_data.local_event.status === "scheduled" || r.raw_data.local_event.status === "rescheduled") && !r.raw_data.local_event.corrected_at)
    .map((r) => {
      const le = r.raw_data!.local_event as Record<string, any>
      const run = lastRun.get(String(le.source_id))
      return {
        topicId: r.id, title: r.topic_title, format: String((r.categories ?? []).find((c) => c.startsWith("event_format:"))?.slice(13) ?? "unknown"),
        startDate: le.start_date ?? null, status: r.status, listingKind: le.listing_kind ?? null, sourceLabel: le.source_label ?? null, url: r.source_url,
        stale: !!run && typeof le.last_verified_at === "string" && le.last_verified_at < run,
      }
    })
  return { rows, error: src.error }
}

// ── Production defaults (lazy; the guard injects every one) ──────────────────────────────────────────────────────

function defaultInTerritory(db: Db) {
  return async (brokerageId: string) => {
    const { resolveActivePullGate } = await import("@/lib/lead-pipeline/scrape-territories")
    const gate = await resolveActivePullGate(db)
    return (a: { city: string | null; state: string | null; zip: string | null }) => gate.check({ brokerageId, city: a.city, state: a.state, zip: a.zip }, { requireArea: true }).allowed
  }
}
async function defaultScreen(): Promise<(text: string) => string | null> {
  const [{ EXCLUDED_TOPIC_RULES }, { detectFairHousingViolations }] = await Promise.all([import("@/lib/content-intel/local-intel"), import("@/lib/compliance-rules/fair-housing-patterns")])
  return (text: string) => {
    const hit = EXCLUDED_TOPIC_RULES.find((r) => r.pattern.test(text))
    if (hit) return `excluded_topic:${hit.reason}`
    return detectFairHousingViolations(text).some((p) => p.severity === "high") ? "fair_housing_phrase" : null
  }
}

/** PURE — the cancellation / time-zone facts parseIcsEvents does not return: UID → STATUS and DTSTART's TZID + time. */
function icsEventMeta(ics: string): Map<string, { status: string | null; tzid: string | null; time: string | null }> {
  const out = new Map<string, { status: string | null; tzid: string | null; time: string | null }>()
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)
  let cur: { uid: string | null; status: string | null; tzid: string | null; time: string | null } | null = null
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = { uid: null, status: null, tzid: null, time: null }; continue }
    if (/^END:VEVENT/i.test(line)) { if (cur?.uid) out.set(cur.uid, { status: cur.status, tzid: cur.tzid, time: cur.time }); cur = null; continue }
    if (!cur) continue
    const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line)
    if (!m) continue
    const k = m[1].toUpperCase()
    if (k === "UID") cur.uid = m[3].trim()
    else if (k === "STATUS") cur.status = m[3].trim().toUpperCase()
    else if (k === "DTSTART") {
      cur.tzid = /TZID=([^;:]+)/i.exec(m[2] ?? "")?.[1] ?? (/Z$/.test(m[3].trim()) ? "UTC" : null)
      const t = /T(\d{2})(\d{2})/.exec(m[3])
      cur.time = t ? `${t[1]}:${t[2]}` : null
    }
  }
  return out
}

/** The publisher-syndication transport: robots.txt first (isRobotsAllowed), then the feed the publisher offers, through the
 *  connector gateway. An iCalendar feed yields events with status, zone and the feed-entry identifier; an event with no
 *  location of its own carries the source's territory as a physical place only when the source declares one. */
const syndicationTransport = (fetchText?: EventDeps["fetchText"]): EventTransport => async (s, ctx) => {
  if (!s.url) return { ok: false, reason: "no_feed_url" }
  const { isRobotsAllowed } = await import("@/lib/assets/screenshot-capture")
  const { LOCAL_INTEL_USER_AGENT, parseIcsEvents } = await import("@/lib/content-intel/local-intel")
  const get = fetchText ?? (async (url: string, brokerageId: string) => {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const r = await callConnector<string>({ connector: "rss", url, method: "GET", auth: { style: "none" }, headers: { "User-Agent": LOCAL_INTEL_USER_AGENT }, responseType: "text", timeoutMs: 15_000, brokerageId, retry: false })
    return { ok: r.ok, status: r.status ?? null, text: r.ok ? (r.data ?? "") : null }
  })
  const u = new URL(s.url)
  const robots = await get(`${u.origin}/robots.txt`, ctx.brokerageId)
  if (robots.ok && !isRobotsAllowed(robots.text ?? "", u.pathname, LOCAL_INTEL_USER_AGENT)) return { ok: false, reason: "robots_disallowed" }
  const feed = await get(s.url, ctx.brokerageId)
  if (!feed.ok) return { ok: false, reason: `feed_fetch_failed:${feed.status ?? "unknown"}` }
  const text = feed.text ?? ""
  if (!/BEGIN:VCALENDAR/i.test(text)) return { ok: false, reason: "feed_not_icalendar (RSS event feeds carry no structured date / status — use the local-intel pass)" }
  const meta = icsEventMeta(text)
  const cancelledUids = [...meta.entries()].filter(([, m]) => m.status === "CANCELLED").map(([uid]) => uid)
  const events: RawEvent[] = parseIcsEvents(text).filter((e) => e.uid).map((e) => {
    const m = meta.get(e.uid!) ?? { status: null, tzid: null, time: null }
    const virtual = /^https?:\/\//i.test(e.location ?? "")
    return {
      sourceEventKey: e.uid!, url: e.url ?? `${s.url}#${encodeURIComponent(e.uid!)}`, title: e.summary,
      location: virtual ? { kind: "virtual" as const, venue: null, city: null, state: null, zip: null, virtualUrl: e.location }
        : { kind: (e.location || s.territory?.city ? "physical" : "unknown") as "physical" | "unknown", venue: e.location, city: s.territory?.city ?? null, state: s.territory?.state ?? null, zip: s.territory?.zip ?? null, virtualUrl: null },
      start: { date: e.start, time: m.time, timeZone: m.tzid }, end: e.end ? { date: e.end, time: null, timeZone: m.tzid } : null,
      status: "scheduled",
    }
  })
  for (const uid of cancelledUids) events.push({ sourceEventKey: uid, url: `${s.url}#${encodeURIComponent(uid)}`, title: "", location: { kind: "unknown", venue: null, city: null, state: null, zip: null, virtualUrl: null }, start: { date: null, time: null, timeZone: null }, end: null, status: "canceled" })
  return { ok: true, events }
}

/** Production transports. licensed_api has NONE: no licensed event feed is contracted (LICENSE-HELD) — such a source says so. */
function defaultTransports(fetchText?: EventDeps["fetchText"]): Partial<Record<EventSourceAccess, EventTransport>> { return { publisher_syndication_feed: syndicationTransport(fetchText) } }
