export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const supabase = await createClient()

    // Count unresolved errors
    const { count, error } = await supabase
      .from("automation_errors")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      message: "Automation error monitor completed",
      unresolved_count: count || 0,
    })
  } catch (error) {
    console.error("[automation-error-monitor] error:", error)
    return NextResponse.json(
      {
        error: "Monitor failed",
        details: error instanceof Error ? error.message : "Unknown",
      },
      { status: 500 }
    )
  }
}
