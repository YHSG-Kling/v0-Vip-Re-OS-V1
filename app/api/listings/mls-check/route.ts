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
    // Live listings table only persists structural fields. Description / public
    // remarks / lockbox details / school district / sqft source / property type
    // / year built do not live on `listings` directly — they're either on the
    // listing form (during draft) or denormalised via the marketing tier or MLS
    // sync. Callers that have those values should pass them inline through
    // `body.overrides`; for stored listings we validate the structural fields
    // and any override the caller supplies.
    const { data: listing } = await supabase
      .from("listings")
      .select(
        `id, brokerage_id, mls_number, list_price, bedrooms, bathrooms, sqft,
         showing_instructions`,
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

    const overrides = (body.overrides ?? {}) as Record<string, unknown>

    const result = checkMlsRules({
      mlsCode: (overrides.mlsCode as string | null) ?? null,
      listPrice: listing.list_price,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      sqft: listing.sqft,
      sqftSource: (overrides.sqftSource as string | null) ?? null,
      yearBuilt: (overrides.yearBuilt as number | null) ?? null,
      propertyType: (overrides.propertyType as string | null) ?? null,
      description: (overrides.description as string | null) ?? null,
      publicRemarks: (overrides.publicRemarks as string | null) ?? null,
      photoCount: photoCount ?? 0,
      hasVirtualTour: !!overrides.hasVirtualTour,
      schoolDistrict: (overrides.schoolDistrict as string | null) ?? null,
      showsSchoolNames: !!overrides.schoolDistrict,
      lockboxType: (overrides.lockboxType as string | null) ?? null,
      showingInstructions: listing.showing_instructions,
    })

    return NextResponse.json(result)
  }

  return NextResponse.json(checkMlsRules(body ?? {}))
}
