// lib/listings/mls-live-date.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE MLS LIVE DATE — THE TWO WRITERS (wave 143, lane 143A).
//
// Owner (wave 143): "Listing intake needs a column for the MLS live date." — distinguish the PLANNED MLS live
// date, the ACTUAL MLS live/publish date (verified from MLS/IDX only), the listing-agreement execution date
// and the coming-soon/marketing status; carry the brokerage/property timezone; never present planned as
// verified. The migration is supabase/migrations/m796; the pure reader is lib/listings/compute-dom.ts
// (resolveMlsLiveDates). This module is the I/O half — and there are exactly TWO ways a date lands:
//
//   recordPlannedMlsLiveDate   a PERSON'S date → listings.go_live_date (the survivor column). Never verified.
//                              Intake, the lifecycle timeline, the launch door and the agreement signature all
//                              come through here. It re-runs the listing compliance loop when the listing sits at
//                              LISTING_AGREEMENT_SIGNED, because the loop's MLS_DATE_CONFIRMED hop waits on exactly
//                              this fact (outcome `passed_awaiting_date`).
//   recordVerifiedMlsLive      a FEED'S date → listings.mls_live_date_actual + go_live_confirmed_at (the survivor
//                              column that had no writer) + go_live_confirmed_source + mls_live_date_basis. Only
//                              lib/listings/mls-live-verification.ts calls it, and only on a `confirmed` verdict
//                              (lib/listings/mls-verification.ts). Idempotent: a listing already verified is
//                              never re-dated (the first confirmation is the evidence).
//
// EVERY write is tenant-pinned (`.eq("brokerage_id", …)` — the brokerage comes from the caller's SESSION or a
// verified row, never a body), reads its `{ error }`, and COUNTS the rows back: an update that matches nothing
// resolves like one that worked (CLAUDE.md §3). Every change leaves an evidence row in lifecycle_events.
//
// DEFENSIVE ABOUT m796 (WRITTEN, NOT APPLIED until the integrator applies it): the planned-date writer touches
// only the EXISTING column first (go_live_date), and the timezone — the one new column on the intake path — in a
// SECOND, best-effort statement, so a listing can still be created and dated before the migration lands. The
// verified writer needs the new columns by definition and reports the refusal by name, never swallowed.
//
// NOT `server-only` itself (a guard drives it with an injected client); the two server-only collaborators
// (the lifecycle-event core and the state→timezone table) are imported inside the functions.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  MLS_LIVE_DATE_BASES,
  MLS_LIVE_SOURCES,
  calendarDaysBetween,
  resolveMlsLiveDates,
  todayInTimeZone,
  ymdOf,
  type MlsLiveDateBasis,
  type MlsLiveSource,
} from "./compute-dom"

type Svc = SupabaseClient<any, any, any>

/** lifecycle_events.event_type of the two hops (dotted audit names, like esign.packet.state_changed). */
export const MLS_LIVE_EVENT = {
  PLANNED: "listing.mls_live_date.planned",
  VERIFIED: "listing.mls_live_date.verified",
} as const

/**
 * Where a planned date came from — evidence only. It is NOT an authority: whatever the source, once the executed
 * listing agreement (or an executed amendment) states the seller-agreed MLS live date, that date governs and no
 * source may plan a different one (wave 145, lane 145B — see recordPlannedMlsLiveDate).
 */
export type PlannedDateSource = "intake" | "timeline" | "launch" | "agreement" | "amendment" | "agent_assistant"

export type PlannedDateResult =
  | { ok: true; noop: boolean; previous: string | null; planned: string | null; timezone: string | null; loop: string | null }
  | { ok: false; reason: string }

export type VerifiedLiveResult =
  | { ok: true; noop: boolean; actual: string; basis: MlsLiveDateBasis; source: MlsLiveSource; varianceDays: number | null; timezone: string | null }
  | { ok: false; reason: string }

/** PURE: is this string an IANA zone this runtime can format with? */
function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || !tz.trim()) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() })
    return true
  } catch {
    return false
  }
}

