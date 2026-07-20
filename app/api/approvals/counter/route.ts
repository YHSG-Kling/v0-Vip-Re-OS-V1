import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { NextResponse } from "next/server"
import { cascadeCounterOffer } from "@/lib/kernel/approval-queue-aggregator"

/**
 * Counter endpoint — the third response lane for OFFER items in the unified
 * queue. Offers are DEAL DECISIONS with the full accept / reject / COUNTER
 * response set; this route handles the counter.
 *
 * Only of:<uuid> ids are valid — marketing content has no counter semantics.
 * Delegates to cascadeCounterOffer, which guards scope + direction (inbound
 * offers on our seller listings only) and then calls the REAL kernel command
 * issueCounterOffer: creates the counter row (offer_type='counter',
 * parent_offer_id, round+1), marks the parent status='countered' +
 * has_counter=true, and emits OFFER_OS_COUNTERED.
 *
 * Body: { id: "of:<uuid>", counterPrice: number, closingDate?: string,
 *         notes?: string }
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const { id, counterPrice, closingDate, notes } = body

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Missing required field: id" }, { status: 400 })
    }
    const price = typeof counterPrice === "string" ? Number(counterPrice) : counterPrice
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      return NextResponse.json(
        { error: "counterPrice must be a positive number" },
        { status: 400 },
      )
    }

    const agentScopeId =
      auth.userType === "agent" && auth.agentId ? auth.agentId : null

    const result = await cascadeCounterOffer(
      id,
      {
        brokerageId: auth.brokerageId,
        agentScopeId,
        reviewerUserId: auth.userId,
      },
      {
        counterPrice: price,
        closingDate:
          typeof closingDate === "string" && closingDate.trim() ? closingDate.trim() : undefined,
        notes: typeof notes === "string" && notes.trim() ? notes.trim() : undefined,
      },
    )

    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? "Failed to send counter" },
        { status: 400 },
      )
    }

    return NextResponse.json({ success: true, type: result.type, target_id: result.targetId })
  } catch (error) {
    console.error("[Approvals Counter] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
