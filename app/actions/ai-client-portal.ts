"use server"

import { createClient } from "@/lib/supabase/server"
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

// `getEducationResources({ contactId, personaType?, brokerageId? })` — DELETED
// (orphan burn-down, category C).
//
// SURVIVOR: `app/actions/portal-education.ts:176 getLessonFeed(contactId)`, which
// is what the portal's Learn tab actually calls
// (app/portal/[contactId]/learn/page.tsx:4). It is a strict superset of this:
// same published learning_modules catalog, same learning_assignments completion
// join, PLUS the education context (portal view, current milestone, age segment)
// and the kernel education plan that order the feed.
//
// It is also the only one of the two that GATES. `getLessonFeed` opens with
// `requireContactAccess(contactId)` and returns EMPTY_FEED when the caller is not
// that contact. This function did not: it was a `"use server"` endpoint that took
// a `contactId` AND an optional `brokerageId` straight off the wire and, when
// `brokerageId` was supplied, skipped the contact lookup entirely — so any
// authenticated caller could enumerate another brokerage's published curriculum
// by posting its id. The caller-supplied tenant id was the whole tenant boundary,
// which is exactly the shape this audit removes.

// Get recommended properties for a contact
export async function getRecommendedProperties(params: {
  contactId: string
  limit?: number
}) {
  const supabase = await createClient()
  
  try {
    // Budget lives on contacts; beds/cities criteria live in property_preferences. The old
    // code selected desired_neighborhoods/bedrooms_min/etc. off contacts (phantom columns) →
    // the query errored and the portal returned no matches.
    const { data: contact } = await supabase
      .from("contacts")
      .select("budget_min, budget_max, brokerage_id")
      .eq("id", params.contactId)
      .single()

    if (!contact) {
      return { success: true, properties: [] }
    }

    const { loadBuyerCriteria } = await import("@/lib/buyer-search/buyer-criteria")
    const criteria = await loadBuyerCriteria(supabase as unknown as Parameters<typeof loadBuyerCriteria>[0], params.contactId)

    // Build query based on preferences
    let query = supabase
      .from("listings")
      .select("*")
      // tenant anchor (scope burn-down): recommendations come from the contact's own brokerage
      .eq("brokerage_id", contact.brokerage_id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(params.limit || 10)

    const minPrice = contact.budget_min ?? criteria?.minPrice ?? null
    const maxPrice = contact.budget_max ?? criteria?.maxPrice ?? null
    if (minPrice) {
      query = query.gte("list_price", minPrice)
    }
    if (maxPrice) {
      query = query.lte("list_price", maxPrice)
    }
    if (criteria?.minBeds) {
      query = query.gte("bedrooms", criteria.minBeds)
    }

    const { data: listings, error } = await query

    if (error) throw error

    // DOM is computed from go_live_date — the column does not exist on
    // listings. Materialize it before returning so client UIs can read
    // `days_on_market` directly.
    const properties = (listings || []).map((l: any) => ({
      ...l,
      days_on_market: computeDaysOnMarket(l.go_live_date),
    }))
    return { success: true, properties }
  } catch (error) {
    console.error("[getRecommendedProperties] Error:", error)
    return { success: false, error: "Failed to fetch recommended properties", properties: [] }
  }
}

// Mark education resource as completed
// Post-1043: completion lives on learning_assignments(contact_id, module_id).
// `resourceId` is now a learning_modules.id (uuid).
export async function markResourceCompleted(params: {
  contactId: string
  resourceId: string
  brokerageId?: string
  completionData?: Record<string, unknown>
}) {
  const supabase = await createClient()

  try {
    let brokerageId = params.brokerageId
    if (!brokerageId) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("brokerage_id")
        .eq("id", params.contactId)
        .single()
      brokerageId = contact?.brokerage_id
    }

    const { error } = await supabase
      .from("learning_assignments")
      .upsert({
        brokerage_id:   brokerageId,
        module_id:      params.resourceId,
        contact_id:     params.contactId,
        signal_source:  "self:portal_complete",
        priority_score: 50,
        status:         "completed",
        completed_at:   new Date().toISOString(),
      }, { onConflict: "contact_id,module_id" })

    if (error) throw error

    return { success: true }
  } catch (error) {
    console.error("[markResourceCompleted] Error:", error)
    return { success: false, error: "Failed to mark resource as completed" }
  }
}

// `getJourneyMilestones({ contactId, transactionId? })` — DELETED (orphan
// burn-down, category C).
//
// SURVIVOR: `lib/kernel/portal.ts:723 getPortalJourneyMilestones(supabase, {
// contactId, transactionId? })`, called by the portal's Journey page
// (app/portal/[contactId]/journey/page.tsx:3). Same table, same ordering, same
// optional-transaction fallback — and one thing this never had.
//
// THE MISSING THING WAS THE CLIENT-VISIBILITY GATE. `transaction_milestones`
// carries `is_client_visible`, which is how an agent decides what the client is
// shown; the kernel reader selects that column and honours it (and layers the
// contact's own `contact_portal_preferences.milestone_overrides` on top). This
// function did `select("*, transactions(*)")` with no such filter, from a
// `"use server"` endpoint that trusted a caller-supplied `contactId`. Wiring it
// to any portal surface would have published every internal milestone — and,
// through the unbounded `transactions(*)` embed, the whole transaction row
// including price fields — to the client the agent had deliberately hidden them
// from. Nothing about it was salvageable onto the survivor.

// `getContactAgent({ contactId })` — DELETED (orphan burn-down, category C).
//
// SURVIVOR: the primary-agent read in `app/portal/[contactId]/team/page.tsx:61`,
// which is the "Your Agent" card this function was written to feed and which has
// been rendering the same `agents` row (with the same `users:user_id` embed, the
// same photo_url→profile_image_url fallback and the same
// phone_mobile→phone_office→users.phone fallback) all along.
//
// MERGED IN BEFORE DELETION: `specializations` and `years_experience`. They were
// the two fields this function selected that the survivor did not, so they were
// added to the team page's select and are now rendered as chips beside the
// agent's name. `specializations` is `character varying` on `agents`, not
// `text[]` — this function passed it through raw; the survivor splits it.
//
// Why the survivor and not this: it destructures `{ data, error }` and renders a
// failed read as a failed read (`agentError`), where this collapsed everything
// into `{ success: false, agent: null }` from a catch — a client whose agent
// lookup was REFUSED would have been told they have no agent. And it is reached
// through a page that has already resolved the portal session, rather than being
// a `"use server"` endpoint that took a bare `contactId` off the wire and
// returned that contact's agent's name, email, phone and bio to anyone who
// guessed a uuid.
