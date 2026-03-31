// app/api/admin/billing/entitlements/[brokerageId]/route.ts
// Feature entitlements + override endpoint

import { NextRequest, NextResponse } from "next/server"
import { resolveFeatureEntitlement, applyFeatureOverride } from "@/lib/kernel/billing"
import { headers } from "next/headers"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ brokerageId: string }> }
) {
  try {
    const headersList = await headers()
    const userType = headersList.get("x-user-type")
    const featureKey = req.nextUrl.searchParams.get("featureKey")

    if (userType !== "superadmin") {
      return NextResponse.json(
        { error: "Only superadmins can access entitlements" },
        { status: 403 }
      )
    }

    if (!featureKey) {
      return NextResponse.json({ error: "Missing featureKey query param" }, { status: 400 })
    }

    const { brokerageId } = await params

    const result = await resolveFeatureEntitlement({
      brokerageId,
      featureKey,
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error("[API] /admin/billing/entitlements GET error:", error)
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
        { error: "Only superadmins can apply feature overrides" },
        { status: 403 }
      )
    }

    const { brokerageId } = await params
    const body = await req.json()

    const result = await applyFeatureOverride({
      brokerageId,
      featureKey: body.featureKey,
      overrideType: body.overrideType,
      trialEndsAt: body.trialEndsAt,
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
    console.error("[API] /admin/billing/entitlements POST error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
