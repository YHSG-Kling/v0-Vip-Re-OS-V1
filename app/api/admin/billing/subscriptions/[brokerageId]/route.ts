// app/api/admin/billing/subscriptions/[brokerageId]/route.ts
// Subscription detail + override endpoint

import { NextRequest, NextResponse } from "next/server"
import { resolveSubscriptionTier, updateSubscriptionState } from "@/lib/kernel/billing"
import { createClient } from "@/lib/supabase/server"
import { requireSuperadminAuth } from "@/lib/kernel/api-auth"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ brokerageId: string }> }
) {
  try {
    const supabase = await createClient()
    const auth = await requireSuperadminAuth(supabase)
    if (!auth.ok) return auth.response

    const { brokerageId } = await params

    const result = await resolveSubscriptionTier({ brokerageId })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

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
  try {
    const supabase = await createClient()
    const auth = await requireSuperadminAuth(supabase)
    if (!auth.ok) return auth.response

    const { brokerageId } = await params
    const body = await req.json()

    const result = await updateSubscriptionState({
      brokerageId,
      tier: body.tier,
      newStatus: body.newStatus,
      cancellationReason: body.cancellationReason,
      actorContext: {
        userId: auth.user.id,
        userType: "superadmin",
      },
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error("[API] /admin/billing/subscriptions POST error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
