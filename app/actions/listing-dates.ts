"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

type ListingDateField = "go_live_date" | "open_house_marketing_date" | "open_house_event_date"

export async function updateListingDate(
  listingId: string,
  field: ListingDateField,
  value: string | null
) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("listings")
    .update({ [field]: value || null })
    .eq("id", listingId)

  if (error) {
    console.error("[updateListingDate] Error:", error)
    return { success: false, error: error.message }
  }

  revalidatePath(`/dashboard/listings/${listingId}/lifecycle`)
  return { success: true }
}
