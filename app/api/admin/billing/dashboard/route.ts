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
    //
    // RESEARCHED AND KEPT (2026-08-26). The param is the platform-staff navigation
    // mechanism for this workspace — see the verdict written into
    // lib/kernel/billing.ts:loadBillingWorkspace. It is no longer this route's gate
    // alone that makes it safe: the kernel command now authorizes the named tenant
    // against the actor itself, which is why `brokerageId` (the actor's OWN
    // membership) travels in actorContext below beside the two identity columns.
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
        // The actor's OWN tenant, resolved from users.brokerage_id by requireAuth —
        // never from the query string. This is what the kernel compares the named
        // brokerage against for a non-platform caller.
        brokerageId: auth.brokerageId,
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
