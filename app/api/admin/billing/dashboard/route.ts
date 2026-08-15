// app/api/admin/billing/dashboard/route.ts
// Billing workspace GET endpoint — Superadmin only.
// Previously used x-user-type and x-user-id headers (spoofable).
// Now uses DB-verified session via requireSuperadminAuth.

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireSuperadminAuth } from "@/lib/kernel/api-auth"
import { loadBillingWorkspace } from "@/lib/kernel/billing"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const auth = await requireSuperadminAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    // brokerageId may still come from query param for superadmin dashboard navigation,
    // but the user's identity is always session-derived.
    const brokerageId =
      req.nextUrl.searchParams.get("brokerageId") ?? auth.brokerageId

    const result = await loadBillingWorkspace({
      brokerageId,
      // The cast is gone with the literal union it existed to satisfy: it claimed
      // every caller was one of three values when `users.user_type` admits
      // fifteen, and the platform's only superadmin ('admin') was none of the
      // three. platform_role travels with it so the kernel can tell a genuine
      // superadmin from a tenant admin.
      actorContext: {
        userId:   auth.userId,
        userType: auth.userType,
        platformRole: auth.platformRole,
      },
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error("[API] /admin/billing/dashboard error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
