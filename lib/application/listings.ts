/**
 * lib/application/listings.ts
 * Listing CRUD — canonical lib-layer home.
 * app/actions/listings.ts re-exports from here and adds "use server" + revalidatePath.
 */

import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"

export async function getListingsService(params: {
  agentId?: string
  /**
   * Tenant anchor — REQUIRED, and applied unconditionally below.
   *
   * It used to be optional and applied only `if (params?.brokerageId)`, which
   * made "no tenant" a silent, legal call shape: `getListingsService()` read
   * every listing on the platform. The only reason that was not a live leak is
   * that this layer runs on the RLS-backed cookie client and every SELECT policy
   * on `listings` is brokerage-scoped — and CLAUDE.md §4 is explicit that RLS is
   * the verified BACKSTOP, not the primary boundary. A conditional predicate also
   * satisfies tenant-scope-guard textually while being able not to run, so the
   * guard could not tell this apart from a real filter.
   *
   * The caller resolves it from the SESSION (app/actions/listings.ts:getListings,
   * via getAgentContext) and never from a parameter the browser supplied. The
   * ungated re-export that let a browser name its own tenant here is gone —
   * tombstone at app/actions/listing-lifecycle.ts:23.
   */
  brokerageId: string
  status?: string
  stage?: string
  limit?: number
}) {
  try {
    // Fail closed: a missing tenant anchor REFUSES rather than widening to every
    // brokerage. "Nobody supplied a tenant" must never render as "all tenants".
    if (!params?.brokerageId) {
      return { success: false as const, error: "Listings require a brokerage", listings: [] as unknown[] }
    }

    const supabase = await createClient()

    let query = supabase
      .from("listings")
      // seller_contact_id is the live FK to contacts (not seller_id). `contacts`
      // genuinely HAS first_name/last_name, so that half was always fine.
      //
      // `agents` does NOT: it has no first_name / last_name (verified against
      // information_schema). A person's name lives on `users`, reached through
      // agents_user_id_fkey — the only FK from agents to users, so an OBJECT
      // embed. Naming them on `agents` made PostgREST reject the ENTIRE query,
      // so getListingsService returned an error for every listing read.
      .select(
        `*,
         seller:seller_contact_id(first_name, last_name),
         agent:agent_id(id, users:user_id(first_name, last_name))`,
      )
      .order("created_at", { ascending: false })
      // UNCONDITIONAL. Every other predicate below is an optional NARROWING; this
      // one is the tenant boundary and does not get to be skipped.
      .eq("brokerage_id", params.brokerageId)
      // ARCHIVE FILTER — also unconditional, and this is the reader that makes
      // archiving mean anything.
      //
      // A listing is RETAINED, never deleted (owner's ruling: "listing shouldn't
      // be deleted because of rules of needing to keep real estate records"), and
      // `listings.deleted_at` carries that state — see the argument in
      // lib/kernel/listing-archive.ts. THIS QUERY IS THE /listings LIST, and it
      // is the path `archiveListing` revalidates. Without this predicate an
      // archived listing stays on the board and the archive is a no-op: the
      // record is stamped and nothing changes for the person who asked for it to
      // go away.
      //
      // Measured 2026-08-23: of 511 `.from("listings")` call sites, 23 filtered
      // `deleted_at` and every one of them was a working-surface reader (search,
      // inventory, public site, sitemap, counts). Not one was a by-id record
      // lookup. This is a working-surface reader and was one of the two canonical
      // ones missing the filter; the other is app/dashboard/listings/page.tsx.
      //
      // NOT applied to by-id record reads — getListingById, and every resolver
      // that pulls a listing for a transaction, offer, commission or document.
      // Those are the RETENTION surface, and an archived listing must still open
      // by id or it has been destroyed in every sense that matters.
      //
      // Pinned by scripts/listing-archive-simulator.ts section 3, with the
      // pre-filter text as its positive control — a filter no test can see
      // deleted is the half of a soft-delete that rots.
      .is("deleted_at", null)

    if (params?.agentId) query = query.eq("agent_id", params.agentId)
    if (params?.status) query = query.eq("status", params.status)
    if (params?.stage) query = query.eq("lifecycle_stage", params.stage)
    if (params?.limit) query = query.limit(params.limit)

    const { data, error } = await query
    if (error) throw error

    // Flattened to the {first_name, last_name} shape every agent-name reader in
    // the app already consumes, so no caller changes.
    const listings = (data ?? []).map((l: any) => {
      const a = l?.agent ?? null
      const u = a?.users ?? null
      return {
        ...l,
        agent: a
          ? { id: a.id, first_name: u?.first_name ?? null, last_name: u?.last_name ?? null }
          : null,
      }
    })

    return { success: true, listings }
  } catch (error) {
    return handleError(error, "getListingsService")
  }
}

export async function createListingService(params: {
  agentId: string
  /** FK to contacts.id — live schema column is seller_contact_id */
  sellerContactId: string
  brokerageId?: string
  address: string
  city: string
  state: string
  zip: string
  listPrice?: number
  bedrooms?: number
  bathrooms?: number
  sqft?: number
  propertyType?: string
}) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("listings")
      .insert({
        agent_id:           params.agentId,
        seller_contact_id:  params.sellerContactId,   // correct FK column
        brokerage_id:       params.brokerageId,
        address:            params.address,
        city:               params.city,
        state:              params.state,
        zip:                params.zip,               // correct column (not zip_code)
        list_price:         params.listPrice,         // correct column (not price)
        bedrooms:           params.bedrooms,
        bathrooms:          params.bathrooms,
        sqft:               params.sqft,              // correct column (not square_footage)
        property_type:      params.propertyType || "residential",
        lifecycle_stage:    "LISTING_AGREEMENT_INITIATED",
        // DRAFT, not active — same rule as the kernel's createListingRecord, which
        // carries the full note. A listing is only taken on once the agreement is
        // SIGNED and compliance has cleared every required document, initial and
        // signature; the compliance-listing-auto-create chain does the promotion.
        // Opening this row `active` published an unsigned listing to buyer search.
        status:             "draft",
      })
      .select()
      .single()

    if (error) throw error
    return { success: true, listing: data }
  } catch (error) {
    return handleError(error, "createListingService")
  }
}
