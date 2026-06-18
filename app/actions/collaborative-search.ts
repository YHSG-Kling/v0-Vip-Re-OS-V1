"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { v4 as uuidv4 } from "uuid"

const COLLAB_SEARCH_AVAILABLE = process.env.COLLABORATIVE_SEARCH_ENABLED !== 'false'

// ==================== COLLABORATIVE SEARCH CRUD ====================

export async function createCollaborativeSearch(
  contactId: string,
  name: string,
  description?: string,
  searchCriteria?: Record<string, any>,
) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not yet available." }
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("collaborative_searches")
    .insert({
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

  // Add the contact as the owner member
  const { data: contact } = await supabase
    .from("contacts")
    .select("email, first_name, last_name")
    .eq("id", contactId)
    .single()

  if (contact?.email) {
    await supabase.from("collaborative_search_members").insert({
      collaborative_search_id: data.id,
      email: contact.email,
      name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim() || "Owner",
      role: "owner",
      invite_status: "accepted",
      accepted_at: new Date().toISOString(),
    })
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

export async function trackPortalActivity(
  contactId: string,
  activityType: string,
  activityData?: Record<string, any>,
  propertyId?: string,
) {
  if (!COLLAB_SEARCH_AVAILABLE) return
  const supabase = await createClient()

  const { error } = await supabase.from("client_portal_activity").insert({
    contact_id: contactId,
    activity_type: activityType,
    metadata: activityData || {},
    property_id: propertyId,
  })

  if (error) {
    console.error("[v0] Error tracking activity:", error)
  }
}
