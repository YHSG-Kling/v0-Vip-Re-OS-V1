"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { ContentGenerationResult } from "@/lib/services"
import {
  sendOpenHouseInvitation,
  sendWeatherAlertToAgent,
  sendFeedbackRequest,
} from "@/lib/communications"
import { completeOpenHouseCheckInAction } from "@/app/actions/open-house-kernel"

function parseAIJsonResponse(text: string) {
  let cleanText = text.trim()
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/^```json\s*/, "").replace(/```\s*$/, "")
  } else if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```\s*/, "").replace(/```\s*$/, "")
  }
  return JSON.parse(cleanText.trim())
}

// ============================================
// OPEN HOUSE CRUD OPERATIONS
// ============================================

export async function scheduleOpenHouse(params: {
  listingId: string
  agentId: string
  startTime: string
  endTime: string
  description?: string
}) {
  try {
    const supabase = await createClient()

    // THE TENANT IS THE LISTING'S, RESOLVED THROUGH THE RECORD — not the
    // caller's. See the worked rationale at app/actions/open-house.ts:481-498:
    // an open house is filed against `listing_id`, so the event belongs to
    // whichever brokerage owns that listing, and resolving it from the record
    // is also what the DB-side triggers compute.
    //
    // This insert stamped nothing at all, so it filed open_house_events rows
    // with a NULL brokerage_id into a table every other writer stamps
    // (open-house.ts:111, seller-open-house.ts:523,
    // seller-listing/execution-engine.ts:854,
    // lib/wizard-staging/content-staging.ts:192). `NULL = <uuid>` is NULL and
    // never true, so those rows are invisible to every reader that narrows with
    // .eq("brokerage_id", …) — including verifyEventOwnership() in
    // seller-open-house.ts, which is what gates the RSVP and QR flows.
    //
    // `params.agentId` is passed through untouched: open_house_events.agent_id
    // FKs agents(id), a disjoint id space from brokerages(id). The two must
    // never be bridged.
    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("brokerage_id")
      .eq("id", params.listingId)
      .maybeSingle()

    if (listingErr) throw listingErr
    if (!listing?.brokerage_id) {
      return {
        success: false,
        error: "Listing not found, or it has no brokerage on record — the open house was not created.",
      }
    }

    const { data, error } = await supabase
      .from("open_house_events")
      .insert({
        listing_id: params.listingId,
        brokerage_id: listing.brokerage_id,
        agent_id: params.agentId,
        event_date: params.startTime.split("T")[0],
        start_time: params.startTime,
        end_time: params.endTime,
        description: params.description,
        status: "scheduled",
      })
      .select()
      .maybeSingle()

    if (error) throw error
    if (!data) throw new Error("Failed to create open house event")

    revalidatePath("/dashboard")
    return { success: true, openHouse: data }
  } catch (error) {
    return handleError(error, "scheduleOpenHouse")
  }
}

export async function getOpenHouseVisitors(openHouseId: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("open_house_attendees")
      .select("*, contact:contacts(*)")
      .eq("event_id", openHouseId)
      .order("check_in_time", { ascending: false })

    if (error) throw error

    return { success: true, visitors: data || [] }
  } catch (error) {
    return handleError(error, "getOpenHouseVisitors")
  }
}

export async function recordVisitor(params: {
  openHouseId: string
  contactId?: string
  firstName: string
  lastName: string
  email?: string
  phone?: string
  notes?: string
  interestLevel?: string
}) {
  try {
    const supabase = await createClient()

    // Auth gate: get current user and brokerage
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return { success: false, error: "Unauthorized" }
    }

    const { data: userRow } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .maybeSingle()

    if (!userRow?.brokerage_id) {
      return { success: false, error: "Brokerage not found" }
    }

    // If contact_id is provided, use direct insert
    if (params.contactId) {
      // TENANT: the EVENT'S brokerage, read from the record this attendee is
      // filed against — the same anchor `app/api/open-house/attend/route.ts` and
      // `lib/kernel/open-house.ts` already use for this table, so there is one
      // way an attendee gets its tenant rather than two.
      //
      // The event is also OWNERSHIP-CHECKED against the caller's brokerage here.
      // `endOpenHouseEvent` reads attendees `.eq("event_id", …).eq("brokerage_id",
      // <caller's users.brokerage_id>)`, so an attendee whose event belongs to
      // another brokerage is unreadable however it is stamped — and stamping the
      // caller's brokerage on another tenant's event would file the row across
      // the boundary. Refuse instead.
      const { data: event, error: eventErr } = await supabase
        .from("open_house_events")
        .select("id, brokerage_id")
        .eq("id", params.openHouseId)
        .maybeSingle()
      if (eventErr) {
        return { success: false, error: `Could not verify the open house: ${eventErr.message}` }
      }
      if (!event) {
        return { success: false, error: "Open house event not found" }
      }
      if (event.brokerage_id !== userRow.brokerage_id) {
        return { success: false, error: "Forbidden: this open house belongs to another brokerage" }
      }

      const { data, error } = await supabase
        .from("open_house_attendees")
        .insert({
          event_id: params.openHouseId,
          brokerage_id: event.brokerage_id,
          contact_id: params.contactId,
          name: `${params.firstName ?? ""} ${params.lastName ?? ""}`.trim(),
          email: params.email,
          phone: params.phone,
          notes: params.notes,
          interest_level: mapInterestLevelText(params.interestLevel),
          check_in_time: new Date().toISOString(),
        })
        .select()
        .maybeSingle()

      if (error) throw error
      if (!data) throw new Error("Failed to record visitor")

      revalidatePath("/dashboard")
      return { success: true, visitor: data, contactId: params.contactId }
    }

    // Walk-in: use kernel flow to resolve or create contact first
    const checkInResult = await completeOpenHouseCheckInAction({
      brokerage_id: userRow.brokerage_id,
      agent_id: user.id,
      open_house_id: params.openHouseId,
      first_name: params.firstName,
      last_name: params.lastName,
      email: params.email,
      phone: params.phone,
      check_in_method: "manual",
      interest_level: mapInterestLevel(params.interestLevel),
      notes: params.notes,
    })

    if (!checkInResult.success) {
      throw new Error(checkInResult.error || "Failed to process walk-in check-in")
    }

    revalidatePath("/dashboard")
    return {
      success: true,
      visitor: { id: checkInResult.attendee_id },
      contactId: checkInResult.contact_id,
      nextActionId: checkInResult.next_action_id,
    }
  } catch (error) {
    return handleError(error, "recordVisitor")
  }
}