/**
 * The zone a listing's MLS dates are calendar days in. ORDER: the PROPERTY's market (its state's zone — an MLS
 * date is local to the market the property sits in), then the BROKERAGE's configured zone, then none (the readers
 * fall back to UTC and say nothing is recorded). Never throws.
 * BLIND SPOT: the state table is one zone per state (population-weighted), so the FL panhandle, west TX, the
 * Michigan UP and similar read the state's zone; an agent can set the listing's own zone to override.
 */
export async function resolveListingTimeZone(
  svc: Svc,
  input: { brokerageId: string; state: string | null | undefined },
): Promise<{ timezone: string | null; from: "property_state" | "brokerage_setting" | "none" }> {
  const state = (input.state ?? "").trim().toUpperCase()
  if (state) {
    try {
      const { STATE_TO_IANA_TIMEZONE } = await import("@/lib/communication/call-compliance")
      const tz = STATE_TO_IANA_TIMEZONE[state]
      if (isValidTimeZone(tz)) return { timezone: tz, from: "property_state" }
    } catch (err) {
      console.error("[mls-live-date] state timezone table unavailable:", (err as Error)?.message ?? err)
    }
  }
  const { data, error } = await svc
    .from("global_settings")
    .select("timezone")
    .eq("brokerage_id", input.brokerageId)
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) {
    console.error(`[mls-live-date] brokerage timezone read refused (${error.message}); the listing will carry no zone`)
    return { timezone: null, from: "none" }
  }
  const tz = ((data ?? [])[0] as { timezone?: string | null } | undefined)?.timezone ?? null
  return isValidTimeZone(tz) ? { timezone: tz.trim(), from: "brokerage_setting" } : { timezone: null, from: "none" }
}

async function evidence(
  svc: Svc,
  brokerageId: string,
  listingId: string,
  event_type: string,
  payload: Record<string, unknown>,
  source: "ui" | "system" | "cron",
  actorUserId: string | null,
  dedupe_key?: string,
): Promise<void> {
  try {
    const { recordLifecycleEvent } = await import("@/lib/events/lifecycle-event-core")
    const r = await recordLifecycleEvent(
      svc,
      brokerageId,
      {
        event_type,
        payload: { listing_id: listingId, ...payload },
        source,
        entity_type: "listing",
        entity_id: listingId,
        ...(actorUserId ? { user_id: actorUserId } : {}),
        ...(dedupe_key ? { dedupe_key } : {}),
      },
      { dedupeWindowHours: null },
    )
    if (!r.ok) console.error(`[mls-live-date] ${event_type} evidence row not recorded for listing ${listingId}: ${r.error}`)
  } catch (err) {
    console.error(`[mls-live-date] ${event_type} evidence threw for listing ${listingId}:`, (err as Error)?.message ?? err)
  }
}

/** A bell for the listing's agent (agents.id → users.id resolved, never substituted — §3). Deduped by the live
 *  idx_notification_dedupe (one UNREAD notice per user + entity + type); a refusal is logged, never thrown. */
export async function bellListingAgent(
  svc: Svc,
  input: { brokerageId: string; listingId: string; agentId: string | null; type: string; title: string; body: string },
): Promise<void> {
  if (!input.agentId) return
  const { data: agent, error: agentErr } = await svc.from("agents").select("user_id").eq("id", input.agentId).maybeSingle()
  const userId = (agent as { user_id?: string | null } | null)?.user_id ?? null
  if (agentErr || !userId) {
    console.error(`[mls-live-date] listing agent ${input.agentId} has no resolvable login (${agentErr?.message ?? "no user_id"}); nobody was belled`)
    return
  }
  const { error } = await svc.from("notifications").insert({
    user_id: userId, brokerage_id: input.brokerageId, type: input.type, title: input.title, body: input.body,
    entity_type: "listing", entity_id: input.listingId, priority: "medium", is_read: false,
  })
  if (error && error.code !== "23505") console.error(`[mls-live-date] bell for listing ${input.listingId} refused: ${error.message}`)
}

// ─── PLANNED ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Record (or clear) the PLANNED MLS live date. `date` is a calendar day (yyyy-mm-dd) or null to clear.
 * Never writes a verified column: a planned date does not become verified by being typed.
 */
