"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { v4 as uuidv4 } from "uuid"

const COLLAB_SEARCH_AVAILABLE = process.env.COLLABORATIVE_SEARCH_ENABLED !== 'false'

// ==================== COLLABORATIVE SEARCH CRUD ====================

/**
 * Create a family/collaborative search for a contact.
 *
 * GATED AND TENANT-STAMPED, both of which were missing.
 *
 * All four live `collaborative_searches` policies (select / insert-check /
 * update-both-clauses / delete), granted to `authenticated`, read
 * `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`. A NULL
 * brokerage_id SATISFIES that predicate for EVERY tenant, so an unstamped search —
 * which carries the buyer's name and their search criteria — was published to, and
 * editable and deletable by, every signed-in user of every other brokerage.
 *
 * The tenant is NOT looked up from `contactId` and stamped: that argument is
 * caller-supplied into a `"use server"` export, and taking the tenant from it would
 * let the caller choose which brokerage to write into. It goes through
 * `requireContactAccess`, the same shared portal gate `trackPortalActivity` below
 * uses — which PROVES the caller is either that contact or staff in the contact's
 * brokerage before yielding the brokerage id. A foreign contactId is refused, not
 * stamped.
 *
 * Service client for the writes, for the reason documented on `trackPortalActivity`
 * below: the gate has already proven the caller, and a portal contact (whose own
 * `current_user_brokerage_id()` need not be the contact's) may satisfy neither the
 * stamped INSERT check nor a read of their own `contacts` row under RLS. Both
 * statements are re-scoped by `access.brokerageId` so the bypass can only touch the
 * tenant the gate proved.
 *
 * Stamping does NOT lock the buyer out of their own search: the second SELECT policy
 * `portal_read_collaborative_searches` admits rows via `portal_member_searches()`,
 * a SECURITY DEFINER function that matches on the caller's JWT email against the
 * search's contact / created_by contact or an invited member row. It carries no
 * brokerage test at all, so the portal reader is untouched by this change.
 */
export async function createCollaborativeSearch(
  contactId: string,
  name: string,
  description?: string,
  searchCriteria?: Record<string, any>,
) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }

  const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(contactId)
  if (!access.ok) {
    console.error("[v0] Error creating collaborative search: caller is not on this contact:", access.error)
    return { error: access.error }
  }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  const { data, error } = await svc
    .from("collaborative_searches")
    .insert({
      brokerage_id: access.brokerageId,
      contact_id: contactId,
      name,
      description,
      search_criteria: searchCriteria || {},
    })
    .select()
    .single()

  if (error) {
    console.error("[v0] Error creating collaborative search:", error)
    return { error: error.message }
  }

  // Add the contact as the owner member. `error` is destructured because supabase-js
  // RESOLVES a refused read — `const { data: contact }` alone reported a denial as
  // "this contact has no email" and silently produced an owner-less search.
  const { data: contact, error: contactError } = await svc
    .from("contacts")
    .select("email, first_name, last_name")
    .eq("id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()

  if (contactError) {
    console.error("[v0] Owner lookup refused — search created without an owner member:", contactError.message)
  }

  if (contact?.email) {
    const { error: memberError } = await svc.from("collaborative_search_members").insert({
      collaborative_search_id: data.id,
      email: contact.email,
      name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim() || "Owner",
      role: "owner",
      invite_status: "accepted",
      accepted_at: new Date().toISOString(),
    })
    if (memberError) {
      console.error("[v0] Owner member NOT recorded for collaborative search:", memberError.message)
    }
  }

  revalidatePath(`/portal/${contactId}`)
  return { data }
}

export async function getCollaborativeSearches(contactId: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return []
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("collaborative_searches")
    .select(`
      *,
      collaborative_search_members(*),
      collaborative_search_properties(*)
    `)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching collaborative searches:", error)
    return []
  }

  return data || []
}

export async function getCollaborativeSearchById(searchId: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return null
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("collaborative_searches")
    .select(`
      *,
      collaborative_search_members(*),
      collaborative_search_properties(*),
      property_consensus(*)
    `)
    .eq("id", searchId)
    .single()

  if (error) {
    console.error("[v0] Error fetching collaborative search:", error)
    return null
  }

  return data
}