/**
 * Map interest_level string to numeric 1-5 scale
 */
function mapInterestLevel(interest?: string): number {
  const levelMap: Record<string, number> = {
    not_interested: 1,
    somewhat_interested: 3,
    interested: 4,
    very_interested: 5,
  }
  return levelMap[interest || "somewhat_interested"] || 3
}

// open_house_attendees.interest_level is CHECK-constrained to hot|warm|cold|no_interest.
function mapInterestLevelText(interest?: string): "hot" | "warm" | "cold" | "no_interest" {
  const m: Record<string, "hot" | "warm" | "cold" | "no_interest"> = {
    not_interested: "no_interest",
    just_looking: "cold",
    somewhat_interested: "warm",
    interested: "warm",
    very_interested: "hot",
    ready_to_offer: "hot",
  }
  return m[interest || "somewhat_interested"] || "warm"
}

// ============================================
// AI TIMING OPTIMIZER
// ============================================

/** Returns the next upcoming Saturday and Sunday from today as YYYY-MM-DD strings */
function nextWeekendDates(): { saturday: string; sunday: string } {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 6=Sat
  const daysToSat = day === 6 ? 7 : (6 - day)
  const sat = new Date(now)
  sat.setDate(now.getDate() + daysToSat)
  const sun = new Date(sat)
  sun.setDate(sat.getDate() + 1)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { saturday: fmt(sat), sunday: fmt(sun) }
}

