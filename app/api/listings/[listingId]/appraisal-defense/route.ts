import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { buildAppraisalDefensePackage } from "@/app/actions/appraisal-defense"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/listings/[listingId]/appraisal-defense
 * Body: { contractPrice?: number }
 *
 * Resolves the most recent CMA report for the listing and builds the
 * appraisal defense package from it.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ listingId: string }> },
) {
  const { listingId } = await params
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { data: listing } = await supabase
    .from("listings")
    .select("id, brokerage_id, agent_id")
    .eq("id", listingId)
    .maybeSingle()

  if (!listing || listing.brokerage_id !== auth.brokerageId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const { data: cma } = await supabase
    .from("cma_reports")
    .select("id")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!cma) {
    return NextResponse.json(
      { error: "No CMA report on file — generate one before requesting an appraisal defense." },
      { status: 422 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const result = await buildAppraisalDefensePackage({
    cmaReportId: cma.id,
    contractPrice: body?.contractPrice,
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 422 })
  }

  return NextResponse.json(result.package)
}