export async function updateSearchCriteria(searchId: string, criteria: Record<string, any>) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }
  const supabase = await createClient()

  const { error } = await supabase
    .from("collaborative_searches")
    .update({
      search_criteria: criteria,
      updated_at: new Date().toISOString(),
    })
    .eq("id", searchId)

  if (error) {
    console.error("[v0] Error updating search criteria:", error)
    return { error: error.message }
  }

  return { success: true }
}

// ==================== MEMBER INVITATIONS ====================

export async function inviteFamilyMember(
  searchId: string,
  email: string,
  name: string,
  role: "editor" | "viewer" = "viewer",
) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }
  const supabase = await createClient()

  // Check if already invited
  const { data: existing } = await supabase
    .from("collaborative_search_members")
    .select("id")
    .eq("collaborative_search_id", searchId)
    .eq("email", email)
    .single()

  if (existing) {
    return { error: "This person has already been invited" }
  }

  const inviteToken = uuidv4()

  const { data, error } = await supabase
    .from("collaborative_search_members")
    .insert({
      collaborative_search_id: searchId,
      email,
      name,
      role,
      invite_token: inviteToken,
      invite_status: "pending",
    })
    .select()
    .single()

  if (error) {
    console.error("[v0] Error inviting member:", error)
    return { error: error.message }
  }

  // Send email invitation with link containing invite_token
  const { sendCollaborativeSearchInvite } = await import("@/lib/services/communication.service")
  
  // Get inviter name
  const { data: search } = await supabase
    .from("collaborative_searches")
    .select("created_by_contact_id, contacts(first_name, last_name)")
    .eq("id", searchId)
    .single()
  
  const contactObj = (search?.contacts as any)
  const inviterName = contactObj?.first_name
    ? `${contactObj.first_name} ${contactObj.last_name}`
    : "A colleague"

  await sendCollaborativeSearchInvite({
    email,
    inviterName,
    inviteToken,
    searchId,
  })

  return { data, inviteToken }
}

export async function acceptInvitation(token: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("collaborative_search_members")
    .update({
      invite_status: "accepted",
      accepted_at: new Date().toISOString(),
    })
    .eq("invite_token", token)
    .eq("invite_status", "pending")
    .select(`
      *,
      collaborative_searches(*)
    `)
    .single()

  if (error) {
    console.error("[v0] Error accepting invitation:", error)
    return { error: "Invalid or expired invitation" }
  }

  return { data }
}

export async function removeMember(searchId: string, memberId: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }
  const supabase = await createClient()

  const { error } = await supabase
    .from("collaborative_search_members")
    .delete()
    .eq("id", memberId)
    .eq("collaborative_search_id", searchId)
    .neq("role", "owner") // Can't remove owner

  if (error) {
    console.error("[v0] Error removing member:", error)
    return { error: error.message }
  }

  return { success: true }
}

// ==================== PROPERTY MANAGEMENT ====================

export async function addPropertyToSearch(
  searchId: string,
  propertyId: string,
  propertyData: Record<string, any>,
  addedByEmail: string,
  notes?: string,
) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }
  const supabase = await createClient()

  // Check if already added
  const { data: existing } = await supabase
    .from("collaborative_search_properties")
    .select("id")
    .eq("collaborative_search_id", searchId)
    .eq("property_mls_id", propertyId)
    .single()

  if (existing) {
    return { error: "Property already added to this search" }
  }

  const { data, error } = await supabase
    .from("collaborative_search_properties")
    .insert({
      collaborative_search_id: searchId,
      property_mls_id: propertyId, // real column (was phantom property_id)
      property_data: propertyData,
      added_by_email: addedByEmail,
      notes,
    })
    .select()
    .single()

  if (error) {
    console.error("[v0] Error adding property to search:", error)
    return { error: error.message }
  }

  return { data }
}

export async function removePropertyFromSearch(searchId: string, propertyId: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }
  const supabase = await createClient()

  const { error } = await supabase
    .from("collaborative_search_properties")
    .update({ status: "removed" })
    .eq("collaborative_search_id", searchId)
    .eq("property_mls_id", propertyId)

  if (error) {
    console.error("[v0] Error removing property:", error)
    return { error: error.message }
  }

  return { success: true }
}

export async function getSearchProperties(searchId: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return []
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("collaborative_search_properties")
    .select(`
      *,
      property_consensus(*),
      property_family_ratings(*)
    `)
    .eq("collaborative_search_id", searchId)
    .eq("status", "active")
    .order("added_at", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching search properties:", error)
    return []
  }

  return data || []
}

