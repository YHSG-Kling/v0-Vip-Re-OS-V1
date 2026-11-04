"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

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
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }

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

/**
 * CLOSE a collaborative search — the terminal half this feature never had.
 *
 * `collaborative_searches.status` was READ BY CODE AND WRITTEN BY NOBODY
 * (census 1b): `getCollaborativeSearches` filters `.eq("status", "active")`
 * (line ~116) and the only writer of a search row —
 * `createCollaborativeSearch` above — never names the column, so every search
 * ever created took the DDL default `'active'` and STAYED active for the life of
 * the account. A family that bought a house six months ago still had their old
 * search sitting at the top of their portal, and the filter that exists to hide
 * finished searches could never hide one.
 *
 * The vocabulary is not invented here: the live CHECK admits exactly
 * `active | archived | completed` (scripts/check-vocabularies.ts:455), so the
 * database has been expecting this transition all along.
 *
 *   completed — they found the home. The happy terminal state.
 *   archived  — they stopped looking. Hidden, not deleted; the ratings and the
 *               consensus history stay on the row.
 *
 * GATED exactly like the create: `requireContactAccess` proves the caller is
 * that contact or staff in the contact's brokerage BEFORE anything is written,
 * and the tenant comes from the gate, never from an argument (§4). The service
 * client is used for the same reason the create documents — a portal contact's
 * own `current_user_brokerage_id()` need not be the contact's — and the UPDATE
 * is re-scoped by the gate's brokerage so the bypass can only touch the tenant
 * the gate proved.
 */
export async function closeCollaborativeSearch(
  searchId: string,
  status: "completed" | "archived",
): Promise<{ success?: true; error?: string }> {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }
  if (status !== "completed" && status !== "archived") {
    // Fail closed on a value outside the live CHECK rather than letting the
    // database refuse the whole statement (23514) and reporting success.
    return { error: "A search can only be completed or archived." }
  }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  // Resolve the search's OWNING contact from the row, then gate on THAT — the
  // searchId is caller-supplied, so the contact it belongs to is read from the
  // database and never taken from the caller.
  const { data: search, error: readError } = await svc
    .from("collaborative_searches")
    .select("id, contact_id, brokerage_id, status")
    .eq("id", searchId)
    .maybeSingle()
  if (readError) return { error: readError.message }
  if (!search?.contact_id) return { error: "Search not found." }

  const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(search.contact_id as string)
  if (!access.ok) return { error: access.error }
  if (search.brokerage_id && search.brokerage_id !== access.brokerageId) {
    return { error: "Forbidden" }
  }

  // `.select()` the UPDATE and COUNT it. An update matching nothing resolves
  // with error null and empty data, byte-identical to one that worked (§3) —
  // and here zero rows means the search was already closed by somebody else,
  // which the caller needs to know rather than be told "done".
  const { data: updated, error } = await svc
    .from("collaborative_searches")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", searchId)
    .eq("brokerage_id", access.brokerageId)
    .eq("status", "active")
    .select("id")
  if (error) {
    console.error("[v0] Error closing collaborative search:", error.message)
    return { error: error.message }
  }
  if ((updated ?? []).length === 0) {
    return { error: "That search is no longer active." }
  }

  revalidatePath(`/portal/${search.contact_id}`)
  return { success: true }
}

export async function updateSearchCriteria(searchId: string, criteria: Record<string, any>) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }
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

/**
 * Invite a family member to give their opinion on the homes already on this shared list.
 *
 * WAVE 149 (lane 149B, C28) — REWRITTEN onto the one share door. What stood here inserted a member through the RLS
 * client with NO gate on who was inviting (the member_write policy admitted anyone whose JWT email matched ANY member
 * row), stored the invite token in PLAINTEXT with no expiry, and emailed it without a suppression check. It now proves
 * the caller is the search's own buyer (requireContactAccess on the search's contact, contact-self only), and shares
 * the list's current homes through lib/portal/collaborative-share.ts shareCollection: hashed, expiring, revocable
 * credential, scope feedback_only, suppression first. `role` is accepted for the old signature and ignored — a
 * collaborator's only scope is feedback_only.
 */
