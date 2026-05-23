import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { pullCalendarEventsFromProvider } from "@/lib/kernel"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "calendar-sync",
    cron_path: "/app/api/cron/calendar-sync/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[CalendarSync] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()

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

    const succeeded = results.filter((r) => r.status === "success").length

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: accounts.length,
      output_count: succeeded,
      metadata: { total: accounts.length, succeeded, failed: accounts.length - succeeded },
    })

    return NextResponse.json({
      message: "Calendar sync completed",
      total: accounts.length,
      results,
    })
  } catch (error) {
    console.error("[calendar-sync] cron error:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json(
      { error: "Cron job failed", details: error instanceof Error ? error.message : "Unknown", context_id: contextId },
      { status: 500 }
    )
  }
}
