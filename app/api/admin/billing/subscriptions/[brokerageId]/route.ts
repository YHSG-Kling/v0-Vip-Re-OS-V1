// app/api/admin/billing/subscriptions/[brokerageId]/route.ts
// Subscription detail + override endpoint

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireSuperadminAuth } from "@/lib/kernel/api-auth"
import { resolveSubscriptionTier, updateSubscriptionState } from "@/lib/kernel/billing"

export async function GET(
  // Deliberately unread: this handler's only input is the ROUTE PARAM below and the
  // session gate above it. The Request must keep its POSITION (Next.js passes the
  // route context second), so it is `_`-prefixed rather than removed.
  _req: NextRequest,
  { params }: { params: Promise<{ brokerageId: string }> }
) {
  const supabase = await createClient()
  const auth = await requireSuperadminAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { brokerageId } = await params
    const result = await resolveSubscriptionTier({ brokerageId })
    if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error("[API] /admin/billing/subscriptions GET error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ brokerageId: string }> }
) {
  const supabase = await createClient()
  const auth = await requireSuperadminAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { brokerageId } = await params
    const body = await req.json()

    const result = await updateSubscriptionState({
      brokerageId,
      tier: body.tier,
      newStatus: body.newStatus,
      cancellationReason: body.cancellationReason,
      // BOTH IDENTITY COLUMNS, VERBATIM — never a hand-written label. See the
      // same seam in ../entitlements/[brokerageId]/route.ts: `userType:
      // "superadmin"` was an assertion typed in to satisfy the old literal-union
      // field, not the caller's real user_type (which for the platform's only
      // superadmin is 'admin'). The kernel gate now gets the session's actual
      // columns and reaches the verdict itself.
      actorContext: {
        userId: auth.userId,   // always from session, never from body/headers
        userType: auth.userType,
        platformRole: auth.platformRole,
      },
    })

    if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error("[API] /admin/billing/subscriptions POST error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
