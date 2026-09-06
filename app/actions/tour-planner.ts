'use server'

/**
 * SYSTEM 5.1 — BUYER TOUR PLANNER (L5-B03)
 * Server actions: create tours, confirm stops, rate showings, complete tours.
 * All writes go to tours, tour_stops, showings, buyer_behavior_log, lifecycle_events.
 */

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { emitLifecycleTransition } from '@/lib/buyer-lifecycle/lifecycle-logger'
import { updateBuyerPreferences } from '@/lib/behavior-learning'
import { isValidUUID } from '@/lib/validations'
import { dispatchStopScheduling } from '@/app/actions/dispatch-showing'

// ─── Auth helper ──────────────────────────────────────────────────────────────
//
// Every tour mutation previously trusted caller-supplied agentUserId /
// brokerageId / contactId. Any signed-in user could create tours under a
// different brokerage, confirm/finalize/complete other agents' tours, and
// pollute buyer behavior signals. Reads were equally open. This helper
// resolves the caller's identity once; all functions then ignore the
// caller-supplied IDs and use the session-derived values.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Unauthorized' }
  const { data: u } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: 'Unauthorized' }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TourStop {
  listingId?: string
  propertyAddress: string
  city?: string
  state?: string
  zip?: string
  listPrice?: number
  primaryPhotoUrl?: string
  listingUrl?: string
  mlsNumber?: string
  listingAgentName?: string
  listingAgentPhone?: string
  listingAgentEmail?: string
  listingAgentCompany?: string
  schedulingMethod?: 'showingtime' | 'manual_call' | 'email' | 'text' | 'other'
  schedulingInstructions?: string
  suggestedDurationMinutes?: number
  driveTimeFromPrevMinutes?: number
}

export interface CreateTourParams {
  contactId: string
  agentUserId: string
  brokerageId: string
  tourDate: string           // ISO date string YYYY-MM-DD
  startTime: string          // HH:MM
  /** Where the tour begins — buyer agent provides this. Used by AI for
   *  drive-time computation on the first leg. */
  startAddress?: string
  stops: TourStop[]
  aiPlanNarrative?: string
  notes?: string
  /** Pre-computed totals from the AI route optimizer */
  totalDurationMinutes?: number
  totalDriveTimeMinutes?: number
}

export interface ConfirmStopParams {
  tourStopId: string
  showingId: string
  tourId: string
  confirmedTime: string      // ISO timestamp
  accessMethod: string
  accessCode?: string
  accessInstructions?: string
  listingAgentName?: string
  listingAgentPhone?: string
  listingAgentCompany?: string
  schedulingReference?: string
  brokerageId: string
  contactId: string
  agentUserId: string
}

export interface RateStopParams {
  tourStopId: string
  showingId: string
  contactId: string
  brokerageId: string
  agentUserId: string
  listingId?: string
  propertyAddress: string
  listPrice?: number
  city?: string
  zip?: string
  interestLevel: 'love_it' | 'like_it' | 'maybe' | 'no'
  note?: string
}

export interface CompleteTourParams {
  tourId: string
  contactId: string
  brokerageId: string
  agentUserId: string
  agentNote?: string
  stopRatings: Array<{
    tourStopId: string
    showingId: string
    interestLevel: 'love_it' | 'like_it' | 'maybe' | 'no'
    note?: string
    listingId?: string
    propertyAddress: string
    listPrice?: number
    city?: string
    zip?: string
  }>
}

// ─── Lifecycle states ─────────────────────────────────────────────────────────
//
// Canonical tour state machine:
//
//   planned           AI built first draft. Buyer agent reviews. Nothing has
//                     gone out to listing agents yet.
//   scheduling        Agent has dispatched scheduling requests for each stop
//                     (ShowingTime API call OR direct text/email to listing
//                     agent). Awaiting confirmations. Per-stop is_confirmed
//                     flips to true as listing agents reply.
//   confirmed         All stops confirmed (or agent finalized with manual
//                     overrides). Final report sent to buyer + listing
//                     agents. Calendar events written. Tour is locked.
//   in_progress       Tour day — buyer is touring. Per-stop arrived/left
//                     timestamps + ratings flow in.
//   completed         All stops visited. Feedback collected; lifecycle
//                     transition fires for buyer (TOURING → tour reflection).
//   cancelled         Agent or buyer cancelled before in_progress.


