import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { supabaseService } from "@/services/supabaseService"

/**
 * THE COLUMNS A CLIENT MAY STATE ON AN EXPENSE.
 *
 * `business_expenses` has exactly TEN columns. Verified 2026-08-22 two ways so
 * the list is not a guess — PGRST204 refuses the ENTIRE insert when a named
 * column is absent (CLAUDE.md §3), so a guessed name loses the whole row:
 *
 *   · live, project hrvaqgvukzxfskkcrwbt:
 *       SELECT column_name FROM information_schema.columns
 *        WHERE table_schema='public' AND table_name='business_expenses';
 *     → id, agent_id, category, description, amount, expense_date, receipt_url,
 *       created_at, brokerage_id, team_id   (brokerage_id is_nullable = 'NO')
 *   · cache, scripts/schema-snapshot.ts:154 — the identical set.
 *
 * FIVE of those ten are the client's to state. The other five are the SERVER's,
 * and this is the whole point of the allowlist:
 *   · id, created_at — DB defaults (gen_random_uuid(), now()). A body that set
 *     them could overwrite an existing row's identity or backdate the ledger.
 *   · agent_id       — the SESSION's agent. Never a body field.
 *   · brokerage_id   — the SESSION's tenant. Never a body field (CLAUDE.md §4).
 *     The m516 trigger `business_expenses_derive_tenant` only derives a tenant
 *     when the caller supplied NONE (`IF NEW.brokerage_id IS NOT NULL THEN
 *     RETURN NEW`), so a body-supplied brokerage_id is HONOURED, not corrected.
 *     The trigger is a backstop for writers that omit the tenant, never a gate
 *     against writers that state the wrong one.
 *   · team_id        — a team-scoped expense must first PROVE the team belongs
 *     to the caller's brokerage. That path exists already and is not duplicated
 *     here: app/actions/financials.ts#logScopedExpense.
 *
 * Anything else in the body is DROPPED, not merged.
 */
const CLIENT_SUPPLIABLE_EXPENSE_COLUMNS = [
  "category",
  "description",
  "amount",
  "expense_date",
  "receipt_url",
] as const

// TOMBSTONE — this handler took the framework's Request object and read NOTHING
// from it: no query string, no body, no header. Every input it uses comes from the
// SESSION (CLAUDE.md §4 — the tenant is never a request field). A route handler
// may be declared with no parameters at all, and leaving an unread `request` in the
// signature advertises a filter this endpoint does not honour.
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }
    const agentId = await resolveAgentId(supabase, user.id)
    if (!agentId) {
      return NextResponse.json({ success: false, error: "Agent profile not found" }, { status: 403 })
    }

    const expenses = await supabaseService.getBusinessExpenses({ agentId })

    console.log("[v0] API fetched expenses:", expenses?.length || 0)

    return NextResponse.json({
      success: true,
      expenses: expenses || [],
      total: expenses?.length || 0,
    })
  } catch (error: any) {
    console.error("[Expenses API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    // GATE FIRST, THEN THE SERVICE CLIENT (CLAUDE.md §4). Both the agent and the
    // TENANT come from the session here, resolved by the same resolver the two
    // sibling expense writers use (app/actions/financials.ts#logScopedExpense,
    // app/actions/agents.ts#addAgentExpense) rather than a second one invented
    // for this route. getAgentContext never throws: on any failure it returns the
    // unauthenticated context, so a gate that cannot run REFUSES below instead of
    // falling through as "checked and fine".
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }
    if (!ctx.agentId) {
      return NextResponse.json({ success: false, error: "Agent profile not found" }, { status: 403 })
    }
    if (!ctx.brokerageId) {
      // An untenanted session cannot log money anywhere. brokerage_id is NOT NULL
      // since m516, and the trigger would raise rather than invent a tenant — a
      // clear 403 beats a 500 carrying a Postgres message.
      return NextResponse.json({ success: false, error: "No brokerage on your account" }, { status: 403 })
    }

    const rawBody = await request.json().catch(() => null)
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return NextResponse.json({ success: false, error: "invalid_body" }, { status: 400 })
    }
    const body = rawBody as Record<string, unknown>

    // ALLOWLIST, NOT SPREAD. `{ ...expenseData }` let a caller state any column
    // on a service-role insert — id, created_at, brokerage_id, team_id, plus any
    // junk name, which PGRST204 would use to refuse the whole row.
    const supplied: Record<string, unknown> = {}
    for (const column of CLIENT_SUPPLIABLE_EXPENSE_COLUMNS) {
      if (body[column] !== undefined) supplied[column] = body[column]
    }

    // Validation mirrors logScopedExpense clause for clause (CLAUDE.md §6 — one
    // vocabulary per function), because these three columns are NOT NULL live and
    // a rejected insert reaches the caller only as a raw Postgres message.
    const description = typeof supplied.description === "string" ? supplied.description.trim() : ""
    if (!description) {
      return NextResponse.json({ success: false, error: "description_required" }, { status: 400 })
    }
    const amount = Number(supplied.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, error: "amount_invalid" }, { status: 400 })
    }
    const expenseDate = typeof supplied.expense_date === "string" ? supplied.expense_date.trim() : ""
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) {
      return NextResponse.json({ success: false, error: "date_invalid" }, { status: 400 })
    }
    const category =
      typeof supplied.category === "string" && supplied.category.trim() ? supplied.category.trim() : "other"
    const receiptUrl =
      typeof supplied.receipt_url === "string" && supplied.receipt_url.trim() ? supplied.receipt_url.trim() : null

    const expense = await supabaseService.createBusinessExpense({
      // SESSION-DERIVED, in that order so no later key can shadow them.
      agent_id: ctx.agentId,
      brokerage_id: ctx.brokerageId,
      category,
      description,
      amount,
      expense_date: expenseDate,
      receipt_url: receiptUrl,
    })

    if (!expense) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to create expense",
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      expense,
    })
  } catch (error: any) {
    console.error("[Expense Create API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Internal server error",
      },
      { status: 500 },
    )
  }
}