export async function recordPlannedMlsLiveDate(
  svc: Svc,
  input: {
    brokerageId: string
    listingId: string
    date: string | null
    actorUserId: string | null
    source: PlannedDateSource
    /**
     * The client for the evidence row and the compliance-loop re-run. Defaults to `svc`. A session-gated caller passes
     * its SESSION client as `svc` (so the listing write stays under the caller's RLS role) and the service client here
     * (the evidence insert and the loop's notification fan-out are system writes the agent's role does not hold).
     */
    evidenceClient?: Svc
    /** Set by the caller that already holds the listing row, to skip the read. */
    listing?: { state?: string | null; go_live_date?: string | null; lifecycle_stage?: string | null; agent_id?: string | null } | null
  },
): Promise<PlannedDateResult> {
  if (!input.brokerageId || !input.listingId) return { ok: false, reason: "no tenant or listing: the planned MLS live date was not recorded" }
  const wanted = input.date === null || input.date === "" ? null : ymdOf(input.date)
  if (input.date && !wanted) return { ok: false, reason: `"${input.date}" is not a calendar date (expected yyyy-mm-dd)` }

  let row: { state?: string | null; go_live_date?: string | null; lifecycle_stage?: string | null; agent_id?: string | null } | null = input.listing ?? null
  if (!row) {
    const { data, error } = await svc
      .from("listings")
      .select("id, state, go_live_date, lifecycle_stage, agent_id")
      .eq("id", input.listingId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (error) return { ok: false, reason: `listing could not be read: ${error.message}` }
    if (!data) return { ok: false, reason: "listing not found in your brokerage" }
    row = data as NonNullable<typeof row>
  }
  const previous = ymdOf(row?.go_live_date ?? null)
  if (previous === wanted) return { ok: true, noop: true, previous, planned: wanted, timezone: null, loop: null }

  // THE SELLER-AGREED DATE GOVERNS (wave 145, lane 145B — owner ruling 2: "The listing agreement would have the date the
  // seller wants to go live on the MLS so check the listing agreement"). Once the EXECUTED listing agreement — or an
  // executed amendment to it — states the date, the planned date is that date and nothing else: intake, the timeline,
  // the launch door and the agent assistant may not plan a different one or clear it, and the agreement path itself can
  // only write what the agreement says. Correction = an executed amendment (lib/listings/listing-agreement-terms.ts
  // recordListingAgreementAmendment), which this writer then follows. FAIL CLOSED: an agreement that could not be read
  // is "unknown", never "the seller agreed nothing". Pre-m856 nothing can be recorded, so nothing governs (legacy).
  const { governingListingAgreementTerms } = await import("./listing-agreement-terms")
  const gov = await governingListingAgreementTerms(input.evidenceClient ?? svc, { brokerageId: input.brokerageId, listingId: input.listingId })
  if (!gov.ok) return { ok: false, reason: `${gov.reason} — whether the seller agreed a different MLS live date is unknown, so the planned date was not changed` }
  if (gov.sellerRequestedMlsLiveDate && wanted !== gov.sellerRequestedMlsLiveDate) {
    const t = gov.resolved.terms.seller_requested_mls_live_date
    return {
      ok: false,
      reason: `The seller-agreed MLS live date is ${gov.sellerRequestedMlsLiveDate} per the executed listing agreement${t?.source === "amendment" ? ` as amended (amendment ${t.versionNo})` : ""}. It changes only through an executed amendment to the listing agreement — record the amendment and the listing follows it.`,
    }
  }

  const { data: written, error: writeErr } = await svc
    .from("listings")
    .update({ go_live_date: wanted, updated_at: new Date().toISOString() })
    .eq("id", input.listingId)
    .eq("brokerage_id", input.brokerageId)
    .select("id")
  if (writeErr) return { ok: false, reason: `planned MLS live date write refused: ${writeErr.message}` }
  if (!written || written.length === 0) return { ok: false, reason: "planned MLS live date write matched no listing in your brokerage" }

  // THE ZONE — second statement, best effort, only where none is recorded (an agent's explicit override wins).
  const zone = await resolveListingTimeZone(svc, { brokerageId: input.brokerageId, state: row?.state ?? null })
  if (zone.timezone) {
    const { error: tzErr } = await svc
      .from("listings")
      .update({ mls_live_timezone: zone.timezone })
      .eq("id", input.listingId)
      .eq("brokerage_id", input.brokerageId)
      .is("mls_live_timezone", null)
    if (tzErr) console.error(`[mls-live-date] timezone not recorded for listing ${input.listingId} (is m796 applied?): ${tzErr.message}`)
  }

  const sys = input.evidenceClient ?? svc
  await evidence(sys, input.brokerageId, input.listingId, MLS_LIVE_EVENT.PLANNED, {
    planned: wanted, previous, verified: false, timezone: zone.timezone, source: input.source,
  }, input.actorUserId ? "ui" : "system", input.actorUserId)

  // DEPENDENT WORKFLOW: the compliance loop's MLS_DATE_CONFIRMED hop waits on this fact.
  let loop: string | null = null
  if (wanted && row?.lifecycle_stage === "LISTING_AGREEMENT_SIGNED") {
    try {
      const { runListingComplianceLoop } = await import("@/lib/listings/listing-compliance-loop")
      const r = await runListingComplianceLoop(sys, { brokerageId: input.brokerageId, listingId: input.listingId, trigger: "mls_live_date_set", actorUserId: input.actorUserId })
      loop = r.outcome
    } catch (err) {
      console.error("[mls-live-date] compliance loop re-run failed (non-fatal):", (err as Error)?.message ?? err)
    }
  }
  return { ok: true, noop: false, previous, planned: wanted, timezone: zone.timezone, loop }
}

// ─── VERIFIED ────────────────────────────────────────────────────────────────────────────────────

/**
 * Record the ACTUAL MLS live date a feed confirmed. Callable only with feed evidence: `source` must be a known
 * feed. `feedListDate` is the feed's own list date when it carries one (RentCast); without it the date is the
 * first day we saw the listing live, in the listing's zone. A feed date in the future of that zone is not
 * evidence of anything and is replaced by the observation day. Idempotent — never re-dates a verified listing.
 */
export async function recordVerifiedMlsLive(
  svc: Svc,
  input: {
    brokerageId: string
    listingId: string
    source: MlsLiveSource
    feedListDate: string | null
    actorUserId: string | null
    now?: Date
  },
): Promise<VerifiedLiveResult> {
  if (!(MLS_LIVE_SOURCES as readonly string[]).includes(input.source)) return { ok: false, reason: `"${input.source}" is not a syndication feed that can verify a live date` }
  const now = input.now ?? new Date()

  const { data, error } = await svc
    .from("listings")
    .select("id, state, agent_id, address, go_live_date, go_live_confirmed_at, go_live_confirmed_source, mls_live_date_actual, mls_live_date_basis, mls_live_timezone")
    .eq("id", input.listingId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (error) return { ok: false, reason: `listing could not be read (is m796 applied?): ${error.message}` }
  if (!data) return { ok: false, reason: "listing not found in your brokerage" }
  const row = data as Record<string, any>

  const already = resolveMlsLiveDates(row, now)
  if (already.basis === "verified" && already.actual && already.verifiedSource) {
    return { ok: true, noop: true, actual: already.actual, basis: already.actualBasis ?? "first_observed", source: already.verifiedSource, varianceDays: already.varianceDays, timezone: already.timezone }
  }

  const timezone = isValidTimeZone(row.mls_live_timezone)
    ? String(row.mls_live_timezone).trim()
    : (await resolveListingTimeZone(svc, { brokerageId: input.brokerageId, state: row.state })).timezone
  const today = todayInTimeZone(timezone, now)
  const feed = ymdOf(input.feedListDate)
  const useFeed = !!feed && calendarDaysBetween(today, feed) <= 0
  const actual = useFeed ? (feed as string) : today
  const basis: MlsLiveDateBasis = useFeed ? "feed_list_date" : "first_observed"
  if (!(MLS_LIVE_DATE_BASES as readonly string[]).includes(basis)) return { ok: false, reason: "internal: unknown basis" }

  const { data: written, error: writeErr } = await svc
    .from("listings")
    .update({
      mls_live_date_actual: actual,
      mls_live_date_basis: basis,
      go_live_confirmed_at: now.toISOString(),
      go_live_confirmed_source: input.source,
      ...(timezone && !isValidTimeZone(row.mls_live_timezone) ? { mls_live_timezone: timezone } : {}),
      updated_at: now.toISOString(),
    })
    .eq("id", input.listingId)
    .eq("brokerage_id", input.brokerageId)
    .is("go_live_confirmed_at", null)
    .select("id")
  if (writeErr) return { ok: false, reason: `verified MLS live date write refused (is m796 applied?): ${writeErr.message}` }
  if (!written || written.length === 0) {
    // Lost a race to another confirmation (or the row left the tenant). The first confirmation stands.
    return { ok: false, reason: "verified MLS live date write matched no unverified listing — another confirmation may have landed first" }
  }

  const planned = ymdOf(row.go_live_date)
  const varianceDays = planned ? calendarDaysBetween(planned, actual) : null
  await evidence(svc, input.brokerageId, input.listingId, MLS_LIVE_EVENT.VERIFIED, {
    actual, basis, source: input.source, planned, variance_days: varianceDays, timezone, verified: true,
  }, input.actorUserId ? "ui" : "cron", input.actorUserId, `mls-live-verified-${input.listingId}`)

  await bellListingAgent(svc, {
    brokerageId: input.brokerageId, listingId: input.listingId, agentId: (row.agent_id as string | null) ?? null,
    type: "listing.mls_live_confirmed",
    title: `Confirmed live on the MLS — ${row.address ?? "your listing"}`,
    body: `${input.source === "rentcast" ? "RentCast" : "Your IDX feed"} shows the listing live as of ${actual}`
      + (varianceDays !== null && varianceDays !== 0 ? ` (${Math.abs(varianceDays)} day${Math.abs(varianceDays) === 1 ? "" : "s"} ${varianceDays > 0 ? "after" : "before"} the planned date)` : "")
      + ". Days on market now count from this verified date.",
  })
  return { ok: true, noop: false, actual, basis, source: input.source, varianceDays, timezone }
}

// ─── THE SELLER-AGREED DATE, FOLLOWED (wave 145, lane 145B — owner ruling 2) ─────────────────────

/**
 * PURE — the open-house marketing and event days hung off a planned MLS live day (yyyy-mm-dd → yyyy-mm-dd).
 * marketing = the last Friday BEFORE the live day; event = the next Saturday AFTER it (a Saturday live day → the
 * following Saturday). Moved here from app/actions/seller-listing/execution-engine.ts calculateOpenHouseDates (its
 * tombstone names this line) so the agreement intake and an executed amendment derive ONE schedule. Calendar-day math
 * in UTC, so the answer does not depend on the server's zone.
 * DEFECT FIXED IN THE MOVE: the retired step back, `dow === 5 ? 7 : ((dow + 2) % 7) + 1`, landed on a THURSDAY for
 * every live day except a Friday (Wed 2026-11-04 → Thu 10-29) — its own spec line said "last Friday". The step back is
 * now `((dow − 5 + 7) % 7) || 7` (Wed → Fri 10-30; a Friday live day → the Friday a week before).
 */
export function openHouseDatesForPlannedLive(plannedYmd: string): { marketingDate: string; eventDate: string } | null {
  const ymd = ymdOf(plannedYmd)
  if (!ymd) return null
  const live = new Date(`${ymd}T12:00:00Z`)
  const dow = live.getUTCDay() // 0=Sun … 6=Sat
  const daysToLastFriday = ((dow - 5 + 7) % 7) || 7
  const daysToNextSaturday = ((6 - dow + 7) % 7) || 7
  const at = (days: number) => new Date(live.getTime() + days * 86_400_000).toISOString().slice(0, 10)
  return { marketingDate: at(-daysToLastFriday), eventDate: at(daysToNextSaturday) }
}

/**
 * Before any open-house marketing has gone out — the only stages whose derived open-house days may move. DERIVED from
 * the stage table's own order (lib/listing-lifecycle/lifecycle-definitions.ts), never a hand-kept list: a stage added
 * before OPEN_HOUSE_MARKETING is covered by construction. An unknown stage is NOT pre-open-house (the closed answer:
 * dates the agent may already have published are never moved on a guess).
 */
async function isBeforeOpenHouseMarketing(stage: string | null): Promise<boolean> {
  const { getStageIndex } = await import("@/lib/listing-lifecycle/lifecycle-definitions")
  const at = getStageIndex((stage ?? "LEAD") as never), cut = getStageIndex("OPEN_HOUSE_MARKETING")
  return at >= 0 && cut >= 0 && at < cut
}

export type FollowAgreedDateResult =
  | { ok: true; noop: boolean; planned: string | null; previous: string | null; reached: string[]; warnings: string[] }
  | { ok: false; reason: string }

/**
 * Make the listing follow the date its EXECUTED listing agreement (as amended) governs — called by the two agreement
 * paths only: markAgreementSigned (the original agreement's term) and an executed amendment. One date change reaches,
 * each through its existing survivor:
 *   · POLICY CHECKS — recordPlannedMlsLiveDate re-runs the listing compliance loop at LISTING_AGREEMENT_SIGNED (its
 *     MLS_DATE_CONFIRMED hop waits on this fact); the launch door (plannedMlsLiveDateLaunchBlocker) and the Coming Soon
 *     readiness / creative read listings.go_live_date live, so they judge the new date on their next read.
 *   · THE MARKETING SCHEDULE — the open-house marketing / event days move with it while no open-house marketing has
 *     gone out (isBeforeOpenHouseMarketing); after that they are the agent's to move, and the bell says so.
 *   · ALERTS — the listing agent is belled (`listing.mls_live_date_changed`), naming the old and new date and that it
 *     came from the agreement.
 *   · THE EVIDENCE / THE EVENT — `listing.mls_live_date.planned` (lifecycle_events, source agreement|amendment), the
 *     durable event the listing concierge, the seller portal and the seller weekly report read the date from.
 * Never touches a verified live date (recordVerifiedMlsLive is its one writer) and never claims "MLS live".
 */
export async function followSellerAgreedMlsLiveDate(
  svc: Svc,
  input: { brokerageId: string; listingId: string; actorUserId: string | null; via: "agreement" | "amendment"; amendmentVersion?: number | null; evidenceClient?: Svc },
): Promise<FollowAgreedDateResult> {
  const sys = input.evidenceClient ?? svc
  const { governingListingAgreementTerms } = await import("./listing-agreement-terms")
  const gov = await governingListingAgreementTerms(sys, { brokerageId: input.brokerageId, listingId: input.listingId })
  if (!gov.ok) return { ok: false, reason: gov.reason }
  const agreed = gov.sellerRequestedMlsLiveDate
  if (!agreed) return { ok: true, noop: true, planned: null, previous: null, reached: [], warnings: gov.agreementId ? ["The executed listing agreement states no MLS live date the seller requested."] : [] }

  const { data: listing, error: lErr } = await svc.from("listings")
    .select("id, state, go_live_date, lifecycle_stage, agent_id, address")
    .eq("id", input.listingId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (lErr) return { ok: false, reason: `listing could not be read: ${lErr.message}` }
  if (!listing) return { ok: false, reason: "listing not found in your brokerage" }
  const row = listing as { state: string | null; go_live_date: string | null; lifecycle_stage: string | null; agent_id: string | null; address: string | null }

  const rec = await recordPlannedMlsLiveDate(svc, {
    brokerageId: input.brokerageId, listingId: input.listingId, date: agreed, actorUserId: input.actorUserId,
    source: input.via, evidenceClient: input.evidenceClient, listing: row,
  })
  if (!rec.ok) return { ok: false, reason: rec.reason }
  if (rec.noop) return { ok: true, noop: true, planned: agreed, previous: rec.previous, reached: [], warnings: [] }
  const reached = ["evidence:listing.mls_live_date.planned", ...(rec.loop ? [`policy:listing_compliance_loop(${rec.loop})`] : [])]
  const warnings: string[] = []

  // THE MARKETING SCHEDULE — only while no open-house marketing has gone out.
  const oh = openHouseDatesForPlannedLive(agreed)
  if (oh && (await isBeforeOpenHouseMarketing(row.lifecycle_stage))) {
    const { data: ohRows, error: ohErr } = await svc.from("listings")
      .update({ open_house_marketing_date: oh.marketingDate, open_house_event_date: oh.eventDate, updated_at: new Date().toISOString() })
      .eq("id", input.listingId).eq("brokerage_id", input.brokerageId).select("id")
    if (ohErr || !ohRows || ohRows.length === 0) warnings.push(`The open-house days were not moved (${ohErr?.message ?? "matched no listing"}).`)
    else reached.push("marketing_schedule:open_house_dates")
  } else if (oh) {
    warnings.push("Open-house marketing has already started, so its days were not moved — move them yourself if they should follow the new date.")
  }

  // ALERTS — the listing agent, told the old date, the new one, and where it came from.
  await bellListingAgent(sys, {
    brokerageId: input.brokerageId, listingId: input.listingId, agentId: row.agent_id, type: "listing.mls_live_date_changed",
    title: `MLS live date ${rec.previous ? `moved ${rec.previous} → ${agreed}` : `set to ${agreed}`} — ${row.address ?? "your listing"}`,
    body: `${input.via === "amendment" ? `An executed amendment${input.amendmentVersion ? ` (no. ${input.amendmentVersion})` : ""} to the listing agreement` : "The executed listing agreement"} states the seller wants to go live on the MLS on ${agreed}. `
      + "The planned date, the compliance check and the open-house schedule follow it; review any scheduled Coming Soon or open-house marketing that names the old date. "
      + "This is the seller's planned date — the listing is not live on the MLS until the feed verifies it.",
  })
  reached.push("alert:listing_agent")
  return { ok: true, noop: false, planned: agreed, previous: rec.previous, reached, warnings }
}

// ─── THE LAUNCH DOOR READS IT ────────────────────────────────────────────────────────────────────

/**
 * Why a listing may NOT be launched (marked active) yet because its PLANNED MLS live date has not arrived —
 * or null. An MLS lists a property as coming soon until its go-live date; asserting `active` in the OS before
 * that date claims a live listing the market does not have. A VERIFIED live date (a feed already shows it live)
 * lifts the block: the feed outranks the plan. The comparison is in the listing's own zone.
 * Read-only; the readiness gate (lib/kernel/listings.ts validateListingLaunchReadiness) turns the sentence into a
 * blocker, and `launchListing` cannot pass without it. Fails OPEN on an unreadable row ONLY because the gate it
 * feeds already refuses an unreadable listing (a second refusal would add nothing); every other reader fails closed.
 */
export async function plannedMlsLiveDateLaunchBlocker(svc: Svc, listingId: string, now: Date = new Date()): Promise<string | null> {
  const { data, error } = await svc.from("listings").select("go_live_date, state, brokerage_id").eq("id", listingId).maybeSingle()
  if (error || !data) return null
  const row = data as { go_live_date: string | null; state: string | null; brokerage_id: string | null }
  const planned = ymdOf(row.go_live_date)
  if (!planned) return null
  // m796 columns, best effort — a missing column (not yet applied) must not break the launch gate.
  const ex = await svc
    .from("listings")
    .select("mls_live_timezone, mls_live_date_actual, go_live_confirmed_at, go_live_confirmed_source, mls_live_date_basis")
    .eq("id", listingId)
    .maybeSingle()
  const extras = (!ex.error && ex.data ? ex.data : {}) as Record<string, unknown>
  const tz = isValidTimeZone(extras.mls_live_timezone as string | null)
    ? String(extras.mls_live_timezone).trim()
    : row.brokerage_id ? (await resolveListingTimeZone(svc, { brokerageId: row.brokerage_id, state: row.state })).timezone : null
  const r = resolveMlsLiveDates({ ...(extras as object), go_live_date: planned, mls_live_timezone: tz }, now)
  if (r.basis === "planned" && r.plannedInFuture) {
    return `The planned MLS live date is ${planned}${tz ? ` (${tz})` : ""} and has not arrived — a listing is coming soon until then and cannot be launched as active. Change the planned date if it is wrong.`
  }
  return null
}