function addMinutes(timeStr: string, minutes: number): string {
  const [h, m] = timeStr.split(':').map(Number)
  const total = h * 60 + m + minutes
  const hh = Math.floor(total / 60) % 24
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// ─── 1. Load saved properties for tour planning ───────────────────────────────

export async function getSavedPropertiesForTour(contactId: string) {
  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // Verify contact belongs to caller's brokerage
  const { data: contact } = await supabase
    .from('contacts').select('brokerage_id').eq('id', contactId).maybeSingle()
  if (!contact) return { success: false, error: 'Contact not found' }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: 'Forbidden' }

  // saved_properties stores address data directly on the row — no FK to listings.
  // The listings join always returns null, so we select only real columns.
  const { data, error } = await supabase
    .from('saved_properties')
    .select(`
      id,
      listing_id,
      notes,
      ai_match_score,
      match_reasons,
      added_to_tour,
      saved_at,
      property_address,
      mls_number,
      list_price,
      bedrooms,
      bathrooms,
      sqft,
      city,
      state,
      primary_photo_url
    `)
    .eq('contact_id', contactId)
    .eq('brokerage_id', auth.brokerageId)
    .eq('dismissed', false)
    .order('ai_match_score', { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, properties: data ?? [] }
}

// ─── 2. Load existing tours for a buyer ───────────────────────────────────────

export async function getBuyerTours(contactId: string) {
  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // Verify contact belongs to caller's brokerage
  const { data: contact } = await supabase
    .from('contacts').select('brokerage_id').eq('id', contactId).maybeSingle()
  if (!contact) return { success: false, error: 'Contact not found' }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: 'Forbidden' }

  const { data, error } = await supabase
    .from('tours')
    .select(`
      id, tour_date, status, notes, ai_plan_narrative,
      all_confirmed, plan_sent_at, created_at,
      tour_stops (
        id, order_index, property_address, city, state, zip,
        listing_id, mls_number, list_price, primary_photo_url,
        listing_url, listing_agent_name, listing_agent_phone,
        listing_agent_email, listing_agent_company,
        scheduling_method, scheduling_instructions,
        access_method, access_code, access_instructions,
        confirmed_time, is_confirmed, suggested_time,
        suggested_duration_minutes, drive_time_from_prev_minutes,
        buyer_interest_level, buyer_note, showing_id,
        time_arrived_at, time_left_at, time_spent_minutes,
        scheduling_reference
      )
    `)
    .eq('contact_id', contactId)
    .eq('brokerage_id', auth.brokerageId)
    .order('tour_date', { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, tours: data ?? [] }
}

// ─── 3. Create a tour plan ────────────────────────────────────────────────────

export async function createTourPlan(params: CreateTourParams) {
  const {
    contactId,
    tourDate, startTime, startAddress, stops,
    aiPlanNarrative, notes,
    totalDurationMinutes, totalDriveTimeMinutes,
  } = params

  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }
  if (!stops.length) return { success: false, error: 'No stops provided' }

  // Auth gate — ignore caller-supplied agentUserId / brokerageId; derive
  // from session so a hostile caller can't create a tour under a different
  // agent / brokerage.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // LIVE-FK CATCH: tours.agent_id AND showings.agent_id both reference
  // agents(id) — inserting the auth users.id here violated the FK and tour
  // creation failed for EVERY caller. Resolve the caller's agents row
  // (honest refusal when none — a non-agent seat can't own a tour).
  const { data: agentRow } = await supabase
    .from('agents').select('id').eq('user_id', agentUserId).maybeSingle()
  const agentRowId = (agentRow as { id: string } | null)?.id ?? null
  if (!agentRowId) {
    return { success: false, error: 'Your account has no agent profile — tours belong to an agent seat.' }
  }

  // Verify contact belongs to caller's brokerage
  const { data: contact } = await supabase
    .from('contacts').select('brokerage_id').eq('id', contactId).maybeSingle()
  if (!contact) return { success: false, error: 'Contact not found' }
  if (contact.brokerage_id !== brokerageId) return { success: false, error: 'Forbidden' }

  // ── Financial verification gate (System J3.1) — buyer must be verified
  //    before tours can be created. Previously this gate was UI-only.
  const { data: finProfile } = await supabase
    .from('buyer_financial_profiles')
    .select('verified')
    .eq('contact_id', contactId)
    .eq('brokerage_id', brokerageId)
    .maybeSingle()
  if (!finProfile?.verified) {
    return {
      success: false,
      error: 'Buyer is not financially verified. Complete the verification gate (proof of funds for cash, or pre-approval for financed) before scheduling tours.',
    }
  }

  // Insert tour — `planned` means AI has built the route but the agent
  // has not yet approved/sent it. Approval flips status to `awaiting_confirmation`
  // and writes agent_approved_at; report send fills report_sent_at.
  const { data: tour, error: tourError } = await supabase
    .from('tours')
    .insert({
      contact_id:               contactId,
      buyer_id:                 contactId,
      agent_id:                 agentRowId, // agents(id) — the FK's target, never users.id
      brokerage_id:             brokerageId,
      tour_date:                tourDate,
      start_time:               startTime,
      start_address:            startAddress ?? null,
      total_duration_minutes:   totalDurationMinutes ?? null,
      total_drive_time_minutes: totalDriveTimeMinutes ?? null,
      status:                   'planned',
      notes:                    notes ?? null,
      ai_plan_narrative:        aiPlanNarrative ?? null,
      plan_sent_at:             new Date().toISOString(),
    })
    .select('id')
    .single()

  if (tourError || !tour) return { success: false, error: tourError?.message ?? 'Failed to create tour' }

  const tourId = tour.id

  // Compute suggested times
  let currentTime = startTime
  const stopsWithTimes = stops.map((stop, i) => {
    // Add drive time from previous stop (skip first)
    if (i > 0 && stop.driveTimeFromPrevMinutes) {
      currentTime = addMinutes(currentTime, stop.driveTimeFromPrevMinutes)
    }
    const suggestedTime = currentTime
    currentTime = addMinutes(currentTime, stop.suggestedDurationMinutes ?? 30)
    return { ...stop, suggestedTime, orderIndex: i }
  })

  // Insert tour_stops
  const stopInserts = stopsWithTimes.map(s => ({
    tour_id:                     tourId,
    brokerage_id:                brokerageId,
    contact_id:                  contactId,
    listing_id:                  s.listingId ?? null,
    order_index:                 s.orderIndex,
    property_address:            s.propertyAddress,
    city:                        s.city ?? null,
    state:                       s.state ?? null,
    zip:                         s.zip ?? null,
    list_price:                  s.listPrice ?? null,
    primary_photo_url:           s.primaryPhotoUrl ?? null,
    listing_url:                 s.listingUrl ?? null,
    mls_number:                  s.mlsNumber ?? null,
    listing_agent_name:          s.listingAgentName ?? null,
    listing_agent_phone:         s.listingAgentPhone ?? null,
    listing_agent_email:         s.listingAgentEmail ?? null,
    listing_agent_company:       s.listingAgentCompany ?? null,
    scheduling_method:           s.schedulingMethod ?? 'manual_call',
    scheduling_instructions:     s.schedulingInstructions ?? null,
    suggested_time:              s.suggestedTime,
    suggested_duration_minutes:  s.suggestedDurationMinutes ?? 30,
    drive_time_from_prev_minutes: s.driveTimeFromPrevMinutes ?? null,
    is_confirmed:                false,
  }))

  const { data: insertedStops, error: stopsError } = await supabase
    .from('tour_stops')
    .insert(stopInserts)
    .select('id, listing_id, order_index')

  if (stopsError) return { success: false, error: stopsError.message }

  // Insert showings (one per stop)
  const showingInserts = (insertedStops ?? []).map((stop, i) => ({
    contact_id:    contactId,
    agent_id:      agentRowId, // agents(id) — same FK as tours.agent_id
    brokerage_id:  brokerageId,
    listing_id:    stopsWithTimes[i]?.listingId ?? null,
    scheduled_date: tourDate,
    status:        'pending',
    tour_id:       tourId,
    sync_source:   'manual' as const,
  }))

  const { data: insertedShowings } = await supabase
    .from('showings')
    .insert(showingInserts.filter(s => s.listing_id))
    .select('id, listing_id')

  // Back-link showing_id onto tour_stops
  if (insertedShowings?.length) {
    for (const showing of insertedShowings) {
      const matchingStop = (insertedStops ?? []).find(
        (ts, i) => stopsWithTimes[i]?.listingId === showing.listing_id
      )
      if (matchingStop) {
        await supabase
          .from('tour_stops')
          .update({ showing_id: showing.id })
          .eq('id', matchingStop.id)
      }
    }
  }

  // Mark saved_properties.added_to_tour = true
  const listingIds = stops.map(s => s.listingId).filter(Boolean) as string[]
  if (listingIds.length) {
    await supabase
      .from('saved_properties')
      .update({ added_to_tour: true })
      .eq('contact_id', contactId)
      .in('listing_id', listingIds)
  }

  // lifecycle_events: tour.planned
  await supabase.from('lifecycle_events').insert({
    brokerage_id:  brokerageId,
    entity_type:   'buyer_lifecycle',
    entity_id:     contactId,
    event_type:    'tour.planned',
    actor_user_id: agentUserId,
    metadata:      { stop_count: stops.length, tour_id: tourId },
  })

  // Advance buyer state → BUYER_TOURING
  await emitLifecycleTransition({
    contactId,
    brokerageId,
    fromState:     'BUYER_TOUR_ELIGIBLE' as any,
    toState:       'BUYER_TOURING' as any,
    triggeredBy:   'agent',
    authorityRole: 'agent',
    userId:        agentUserId,
    sourceSystem:  'tour_planner',
    metadata:      { tour_id: tourId },
  }).catch(() => {})

  // Notification for agent
  await supabase.from('notifications').insert({
    user_id:     agentUserId,
    brokerage_id: brokerageId,
    type:        'tour.plan_created',
    title:       `Tour plan created`,
    body:        `${stops.length} stops planned for ${tourDate}`,
    entity_type: 'tour',
    entity_id:   tourId,
    priority:    'medium',
    channel:     'in_app',
  })

  const stopIds = (insertedStops ?? [])
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    .map(s => s.id)

  return { success: true, tourId, stopCount: stops.length, stopIds }
}