// ==================== RATINGS & VOTING ====================

export async function rateProperty(
  searchId: string,
  propertyId: string,
  memberEmail: string,
  rating: number,
  vote: "love" | "like" | "neutral" | "dislike" | "pass",
  pros?: string[],
  cons?: string[],
  comments?: string,
) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("property_family_ratings")
    .upsert(
      {
        collaborative_search_id: searchId,
        property_id: propertyId,
        member_email: memberEmail,
        rating,
        vote,
        pros: pros || [],
        cons: cons || [],
        comments,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "collaborative_search_id,property_id,member_email",
      },
    )
    .select()
    .single()

  if (error) {
    console.error("[v0] Error rating property:", error)
    return { error: error.message }
  }

  // Consensus is updated automatically by trigger
  return { data }
}

export async function getPropertyRatings(searchId: string, propertyId: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return []
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("property_family_ratings")
    .select(`
      *,
      collaborative_search_members!inner(name, role)
    `)
    .eq("collaborative_search_id", searchId)
    .eq("property_id", propertyId)

  if (error) {
    console.error("[v0] Error fetching ratings:", error)
    return []
  }

  return data || []
}

export async function getConsensus(searchId: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return []
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("property_consensus")
    .select(`
      *,
      collaborative_search_properties(property_data)
    `)
    .eq("collaborative_search_id", searchId)
    .order("avg_rating", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching consensus:", error)
    return []
  }

  return data || []
}

export async function markAsFinalist(searchId: string, propertyId: string, isFinalist: boolean) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }
  const supabase = await createClient()

  const { error } = await supabase
    .from("property_consensus")
    .update({ is_finalist: isFinalist })
    .eq("collaborative_search_id", searchId)
    .eq("property_id", propertyId)

  if (error) {
    console.error("[v0] Error updating finalist status:", error)
    return { error: error.message }
  }

  return { success: true }
}

// ==================== ACTIVITY TRACKING ====================

/**
 * The collaborative-search engagement ledger. TENANT-STAMPED, which is the repair: the row's
 * SELECT policy admits the agent side only through has_brokerage_access(brokerage_id) or
 * agent_id = current_user_agent_id(), so a row written with both columns null — as this one was —
 * is readable by the client who generated it and by platform admins, and by nobody who can act on
 * it. The column is nullable, so the write succeeded and the signal simply never arrived.
 *
 * The tenant cannot come from the session (the caller is a portal contact, whose users row has no
 * brokerage), so it comes from the CONTACT, through the shared portal gate — which also closes the
 * hole that this took a bare contactId from a client component and would happily plant activity on
 * any contact in the database. Same gate as the buyer-offer tools; not a second auth pattern.
 */
export async function trackPortalActivity(
  contactId: string,
  activityType: string,
  activityData?: Record<string, any>,
  propertyId?: string,
): Promise<{ recorded: boolean; reason?: string }> {
  if (!COLLAB_SEARCH_AVAILABLE) return { recorded: false, reason: "disabled" }

  const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(contactId)
  if (!access.ok) {
    console.error("[collaborative-search] activity NOT recorded — caller is not on this contact:", access.error)
    return { recorded: false, reason: access.error }
  }

  // Service client from here: the gate has proven the caller, and a portal contact cannot read
  // their own contacts row (to find the owning agent) or satisfy the staff INSERT lane under RLS.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  // contacts.agent_id is AGENTS-class, the same class this column FKs — a straight copy. The
  // caller's users.id is a DISJOINT space and is never substituted for it.
  const { data: owner, error: ownerError } = await svc
    .from("contacts")
    .select("agent_id")
    .eq("id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()
  if (ownerError) {
    console.error("[collaborative-search] owning-agent read refused — activity row loses its agent stamp:", ownerError.message)
  }

  const activityRow = {
    brokerage_id: access.brokerageId,
    contact_id: contactId,
    agent_id: (owner as { agent_id: string | null } | null)?.agent_id ?? null,
    activity_type: activityType,
    metadata: activityData || {},
    property_id: propertyId ?? null,
  }
  const { error } = await svc.from("client_portal_activity").insert(activityRow)

  if (error) {
    console.error(`[collaborative-search] activity '${activityType}' NOT recorded:`, error.message)
    return { recorded: false, reason: error.message }
  }
  return { recorded: true }
}
