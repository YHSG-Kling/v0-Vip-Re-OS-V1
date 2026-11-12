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
      // BOTH IDENTITY COLUMNS, VERBATIM — never a hand-written label. This read
      // `userType: "superadmin"`, which was not the caller's user_type but an
      // assertion typed in to satisfy the old literal-union field. It happened to
      // be harmless only because requireSuperadminAuth above had already checked
      // both columns; the kernel's own gate was reduced to a rubber stamp, and
      // the platform's only superadmin (user_type='admin',
      // platform_role='superadmin') was being described to it as something they
      // are not. The session's real values are passed now, and the kernel gate
      // (validateSuperadminOnly) reaches the same verdict on its own.
      actorContext: {
        userId: auth.userId,   // always from session, never from body/headers
        userType: auth.userType,
        platformRole: auth.platformRole,
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
