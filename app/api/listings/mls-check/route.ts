import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { checkMlsRules } from "@/lib/listings/mls-rule-check"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/listings/mls-check
 *
 * Either:
 *   • Body contains the listing fields directly (preview before saving), OR
 *   • Body contains { listingId } — load the saved listing and validate.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const body = await req.json().catch(() => ({}))

  if (body?.listingId) {
    const { data: listing } = await supabase
      .from("listings")
      .select(
        `id, brokerage_id, mls_code, list_price, bedrooms, bathrooms, sqft, sqft_source,
         year_built, property_type, description, public_remarks, lockbox_type, showing_instructions,
         school_district`,
      )
      .eq("id", body.listingId)
      .maybeSingle()

    if (!listing || listing.brokerage_id !== auth.brokerageId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const { count: photoCount } = await supabase
      .from("listing_media")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listing.id)
      .eq("media_type", "photo")

    const result = checkMlsRules({
      mlsCode: listing.mls_code,
      listPrice: listing.list_price,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      sqft: listing.sqft,
      sqftSource: listing.sqft_source,
      yearBuilt: listing.year_built,
      propertyType: listing.property_type,
      description: listing.description,
      publicRemarks: listing.public_remarks,
      photoCount: photoCount ?? 0,
      hasVirtualTour: false, // would join virtual_tours table when present
      schoolDistrict: listing.school_district,
      showsSchoolNames: !!listing.school_district,
      lockboxType: listing.lockbox_type,
      showingInstructions: listing.showing_instructions,
    })

    return NextResponse.json(result)
  }

  return NextResponse.json(checkMlsRules(body ?? {}))
}
