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
      actorContext: {
        userId:   auth.userId,
        userType: auth.userType as "superadmin" | "broker_admin" | "agent",
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
