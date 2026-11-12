import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { presentTenantMessage } from "@/lib/errors"

// ─────────────────────────────────────────────────────────────────────────────
// WAVE 152 (lane 152K — the integrator queue's 152D outside-lane 4). This route was the last FAKE accounting path:
// its expense / commission loops counted rows as "synced" without calling any provider ("Simulate sync to accounting
// provider"), the card then toasted "Sync Complete — Synced N records", and it closed its log row with
// `status: "completed_with_errors"` — a value the live CHECK on accounting_sync_log.status refuses
// (completed | failed | pending | running, scripts/check-vocabularies.ts), so that write could never land.
//
// What is TRUE, and where the work actually lives (orphan doctrine §1.3 — the functionality is elsewhere):
//   · brokerage expenses → lib/finance/accounting-egress.ts pushExpenseToAccounting, called off
//     app/actions/financials.ts logScopedExpense the moment a brokerage expense is logged;
//   · closed commissions → pushCommissionToAccounting, called off app/actions/ai-financial-management.ts;
//   · a one-off posting with an exact QuickBooks reference → app/actions/accounting-sync.ts pushAccountingEntry via
//     app/settings/accounting/manual-entry-card.tsx.
// Each of those writes ONE honest accounting_sync_log row per real push (completed / failed), and NO row when nothing
// was attempted. A bulk re-push from here would post duplicates into the brokerage's books (the survivors carry no
// "already sent" marker), so this door sends nothing, writes no log row, emits no "sync completed" event, and says so.
// ─────────────────────────────────────────────────────────────────────────────

const SYNC_TYPES = ["commission", "expense", "full"] as const

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Authenticate user
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Tenant + role from the SESSION — user_type is canonical; role is legacy fallback
    const { data: profile } = await supabase
      .from("users")
      .select("user_type, role, brokerage_id")
      .eq("id", user.id)
      .single()

    const resolvedType = profile?.user_type ?? profile?.role ?? ""
    if (!profile || !isBrokerageFinanceAdmin({ user_type: resolvedType })) {
      return NextResponse.json({ error: "Forbidden: broker or admin role required" }, { status: 403 })
    }

    if (!profile.brokerage_id) {
      return NextResponse.json({ error: "No brokerage found" }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const { sync_type } = (body ?? {}) as { sync_type?: string }
    if (!sync_type || !(SYNC_TYPES as readonly string[]).includes(sync_type)) {
      return NextResponse.json({ error: "Invalid sync_type" }, { status: 400 })
    }

    // Nothing is attempted, so nothing is logged (the egress rule: no accounting_sync_log row when nothing was tried).
    const message = presentTenantMessage({
      what: "Nothing was sent to your accounting books from this button",
      affects: "When QuickBooks is connected, brokerage expenses and closed commissions are sent to it one at a time as they are recorded, and any that could not be sent appear under Sync errors",
      work: { state: "unchanged" },
      next: "you",
      action: { label: "Use Manual entry to post a one-off item" },
    })
    return NextResponse.json({ success: false, sent: 0, notSent: true, syncType: sync_type, error: message.sentence })
  } catch (error) {
    console.error("[Accounting Sync] Error:", error)
    return NextResponse.json(
      { success: false, error: presentTenantMessage({ what: "This didn't finish because of a problem on our side", next: "platform_support", action: { label: "Try again" } }).sentence },
      { status: 500 },
    )
  }
}
