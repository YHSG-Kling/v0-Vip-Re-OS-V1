import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { scheduleRetry } from "@/lib/errors/auto-retry"

/**
 * POST /api/errors/retry
 * Retry one or more errors
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check user role
    const { data: userData } = await supabase
      .from("users")
      .select("user_type, platform_role, brokerage_id")
      .eq("id", user.id)
      .single()

    // TRUE ADMIN GATE (operational: error ops) — repointed to the ONE tenant
    // roster; the separate platform_role clause is kept as the platform lane.
    // 'superadmin' was dead in the array: 0 live rows store that users.user_type.
    if (!userData || (!isAdminOrBroker({ user_type: userData.user_type }) && userData.platform_role !== "superadmin")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const body = await request.json()
    const { errorId, errorIds } = body

    const idsToRetry = errorIds || (errorId ? [errorId] : [])

    if (idsToRetry.length === 0) {
      return NextResponse.json(
        { error: "No error IDs provided" },
        { status: 400 }
      )
    }

    const results: { errorId: string; success: boolean; error?: string }[] = []

    for (const id of idsToRetry) {
      const result = await scheduleRetry(id)
      results.push({
        errorId: id,
        success: result.success,
        error: result.error,
      })
    }

    const successCount = results.filter(r => r.success).length
    const failCount = results.filter(r => !r.success).length

    return NextResponse.json({
      results,
      summary: {
        total: results.length,
        success: successCount,
        failed: failCount,
      },
    })
  } catch (err) {
    console.error("[API /errors/retry] Error:", err)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