export async function optimizeOpenHouseTiming(params: { propertyId: string; agentId: string; proposedDate?: string }) {
  if (!isValidUUID(params.agentId)) {
    const { saturday, sunday } = nextWeekendDates()
    return {
      recommended_times: [
        { date: saturday, time: "14:00-16:00", score: 92, reasoning: "Saturday afternoon is prime time — families have flexibility after morning activities. 1-3 PM captures both early and mid-afternoon browsers." },
        { date: sunday, time: "13:00-15:00", score: 88, reasoning: "Sunday early afternoon works well for serious buyers who prefer less crowded viewings. Good natural lighting and comfortable timing." },
      ],
    }
  }

  const supabase = await createClient()

  try {
    const { data: property } = await supabase.from("listings").select("*").eq("id", params.propertyId).maybeSingle()
    if (!property) {
      return { success: false, error: "Property not found" }
    }

    // Get historical data
    const { data: historical } = await supabase
      .from("open_house_events")
      .select("*, listing:listings!inner(property_type), open_house_analytics(*)")
      // tenant anchor (scope burn-down): history from the property's own brokerage
      .eq("brokerage_id", property.brokerage_id)
      .eq("listing.property_type", property?.property_type)
      .order("event_date", { ascending: false })
      .limit(20)

    const prompt = `Analyze optimal open house timing for this property:

PROPERTY DETAILS:
- Type: ${property?.property_type}
- Price: $${property?.price}
- Location: ${property?.address}
- Target Buyers: ${property?.target_buyer_personas || "general"}

HISTORICAL DATA (Similar Properties):
${
  historical
    ?.map(
      (h: any) =>
        `- ${h.event_date} ${h.start_time}: ${h.actual_attendance || 0} attendees (predicted: ${h.predicted_attendance || 0})`
    )
    .join("\n") || "No historical data"
}

CONSTRAINTS:
- Avoid major holidays
- Consider local market patterns
- Weekend preferred but not required
- Weather considerations

ANALYSIS NEEDED:
1. Best day of week (Saturday vs Sunday vs weekday)
2. Optimal time slot (morning, afternoon, evening)
3. Seasonal considerations
4. Competition analysis (other open houses)
5. Market activity levels

OUTPUT FORMAT (JSON):
{
  "recommended_times": [
    {
      "date": "YYYY-MM-DD",
      "time": "HH:MM-HH:MM",
      "score": 0-100,
      "reasoning": "why this time is optimal",
      "expected_attendance": 15,
      "competition_level": "low" | "medium" | "high"
    }
  ],
  "avoid_dates": ["YYYY-MM-DD"],
  "best_practices": ["tip1", "tip2"]
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    return parseAIJsonResponse(text)
  } catch (error) {
    console.error("Optimize timing error:", error)
    return { error: "Failed to optimize timing" }
  }
}

// ============================================
// MATCH SCORING
// ============================================

export async function calculateMatchScore(contactId: string, propertyId: string): Promise<number> {
  if (!isValidUUID(contactId) || !isValidUUID(propertyId)) {
    return 0
  }

  const supabase = await createClient()

  try {
    const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).maybeSingle()

    const { data: property } = await supabase.from("listings").select("*").eq("id", propertyId).maybeSingle()

    if (!contact || !property) return 0

    let score = 0

    // Price match (0-25 points)
    const budgetMin = contact.budget_min || 0
    const budgetMax = contact.budget_max || Number.POSITIVE_INFINITY
    if (property.price >= budgetMin && property.price <= budgetMax) {
      score += 25
    } else if (property.price < budgetMin * 1.1 || property.price > budgetMax * 0.9) {
      score += 15 // Within 10% tolerance
    }

    // Beds/baths match (0-20 points)
    if (contact.beds_wanted && property.beds >= contact.beds_wanted) {
      score += 10
    }
    if (contact.baths_wanted && property.baths >= contact.baths_wanted) {
      score += 10
    }

    // Location match (0-15 points)
    if (contact.preferred_locations?.includes(property.neighborhood)) {
      score += 15
    } else if (contact.preferred_locations?.some((loc: string) => property.address?.includes(loc))) {
      score += 10
    }

    // Property type match (0-10 points)
    if (contact.property_type_preference === property.property_type) {
      score += 10
    }

    // Features match (0-20 points)
    const desiredFeatures = contact.must_have_features || []
    const propertyFeatures = property.features || []
    const matchingFeatures = desiredFeatures.filter((f: string) => propertyFeatures.includes(f))
    score += Math.min((matchingFeatures.length / Math.max(desiredFeatures.length, 1)) * 20, 20)

    // Engagement score (0-10 points)
    score += ((contact.engagement_score || 0) / 100) * 10

    return Math.min(score, 100)
  } catch (error) {
    console.error("Calculate match score error:", error)
    return 0
  }
}

// ============================================
// PERSONALIZED INVITATIONS
// ============================================

export async function generatePersonalizedInvite(params: { contactId: string; eventId: string }) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: contact } = await supabase.from("contacts").select("*").eq("id", params.contactId).maybeSingle()

    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", params.eventId)
      .maybeSingle()

    const { data: persona } = await supabase
      .from("client_detailed_personas")
      .select("*")
      .eq("id", contact?.persona_id)
      .maybeSingle()

    const matchScore = await calculateMatchScore(params.contactId, event?.listing_id)

    const prompt = `Generate personalized open house invitation for ${contact?.first_name} ${contact?.last_name}.

RECIPIENT PROFILE:
- Name: ${contact?.first_name} ${contact?.last_name}
- Persona: ${persona?.persona_type || "general"}
- Looking for: ${contact?.beds_wanted} bed, ${contact?.baths_wanted} bath
- Budget: $${contact?.budget_min}-${contact?.budget_max}
- Priorities: ${contact?.must_have_features?.join(", ") || "Not specified"}
- Timeline: ${contact?.timeline || "flexible"}
- Pain Points: ${persona?.pain_points?.join(", ") || "Unknown"}

PROPERTY DETAILS:
- Address: ${event?.property?.address}
- Beds/Baths: ${event?.property?.beds}/${event?.property?.baths}
- Price: $${event?.property?.price}
- Key Features: ${event?.property?.features?.join(", ") || "Various"}
- Neighborhood: ${event?.property?.neighborhood}

MATCH REASONING:
- Match Score: ${matchScore}/100
- Why this fits: ${generateMatchReasoning(contact, event?.property, matchScore)}

OPEN HOUSE DETAILS:
- Date: ${event?.event_date}
- Time: ${event?.start_time} - ${event?.end_time}

TASK: Write personalized invitation that:
1. Addresses ${contact?.first_name} by name
2. Highlights property features matching THEIR specific priorities
3. Explains why THIS home fits THEIR needs (not generic)
4. Creates gentle urgency without pressure
5. Makes it easy to RSVP

TONE: ${persona?.communication_preferences === "formal" ? "Professional but friendly" : "Warm and conversational"}

DO NOT use generic phrases like "great opportunity" or "don't miss out"
DO reference their specific search criteria
DO make them feel you're thinking about THEM specifically

OUTPUT FORMAT (JSON):
{
  "email_subject": "...",
  "email_body": "...",
  "sms_message": "...",
  "reasoning": "Why this property matches this contact"
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    const result = parseAIJsonResponse(text)

    revalidatePath("/dashboard/open-house")
    return { success: true, data: result, invite: result.email_body ?? null }
  } catch (error) {
    console.error("Generate invite error:", error)
    return { success: false, error: "Failed to generate invitation" }
  }
}

function generateMatchReasoning(contact: any, property: any, score: number): string {
  const reasons = []

  if (property?.price >= contact?.budget_min && property?.price <= contact?.budget_max) {
    reasons.push("Within budget")
  }
  if (property?.beds >= contact?.beds_wanted) {
    reasons.push(`Has ${contact?.beds_wanted}+ bedrooms as requested`)
  }
  if (contact?.preferred_locations?.includes(property?.neighborhood)) {
    reasons.push("In preferred neighborhood")
  }

  return reasons.join(", ") || "Good general fit"
}

// ============================================
// SEND INVITATIONS
// ============================================

export async function sendOpenHouseInvitations(params: { eventId: string; contactIds: string[] }) {
  if (!isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid event ID" }
  }

  const supabase = await createClient()
  const results = []

  for (const contactId of params.contactIds) {
    if (!isValidUUID(contactId)) continue

    try {
      const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).maybeSingle()

      const { data: event } = await supabase.from("open_house_events").select("*").eq("id", params.eventId).maybeSingle()

      // Generate personalized content
      const inviteResult = await generatePersonalizedInvite({ contactId, eventId: params.eventId })

      if (!inviteResult.success) {
        results.push({ contactId, status: "failed", error: "Content generation failed" })
        continue
      }

      const matchScore = await calculateMatchScore(contactId, event?.listing_id)

      // STAGED, THEN PROMOTED ON A REAL DISPATCH. This row used to be written
      // with sent_at = now() BEFORE the send was attempted, by code whose send
      // was an empty comment — and then results.push said "sent" regardless of
      // what happened. Every count downstream (total_invites_sent on the event
      // analytics reads this table) inherited the fabrication. The sibling
      // writer in seller-open-house.ts was already corrected this way; this one
      // was missed.
      //
      // contacts.preferred_contact_method has NO check constraint, but
      // open_house_invitations.channel does — {both, email, in_app, sms}. A
      // contact whose preference is "phone" or "text" silently FAILED the
      // insert. Normalise to the vocabulary the column actually accepts.
      const preference = String(contact?.preferred_contact_method ?? "").toLowerCase()
      const channel: "email" | "sms" | "both" =
        preference === "sms" || preference === "text" || preference === "phone"
          ? "sms"
          : preference === "both"
            ? "both"
            : "email"

      const { data: invitation } = await supabase
        .from("open_house_invitations")
        .insert({
          event_id: params.eventId,
          contact_id: contactId,
          brokerage_id: contact?.brokerage_id ?? null,
          channel,
          personalized_message: inviteResult.data.email_body,
          match_score: matchScore,
          match_reasoning: inviteResult.data.reasoning,
          status: "queued",
          sent_at: null,
        })
        .select()
        .maybeSingle()

      if (!invitation?.id) {
        results.push({ contactId, status: "failed", error: "Could not stage the invitation" })
        continue
      }

      // sendOpenHouseInvitation RETURNS { success:false, error } for a refusal
      // (DNC, suppression, quiet hours, no address on file) — it does not throw,
      // so the catch below would never see one. Read the result.
      const sendRes = await sendOpenHouseInvitation({
        contactId,
        eventId: params.eventId,
        method: channel,
        personalizedMessage: inviteResult.data.email_body,
        // generatePersonalizedInvite writes an sms_message per contact and this
        // was the only place that could carry it to the send.
        personalizedSms: inviteResult.data.sms_message,
      })

      if (sendRes.success) {
        await supabase
          .from("open_house_invitations")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", invitation.id)
      }

      results.push({
        contactId,
        status: sendRes.success ? "sent" : "failed",
        error: sendRes.success ? undefined : sendRes.error,
        invitationId: invitation.id,
      })
    } catch (error) {
      results.push({ contactId, status: "failed", error: String(error) })
    }
  }

  // MARKETING REACH IS WHO WAS REACHED, not who was considered. This used to be
  // params.contactIds.length — the size of the input list — so a run in which
  // every single send was refused still reported full reach.
  const delivered = results.filter((r) => r.status === "sent").length
  await supabase
    .from("open_house_events")
    .update({ marketing_reach: delivered })
    .eq("id", params.eventId)

  revalidatePath("/dashboard/open-house")
  // success means at least one invitation actually left the building. A run
  // where every contact was suppressed is not a success with a nice list.
  return {
    success: delivered > 0,
    delivered,
    attempted: results.length,
    error: delivered > 0 ? undefined : (results.find((r) => r.error)?.error ?? "No invitation was delivered"),
    results,
  }
}

