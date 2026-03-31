// app/api/admin/billing/subscriptions/[brokerageId]/route.ts
// Subscription detail + override endpoint

import { NextRequest, NextResponse } from "next/server"
import { resolveSubscriptionTier, updateSubscriptionState } from "@/lib/kernel/billing"
import { headers } from "next/headers"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ brokerageId: string }> }
) {
  try {
    const headersList = await headers()
    const userType = headersList.get("x-user-type")

    if (userType !== "superadmin") {
      return NextResponse.json(
        { error: "Only superadmins can access subscription details" },
        { status: 403 }
      )
    }

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
    const headersList = await headers()
    const userId = headersList.get("x-user-id")
    const userType = headersList.get("x-user-type")

    if (userType !== "superadmin") {
      return NextResponse.json(
        { error: "Only superadmins can update subscriptions" },
        { status: 403 }
      )
    }

    const { brokerageId } = await params
    const body = await req.json()

    const result = await updateSubscriptionState({
      brokerageId,
      tier: body.tier,
      newStatus: body.newStatus,
      cancellationReason: body.cancellationReason,
      actorContext: {
        userId: userId || "",
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
