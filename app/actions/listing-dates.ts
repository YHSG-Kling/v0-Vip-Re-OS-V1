"use server"

/**
 * app/actions/listing-dates.ts — the lifecycle timeline's date editor.
 *
 * WAVE 143, LANE 143A. Three things changed, all found at the audit:
 *
 *   1. `go_live_date` is the PLANNED MLS live date (a plan a person typed — never verified). It is recorded through
 *      the ONE writer, lib/listings/mls-live-date.ts recordPlannedMlsLiveDate, which validates the day, resolves the
 *      listing's timezone, leaves an evidence row, and re-runs the listing compliance loop when the listing is
 *      waiting at LISTING_AGREEMENT_SIGNED for exactly this fact. The verified date is a different column and a
 *      different writer (recordVerifiedMlsLive — a feed's word, never this form's).
 *   2. THE TENANT COMES FROM THE SESSION. This action used to update `.eq("id", listingId)` with the caller's own
 *      client and report success — an update that matches nothing resolves exactly like one that worked (CLAUDE.md
 *      §3), so a listing in another brokerage (or one RLS hid) answered `{ success: true }`. Every write is now
 *      pinned to the session's brokerage and COUNTED.
 *   3. `field` is allow-listed at runtime. The TypeScript union is erased at the HTTP boundary — every export of a
 *      "use server" file is a public endpoint — so a body naming any other column used to be written straight through.
 */

import { revalidatePath } from "next/cache"
import { requireCaller } from "@/lib/auth/require-caller"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { ymdOf } from "@/lib/listings/compute-dom"

type ListingDateField = "go_live_date" | "open_house_marketing_date" | "open_house_event_date"
const LISTING_DATE_FIELDS: readonly ListingDateField[] = ["go_live_date", "open_house_marketing_date", "open_house_event_date"]

export async function updateListingDate(
  listingId: string,
  field: ListingDateField,
  value: string | null
): Promise<{ success: boolean; error?: string; planned?: { timezone: string | null; loop: string | null } }> {
  if (!isValidUUID(listingId)) return { success: false, error: "Invalid listing ID" }
  if (!(LISTING_DATE_FIELDS as readonly string[]).includes(field)) return { success: false, error: `"${String(field)}" is not an editable listing date` }
  const wanted = value === null || value === "" ? null : ymdOf(value)
  if (value && !wanted) return { success: false, error: "Enter the date as yyyy-mm-dd" }

  // GATE FIRST (the session decides the tenant), THEN the service client — every statement below is pinned to it.
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  // The listing write runs on the caller's SESSION client (their RLS role still decides who may edit a listing) and is
  // pinned to the session's brokerage and counted; only the evidence row + compliance-loop fan-out use the service client.
  const session = caller.supabase

  if (field === "go_live_date") {
    const r = await (await import("@/lib/listings/mls-live-date")).recordPlannedMlsLiveDate(session as any, {
      brokerageId: caller.brokerageId, listingId, date: wanted, actorUserId: caller.userId, source: "timeline",
      evidenceClient: createServiceClient() as any,
    })
    if (!r.ok) {
      console.error("[updateListingDate] planned MLS live date refused:", r.reason)
      return { success: false, error: r.reason }
    }
    revalidatePath(`/dashboard/listings/${listingId}/lifecycle`)
    return { success: true, planned: { timezone: r.timezone, loop: r.loop } }
  }

  const { data, error } = await session
    .from("listings")
    .update({ [field]: wanted, updated_at: new Date().toISOString() })
    .eq("id", listingId)
    .eq("brokerage_id", caller.brokerageId)
    .select("id")
  if (error) {
    console.error("[updateListingDate] Error:", error)
    return { success: false, error: error.message }
  }
  if (!data || data.length === 0) return { success: false, error: "Listing not found in your brokerage (or you may not edit it)" }

  revalidatePath(`/dashboard/listings/${listingId}/lifecycle`)
  return { success: true }
}
