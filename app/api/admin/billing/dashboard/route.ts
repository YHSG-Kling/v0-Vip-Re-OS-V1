// app/api/admin/billing/dashboard/route.ts
// Billing workspace GET endpoint - Superadmin only

import { NextRequest, NextResponse } from "next/server"
import { loadBillingWorkspace } from "@/lib/kernel/billing"
import { createClient } from "@/lib/supabase/server"
import { requireSuperadminAuth } from "@/lib/kernel/api-auth"

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireSuperadminAuth(supabase)
    if (!auth.ok) return auth.response

    const brokerageId = req.nextUrl.searchParams.get("brokerageId")
    if (!brokerageId) {
      return NextResponse.json({ error: "Missing brokerageId query param" }, { status: 400 })
    }

    const result = await loadBillingWorkspace({
      brokerageId,
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
    console.error("[API] /admin/billing/dashboard error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
