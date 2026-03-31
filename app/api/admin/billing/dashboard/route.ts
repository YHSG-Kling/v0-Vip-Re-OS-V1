// app/api/admin/billing/dashboard/route.ts
// Billing workspace GET endpoint - Superadmin only

import { NextRequest, NextResponse } from "next/server"
import { loadBillingWorkspace } from "@/lib/kernel/billing"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"

export async function GET(req: NextRequest) {
  try {
    const headersList = await headers()
    const userId = headersList.get("x-user-id")
    const userType = headersList.get("x-user-type")
    const brokerageId = req.nextUrl.searchParams.get("brokerageId")

    if (!userId || !userType || !brokerageId) {
      return NextResponse.json(
        { error: "Missing required headers or query params" },
        { status: 400 }
      )
    }

    if (userType !== "superadmin") {
      return NextResponse.json(
        { error: "Only superadmins can access billing dashboard" },
        { status: 403 }
      )
    }

    const result = await loadBillingWorkspace({
      brokerageId,
      actorContext: {
        userId,
        userType: userType as "superadmin" | "broker_admin" | "agent",
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
