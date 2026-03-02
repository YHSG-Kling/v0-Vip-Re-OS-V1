import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { pullCalendarEventsFromProvider } from "@/lib/kernel"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const supabase = await createClient()

    const { data: accounts, error } = await supabase
      .from("calendar_provider_accounts")
      .select("id, user_id, brokerage_id")
      .eq("is_active", true)
      .order("last_sync_at", { ascending: true, nullsFirst: true })
      .limit(50)

    if (error || !accounts) {
      return NextResponse.json({ error: "Failed to fetch accounts" }, { status: 500 })
    }

    const results: Array<{ accountId: string; status: "success" | "failed"; error?: string }> = []

    for (const account of accounts) {
      try {
        await pullCalendarEventsFromProvider({
          userId: account.user_id,
          providerAccountId: account.id,
        })
        results.push({ accountId: account.id, status: "success" })
      } catch (err) {
        results.push({
          accountId: account.id,
          status: "failed",
          error: err instanceof Error ? err.message : "Unknown error",
        })
      }
    }

    return NextResponse.json({
      message: "Calendar sync completed",
      total: accounts.length,
      results,
    })
  } catch (error) {
    console.error("[calendar-sync] cron error:", error)
    return NextResponse.json(
      {
        error: "Cron job failed",
        details: error instanceof Error ? error.message : "Unknown",
      },
      { status: 500 }
    )
  }
}