export async function inviteFamilyMember(
  searchId: string,
  email: string,
  name: string,
  _role: "editor" | "viewer" = "viewer",
) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }
  const owner = await gateSearchOwner(searchId)
  if (!owner.ok) return { error: owner.error }
  const { data: homes, error } = await owner.svc.from("collaborative_search_properties")
    .select("property_mls_id").eq("collaborative_search_id", searchId).eq("status", "active")
  if (error) return { error: error.message }
  const refs = ((homes ?? []) as Array<{ property_mls_id: string }>).map((h) => h.property_mls_id)
  if (!refs.length) return { error: "Add a home to this list first — your family member is invited to give their opinion on the homes you share." }
  const r = await shareHomesWithFamilyAction({ contactId: owner.contactId, listingRefs: refs, collaborator: { name, email } })
  if (!r.ok) return { error: r.error }
  return { data: { id: r.memberId }, delivery: r.delivery, link: r.link, notes: r.notes }
}

/**
 * Close a family member's access. WAVE 149 (149B): what stood here DELETED the member through the RLS client with no
 * gate on the caller and no row count — and the delete cascaded their opinions away from the buyer. Now: the search's
 * own buyer (or their brokerage staff) only, and the member's link is REVOKED (their opinions stay with the buyer).
 * SURVIVOR: lib/portal/collaborative-share.ts revokeCollaborator.
 */
export async function removeMember(searchId: string, memberId: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }
  const owner = await gateSearchOwner(searchId, { staffMay: true })
  if (!owner.ok) return { error: owner.error }
  const { revokeCollaborator } = await import("@/lib/portal/collaborative-share")
  const r = await revokeCollaborator(owner.svc, { brokerageId: owner.brokerageId, contactId: owner.contactId, memberId })
  return r.ok ? { success: true } : { error: r.error }
}

// ==================== PROPERTY MANAGEMENT ====================

/**
 * Add one of the buyer's saved homes to their shared list. WAVE 149 (149B): the facts a collaborator sees were the
 * `propertyData` the CLIENT posted, into the RLS client, with no gate. Now the search's own buyer only, and the facts
 * are re-read from the buyer's saved row under the tenant (sharedFactsFromSaved — public listing facts, never the
 * buyer's notes or scores). `propertyData` / `addedByEmail` / `notes` stay in the signature and are not trusted.
 */
export async function addPropertyToSearch(
  searchId: string,
  propertyId: string,
  _propertyData: Record<string, any>,
  _addedByEmail: string,
  _notes?: string,
) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }
  const owner = await gateSearchOwner(searchId)
  if (!owner.ok) return { error: owner.error }
  const { sharedFactsFromSaved, savedRef } = await import("@/lib/portal/collaborative-share")
  const { data: saved, error: savedError } = await owner.svc.from("saved_properties")
    .select("listing_id, external_property_id, property_address, city, state, list_price, bedrooms, bathrooms, sqft, primary_photo_url, property_type, dismissed")
    .eq("contact_id", owner.contactId).eq("brokerage_id", owner.brokerageId)
  if (savedError) return { error: savedError.message }
  const row = ((saved ?? []) as Array<Record<string, any>>).find((r) => savedRef(r) === propertyId && !r.dismissed)
  if (!row) return { error: "Only homes you've saved can be shared — save it first." }
  const { data: existing, error: existingError } = await owner.svc.from("collaborative_search_properties")
    .select("id").eq("collaborative_search_id", searchId).eq("property_mls_id", propertyId).maybeSingle()
  if (existingError) return { error: existingError.message }
  if (existing) return { error: "Property already added to this search" }
  const { data, error } = await owner.svc.from("collaborative_search_properties")
    .insert({ collaborative_search_id: searchId, property_mls_id: propertyId, property_data: sharedFactsFromSaved(row), added_by_contact_id: owner.contactId, status: "active" })
    .select().single()
  if (error) {
    console.error("[collaborative-search] Error adding property to search:", error.message)
    return { error: error.message }
  }
  return { data }
}

export async function removePropertyFromSearch(searchId: string, propertyId: string) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }
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

/**
 * The BUYER's own vote on a shared home. WAVE 149 (149B): `memberEmail` came from the request body into the RLS
 * client, so a vote could be cast as anyone. Now the search's own buyer only, recorded under the buyer's contact email
 * read from the database, keyed on the shared home's row id (property_family_ratings.property_id is a uuid). The
 * dashboard passes the listing ref (property_mls_id); it is resolved to the shared row here. A collaborator votes
 * through submitFamilyOpinionAction (their token proves who they are). Consensus is recomputed here — the trigger the
 * old comment promised does not exist (pg_trigger, 2026-11-03).
 */
