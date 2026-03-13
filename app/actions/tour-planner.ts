'use server'

/**
 * SYSTEM 5.1 — BUYER TOUR PLANNER (L5-B03)
 * Server actions: create tours, confirm stops, rate showings, complete tours.
 * All writes go to tours, tour_stops, showings, buyer_behavior_log, lifecycle_events.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { emitLifecycleTransition } from '@/lib/buyer-lifecycle/lifecycle-logger'
import { updateBuyerPreferences } from '@/lib/behavior-learning'
import { isValidUUID } from '@/lib/validations'

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
  schedulingMethod?: 'showingtime' | 'call_agent' | 'other'
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
  stops: TourStop[]
  aiPlanNarrative?: string
  notes?: string
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
  // Supabase CHECK constraint: buyer_interest_level = ANY ('love_it','like_it','maybe','no')
  // 'not_for_us' is NOT valid - use 'no' instead
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
    // Supabase CHECK constraint: buyer_interest_level = ANY ('love_it','like_it','maybe','no')
    interestLevel: 'love_it' | 'like_it' | 'maybe' | 'no'
    note?: string
    listingId?: string
    propertyAddress: string
    listPrice?: number
    city?: string
    zip?: string
  }>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

  const supabase = createServiceClient()

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
      listings (
        id, address, city, state, zip, list_price,
        bedrooms, bathrooms, sqft, mls_number,
        agent_id, showing_instructions
      )
    `)
    .eq('contact_id', contactId)
    .eq('dismissed', false)
    .order('ai_match_score', { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, properties: data ?? [] }
}

// ─── 2. Load existing tours for a buyer ───────────────────────────────────────

export async function getBuyerTours(contactId: string) {
  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }

  const supabase = createServiceClient()

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
        time_arrived_at, time_left_at, time_spent_minutes
      )
    `)
    .eq('contact_id', contactId)
    .order('tour_date', { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, tours: data ?? [] }
}

// ─── 3. Create a tour plan ────────────────────────────────────────────────────

export async function createTourPlan(params: CreateTourParams) {
  const { contactId, agentUserId, brokerageId, tourDate, startTime, stops, aiPlanNarrative, notes } = params

  if (!isValidUUID(contactId) || !isValidUUID(agentUserId) || !isValidUUID(brokerageId)) {
    return { success: false, error: 'Invalid ID' }
  }
  if (!stops.length) return { success: false, error: 'No stops provided' }

  const supabase = createServiceClient()

  // Insert tour
  const { data: tour, error: tourError } = await supabase
    .from('tours')
    .insert({
      contact_id:        contactId,
      buyer_id:          contactId,
      agent_id:          agentUserId,
      brokerage_id:      brokerageId,
      tour_date:         tourDate,
      status:            'planned',
      notes:             notes ?? null,
      ai_plan_narrative: aiPlanNarrative ?? null,
      plan_sent_at:      new Date().toISOString(),
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
    scheduling_method:           s.schedulingMethod ?? 'call_agent',
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
    agent_id:      agentUserId,
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

  return { success: true, tourId, stopCount: stops.length }
}

// ─── 4. Confirm a single stop ─────────────────────────────────────────────────

export async function confirmTourStop(params: ConfirmStopParams) {
  const {
    tourStopId, showingId, tourId,
    confirmedTime, accessMethod, accessCode, accessInstructions,
    listingAgentName, listingAgentPhone, listingAgentCompany,
    schedulingReference, brokerageId, contactId, agentUserId,
  } = params

  const supabase = createServiceClient()

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
      scheduling_reference:   schedulingReference ?? null,
      is_confirmed:           true,
    })
    .eq('id', tourStopId)

  if (stopError) return { success: false, error: stopError.message }

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

// ─── 4b. Confirm Tour (tour-level confirm — sets status='confirmed') ──────────

export async function confirmTour(params: {
  tourId: string
  brokerageId: string
  contactId: string
  agentUserId: string
  departureTime?: string
  agentNotes?: string
}) {
  const { tourId, brokerageId, contactId, agentUserId, departureTime, agentNotes } = params
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('tours')
    .update({
      status:       'confirmed',
      confirmed_at: new Date().toISOString(),
      notes:        agentNotes ?? null,
    })
    .eq('id', tourId)

  if (error) return { success: false, error: error.message }

  await supabase.from('lifecycle_events').insert({
    brokerage_id:  brokerageId,
    entity_type:   'buyer_lifecycle',
    entity_id:     contactId,
    event_type:    'tour.confirmed',
    actor_user_id: agentUserId,
    metadata:      { tour_id: tourId, departure_time: departureTime },
  })

  return { success: true }
}

// ─── 5. Rate a stop (day-of) ──────────────────────────────────────────────────

export async function rateTourStop(params: RateStopParams) {
  const { tourStopId, showingId, contactId, brokerageId, agentUserId,
    listingId, propertyAddress, listPrice, city, zip, interestLevel, note } = params

  const supabase = createServiceClient()

  await supabase
    .from('tour_stops')
    .update({ buyer_interest_level: interestLevel, buyer_note: note ?? null })
    .eq('id', tourStopId)

  if (showingId && isValidUUID(showingId)) {
    await supabase
      .from('showings')
      .update({ buyer_interest_level: interestLevel, feedback: note ?? null })
      .eq('id', showingId)
  }

  // Signal weight: love_it=10, like_it=5, maybe=2, no=-2
  // Supabase CHECK constraint uses 'no' not 'not_for_us'
  const signalWeights: Record<string, number> = { love_it: 10, like_it: 5, maybe: 2, no: -2 }
  await supabase.from('buyer_behavior_log').insert({
    brokerage_id:     brokerageId,
    contact_id:       contactId,
    agent_id:         agentUserId,
    signal_type:      interestLevel,
    listing_id:       listingId ?? null,
    property_address: propertyAddress,
    list_price:       listPrice ?? null,
    city:             city ?? null,
    zip:              zip ?? null,
    signal_value:     signalWeights[interestLevel],
    source:           'agent_dashboard',
    metadata:         { note, tour_stop_id: tourStopId },
  })

  return { success: true }
}

// ─── 6. Complete the tour ─────────────────────────────────────────────────────

export async function completeTour(params: CompleteTourParams) {
  const { tourId, contactId, brokerageId, agentUserId, agentNote, stopRatings } = params

  const supabase = createServiceClient()

  // Batch-update tour_stops
  for (const r of stopRatings) {
    await supabase
      .from('tour_stops')
      .update({ buyer_interest_level: r.interestLevel, buyer_note: r.note ?? null })
      .eq('id', r.tourStopId)

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
    }
  }

  // Complete the tour
  await supabase
    .from('tours')
    .update({ status: 'completed', notes: agentNote ?? null })
    .eq('id', tourId)

  // Bulk buyer_behavior_log
  // Supabase CHECK constraint uses 'no' not 'not_for_us'
  const signalWeights: Record<string, number> = { love_it: 10, like_it: 5, maybe: 2, no: -2 }
  const logInserts = stopRatings.map(r => ({
    brokerage_id:     brokerageId,
    contact_id:       contactId,
    agent_id:         agentUserId,
    signal_type:      r.interestLevel,
    listing_id:       r.listingId ?? null,
    property_address: r.propertyAddress,
    list_price:       r.listPrice ?? null,
    city:             r.city ?? null,
    signal_value:     signalWeights[r.interestLevel],
    source:           'agent_dashboard',
    metadata:         { tour_id: tourId, note: r.note },
  }))
  await supabase.from('buyer_behavior_log').insert(logInserts)

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
  brokerageId: string
  stops: TourStop[]
  buyerName: string
}) {
  const { contactId, brokerageId, stops, buyerName } = params

  try {
    const { generateObject } = await import('ai')
    const { z } = await import('zod')

    const stopsText = stops.map((s, i) =>
      `Stop ${i + 1}: ${s.propertyAddress}${s.city ? ', ' + s.city : ''} — $${s.listPrice?.toLocaleString() ?? 'N/A'}`
    ).join('\n')

    const { object } = await generateObject({
      model: 'anthropic/claude-opus-4-5',
      schema: z.object({ narrative: z.string() }),
      prompt: `You are a real estate tour planning assistant. Write a brief, practical tour narrative (2-3 sentences) for agent ${buyerName}'s buyer.
Tour stops:
${stopsText}

Focus on geography flow, any standout properties, and pacing. Be specific and helpful. No fluff.`,
    })

    return { success: true, narrative: object.narrative }
  } catch {
    return {
      success:   true,
      narrative: `This tour covers ${stops.length} properties for ${buyerName}. Properties are ordered for efficient routing. Review access instructions for each stop before departure.`,
    }
  }
}
