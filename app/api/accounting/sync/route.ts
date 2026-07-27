import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Authenticate user
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get user profile and verify role — user_type is canonical; role is legacy fallback
    const { data: profile } = await supabase
      .from("users")
      .select("user_type, role, brokerage_id")
      .eq("id", user.id)
      .single()

    const resolvedType = profile?.user_type ?? profile?.role ?? ""
    if (!profile || !["broker", "admin"].includes(resolvedType)) {
      return NextResponse.json({ error: "Forbidden: broker or admin role required" }, { status: 403 })
    }

    if (!profile.brokerage_id) {
      return NextResponse.json({ error: "No brokerage found" }, { status: 400 })
    }

    const body = await request.json()
    const { sync_type } = body as { sync_type: "commission" | "expense" | "full" }

    if (!sync_type || !["commission", "expense", "full"].includes(sync_type)) {
      return NextResponse.json({ error: "Invalid sync_type" }, { status: 400 })
    }

    // Get active provider credentials
    const { data: credentials } = await supabase
      .from("integration_credentials")
      .select("*")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("is_active", true)
      .in("provider_name", ["quickbooks", "xero"])
      .limit(1)
      .single()

    if (!credentials) {
      return NextResponse.json({ error: "No accounting provider connected" }, { status: 400 })
    }

    // Create sync log entry
    const { data: syncLog, error: syncLogError } = await supabase
      .from("accounting_sync_log")
      .insert({
        brokerage_id: profile.brokerage_id,
        provider: credentials.provider_name,
        sync_type,
        status: "running",
        records_synced: 0,
        records_failed: 0,
        started_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (syncLogError || !syncLog) {
      return NextResponse.json({ error: "Failed to create sync log" }, { status: 500 })
    }

    // Log kernel event for sync started
    await supabase.from("lifecycle_events").insert({
      brokerage_id: profile.brokerage_id,
      event_type: KernelEvent.SYSTEM_SYNC_TRIGGERED,
      entity_type: "accounting_sync_log",
      entity_id: syncLog.id,
      actor_user_id: user.id,
      metadata: {
        provider: credentials.provider_name,
        sync_type,
        triggered_by: user.id,
      },
      created_at: new Date().toISOString(),
    })

    // Perform sync based on type
    let recordsSynced = 0
    let recordsFailed = 0
    const errors: Array<{ record_type: string; record_id: string; error_message: string }> = []

    try {
      if (sync_type === "commission" || sync_type === "full") {
        // Sync commissions
        const { data: commissions } = await supabase
          // KEEP-ONE (m283): agent_commissions is the canonical ledger.
          // Column translation: commissions.paid_date -> paid_at.
          .from("agent_commissions")
          .select("id, gross_commission, agent_commission, brokerage_commission, status, paid_at")
          .eq("brokerage_id", profile.brokerage_id)
          .eq("status", "paid")
          .is("paid_at", null)
          .limit(100)

        if (commissions) {
          for (const commission of commissions) {
            try {
              // Simulate sync to accounting provider
              // In production, this would call QuickBooks/Xero API
              recordsSynced++
            } catch (err) {
              recordsFailed++
              errors.push({
                record_type: "commission",
                record_id: commission.id,
                error_message: err instanceof Error ? err.message : "Unknown error",
              })
            }
          }
        }
      }

      if (sync_type === "expense" || sync_type === "full") {
        // Sync expenses
        const { data: expenses } = await supabase
          .from("business_expenses")
          .select("id, amount, description, expense_date, category")
          .limit(100)

        if (expenses) {
          for (const expense of expenses) {
            try {
              // Simulate sync to accounting provider
              // In production, this would call QuickBooks/Xero API
              recordsSynced++
            } catch (err) {
              recordsFailed++
              errors.push({
                record_type: "expense",
                record_id: expense.id,
                error_message: err instanceof Error ? err.message : "Unknown error",
              })
            }
          }
        }
      }

      // Insert any errors
      if (errors.length > 0) {
        await supabase.from("sync_errors").insert(
          errors.map((e) => ({
            sync_log_id: syncLog.id,
            brokerage_id: profile.brokerage_id,
            record_type: e.record_type,
            record_id: e.record_id,
            error_code: "SYNC_FAILED",
            error_message: e.error_message,
            created_at: new Date().toISOString(),
          }))
        )
      }

      // Update sync log with results
      await supabase
        .from("accounting_sync_log")
        .update({
          status: recordsFailed > 0 ? "completed_with_errors" : "completed",
          records_synced: recordsSynced,
          records_failed: recordsFailed,
          completed_at: new Date().toISOString(),
          error_summary: recordsFailed > 0 ? `${recordsFailed} records failed to sync` : null,
        })
        .eq("id", syncLog.id)

      // Log kernel event for sync completed
      await supabase.from("lifecycle_events").insert({
        brokerage_id: profile.brokerage_id,
        event_type: KernelEvent.SYSTEM_SYNC_COMPLETED,
        entity_type: "accounting_sync_log",
        entity_id: syncLog.id,
        actor_user_id: user.id,
        metadata: {
          provider: credentials.provider_name,
          sync_type,
          records_synced: recordsSynced,
          records_failed: recordsFailed,
        },
        created_at: new Date().toISOString(),
      })

      return NextResponse.json({
        success: true,
        syncLogId: syncLog.id,
        recordsSynced,
        recordsFailed,
      })
    } catch (syncError) {
      // Update sync log with failure
      await supabase
        .from("accounting_sync_log")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_summary: syncError instanceof Error ? syncError.message : "Unknown error",
        })
        .eq("id", syncLog.id)

      return NextResponse.json({
        success: false,
        error: syncError instanceof Error ? syncError.message : "Sync failed",
        syncLogId: syncLog.id,
      }, { status: 500 })
    }
  } catch (error) {
    console.error("[Accounting Sync] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