// ─── 4a. Schedule tour stops (dispatch to listing agents) ────────────────────
//
// After AI builds the first draft and the buyer agent reviews it, this is
// the action that goes out to listing agents:
//   - schedulingMethod='showingtime' → ShowingTime API call (deferred — for
//     now we record intent and mark the stop as scheduling-pending)
//   - schedulingMethod='manual_call' → text message draft to listing_agent_phone
//   - schedulingMethod='other'       → email draft to listing_agent_email
//
// Flips tour status: planned → scheduling. Each stop now has a record of
// outreach so the agent can track who they've contacted vs who still needs
// to be reached. Listing agents reply via:
//   - ShowingTime push back into our system
//   - Direct reply that the agent records via confirmTourStop()
export async function scheduleTourStops(params: {
  tourId:      string
  agentUserId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
}): Promise<{ success: boolean; error?: string; dispatched?: number; sent?: number; drafted?: number }> {
  const { tourId } = params
  if (!isValidUUID(tourId)) return { success: false, error: 'Invalid tour ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Load tour + stops
  const [{ data: tour }, { data: stops }] = await Promise.all([
    supabase.from('tours').select('id, contact_id, agent_id, status, tour_date, start_time')
      .eq('id', tourId).eq('brokerage_id', brokerageId).maybeSingle(),
    supabase.from('tour_stops')
      .select('id, listing_id, property_address, listing_agent_name, listing_agent_phone, listing_agent_email, scheduling_method, suggested_time, suggested_duration_minutes')
      .eq('tour_id', tourId)
      .order('order_index', { ascending: true }),
  ])

  if (!tour) return { success: false, error: 'Tour not found' }
  if (tour.status === 'confirmed' || tour.status === 'completed' || tour.status === 'cancelled') {
    return { success: false, error: `Tour is ${tour.status} — cannot reschedule` }
  }

  // Flip status to scheduling
  const { error: statusError } = await supabase
    .from('tours').update({ status: 'scheduling' }).eq('id', tourId)
  if (statusError) return { success: false, error: statusError.message }

  // Dispatch each stop through the CANONICAL showing-dispatch lane
  // (app/actions/dispatch-showing.ts → lib/showings/dispatchers.ts). This used
  // to only write 'tour_stop.schedule_dispatched' lifecycle events — the toast
  // said "N listing agents contacted" while nothing had actually gone out; the
  // real dispatcher was reachable only via the per-stop dropdown. Same lane,
  // now on the bulk button too: with provider credentials the request is sent
  // (ShowingTime API / Twilio / Gmail-Outlook-SendGrid); without them the lane
  // records an honest DRAFT ('tour_stop.scheduling_drafted') the agent finishes
  // from the per-stop dropdown. dispatchStopScheduling records each attempt as
  // a lifecycle_event itself, so no duplicate event write here.
  //
  // Channel comes from the stop's own scheduling_method, falling back to
  // whichever listing-agent handle is actually on file — never a channel with
  // no recipient when a usable one exists.
  let sent = 0
  let drafted = 0
  for (const stop of stops ?? []) {
    const method = stop.scheduling_method ?? 'manual_call'
    const channel: 'showingtime' | 'sms' | 'email' =
      method === 'showingtime' ? 'showingtime'
      : method === 'email'     ? 'email'
      : stop.listing_agent_phone ? 'sms'
      : stop.listing_agent_email ? 'email'
      : 'showingtime'
    const res = await dispatchStopScheduling({ tourStopId: stop.id, channel })
    if (!res.success) {
      // Refusal reported as a refusal — a stop the lane would not take must not
      // be counted as contacted.
      return {
        success: false,
        error: `Dispatch refused for stop ${stop.property_address ?? stop.id}: ${res.error ?? 'unknown'}`,
        dispatched: sent + drafted, sent, drafted,
      }
    }
    if (res.sent) sent += 1
    else drafted += 1
  }

  return { success: true, dispatched: (stops ?? []).length, sent, drafted }
}

// ─── 4b. Finalize tour (after agent has heard back from listing agents) ──────
//
// After listing agents reply (some via ShowingTime push, some by phone/text
// the agent confirmed manually), the buyer agent finalizes the tour. This
// is the canonical APPROVED state. On finalize:
//   - Status → confirmed
//   - agent_approved_at + agent_approved_by recorded
//   - Tour-level all_confirmed flag set if every stop is confirmed
//   - Calendar events created for each confirmed stop
//   - Final report sent to buyer (portal + optionally email/SMS)
export async function finalizeTour(params: {
  tourId:       string
  agentUserId?:  string  // ignored — derived from session
  brokerageId?:  string  // ignored — derived from session
  /** Channels to send the final report through */
  reportChannels: Array<'portal' | 'email' | 'sms'>
  /** Optional URL to a generated report PDF */
  reportUrl?:   string
  /** Optional final edits the agent made before finalizing */
  editedNotes?: string
  editedNarrative?: string
  /** When the agent plans to leave — carried onto the buyer-lifecycle event.
   *  MERGED IN from the deleted `confirmTour` wrapper (tombstone below). */
  departureTime?: string
}): Promise<{ success: boolean; error?: string; calendarEventCount?: number }> {
  const { tourId, reportChannels, reportUrl, editedNotes, editedNarrative, departureTime } = params
  if (!isValidUUID(tourId)) return { success: false, error: 'Invalid tour ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Load tour + stops
  const [{ data: tour }, { data: stops }] = await Promise.all([
    supabase.from('tours')
      .select('id, contact_id, agent_id, tour_date, start_time')
      .eq('id', tourId).eq('brokerage_id', brokerageId).maybeSingle(),
    supabase.from('tour_stops')
      .select('id, property_address, suggested_time, suggested_duration_minutes, confirmed_time, is_confirmed, listing_id')
      .eq('tour_id', tourId)
      .order('order_index', { ascending: true }),
  ])

  if (!tour) return { success: false, error: 'Tour not found' }

  const allConfirmed = (stops ?? []).every(s => s.is_confirmed)
  const nowIso = new Date().toISOString()

  // Tour update
  const tourUpdates: Record<string, unknown> = {
    status:            'confirmed',
    agent_approved_at: nowIso,
    agent_approved_by: agentUserId,
    all_confirmed:     allConfirmed,
    report_sent_at:    nowIso,
    report_sent_via:   reportChannels,
    report_url:        reportUrl ?? null,
  }
  if (editedNotes !== undefined)     tourUpdates.notes = editedNotes
  if (editedNarrative !== undefined) tourUpdates.ai_plan_narrative = editedNarrative

  const { error: tourErr } = await supabase
    .from('tours').update(tourUpdates).eq('id', tourId)
  if (tourErr) return { success: false, error: tourErr.message }

  // Calendar events for each stop with a confirmed (or suggested) time
  let calendarEventCount = 0
  for (const stop of stops ?? []) {
    const startBase = stop.confirmed_time
      ? new Date(stop.confirmed_time)
      : tour.tour_date && stop.suggested_time
        ? new Date(`${tour.tour_date}T${stop.suggested_time}`)
        : null
    if (!startBase) continue
    const durationMin = stop.suggested_duration_minutes ?? 30
    const endIso = new Date(startBase.getTime() + durationMin * 60_000).toISOString()
    const { error } = await supabase.from('calendar_events').insert({
      brokerage_id:        brokerageId,
      entity_type:         'tour_stop',
      entity_id:           stop.id,
      event_type:          'showing',
      start_at:            startBase.toISOString(),
      end_at:              endIso,
      timezone_name:       'America/New_York',
      is_system_generated: true,
      deadline_notified:   false,
      metadata: {
        tour_id:          tourId,
        contact_id:       tour.contact_id,
        agent_id:         tour.agent_id,
        listing_id:       stop.listing_id,
        property_address: stop.property_address,
      },
    })
    if (!error) calendarEventCount++
  }

  // Buyer-portal message + lifecycle event
  if (reportChannels.includes('portal') && tour.contact_id) {
    await supabase.from('client_portal_messages').insert({
      contact_id: tour.contact_id,
      direction:  "agent_to_client",
      body:       'Your tour is confirmed. Tap to view the itinerary, route, and per-property details.',
      created_at: nowIso,
    }).then(() => null, () => null)
  }

  await supabase.from('lifecycle_events').insert({
    brokerage_id:  brokerageId,
    entity_type:   'tour',
    entity_id:     tourId,
    event_type:    'tour.confirmed',
    actor_user_id: agentUserId,
    metadata: {
      report_channels:  reportChannels,
      stop_count:       (stops ?? []).length,
      all_confirmed:    allConfirmed,
      calendar_events:  calendarEventCount,
    },
  }).then(() => null, () => null)

  // ── MERGED FORWARD FROM THE DELETED `confirmTour` WRAPPER ──────────────────
  // Two writes the wrapper did and this function did not: the agent's own
  // in-app notification, and the BUYER-LIFECYCLE event (a different rail from
  // the `tour` lifecycle event above — same event_type, different entity).
  // Both are best-effort; neither may turn a confirmed tour into a failure.
  //
  // The contact id comes from the TOUR ROW, not from a parameter. The wrapper
  // took `contactId` from its caller and wrote it straight onto a lifecycle
  // event under the caller's brokerage — a body-supplied entity id on a service
  // client, which is the shape CLAUDE.md §4 rules out. `tour` was already loaded
  // above under `.eq('brokerage_id', brokerageId)`, so its `contact_id` is
  // tenant-proven and cannot be pointed at another brokerage's contact.
  try {
    await supabase.from('notifications').insert({
      user_id:      agentUserId,
      brokerage_id: brokerageId,
      type:         'tour.confirmed',
      title:        'Tour confirmed',
      body:         'Your tour is confirmed and calendar events have been created.',
      entity_type:  'tour',
      entity_id:    tourId,
      priority:     'high',
      channel:      'in_app',
    })
  } catch { /* non-critical */ }

  if (tour.contact_id) {
    await supabase.from('lifecycle_events').insert({
      brokerage_id:  brokerageId,
      entity_type:   'buyer_lifecycle',
      entity_id:     tour.contact_id,
      event_type:    'tour.confirmed',
      actor_user_id: agentUserId,
      metadata:      { tour_id: tourId, departure_time: departureTime ?? null },
    }).then(() => null, () => null)
  }

  return { success: true, calendarEventCount }
}

// ─── `approveTourPlan` and `sendTourReport` REMOVED ──────────────────────────
// Both were @deprecated one-line shims that did nothing but call
// `finalizeTour` above — approveTourPlan with `reportChannels: ['portal']`,
// sendTourReport with the caller's `channels` renamed. The survivor is
// `app/actions/tour-planner.ts:finalizeTour`, which the tour confirm tab
// (app/crm/contacts/[contactId]/tours/components/tour-confirm-tab.tsx) already
// calls directly, and which is strictly more capable: it takes every channel,
// the report url and the agent's final edits in ONE step, resolves the actor
// and the tenant from the SESSION (the shims accepted `agentUserId` and
// `brokerageId` from the caller — parameters finalizeTour now ignores on
// purpose), and stamps `report_sent_at` for lib/kernel/tour-optimizer.ts's
// idempotency. Nothing was merged forward: neither shim held a line of logic
// of its own, and the two-step approve-then-send flow they preserved is the
// flow the deprecation note says was wrong — the agent approves AFTER the
// listing agents reply, which is what finalizeTour does in a single call.

// ─── 5. Confirm a single stop ─────────────────────────────────────────────────

export async function confirmTourStop(params: ConfirmStopParams) {
  const {
    tourStopId, showingId, tourId,
    confirmedTime, accessMethod, accessCode, accessInstructions,
    listingAgentName, listingAgentPhone, listingAgentCompany,
    schedulingReference,
  } = params

  if (!isValidUUID(tourStopId) || !isValidUUID(tourId)) {
    return { success: false, error: 'Invalid ID' }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Verify tour stop belongs to caller's brokerage
  const { data: stopRow } = await supabase
    .from('tour_stops')
    .select('id, tour_id, brokerage_id')
    .eq('id', tourStopId)
    .maybeSingle()
  if (!stopRow) return { success: false, error: 'Tour stop not found' }
  if (stopRow.brokerage_id !== brokerageId) return { success: false, error: 'Forbidden' }
  if (stopRow.tour_id !== tourId) return { success: false, error: 'Tour ID mismatch' }

  const { error: stopError } = await supabase
    .from('tour_stops')
    .update({
      confirmed_time:         confirmedTime,
      access_method:          accessMethod,
      access_code:            accessCode ?? null,
      access_instructions:    accessInstructions ?? null,
      listing_agent_name:     listingAgentName ?? null,
      listing_agent_phone:    listingAgentPhone ?? null,
      listing_agent_company:  listingAgentCompany ?? null,
      // RE-ADJUDICATED 2026-09-04 — THE 2026-09-03 NOTE WAS WRONG, and the way
      // it was wrong is the exact failure CLAUDE.md §2 warns about: it pointed
      // at a TYPE and a useState default as if they were a read.
      // app/crm/contacts/[contactId]/tours/components/tour-confirm-tab.tsx:39
      // declares `scheduling_reference` on its TourStop interface and :98 seeds
      // the input from `stop.scheduling_reference` — but the only query that
      // loads those stops (getContactTours, the `tour_stops (…)` embed at :226)
      // listed its columns EXPLICITLY and did not include this one. A TypeScript
      // interface is not a select list: the field arrived `undefined` on every
      // render, the confirm form opened blank, and an agent re-confirming a
      // ShowingTime appointment silently wiped the provider's own reference by
      // saving an empty string back over it. The census was right and the
      // re-check was reading the wrong evidence.
      //
      // FIXED at the source: `scheduling_reference` is now IN the embed
      // (:226+), which is the reader this column always needed. Other writer:
      // the ShowingTime webhook (app/api/showings/showingtime-webhook/route.ts:180).
      scheduling_reference:   schedulingReference ?? null,
      is_confirmed:           true,
    })
    .eq('id', tourStopId)
    .eq('brokerage_id', brokerageId)

  if (stopError) return { success: false, error: stopError.message }

  // Write a calendar_event for the agent — this stop is now confirmed.
  // Only the agent's calendar gets the event here; the contact's calendar is written
  // when the full tour is confirmed and sent (confirmTour below).
  try {
    await supabase.from('calendar_events').insert({
      brokerage_id:        brokerageId,
      entity_type:         'tour_stop',
      entity_id:           tourStopId,
      event_type:          'showing',
      start_at:            confirmedTime,
      is_system_generated: true,
    })
  } catch { /* non-critical */ }

  // Update linked showing
  if (showingId && isValidUUID(showingId)) {
    await supabase
      .from('showings')
      .update({
        scheduled_at:           confirmedTime,
        is_confirmed:           true,
        confirmed_at:           new Date().toISOString(),
        access_method:          accessMethod,
        access_code:            accessCode ?? null,
        access_instructions:    accessInstructions ?? null,
        listing_agent_name:     listingAgentName ?? null,
        listing_agent_phone:    listingAgentPhone ?? null,
        listing_agent_company:  listingAgentCompany ?? null,
        scheduling_reference:   schedulingReference ?? null,
      })
      .eq('id', showingId)
  }

  // Check if all stops confirmed → update tour
  const { data: allStops } = await supabase
    .from('tour_stops')
    .select('is_confirmed')
    .eq('tour_id', tourId)

  const allConfirmed = allStops?.every(s => s.is_confirmed) ?? false

  if (allConfirmed) {
    await supabase
      .from('tours')
      .update({ all_confirmed: true, status: 'confirmed' })
      .eq('id', tourId)

    await supabase.from('notifications').insert({
      user_id:     agentUserId,
      brokerage_id: brokerageId,
      type:        'tour.all_confirmed',
      title:       'All showings confirmed',
      body:        `All stops confirmed for tour on ${tourId}`,
      entity_type: 'tour',
      entity_id:   tourId,
      priority:    'high',
      channel:     'in_app',
    })
  }

  return { success: true, allConfirmed }
}

// ─── 4c. `confirmTour` REMOVED ───────────────────────────────────────────────
//
// TOMBSTONE: `confirmTour(params)` — DELETED as a legacy wrapper.
// SURVIVOR: `finalizeTour`, app/actions/tour-planner.ts:560.
//
// Its own header called it "legacy entry — routes to finalizeTour", and that is
// all it did: validate two uuids, re-authenticate, call finalizeTour, then add
// two best-effort writes of its own. BOTH of those writes were MERGED ONTO THE
// SURVIVOR FIRST (see the "MERGED FORWARD" block at the end of finalizeTour) —
// the agent's `tour.confirmed` notification and the `buyer_lifecycle` lifecycle
// event, plus the `departureTime` that event carries, which finalizeTour now
// accepts as an optional parameter.
//
// THE MERGE MADE IT STRICTLY SAFER, not merely equal. The wrapper required a
// caller-supplied `contactId` and wrote it onto a lifecycle event under the
// caller's brokerage; the survivor takes the contact id off the TOUR ROW it
// already loaded with `.eq('brokerage_id', brokerageId)`, so a body-supplied id
// can no longer name another tenant's contact (CLAUDE.md §4). The survivor also
// returns `calendarEventCount`, which the wrapper swallowed and replaced with a
// bare `{ success: true }`.
//
// The single caller — app/crm/contacts/[contactId]/tours/components/
// tour-confirm-tab.tsx — already imported `finalizeTour` alongside it and now
// calls it directly, which is what the `approveTourPlan`/`sendTourReport`
// tombstone above already claimed was true.

// ─── 4d. Day-of check-in / check-out on a stop ───────────────────────────────
//
// ORPHAN DOCTRINE §1.2 — no duplicate existed, the capability was wanted, so this
// is the BUILT missing half.
//
// tour_stops.time_arrived_at / time_left_at / time_spent_minutes were WRITERLESS.
// Verified live on hrvaqgvukzxfskkcrwbt before this was written: all three column
// DEFAULTs NULL and is_generated 'NEVER'; pg_trigger empty for tour_stops; pg_proc
// holds no routine naming the table or any of the three columns; and every row
// count was 0. Their ONE appearance in the whole tree was the SELECT list at
// getBuyerTours above (:236) — read by nobody, written by nothing.
//
// THE OWNER'S RULING closed the question a prior lane left unresolved:
// showings.completed_at / duration_minutes are NOT the survivor —
// "tours and showings are 2 different as showings are for showing requests or
// showings on the tenants listings". A showing is a request against a tenant's
// OWN listing; a tour stop is our buyer standing in someone else's house. There
// is no duplicate to merge onto, so the half that was missing gets BUILT.
//
// THE READER THAT WAS ALREADY THERE, THROWING THE NUMBER AWAY:
// app/crm/contacts/[contactId]/tours/components/tour-day-of-tab.tsx has run a
// per-stop STOPWATCH since it was written — "Time at this stop: 07:42", ticking
// once a second, reset on every stop change and lost on every refresh. The agent
// has always been shown this number. Nothing ever persisted it. That is the exact
// shape §1.2 describes: the capability is wanted, half of it already shipped, and
// the other half is a writer.
//
// WHY THE DURATION IS NOT A PARAMETER: m564 makes time_spent_minutes a GENERATED
// ALWAYS column derived from the two timestamps, so a caller-supplied minute count
// is not merely ignored here — Postgres refuses it outright. This action stamps
// SERVER time for both ends; the browser's clock never reaches the row. A stop
// with an arrival and no departure derives NULL, never 0: "we never recorded the
// leave" must not launder itself into "they spent no time there", the same rule
// signal-mapping.ts::tourInterestToRating holds for an unrated stop.
export async function stampTourStopPresence(params: {
  tourStopId: string
  phase: 'arrived' | 'departed'
}): Promise<{
  success: boolean
  error?: string
  arrivedAt?: string | null
  leftAt?: string | null
  minutesOnSite?: number | null
  tourStatus?: string | null
}> {
  const { tourStopId, phase } = params

  if (!isValidUUID(tourStopId)) return { success: false, error: 'Invalid tour stop ID' }
  if (phase !== 'arrived' && phase !== 'departed') return { success: false, error: 'Invalid phase' }

  // Tenant from the SESSION (§4) — this action takes no brokerageId, no
  // contactId and no agentUserId, so there is no body-supplied tenant to trust.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // ── THE PREDICATE CHAIN: a stop belongs to a tour belongs to a tenant ───────
  // BOTH links are proven, not just the stop's own denormalized brokerage_id.
  // tour_stops.brokerage_id is a copy; tours.brokerage_id is where the tour
  // actually lives. If a stop row's copy ever disagreed with its parent, trusting
  // the copy alone would let a stop be stamped under the wrong tenant — so link 1
  // checks the copy, link 2 re-derives the truth through the parent, and a
  // disagreement refuses instead of picking a winner.
  const { data: stopRow, error: stopReadError } = await supabase
    .from('tour_stops')
    .select('id, tour_id, brokerage_id, time_arrived_at, time_left_at, time_spent_minutes')
    .eq('id', tourStopId)
    .maybeSingle()
  if (stopReadError) return { success: false, error: stopReadError.message }
  if (!stopRow) return { success: false, error: 'Tour stop not found' }
  if (stopRow.brokerage_id !== brokerageId) return { success: false, error: 'Forbidden' }
  if (!stopRow.tour_id) return { success: false, error: 'Tour stop has no parent tour' }

  const { data: tourRow, error: tourReadError } = await supabase
    .from('tours')
    .select('id, status')
    .eq('id', stopRow.tour_id)
    .eq('brokerage_id', brokerageId)   // link 2 — the parent, under the session's tenant
    .maybeSingle()
  if (tourReadError) return { success: false, error: tourReadError.message }
  // Deliberately the same message as a missing stop: distinguishing "not yours"
  // from "does not exist" is an id-enumeration oracle across tenants
  // (the rule lib/kernel/crm.ts::archiveContactRecord states).
  if (!tourRow) return { success: false, error: 'Tour stop not found' }

  // A closed day takes no more stamps. Statuses that ACCEPT a stamp are the live
  // ones the tree actually writes — planned / scheduling / confirmed / in_progress
  // — so this is a refusal list, not an allow-list that a new state silently fails.
  if (tourRow.status === 'cancelled' || tourRow.status === 'completed') {
    return {
      success: false,
      error: `Tour is ${tourRow.status} — the day is closed; stops can no longer be checked in or out.`,
    }
  }

  const nowIso = new Date().toISOString()
  const patch: Record<string, string> = {}

  if (phase === 'arrived') {
    // FIRST ARRIVAL WINS. The day-of tab stamps on mount, and a remount — a
    // refresh, a back-navigation, React re-running an effect — must not restart
    // the clock and shrink a 40-minute visit to 2. Re-stamping is reported as the
    // no-op it is, carrying the ORIGINAL arrival back so the caller renders the
    // real one.
    if (stopRow.time_arrived_at) {
      return {
        success:       true,
        arrivedAt:     stopRow.time_arrived_at,
        leftAt:        stopRow.time_left_at ?? null,
        minutesOnSite: stopRow.time_spent_minutes ?? null,
        tourStatus:    tourRow.status ?? null,
      }
    }
    patch.time_arrived_at = nowIso
  } else {
    // You cannot leave a house you never entered. Stamping a lone departure would
    // leave time_spent_minutes NULL forever while the row LOOKED recorded — an
    // absence dressed as a fact. Refuse and say why.
    if (!stopRow.time_arrived_at) {
      return { success: false, error: 'No arrival recorded for this stop — check in before checking out.' }
    }
    // m564's tour_stops_visit_window_check would refuse this at the database, but
    // a caught constraint violation reads as an outage; naming the real cause is
    // the honest failure.
    if (new Date(nowIso).getTime() < new Date(stopRow.time_arrived_at).getTime()) {
      return { success: false, error: 'Departure precedes the recorded arrival — refusing to store a negative visit.' }
    }
    // LATEST DEPARTURE WINS — an agent who steps out and comes back leaves for
    // real the last time, and the second stamp is the truer one.
    patch.time_left_at = nowIso
  }

  // §3: an UPDATE matching NOTHING resolves clean — `error` null, and byte-identical
  // to one that worked. `.select()` the update and COUNT what came back, or a stop
  // deleted or re-parented between the read above and this write reports SUCCESS to
  // an agent standing in the driveway. The survivor pattern is
  // lib/kernel/crm.ts::archiveContactRecord (~:981).
  const { data: stamped, error: stampError } = await supabase
    .from('tour_stops')
    .update(patch)
    .eq('id', tourStopId)
    .eq('tour_id', stopRow.tour_id)
    .eq('brokerage_id', brokerageId)
    .select('id, time_arrived_at, time_left_at, time_spent_minutes')

  if (stampError) return { success: false, error: stampError.message }
  if (!stamped?.length) {
    return { success: false, error: 'Tour stop not found, moved, or not yours to stamp' }
  }
  const row = stamped[0] as {
    time_arrived_at: string | null
    time_left_at: string | null
    time_spent_minutes: number | null
  }

  // ── THE STATE-MACHINE TRANSITION NOTHING ON THIS SURFACE PERFORMED ─────────
  // The canonical machine at the top of this file says in_progress is "Tour day —
  // buyer is touring. Per-stop arrived/left timestamps + ratings flow in." The
  // first arrival IS that moment. Until now only the mobile Start Tour button
  // (app/mobile/components/os/tour-day-panel.tsx) ever wrote in_progress, so an
  // agent working the CRM day-of tab left the tour sitting in `confirmed` through
  // the entire day it was being toured.
  //
  // Best-effort and zero-row-tolerant on purpose: this is a status the tour may
  // already hold, and a concurrent completeTour is a legitimate race. The stamp is
  // the thing that must not lie; the status is a consequence of it.
  let tourStatus: string | null = tourRow.status ?? null
  if (phase === 'arrived' && tourRow.status !== 'in_progress') {
    const { data: advanced } = await supabase
      .from('tours')
      .update({ status: 'in_progress' })
      .eq('id', stopRow.tour_id)
      .eq('brokerage_id', brokerageId)
      .in('status', ['planned', 'scheduling', 'confirmed'])
      .select('id, status')
    if (advanced?.length) tourStatus = (advanced[0] as { status: string }).status
  }

  return {
    success:       true,
    arrivedAt:     row.time_arrived_at,
    leftAt:        row.time_left_at,
    minutesOnSite: row.time_spent_minutes,
    tourStatus,
  }
}

// ─── 5. Rate a stop (day-of) ──────────────────────────────────────────────────

export async function rateTourStop(params: RateStopParams) {
  const { tourStopId, showingId, contactId,
    listingId, propertyAddress, listPrice, city, zip, interestLevel, note } = params

  if (!isValidUUID(tourStopId) || !isValidUUID(contactId)) {
    return { success: false, error: 'Invalid ID' }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Verify tour stop belongs to caller's brokerage and contact
  const { data: stopRow } = await supabase
    .from('tour_stops')
    .select('brokerage_id, contact_id')
    .eq('id', tourStopId)
    .maybeSingle()
  if (!stopRow) return { success: false, error: 'Tour stop not found' }
  if (stopRow.brokerage_id !== brokerageId) return { success: false, error: 'Forbidden' }
  if (stopRow.contact_id !== contactId) return { success: false, error: 'Contact ID mismatch' }

  await supabase
    .from('tour_stops')
    .update({ buyer_interest_level: interestLevel, buyer_note: note ?? null })
    .eq('id', tourStopId)
    .eq('brokerage_id', brokerageId)

  if (showingId && isValidUUID(showingId)) {
    await supabase
      .from('showings')
      .update({ buyer_interest_level: interestLevel, feedback: note ?? null })
      .eq('id', showingId)
      .eq('brokerage_id', brokerageId)
  }

  // Canonical learner vocabulary (matches preference-updater SIGNAL_WEIGHTS); legacy 'no' → not_for_us.
  const signalWeights: Record<string, number> = { love_it: 10, like_it: 3, maybe: 1, not_for_us: -5 }
  const canonicalSignal = interestLevel === 'no' ? 'not_for_us' : interestLevel

  // buyer_behavior_log.agent_id FKs to agents(id), and agents.id / users.id are
  // DISJOINT (§3) — this insert used to write the caller's users.id straight in,
  // so Postgres refused it with 23503 whenever that id had no agents twin. And
  // the result was not destructured, so the refusal RESOLVED silently (§3) and
  // every day-of tour reaction — love_it / like_it / maybe / not_for_us, the
  // highest-value behavior signals in the product — was lost to the preference
  // learner while the UI reported success. completeTour below had already been
  // fixed for the identical class; this is its sibling, now on the same shape.
  const { data: actorAgent, error: actorErr } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', agentUserId)
    .eq('brokerage_id', brokerageId)
    .maybeSingle()
  if (actorErr) console.error('[rateTourStop] agents resolution refused:', actorErr.message)
  const actorAgentId = (actorAgent as { id: string } | null)?.id ?? null

  const { error: logErr } = await supabase.from('buyer_behavior_log').insert({
    brokerage_id:     brokerageId,
    contact_id:       contactId,
    agent_id:         actorAgentId,
    signal_type:      canonicalSignal,
    listing_id:       listingId ?? null,
    property_address: propertyAddress,
    list_price:       listPrice ?? null,
    city:             city ?? null,
    zip:              zip ?? null,
    signal_value:     signalWeights[canonicalSignal] ?? 0,
    source:           'agent_dashboard',
    metadata:         { note, tour_stop_id: tourStopId },
  })
  if (logErr) {
    // The stop rating itself saved above; a lost learner signal must not fail
    // the rating — but it must never be silent, because a swallowed refusal
    // here is exactly how this signal went missing for its whole life.
    console.error('[rateTourStop] buyer_behavior_log insert refused — preference signal lost:', logErr.message)
  }

  return { success: true }
}

// ─── 6. Complete the tour ─────────────────────────────────────────────────────

export async function completeTour(params: CompleteTourParams) {
  const { tourId, contactId, agentNote, stopRatings } = params

  if (!isValidUUID(tourId) || !isValidUUID(contactId)) {
    return { success: false, error: 'Invalid ID' }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const agentUserId = auth.userId
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // buyer_behavior_log.agent_id FKs to agents(id) — resolve the caller's
  // agents row once (LIVE-FK class fix; users.id here failed the insert).
  // Brokerage-scoped and error-read since the rateTourStop sibling fix: a
  // multi-brokerage user must resolve to THIS tenant's agents row, and a
  // refused read must not silently become "no agent" (§3).
  const { data: actorAgent, error: actorErr } = await supabase
    .from('agents').select('id').eq('user_id', agentUserId).eq('brokerage_id', brokerageId).maybeSingle()
  if (actorErr) console.error('[completeTour] agents resolution refused:', actorErr.message)
  const actorAgentId = (actorAgent as { id: string } | null)?.id ?? null

  // Verify tour belongs to caller's brokerage and contact
  const { data: tourRow } = await supabase
    .from('tours')
    .select('brokerage_id, contact_id')
    .eq('id', tourId)
    .maybeSingle()
  if (!tourRow) return { success: false, error: 'Tour not found' }
  if (tourRow.brokerage_id !== brokerageId) return { success: false, error: 'Forbidden' }
  if (tourRow.contact_id !== contactId) return { success: false, error: 'Contact ID mismatch' }

  // Batch-update tour_stops — scope each by brokerage_id + tour_id
  for (const r of stopRatings) {
    if (!isValidUUID(r.tourStopId)) continue
    await supabase
      .from('tour_stops')
      .update({ buyer_interest_level: r.interestLevel, buyer_note: r.note ?? null })
      .eq('id', r.tourStopId)
      .eq('tour_id', tourId)
      .eq('brokerage_id', brokerageId)

    if (r.showingId && isValidUUID(r.showingId)) {
      await supabase
        .from('showings')
        .update({
          buyer_interest_level: r.interestLevel,
          feedback:             r.note ?? null,
          status:               'completed',
          completed_at:         new Date().toISOString(),
        })
        .eq('id', r.showingId)
        .eq('brokerage_id', brokerageId)
    }
  }

  // Complete the tour
  await supabase
    .from('tours')
    .update({ status: 'completed', notes: agentNote ?? null })
    .eq('id', tourId)
    .eq('brokerage_id', brokerageId)

  const signalWeights: Record<string, number> = { love_it: 10, like_it: 3, maybe: 1, not_for_us: -5 }
  const logInserts = stopRatings.map(r => {
    const canonicalSignal = r.interestLevel === 'no' ? 'not_for_us' : r.interestLevel
    return {
      brokerage_id:     brokerageId,
      contact_id:       contactId,
      agent_id:         actorAgentId,
      signal_type:      canonicalSignal,
      listing_id:       r.listingId ?? null,
      property_address: r.propertyAddress,
      list_price:       r.listPrice ?? null,
      city:             r.city ?? null,
      signal_value:     signalWeights[canonicalSignal] ?? 0,
      source:           'agent_dashboard',
      metadata:         { tour_id: tourId, note: r.note },
    }
  })
  // Destructured since the rateTourStop sibling fix: supabase-js RESOLVES a
  // refused insert (§3), and a silent refusal here loses the whole tour's
  // reaction batch to the preference learner while the tour still completes.
  const { error: batchLogErr } = await supabase.from('buyer_behavior_log').insert(logInserts)
  if (batchLogErr) {
    console.error('[completeTour] buyer_behavior_log batch insert refused — tour preference signals lost:', batchLogErr.message)
  }

  // Update preference model from new signals
  await updateBuyerPreferences(contactId, brokerageId).catch(() => {})

  // Lifecycle event
  const lovedCount  = stopRatings.filter(r => r.interestLevel === 'love_it').length
  const likedCount  = stopRatings.filter(r => r.interestLevel === 'like_it').length
  await supabase.from('lifecycle_events').insert({
    brokerage_id:  brokerageId,
    entity_type:   'buyer_lifecycle',
    entity_id:     contactId,
    event_type:    'tour.completed',
    actor_user_id: agentUserId,
    metadata:      {
      tour_id:     tourId,
      stops_count: stopRatings.length,
      loved_count: lovedCount,
      liked_count: likedCount,
    },
  })

  return {
    success:    true,
    lovedCount,
    likedCount,
    totalStops: stopRatings.length,
  }
}

// ─── 7. Generate AI plan narrative ───────────────────────────────────────────

export async function generateTourNarrative(params: {
  contactId: string
  brokerageId?: string  // ignored — derived from session
  stops: TourStop[]
  buyerName: string
}) {
  const { contactId, stops, buyerName } = params

  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }

  // Auth gate — burns paid AI inference. Was previously open: any caller
  // could trigger Claude Opus calls under our API key.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  // Verify contact belongs to caller's brokerage
  const svc = createServiceClient()
  const { data: contact } = await svc
    .from('contacts').select('brokerage_id').eq('id', contactId).maybeSingle()
  if (!contact) return { success: false, error: 'Contact not found' }
  if (contact.brokerage_id !== auth.brokerageId) return { success: false, error: 'Forbidden' }

  try {
    const { generateText, Output } = await import('ai')
    const { z } = await import('zod')

    const stopsText = stops.map((s, i) =>
      `Stop ${i + 1}: ${s.propertyAddress}${s.city ? ', ' + s.city : ''} — $${s.listPrice?.toLocaleString() ?? 'N/A'}`
    ).join('\n')

    const { experimental_output: object } = await generateText({
      model: 'anthropic/claude-opus-4-5',
      experimental_output: Output.object({ schema: z.object({ narrative: z.string() }) }),
      prompt: `You are a real estate tour planning assistant. Write a brief, practical tour narrative (2-3 sentences) for agent ${buyerName}'s buyer.
Tour stops:
${stopsText}

Focus on geography flow, any standout properties, and pacing. Be specific and helpful. No fluff.`,
    })

    return { success: true, narrative: object?.narrative ?? `This tour covers ${stops.length} properties for ${buyerName}. Properties are ordered for efficient routing. Review access instructions for each stop before departure.` }
  } catch {
    return {
      success:   true,
      narrative: `This tour covers ${stops.length} properties for ${buyerName}. Properties are ordered for efficient routing. Review access instructions for each stop before departure.`,
    }
  }
}

// ─── 9. Update tour stop order (manual drag reorder) ─────────────────────────

export async function updateTourStopOrder(
  tourId: string,
  orderedStopIds: string[]
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(tourId)) return { success: false, error: 'Invalid tour ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // Verify tour belongs to caller's brokerage
  const { data: tourRow } = await supabase
    .from('tours').select('brokerage_id').eq('id', tourId).maybeSingle()
  if (!tourRow) return { success: false, error: 'Tour not found' }
  if (tourRow.brokerage_id !== auth.brokerageId) return { success: false, error: 'Forbidden' }

  const updates = orderedStopIds
    .filter(id => isValidUUID(id))
    .map((id, idx) =>
      supabase.from('tour_stops')
        .update({ order_index: idx })
        .eq('id', id)
        .eq('tour_id', tourId)
        .eq('brokerage_id', auth.brokerageId)
    )
  const results = await Promise.all(updates)
  const failed = results.find(r => r.error)
  if (failed?.error) return { success: false, error: failed.error.message }
  return { success: true }
}

// ─── 11. The shortlist BECOMES a tour ────────────────────────────────────────
//
// THE DRIFT THIS CLOSES. The product grew a second route/drive-time lane:
// `app/actions/ai-predictions.ts:optimizeShowingRoute` writes
// `smart_showing_recommendations` — which of a buyer's SAVED homes are worth
// seeing, resolved against whichever property source serves the tenant (the
// platform's RentCast by default, the tenant's own IDX feed when connected),
// with the homes no source could answer reported by name. That is a REAL and
// distinct act: it is a recommendation, and nothing else in the product makes
// one. What it must NOT be is a second tour planner, and until this wave it was
// one — it guessed its own stop order and drive time from a model while the
// tour lane (tours + tour_stops + showings, and the kernel optimizer that
// sequences them by real geometry) answered the same question from coordinates.
//
// Owner ruling, verbatim: "you have smart showing route but there is also tour
// planning which was what we built originally. you have to be careful and not
// create more drifts we are trying to solve."
//
// So the recommendation now HANDS OFF instead of re-deriving: the row carries
// the kernel's order, the start time and the start address, and this action
// turns it into the real thing — createTourPlan (above) writes tours +
// tour_stops + showings, and lib/kernel/tour-optimizer.ts:optimizeTourRoute then
// runs over the SAVED tour, stamping tours.total_drive_time_minutes and the
// showing_routes audit row. One engine, one set of numbers, one lane the agent
// can actually schedule, confirm and run.
//
// EVERY GATE createTourPlan HOLDS STILL HOLDS: session-derived tenant and agent
// seat, the contact must be in the caller's brokerage, and the buyer must be
// financially verified. This is a shortcut through the shortlist, never around
// the gates.
export async function createTourFromShowingRecommendation(params: {
  recommendationId: string
}): Promise<{ success: boolean; error?: string; tourId?: string; stopCount?: number; optimized?: string }> {
  const { recommendationId } = params
  if (!isValidUUID(recommendationId)) return { success: false, error: 'Invalid recommendation ID' }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // The error is READ. supabase-js resolves a refusal, so "we were refused" and
  // "no such plan" are byte-identical if only `data` is destructured — and one
  // of those is a tenancy problem the agent must be told about.
  const { data: rec, error: recError } = await supabase
    .from('smart_showing_recommendations')
    .select('id, brokerage_id, contact_id, recommended_properties, showing_route, recommended_day')
    .eq('id', recommendationId)
    .maybeSingle()
  if (recError) return { success: false, error: `Could not read the showing plan: ${recError.message}` }
  if (!rec) return { success: false, error: 'Showing plan not found' }
  if (rec.brokerage_id !== auth.brokerageId) return { success: false, error: 'Forbidden' }
  if (!rec.contact_id) {
    // The table is dual-keyed (lead_id | contact_id). A tour hangs off a CONTACT,
    // and `contacts.id` and `leads.id` are disjoint spaces — so a lead-keyed plan
    // is refused rather than filed against a contact that does not exist.
    return {
      success: false,
      error: 'This showing plan is filed against a pre-conversion record. Promote it to a contact before planning a tour.',
    }
  }

  const route = (rec.showing_route ?? {}) as {
    startTime?: string | null
    startAddress?: string | null
    properties?: unknown
  }
  const rows = Array.isArray(rec.recommended_properties)
    ? (rec.recommended_properties as Array<Record<string, unknown>>)
    : []
  if (rows.length === 0) return { success: false, error: 'This showing plan has no homes in it.' }

  // The ORDER is the kernel's, carried across unchanged: the plan was sequenced
  // by lib/kernel/tour-optimizer.ts and re-sorting it here would be a second
  // opinion on the one fact this whole change exists to keep single.
  const ordered = [...rows].sort(
    (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0),
  )

  const stops: TourStop[] = ordered
    .map((r) => {
      const address = typeof r.address === 'string' ? r.address.trim() : ''
      if (!address) return null
      const drive = typeof r.driveMinutesFromPrev === 'number' ? r.driveMinutesFromPrev : undefined
      const duration = typeof r.durationMinutes === 'number' ? r.durationMinutes : 30
      return {
        propertyAddress: address,
        suggestedDurationMinutes: duration,
        // Carried so the created plan's clock matches the shortlist the agent
        // approved. Un-geocoded homes carried NO drive on the plan and carry
        // none here either — `undefined`, never 0.
        driveTimeFromPrevMinutes: drive ?? undefined,
      } as TourStop
    })
    .filter((s): s is TourStop => s !== null)

  if (stops.length === 0) return { success: false, error: 'None of the homes on this plan carry an address to tour.' }

  const startTime = typeof route.startTime === 'string' && /^\d{1,2}:\d{2}/.test(route.startTime)
    ? route.startTime
    : null
  if (!startTime) {
    return { success: false, error: 'This showing plan has no start time, so a tour day cannot be laid out from it.' }
  }
  const tourDate = rec.recommended_day
  if (!tourDate) return { success: false, error: 'This showing plan has no date.' }

  const created = await createTourPlan({
    contactId: rec.contact_id,
    // Ignored by createTourPlan — it derives both from the session (§4). Passed
    // only because the parameter shape requires them.
    agentUserId: auth.userId,
    brokerageId: auth.brokerageId,
    tourDate,
    startTime,
    startAddress: typeof route.startAddress === 'string' && route.startAddress.trim()
      ? route.startAddress.trim()
      : undefined,
    stops,
    // NO totalDriveTimeMinutes ON PURPOSE. A non-null tours.total_drive_time_minutes
    // is the kernel optimizer's idempotency stamp, so passing one here would mark
    // the new tour "already optimized" and the run below — the one that writes the
    // per-leg drives and the showing_routes audit row — would skip it forever.
    totalDurationMinutes: stops.reduce(
      (a, s) => a + (s.suggestedDurationMinutes ?? 30) + (s.driveTimeFromPrevMinutes ?? 0),
      0,
    ),
  })
  if (!created.success || !created.tourId) {
    return { success: false, error: created.error ?? 'Failed to create the tour' }
  }

  // ONE ENGINE, RUN ON THE SAVED TOUR. Same module the plan tab, the confirm tab,
  // the voice lane and the cron sweep run. A refusal here does not undo the tour:
  // the tour exists and is schedulable; what it lacks is the audit row, and that
  // is reported rather than hidden.
  let optimized: string | undefined
  try {
    const { optimizeTourRoute } = await import('@/lib/kernel/tour-optimizer')
    const r = await optimizeTourRoute(created.tourId, supabase)
    optimized = r.ok
      ? `${r.stopsSequenced}/${r.stopsTotal} stops sequenced by drive time (~${r.totalDriveMinutes} min est.).`
      : `The tour was created but the route optimizer did not run: ${r.reason ?? 'unknown'}.`
  } catch (err) {
    optimized = `The tour was created but the route optimizer did not run: ${
      err instanceof Error ? err.message : 'unknown error'
    }.`
  }

  return { success: true, tourId: created.tourId, stopCount: stops.length, optimized }
}