// ============================================
// RSVP HANDLING
// ============================================

/**
 * RSVP from an emailed invitation link.
 *
 * CREDENTIAL MODEL — read this before touching the client below. The invitee is
 * an ANONYMOUS visitor: they hold an invitation link, not a platform login, and
 * most of them never will (they are contacts, not users). The unguessable pair
 * (eventId, invitationId) IS the credential — both must be supplied and the
 * invitation must actually belong to that event, which is checked below.
 *
 * This ran on `createClient()` (the caller's RLS session). Verified live: the
 * `open_house_invitations` policy is
 * `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`, and the
 * rows `inviteContacts` writes carry the contact's real `brokerage_id` — so for
 * an anonymous invitee `current_user_brokerage_id()` is NULL, the predicate is
 * false, and the SELECT was REFUSED. The function's own honest error path then
 * told every invitee "Could not look up that invitation". **No RSVP from an
 * emailed link could ever have succeeded.** The service client is the door this
 * lane needs; the id pair, not a session, is what authorizes it.
 */
export async function handleRSVP(params: { eventId: string; invitationId: string; response: "yes" | "maybe" | "no" }) {
  if (!isValidUUID(params.eventId) || !isValidUUID(params.invitationId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  try {
    // Destructure `error` (wave 4 slice 2). supabase-js RESOLVES a refused
    // query, so `const { data: invitation }` alone turned an RLS refusal into
    // the same "Invitation not found" as a bad id — and this path then went on
    // to write.
    const { data: invitation, error: invErr } = await supabase
      .from("open_house_invitations")
      .select("*")
      .eq("id", params.invitationId)
      .maybeSingle()

    if (invErr) {
      return { success: false, error: "Could not look up that invitation — your RSVP was not recorded." }
    }
    if (!invitation) {
      return { success: false, error: "Invitation not found" }
    }
    // The invitation must actually belong to the event named in the link.
    // Without this, an invitation id and an event id from two different
    // brokerages could be combined into one tracking row.
    if (invitation.event_id !== params.eventId) {
      return { success: false, error: "Invitation not found" }
    }

    // Update invitation — refuse a zero-row write instead of thanking the
    // invitee for an RSVP that was never recorded.
    const { data: updated, error: updErr } = await supabase
      .from("open_house_invitations")
      .update({
        rsvp_response: params.response,
        rsvp_updated_at: new Date().toISOString(),
      })
      .eq("id", params.invitationId)
      .select("id")

    if (updErr) return { success: false, error: "Your RSVP could not be saved. Please try again." }
    if (!updated || updated.length === 0) {
      return { success: false, error: "Your RSVP could not be saved. Please try again." }
    }

    // Track RSVP.
    // brokerage_id is STAMPED from the invitation. It was omitted entirely, and
    // open_house_rsvp_tracking's RLS policy is
    // `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()` with
    // a NULLABLE brokerage_id (both verified live) — so every row this endpoint
    // wrote was untenanted, which under that policy means readable AND writable
    // by every user of every tenant, and by anonymous callers. Stamping the
    // tenant closes it; a row with no resolvable tenant is refused rather than
    // written world-open.
    const rsvpBrokerageId = (invitation as { brokerage_id?: string | null }).brokerage_id ?? null
    if (!rsvpBrokerageId) {
      return { success: false, error: "This invitation is not linked to a brokerage — your RSVP was not recorded." }
    }
    const { error: trackErr } = await supabase.from("open_house_rsvp_tracking").insert({
      brokerage_id: rsvpBrokerageId,
      event_id: params.eventId,
      contact_id: invitation.contact_id,
      rsvp_status: params.response,
      rsvp_updated_at: new Date().toISOString(),
    })
    if (trackErr) {
      // The RSVP itself landed on the invitation above — say what did and did
      // not happen rather than reporting a clean success or a clean failure.
      console.error("[handleRSVP] rsvp tracking insert failed:", trackErr.message)
    }

    revalidatePath("/dashboard/open-house")

    const message = {
      yes: "Great! We look forward to seeing you. Calendar invite sent to your email.",
      maybe: "No problem! We hope you can make it. Let us know if plans change.",
      no: "Thanks for letting us know. We'll keep you updated on other properties.",
    }[params.response]

    return { success: true, message }
  } catch (error) {
    console.error("Handle RSVP error:", error)
    return { success: false, error: "Failed to record RSVP" }
  }
}

// ============================================
// ATTENDANCE PREDICTION
// ============================================

export async function predictAttendance(eventId: string) {
  if (!isValidUUID(eventId)) {
    return {
      predicted_attendance_low: 12,
      predicted_attendance_mid: 18,
      predicted_attendance_high: 24,
      confidence_level: 0.78,
      serious_buyers_expected: 5,
    }
  }

  const supabase = await createClient()

  try {
    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", eventId)
      .maybeSingle()

    if (!event) {
      return { success: false, error: "Event not found" }
    }

    const { data: invitations } = await supabase.from("open_house_invitations").select("*").eq("event_id", eventId)

    const { data: historical } = await supabase
      .from("open_house_events")
      .select("*, listing:listings!inner(property_type), open_house_analytics(*)")
      // tenant anchor (scope burn-down): history from the event's own brokerage
      .eq("brokerage_id", event.brokerage_id)
      .eq("listing.property_type", event?.property?.property_type)
      .limit(10)

    const rsvpYes = invitations?.filter((i: any) => i.rsvp_response === "yes").length || 0
    const rsvpMaybe = invitations?.filter((i: any) => i.rsvp_response === "maybe").length || 0

    const prompt = `Predict attendance for open house event.

EVENT DETAILS:
- Property: ${event?.property?.address}
- Date: ${event?.event_date} ${event?.start_time}-${event?.end_time}
- Price: $${event?.property?.price}
- Property Type: ${event?.property?.property_type}

INVITATION METRICS:
- Total Invitations Sent: ${invitations?.length || 0}
- RSVPs: ${rsvpYes} Yes, ${rsvpMaybe} Maybe
- No Response: ${(invitations?.length ?? 0) - rsvpYes - rsvpMaybe || 0}

HISTORICAL DATA (Similar Properties):
${
  historical
    ?.map((h: any) => `- ${h.event_date}: ${h.actual_attendance || 0} attendees (predicted: ${h.predicted_attendance || 0})`)
    .join("\n") || "No historical data"
}

TASK: Predict attendance with confidence intervals.

Consider:
- RSVP conversion rate (typically 60-80% of Yes RSVPs attend)
- Walk-in rate (neighbors, unregistered buyers)
- Day of week effectiveness
- Seasonal trends

OUTPUT FORMAT (JSON):
{
  "predicted_attendance_low": 12,
  "predicted_attendance_mid": 18,
  "predicted_attendance_high": 24,
  "confidence_level": 0.78,
  "serious_buyers_expected": 5,
  "breakdown": {
    "from_rsvps": 14,
    "walk_ins_estimated": 4
  },
  "factors": {
    "positive": ["Strong RSVP rate"],
    "negative": []
  },
  "recommendation": "Good turnout expected."
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    const prediction = parseAIJsonResponse(text)

    // Store prediction
    await supabase
      .from("open_house_events")
      .update({
        attendance_prediction: prediction.predicted_attendance_mid,
      })
      .eq("id", eventId)

    return prediction
  } catch (error) {
    console.error("Predict attendance error:", error)
    return { error: "Failed to predict attendance" }
  }
}

// ============================================
// AUTOMATED FOLLOW-UPS
// ============================================

export async function processEventFollowups(eventId: string, client?: any) {
  if (!isValidUUID(eventId)) {
    return { success: false, error: "Invalid event ID" }
  }

  // client seam: the post-event CRON passes the service client (no session);
  // UI callers keep the session-scoped default.
  const supabase = client ?? await createClient()

  try {
    // Mark event as completed
    await supabase.from("open_house_events").update({ status: "completed" }).eq("id", eventId)

    // Get all attendees
    const { data: attendees } = await supabase.from("open_house_attendees").select("*").eq("event_id", eventId)

    if (!attendees || attendees.length === 0) {
      return { success: true, message: "No attendees to follow up with" }
    }

    // Calculate lead scores
    for (const attendee of attendees) {
      const leadScore = calculateAttendeeLeadScore(attendee)
      attendee.ai_lead_score = leadScore // keep the in-memory copy fresh for the handoff below
      await supabase.from("open_house_attendees").update({ ai_lead_score: leadScore }).eq("id", attendee.id)
    }

    // Segment and trigger follow-ups
    const hotLeads = attendees.filter((a: any) => a.ai_lead_score >= 70)
    const warmLeads = attendees.filter((a: any) => a.ai_lead_score >= 40 && a.ai_lead_score < 70)

    // CROSS-MANAGER BRIDGE — hand the hot, unrepresented buyers from this Listing Concierge event to
    // the AI ISA over the bus so they enter the buyer pipeline instead of dying as a dashboard count.
    // Manager-orchestrated; best-effort (never fails the follow-up).
    try {
      const { data: ev } = await supabase
        .from("open_house_events")
        .select("brokerage_id, listing_id, listings(address, city, state)")
        .eq("id", eventId)
        .maybeSingle()
      const brokerageId = (ev as any)?.brokerage_id ?? null
      if (brokerageId) {
        const l = (ev as any)?.listings
        const propertyAddress = l ? [l.address, l.city, l.state].filter(Boolean).join(", ") : null
        const { handoffOpenHouseLeads } = await import("@/lib/intelligence/open-house-lead-routing-runner")
        await handoffOpenHouseLeads({
          brokerageId, eventId, listingId: (ev as any)?.listing_id ?? null, propertyAddress,
          attendees: attendees.map((a: any) => ({
            id: a.id, ai_lead_score: a.ai_lead_score, interest_level: a.interest_level,
            name: a.name ?? a.attendee_name, email: a.email, phone: a.phone,
            contact_id: a.contact_id, has_agent: a.has_agent ?? a.working_with_agent ?? false,
          })),
        }, supabase as any)
      }
    } catch (err) {
      console.warn("[open-house] hot-lead handoff failed:", err)
    }

    // Generate analytics
    await generateEventAnalytics(eventId)

    revalidatePath("/dashboard/open-house")
    return {
      success: true,
      data: {
        total_attendees: attendees.length,
        hot_leads: hotLeads.length,
        warm_leads: warmLeads.length,
      },
    }
  } catch (error) {
    console.error("Process followups error:", error)
    return { success: false, error: "Failed to process follow-ups" }
  }
}

function calculateAttendeeLeadScore(attendee: any): number {
  let score = 0

  // Interest level (0-40 points)
  // attendee.interest_level is the canonical CHECK vocab (hot|warm|cold|no_interest).
  const interestScores: Record<string, number> = {
    hot: 40,
    warm: 25,
    cold: 10,
    no_interest: 0,
  }
  score += interestScores[attendee.interest_level] || 0

  // Time spent (0-20 points)
  if (attendee.time_spent_minutes > 30) score += 20
  else if (attendee.time_spent_minutes > 20) score += 15
  else if (attendee.time_spent_minutes > 10) score += 10
  else score += 5

  // Feedback rating (0-10 points)
  if (attendee.feedback_rating) {
    score += attendee.feedback_rating * 2
  }

  // Asked specific questions (0-10 points)
  if (attendee.specific_questions?.length > 0) score += 10

  return Math.min(score, 100)
}

async function generateEventAnalytics(eventId: string) {
  const supabase = await createClient()

  const { data: event } = await supabase.from("open_house_events").select("*").eq("id", eventId).maybeSingle()

  const { data: attendees } = await supabase.from("open_house_attendees").select("*").eq("event_id", eventId)

  const { data: invitations } = await supabase.from("open_house_invitations").select("*").eq("event_id", eventId)

  const analytics = {
    event_id: eventId,
    total_invites_sent: invitations?.length || 0,
    rsvp_yes_count: invitations?.filter((i: any) => i.rsvp_response === "yes").length || 0,
    rsvp_maybe_count: invitations?.filter((i: any) => i.rsvp_response === "maybe").length || 0,
    rsvp_no_count: invitations?.filter((i: any) => i.rsvp_response === "no").length || 0,
    total_attendance: attendees?.length || 0,
    attendance_vs_predicted: (attendees?.length || 0) - (event?.attendance_prediction || 0),
    serious_buyers_count:
      attendees?.filter(
        (a: any) => a.interest_level === "hot"
      ).length || 0,
    avg_lead_score:
      attendees && attendees.length > 0
        ? attendees.reduce((sum: number, a: any) => sum + (a.ai_lead_score || 0), 0) / attendees.length
        : 0,
    avg_time_spent_minutes:
      attendees && attendees.length > 0
        ? attendees.reduce((sum: number, a: any) => sum + (a.time_spent_minutes || 0), 0) / attendees.length
        : 0,
  }

  await supabase.from("open_house_analytics").insert(analytics)

  return analytics
}

// ============================================
// CRUD OPERATIONS
// ============================================

export async function createOpenHouseEvent(params: {
  agentId: string
  propertyId: string
  eventDate: string
  startTime: string
  endTime: string
  description?: string
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.propertyId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Tenant resolved through the RECORD (the listing this open house is on),
    // for the reason spelled out on scheduleOpenHouse above and worked through
    // at app/actions/open-house.ts:481-498. `params.agentId` stays as passed —
    // agents(id) and brokerages(id) are disjoint id spaces.
    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("brokerage_id")
      .eq("id", params.propertyId)
      .maybeSingle()

    if (listingErr) throw listingErr
    if (!listing?.brokerage_id) {
      return {
        success: false,
        error: "Listing not found, or it has no brokerage on record — the open house was not created.",
      }
    }

    const { data: event, error } = await supabase
      .from("open_house_events")
      .insert({
        agent_id: params.agentId,
        listing_id: params.propertyId,
        brokerage_id: listing.brokerage_id,
        event_date: params.eventDate,
        start_time: params.startTime,
        end_time: params.endTime,
        description: params.description,
        status: "scheduled",
      })
      .select()
      .maybeSingle()

    if (error) throw error
    if (!event) throw new Error("Failed to create open house event")

    revalidatePath(`/dashboard/listings/${params.propertyId}/open-house`)
    return { success: true, data: event }
  } catch (error) {
    console.error("Create event error:", error)
    return { success: false, error: "Failed to create event" }
  }
}

export async function getOpenHouseEvents(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("open_house_events")
    .select("*, property:listings(*), analytics:open_house_analytics(*)")
    .eq("agent_id", agentId)
    .order("event_date", { ascending: false })

  if (error) {
    console.error("Get events error:", error)
    return []
  }

  return data || []
}

// ============================================
// WEATHER INTEGRATION
// ============================================

/** WMO weather interpretation codes (Open-Meteo `weather_code`) → readable conditions. */
function describeWeatherCode(code: number): string {
  if (code === 0) return "clear sky"
  if (code === 1) return "mostly clear"
  if (code === 2) return "partly cloudy"
  if (code === 3) return "overcast"
  if (code === 45 || code === 48) return "fog"
  if (code >= 51 && code <= 57) return "drizzle"
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain"
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow"
  if (code >= 95) return "thunderstorm"
  return "unknown"
}

export async function fetchWeatherForEvent(eventId: string) {
  if (!isValidUUID(eventId)) {
    return { error: "Invalid event ID" }
  }

  const supabase = await createClient()

  try {
    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", eventId)
      .maybeSingle()

    if (!event?.property?.latitude || !event?.property?.longitude) {
      return { error: "Property location not found" }
    }

    // Real forecast from Open-Meteo (keyless public API) for the event date at
    // the property's coordinates. Honest failure when the date is outside the
    // provider's ~16-day forecast window or the fetch fails — never mock data.
    const eventDate = String(event.event_date ?? new Date().toISOString()).slice(0, 10)
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(event.property.latitude)}` +
      `&longitude=${encodeURIComponent(event.property.longitude)}` +
      `&daily=weather_code,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto` +
      `&start_date=${eventDate}&end_date=${eventDate}`

    const res = await fetch(url, { cache: "no-store" })
    if (!res.ok) {
      return { error: `Weather provider error (${res.status}) — forecast unavailable for ${eventDate}` }
    }
    const forecast = await res.json()
    const daily = forecast?.daily
    const temperature = Number(daily?.temperature_2m_max?.[0])
    if (!daily || !Number.isFinite(temperature)) {
      return { error: `No forecast available for ${eventDate} (may be outside the 16-day forecast window)` }
    }

    const precipChance = Number(daily.precipitation_probability_max?.[0] ?? 0)
    const conditions = describeWeatherCode(Number(daily.weather_code?.[0] ?? -1))
    const weather = {
      temperature: Math.round(temperature),
      conditions,
      precip_chance: Math.round(precipChance),
      wind_speed: Math.round(Number(daily.wind_speed_10m_max?.[0] ?? 0)),
      quality_score: calculateWeatherScore({ temperature, precip_chance: precipChance, conditions }),
      source: "open-meteo",
      fetched_at: new Date().toISOString(),
    }

    // Store weather forecast
    const { error: storeError } = await supabase
      .from("open_house_events")
      .update({
        weather_forecast: weather,
      })
      .eq("id", eventId)
    if (storeError) {
      // Non-fatal — the live forecast is still returned to the caller.
      console.error(`[open-house] Failed to store weather forecast for event ${eventId}:`, storeError)
    }

    // Alert the agent on poor weather
    if (weather.quality_score < 50) {
      console.log(`[v0] Weather warning for event ${eventId}: score ${weather.quality_score}`)
      if (event.agent_id) {
        // event.agent_id is an agents.id; the alert resolves it to the agent's
        // users row for a mailbox. Non-fatal, but no longer silent — the result
        // used to be discarded entirely, so a failed alert looked identical to
        // a delivered one from here.
        const alert = await sendWeatherAlertToAgent({
          eventId,
          agentId: event.agent_id,
          weatherData: weather,
        })
        if (!alert.success) {
          console.error(`[open-house] Weather alert not delivered for event ${eventId}: ${alert.error}`)
        }
      }
    }

    return weather
  } catch (error) {
    console.error("Fetch weather error:", error)
    return { error: "Failed to fetch weather" }
  }
}

function calculateWeatherScore(weather: any): number {
  let score = 100

  // Temperature penalties
  if (weather.temperature < 40 || weather.temperature > 85) score -= 20
  if (weather.temperature < 32 || weather.temperature > 95) score -= 40

  // Precipitation penalties
  score -= weather.precip_chance * 0.5

  // Conditions
  if (weather.conditions?.includes("rain")) score -= 30
  if (weather.conditions?.includes("snow")) score -= 40
  if (weather.conditions?.includes("storm")) score -= 50

  return Math.max(score, 0)
}

// ============================================
// PERFORMANCE INSIGHTS
// ============================================

export async function generatePerformanceInsights(eventId: string) {
  if (!isValidUUID(eventId)) {
    return {
      overall_grade: "B+",
      performance_summary: "Above average event with strong attendance and good lead quality.",
      strengths: ["High RSVP conversion", "Quality leads generated"],
      weaknesses: ["Could improve follow-up speed"],
      recommendations: ["Schedule next open house on Saturday afternoon", "Focus on hot leads within 24 hours"],
    }
  }

  const supabase = await createClient()

  try {
    const { data: analytics } = await supabase.from("open_house_analytics").select("*").eq("event_id", eventId).maybeSingle()

    const { data: event } = await supabase.from("open_house_events").select("*").eq("id", eventId).maybeSingle()

    if (!analytics || !event) {
      return { error: "Analytics data not found" }
    }

    const prompt = `Analyze open house performance and provide actionable insights.

EVENT METRICS:
Invitations:
- Sent: ${analytics.total_invites_sent}
- RSVP Yes: ${analytics.rsvp_yes_count}
- RSVP Rate: ${((analytics.rsvp_yes_count / analytics.total_invites_sent) * 100).toFixed(1)}%

Attendance:
- Predicted: ${event.attendance_prediction}
- Actual: ${analytics.total_attendance}
- Accuracy: ${((analytics.total_attendance / event.attendance_prediction) * 100).toFixed(1)}%

Lead Quality:
- Serious Buyers: ${analytics.serious_buyers_count}
- Average Lead Score: ${analytics.avg_lead_score?.toFixed(1)}/100
- Average Time Spent: ${analytics.avg_time_spent_minutes?.toFixed(1)} minutes

TASK: Provide performance analysis with letter grade (A+, A, A-, B+, B, etc.) and recommendations.

OUTPUT FORMAT (JSON):
{
  "overall_grade": "A-",
  "performance_summary": "Strong event with excellent turnout",
  "strengths": ["High attendance", "Quality leads"],
  "weaknesses": ["Lower than expected time spent"],
  "recommendations": ["Schedule follow-up calls within 24 hours", "Try evening open house next time"],
  "comparison_to_average": {
    "attendance": "+15%",
    "lead_quality": "+22%"
  },
  "next_steps": ["Contact hot leads today", "Send thank you emails to all attendees"]
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    const insights = parseAIJsonResponse(text)

    // Store insights
    await supabase
      .from("open_house_analytics")
      .update({
        performance_insights: insights,
      })
      .eq("event_id", eventId)

    return insights
  } catch (error) {
    console.error("Generate insights error:", error)
    return { error: "Failed to generate insights" }
  }
}

// ============================================
// FEEDBACK COLLECTION
// ============================================

export async function sendFeedbackRequestToAttendee(attendeeId: string) {
  if (!isValidUUID(attendeeId)) {
    return { success: false, error: "Invalid attendee ID" }
  }

  const supabase = await createClient()

  try {
    const { data: attendee } = await supabase.from("open_house_attendees").select("*").eq("id", attendeeId).maybeSingle()

    if (!attendee) {
      return { success: false, error: "Attendee not found" }
    }

    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", attendee.event_id)
      .maybeSingle()

    const feedbackUrl = `${process.env.NEXT_PUBLIC_APP_URL || ""}/open-house/feedback/${attendeeId}`

    // An attendee with no linked contact has nowhere to send to. Saying so beats
    // returning success for a request that was never addressed to anyone — the
    // analytics tab marks the attendee "sent" and stops offering the button.
    if (!attendee.contact_id) {
      return { success: false, error: "This attendee has no linked contact record to reach" }
    }

    // sendFeedbackRequest RETURNS { success:false, error } on a refusal and does
    // not throw. This used to return { success: true } unconditionally, so the
    // tab reported "Feedback request sent" for a function that sent nothing.
    const res = await sendFeedbackRequest({
      contactId: attendee.contact_id,
      eventId: attendee.event_id,
      feedbackUrl,
    })

    if (!res.success) {
      return { success: false, error: res.error ?? "The feedback request was not delivered" }
    }

    return { success: true, feedbackUrl }
  } catch (error) {
    console.error("Send feedback request error:", error)
    return { success: false, error: "Failed to send feedback request" }
  }
}

export async function submitFeedback(params: {
  attendeeId: string
  overallRating: number
  whatLikedMost?: string
  concerns?: string
  pricingFeedback?: string
  wouldMakeOffer?: string
  preferredFollowUp?: string
  additionalComments?: string
}) {
  if (!isValidUUID(params.attendeeId)) {
    return { success: false, error: "Invalid attendee ID" }
  }

  // CREDENTIAL MODEL: identical to handleRSVP above. The person filling this in
  // is an open-house visitor following the link `sendFeedbackRequestToAttendee`
  // emails them (`/open-house/feedback/<attendeeId>`); the unguessable attendee
  // id is the credential. On the RLS session client the
  // `open_house_attendees` policy
  // (`brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`)
  // refused every anonymous read, so this endpoint could only ever answer
  // "Could not look up that visit" to the very people it was built for.
  const supabase = createServiceClient()

  try {
    // Destructure `error` — a refusal must not read as "Attendee not found"
    // and must never fall through to a write. (wave 4 slice 2)
    const { data: attendee, error: attErr } = await supabase
      .from("open_house_attendees").select("*").eq("id", params.attendeeId).maybeSingle()

    if (attErr) {
      return { success: false, error: "Could not look up that visit — your feedback was not saved." }
    }
    if (!attendee) {
      return { success: false, error: "Attendee not found" }
    }

    // open_house_feedback carries a buyer's price opinion, their concerns and
    // their contact link. Its RLS policy is
    // `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()` and
    // brokerage_id is NULLABLE (both verified live), so a row written with a
    // null tenant is readable by every user of every tenant AND by anonymous
    // callers. `attendee.brokerage_id ?? null` did exactly that whenever the
    // attendee row had drifted untenanted. Resolve from the event as a fallback
    // and REFUSE rather than write the feedback world-open.
    let feedbackBrokerageId: string | null =
      (attendee as { brokerage_id?: string | null }).brokerage_id ?? null
    if (!feedbackBrokerageId && attendee.event_id) {
      const { data: ev } = await supabase
        .from("open_house_events").select("brokerage_id").eq("id", attendee.event_id).maybeSingle()
      feedbackBrokerageId = (ev as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
    }
    if (!feedbackBrokerageId) {
      return {
        success: false,
        error: "This visit is not linked to a brokerage — your feedback was not saved.",
      }
    }

    // Update attendee record — refuse a zero-row write rather than thanking the
    // visitor for feedback that was never stored.
    const { data: attUpdated, error: attUpdErr } = await supabase
      .from("open_house_attendees")
      .update({
        feedback_rating: params.overallRating,
        feedback_comments: params.additionalComments,
        feedback_collected_at: new Date().toISOString(),
      })
      .eq("id", params.attendeeId)
      .select("id")

    if (attUpdErr || !attUpdated || attUpdated.length === 0) {
      return { success: false, error: "Your feedback could not be saved. Please try again." }
    }

    // Store detailed feedback in the correct table with correct column names
    const { error: fbErr } = await supabase.from("open_house_feedback").insert({
      attendee_id: params.attendeeId,
      event_id: attendee.event_id,
      contact_id: attendee.contact_id ?? null,
      brokerage_id: feedbackBrokerageId,
      rating: params.overallRating,
      price_opinion: params.pricingFeedback ?? null,
      liked_most: params.whatLikedMost ?? null,
      concerns: params.concerns ?? null,
      interested_in_offer: params.wouldMakeOffer === "yes",
      has_own_agent: attendee.working_with_agent ?? false,
    })
    if (fbErr) {
      return {
        success: false,
        error: "Your rating was recorded but the detailed feedback could not be saved. Please try again.",
      }
    }

    // Update lead score based on feedback
    let scoreAdjustment = 0
    if (params.wouldMakeOffer === "yes") scoreAdjustment = 20
    if (params.overallRating >= 4) scoreAdjustment += 10

    if (scoreAdjustment > 0) {
      await supabase
        .from("open_house_attendees")
        .update({
          ai_lead_score: (attendee.ai_lead_score || 0) + scoreAdjustment,
        })
        .eq("id", params.attendeeId)
    }

    revalidatePath("/dashboard/open-house")
    return { success: true, message: "Thank you for your feedback!" }
  } catch (error) {
    console.error("Submit feedback error:", error)
    return { success: false, error: "Failed to submit feedback" }
  }
}

// ============================================
// COMPETITIVE INTELLIGENCE
// ============================================

export async function monitorCompetingEvents(eventId: string) {
  if (!isValidUUID(eventId)) {
    return { competing_count: 0, same_time_conflicts: 0 }
  }

  const supabase = await createClient()

  try {
    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", eventId)
      .maybeSingle()

    if (!event) {
      return { error: "Event not found" }
    }

    // Query for other open houses in the area on same date
    const { data: competingEvents } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      // tenant anchor (scope burn-down): competition scan stays inside the event's brokerage
      .eq("brokerage_id", event.brokerage_id)
      .eq("event_date", event.event_date)
      .neq("id", eventId)
      .limit(20)

    // Calculate which ones overlap in time and are nearby
    const sameTimeConflicts = (competingEvents || []).filter((ce: any) => {
      // Check time overlap
      const eventStart = parseTime(event.start_time)
      const eventEnd = parseTime(event.end_time)
      const ceStart = parseTime(ce.start_time)
      const ceEnd = parseTime(ce.end_time)

      return (eventStart < ceEnd && eventEnd > ceStart)
    })

    const competingData = {
      total_competing: competingEvents?.length || 0,
      same_time_conflicts: sameTimeConflicts.length,
      competing_events: (competingEvents || []).map((ce: any) => ({
        address: ce.property?.address,
        time: `${ce.start_time}-${ce.end_time}`,
        price: ce.property?.price,
        property_type: ce.property?.property_type,
      })),
    }

    // Store competing events data
    await supabase
      .from("open_house_events")
      .update({
        competing_events_data: competingData,
      })
      .eq("id", eventId)

    return competingData
  } catch (error) {
    console.error("Monitor competing events error:", error)
    return { error: "Failed to monitor competition" }
  }
}

function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(":").map(Number)
  return hours * 60 + minutes
}

// ============================================
// DIGITAL CHECK-IN
// ============================================

export async function checkInAttendee(params: {
  eventId: string
  contactEmail: string
  contactName: string
  contactPhone?: string
  interestLevel?: string
  specificQuestions?: string[]
  optInFollowUp?: boolean
}) {
  if (!isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid event ID" }
  }

  const supabase = await createClient()

  try {
    // Check if attendee already checked in
    const { data: existing } = await supabase
      .from("open_house_attendees")
      .select("id")
      .eq("event_id", params.eventId)
      .eq("email", params.contactEmail)
      .maybeSingle()

    if (existing) {
      return { success: false, error: "Already checked in" }
    }

    // TENANT: the EVENT'S brokerage — the record this attendee is filed against.
    // Nothing else in this function's scope carries one (it takes no caller
    // context at all), and `endOpenHouseEvent` pairs `event_id` with the caller's
    // brokerage when it reads attendees back, so the event is the only anchor
    // that can make this row readable by the surface that owns it.
    const { data: event, error: eventErr } = await supabase
      .from("open_house_events")
      .select("id, brokerage_id")
      .eq("id", params.eventId)
      .maybeSingle()
    if (eventErr) {
      return { success: false, error: `Could not verify the open house: ${eventErr.message}` }
    }
    if (!event) {
      return { success: false, error: "Open house event not found" }
    }

    // Create attendee record.
    //
    // THE INSERT IS DESTRUCTURED, AND IT MATTERS MORE HERE THAN THE STAMP:
    // `open_house_attendees.contact_id` is NOT NULL on the live schema and this
    // writer sends no contact at all, so every call has been refused 23502 —
    // while `const { data: attendee }` read the refusal as "no row returned" and
    // the function returned `{ success: true, data: null }`. Resolving an email
    // to a contact (or creating one, the way the public sign-in route does) is a
    // product decision, so it is NAMED here rather than guessed at: this action
    // currently has no callers in the tree, and the check-in surface uses
    // `app/actions/seller-open-house.ts:checkInAttendee` instead.
    const { data: attendee, error: attendeeErr } = await supabase
      .from("open_house_attendees")
      .insert({
        event_id: params.eventId,
        brokerage_id: event.brokerage_id,
        email: params.contactEmail,
        name: params.contactName,
        phone: params.contactPhone ?? null,
        interest_level: mapInterestLevelText(params.interestLevel),
        check_in_time: new Date().toISOString(),
        arrival_time: new Date().toISOString(),
        working_with_agent: false,
        tcpa_consent: params.optInFollowUp !== false,
        ai_lead_score: 0,
      })
      .select()
      .maybeSingle()

    if (attendeeErr) {
      return { success: false, error: attendeeErr.message }
    }

    revalidatePath("/dashboard/open-house")
    return { success: true, data: attendee }
  } catch (error) {
    console.error("Check-in attendee error:", error)
    return { success: false, error: "Failed to check in" }
  }
}
