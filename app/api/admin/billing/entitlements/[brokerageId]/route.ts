// app/api/admin/billing/entitlements/[brokerageId]/route.ts
// Feature entitlements + override endpoint

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireSuperadminAuth } from "@/lib/kernel/api-auth"
import { resolveFeatureEntitlement, applyFeatureOverride } from "@/lib/kernel/billing"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ brokerageId: string }> }
) {
  const supabase = await createClient()
  const auth = await requireSuperadminAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const featureKey = req.nextUrl.searchParams.get("featureKey")
    if (!featureKey) {
      return NextResponse.json({ error: "Missing featureKey query param" }, { status: 400 })
    }

    const { brokerageId } = await params
    const result = await resolveFeatureEntitlement({ brokerageId, featureKey })
    if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 })
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
  const supabase = await createClient()
  const auth = await requireSuperadminAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { brokerageId } = await params
    const body = await req.json()

    const result = await applyFeatureOverride({
      brokerageId,
      featureKey: body.featureKey,
      overrideType: body.overrideType,
      trialEndsAt: body.trialEndsAt,
      actorContext: {
        userId: auth.userId,   // always from session, never from body/headers
        userType: "superadmin",
      },
    })

    if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error("[API] /admin/billing/entitlements POST error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