export async function rateProperty(
  searchId: string,
  propertyId: string,
  _memberEmail: string,
  rating: number,
  vote: "love" | "like" | "neutral" | "dislike" | "pass",
  pros?: string[],
  cons?: string[],
  comments?: string,
) {
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }
  const owner = await gateSearchOwner(searchId)
  if (!owner.ok) return { error: owner.error }
  const { FAMILY_VOTES, consensusOf } = await import("@/lib/portal/collaborative-share")
  if (!(FAMILY_VOTES as readonly string[]).includes(vote)) return { error: "That vote isn't one I know." }
  const { data: homes, error: homeError } = await owner.svc.from("collaborative_search_properties")
    .select("id, property_mls_id").eq("collaborative_search_id", searchId)
  if (homeError) return { error: homeError.message }
  const home = ((homes ?? []) as Array<{ id: string; property_mls_id: string }>).find((h) => h.id === propertyId || h.property_mls_id === propertyId)
  if (!home) return { error: "That home isn't on this shared list." }
  const { data: me, error: meError } = await owner.svc.from("contacts").select("email").eq("id", owner.contactId).eq("brokerage_id", owner.brokerageId).maybeSingle()
  if (meError || !me?.email) return { error: "Your vote couldn't be recorded — your contact email is missing." }
  const now = new Date().toISOString()
  const { data, error } = await owner.svc.from("property_family_ratings").upsert({
    collaborative_search_id: searchId, property_id: home.id, member_email: String(me.email).toLowerCase(), brokerage_id: owner.brokerageId,
    rating: Number.isFinite(rating) && rating >= 1 && rating <= 5 ? Math.round(rating) : null, vote, pros: pros || [], cons: cons || [], notes: comments ?? null, updated_at: now,
  }, { onConflict: "collaborative_search_id,property_id,member_email" }).select().single()
  if (error) {
    console.error("[collaborative-search] Error rating property:", error.message)
    return { error: error.message }
  }
  const { data: all } = await owner.svc.from("property_family_ratings").select("rating").eq("collaborative_search_id", searchId).eq("property_id", home.id)
  const { error: consError } = await owner.svc.from("property_consensus").upsert({ collaborative_search_id: searchId, property_id: home.id, ...consensusOf((all ?? []) as Array<{ rating: number | null }>), updated_at: now }, { onConflict: "collaborative_search_id,property_id" })
  if (consError) console.error("[collaborative-search] consensus not refreshed:", consError.message)
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
  if (!COLLAB_SEARCH_AVAILABLE) return { error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }
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

// ==================== C28 — SHARE HOMES WITH FAMILY (wave 149, lane 149B) ====================
//
// Owner ruling 6: "the buyer shares the homes they were searching and brings in a family member to give their opinion
// on the selected properties." The rules live in lib/portal/collaborative-share.ts; these are the doors. Every export
// is a public endpoint (CLAUDE.md §4): the BUYER doors gate on requireContactAccess (tenant from the gate, never the
// body); the COLLABORATOR doors take only the share token, which the module hash-matches, expiry- and revocation-checks.

type ServiceClient = ReturnType<typeof import("@/lib/supabase/service").createServiceClient>

/** The search's OWNING buyer (read from the row — searchId is caller-supplied), then the shared gate. */
async function gateSearchOwner(searchId: string, opts: { staffMay?: boolean } = {}):
  Promise<{ ok: true; svc: ServiceClient; brokerageId: string; contactId: string; userId: string } | { ok: false; error: string }> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: search, error } = await svc.from("collaborative_searches").select("id, contact_id, brokerage_id").eq("id", searchId).maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!search?.contact_id) return { ok: false, error: "Search not found." }
  const { requireContactAccess, accessRefusal } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(search.contact_id as string)
  if (!access.ok) return { ok: false, error: accessRefusal(access.error) }
  if (search.brokerage_id !== access.brokerageId) return { ok: false, error: "Forbidden" }
  if (!access.isContactSelf && !opts.staffMay) return { ok: false, error: "Only the buyer can share their homes or vote on them." }
  return { ok: true, svc, brokerageId: access.brokerageId, contactId: search.contact_id as string, userId: access.userId }
}

async function gateBuyerSelf(contactId: string, opts: { staffMay?: boolean } = {}):
  Promise<{ ok: true; svc: ServiceClient; brokerageId: string; userId: string } | { ok: false; error: string }> {
  const { requireContactAccess, accessRefusal } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { ok: false, error: accessRefusal(access.error) }
  if (!access.isContactSelf && !opts.staffMay) return { ok: false, error: "Only the buyer can decide this." }
  const { createServiceClient } = await import("@/lib/supabase/service")
  return { ok: true, svc: createServiceClient(), brokerageId: access.brokerageId, userId: access.userId }
}

function shareLink(token: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
  return `${base}/search/join?token=${encodeURIComponent(token)}`
}

export type ShareHomesOutcome =
  | { ok: true; searchId: string; memberId: string; sharedCount: number; delivery: "email" | "link"; link: string; notes: string[] }
  | { ok: false; error: string }

/** C28 shareCollection — the buyer picks saved homes and one family member (email or mobile); scope feedback_only. */
export async function shareHomesWithFamilyAction(input: {
  contactId: string
  listingRefs: string[]
  collaborator: { name: string; email?: string | null; phone?: string | null }
}): Promise<ShareHomesOutcome> {
  if (!COLLAB_SEARCH_AVAILABLE) return { ok: false, error: "Collaborative search is not configured on this platform right now — platform staff can switch it back on." }
  const g = await gateBuyerSelf(input.contactId)
  if (!g.ok) return g
  const { shareCollection, COLLABORATOR_SCOPE } = await import("@/lib/portal/collaborative-share")
  const { checkSuppression } = await import("@/lib/kernel/compliance/check-suppression")
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const { data: me } = await g.svc.from("contacts").select("first_name, last_name").eq("id", input.contactId).eq("brokerage_id", g.brokerageId).maybeSingle()
  const inviterName = [me?.first_name, me?.last_name].filter(Boolean).join(" ").trim() || "Someone close to you"
  const at = new Date().toISOString()
  const r = await withActionLedger(
    {
      brokerageId: g.brokerageId,
      action: "portal.family_search.share",
      actor: { type: "user", userId: g.userId },
      subject: { type: "contact", id: input.contactId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `buyer shared ${(input.listingRefs ?? []).length} saved home(s) with a family member for their opinion`,
      idempotencyKey: `portal.family_search.share:${input.contactId}:${(input.collaborator?.email ?? input.collaborator?.phone ?? "").toLowerCase()}:${at.slice(0, 16)}`,
      channel: "portal",
      riskClass: "LOW_RISK_WRITE",
      systemSource: "buyer_portal_family_search",
      detail: { homes: (input.listingRefs ?? []).length, channel: input.collaborator?.email ? "email" : "link", scope: COLLABORATOR_SCOPE },
    },
    () => shareCollection(g.svc, {
      brokerageId: g.brokerageId, buyerContactId: input.contactId, actorUserId: g.userId,
      listingRefs: input.listingRefs ?? [], collaborator: input.collaborator ?? { name: "" }, scope: COLLABORATOR_SCOPE,
    }, {
      checkSuppression: (p) => checkSuppression({ brokerageId: p.brokerageId, email: p.email ?? null, phone: p.phone ?? null, channel: p.channel }, { client: g.svc }),
      sendEmailInvite: async (p) => {
        try {
          const { sendCollaborativeSearchInvite } = await import("@/lib/services/communication.service")
          // 149Z (lane 149B Outside-lane 4): the invite carries the TENANT's brand through the one resolver (session tenant).
          const { resolveConsentBrand } = await import("@/lib/contact-pipeline/contact-capture")
          const tenantBrand = await resolveConsentBrand(g.svc as never, { brokerageId: g.brokerageId }).catch(() => null)
          const sent: any = await sendCollaborativeSearchInvite({ email: p.email, inviterName, inviteToken: p.token, searchId: p.searchId, tenantBrand })
          return sent && sent.success === false ? { ok: false, error: sent.error ?? "the sender refused" } : { ok: true }
        } catch (e) {
          return { ok: false, error: (e as Error)?.message ?? "the sender failed" }
        }
      },
    }),
    {
      settle: (x) => x.ok ? { status: "executed", outcome: `shared_${x.delivery}` } : { status: "failed", outcome: "share_refused", error: x.error },
      replay: (claim) => ({ ok: false as const, error: claim.kind === "refused" ? claim.error : "That share is already on its way." }),
    },
  )
  if (!r.ok) return r
  revalidatePath(`/portal/${input.contactId}/search`)
  return { ok: true, searchId: r.searchId, memberId: r.memberId, sharedCount: r.sharedHomeIds.length, delivery: r.delivery, link: shareLink(r.token), notes: r.notes }
}

/**
 * The collaborator opens the shared homes (token only) — the invitation's acceptance IS the first open. Returns ONLY
 * the shared homes and their own opinions.
 *
 * WAVE 149 (149B, C28) — same export, completed: what stood here matched the PLAINTEXT
 * `collaborative_search_members.invite_token` through the RLS client, flipped the row to accepted and returned the
 * member + the WHOLE search row (the buyer's criteria included), and its caller (app/search/join/page.tsx) then sent
 * the family member to the homepage with nothing to see. Tokens are SHA-256 hashes now (m937), checked for scope,
 * expiry and revocation (lib/portal/collaborative-share.ts collaboratorView).
 */
export async function acceptInvitation(token: string) {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { collaboratorView } = await import("@/lib/portal/collaborative-share")
  return collaboratorView(createServiceClient(), String(token ?? ""))
}

/** The collaborator's opinion on one shared home (token only — the member is the one the token proves). */
export async function submitFamilyOpinionAction(input: { token: string; sharedHomeId: string; vote: "love" | "like" | "neutral" | "dislike" | "pass"; comment?: string | null }) {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { recordCollaboratorOpinion } = await import("@/lib/portal/collaborative-share")
  const svc = createServiceClient()
  return recordCollaboratorOpinion(svc, String(input?.token ?? ""), { sharedHomeId: String(input?.sharedHomeId ?? ""), vote: input?.vote, comment: input?.comment ?? null }, {
    tellShoppingAgent: async (p) => {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const r = await publishManagerSignal({
        brokerageId: p.brokerageId, fromManager: "ai_isa", toManager: "shopping_agent", signalType: "family_feedback_received",
        message: p.message, entityType: "contact", entityId: p.contactId, contactId: p.contactId, payload: p.payload,
      }, svc)
      if (!r.ok) console.error("[collaborative-search] shopping agent signal refused:", r.reason)
      return r.ok
    },
  })
}

/** The buyer's (or their agent's) view of everything family said, by name, per home. */
export async function loadFamilyFeedbackAction(contactId: string) {
  const g = await gateBuyerSelf(contactId, { staffMay: true })
  if (!g.ok) return g
  const { buyerFeedbackDigest } = await import("@/lib/portal/collaborative-share")
  return buyerFeedbackDigest(g.svc, { brokerageId: g.brokerageId, contactId })
}

/** The buyer's say: may family opinions shape the Shopping Agent's suggestions? The buyer only; ledgered. */
export async function setFamilyFeedbackUseAction(input: { contactId: string; allow: boolean }) {
  const g = await gateBuyerSelf(input.contactId)
  if (!g.ok) return g
  const { setFamilyFeedbackForShoppingAgent } = await import("@/lib/portal/collaborative-share")
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const at = new Date().toISOString()
  const allow = input.allow === true
  return withActionLedger(
    {
      brokerageId: g.brokerageId, action: "portal.family_search.feedback_consent", actor: { type: "user", userId: g.userId },
      subject: { type: "contact", id: input.contactId }, reasonCode: "HUMAN_REQUESTED",
      reasonDetail: allow ? "buyer allowed family opinions to shape the Shopping Agent" : "buyer kept family opinions to themselves",
      idempotencyKey: `portal.family_search.feedback_consent:${input.contactId}:${allow}:${at.slice(0, 16)}`,
      channel: "portal", riskClass: "LOW_RISK_WRITE", systemSource: "buyer_portal_family_search", detail: { allow },
    },
    () => setFamilyFeedbackForShoppingAgent(g.svc, { brokerageId: g.brokerageId, contactId: input.contactId, allow, actorUserId: g.userId }),
    {
      settle: (x) => x.ok ? { status: "executed", outcome: allow ? "allowed" : "withheld" } : { status: "failed", outcome: "consent_refused", error: x.error },
      replay: (claim) => (claim.kind === "replay" ? { ok: true as const } : { ok: false as const, error: claim.kind === "refused" ? claim.error : "Already saving." }),
    },
  )
}
