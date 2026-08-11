import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"

// Consolidated read endpoint for the dashboard data hooks
// (hooks/use-dashboard-data.ts). Nothing else calls it.
//
// ── WHAT THIS LANE IS, AND WHAT IT IS NOT (wave 13, L3) ──────────────────────
// A read-both verdict was owed here against how the dashboard fetches these
// same entities today. The answer, argued from CAPABILITY and not from import
// counts, is in the header of hooks/use-dashboard-data.ts: every branch below
// is a strict SUBSET of a live server action that the app already renders from,
// and the one capability this lane appeared to add — client-side revalidation
// after a mutation — is available over those richer readers already
// (hooks/use-contact-dashboard.ts wraps server actions in SWR and gets the same
// `mutate` handle, with no HTTP hop and no second auth round trip).
//
// So this lane is the LOSER of a duplicate pair. It is NOT deleted yet, because
// the method requires the merge FIRST and three things this route does that its
// survivors do not are still unmerged — they are listed in the hook header under
// MERGE DEBT. Until those land this file is the merge SOURCE, so it stays, and
// it stays CORRECT.
//
// ── SECURITY INVARIANTS (all three are proven by
//    scripts/dashboard-data-layer-simulator.ts) ─────────────────────────────
//   1. SCOPE IS SESSION-DERIVED ONLY. agent_id and brokerage_id are never read
//      from the query string. A query parameter may NARROW a branch; it may
//      never replace or widen the session scope. (`communications` used to let
//      `contact_id` REPLACE the agent filter outright — any signed-in browser
//      could read any contact's message history in any brokerage. An HTTP route
//      is reachable by anyone with a URL bar, so "nothing calls it" never made
//      that safe.)
//   2. A REFUSED READ IS A FAILURE, NEVER AN EMPTY LIST. supabase-js RESOLVES a
//      refused query, so `const { data }` renders "permission denied" and "you
//      have no transactions" identically. Every branch here builds a query and
//      exactly ONE place awaits it, with `error` destructured — there is no
//      second read that could quietly drop its error on the floor.
//   3. AN UNKNOWN OR UNPRIVILEGED REQUEST REFUSES. Unknown `type` → 400. A
//      non-broker asking for the team roster → 403, not `[]`; an empty list is
//      indistinguishable from "your brokerage has no agents".

function refuse(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status })
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return refuse(401, "Unauthorized")
    }

    const { searchParams } = new URL(request.url)
    const dataType = searchParams.get("type")

    // Tenant + role in ONE read. The role used to be fetched a second time
    // inside the roster branch, which meant a second chance to swallow an error.
    const { data: userRow, error: identityError } = await supabase
      .from("users")
      .select("brokerage_id, user_type")
      .eq("id", user.id)
      .maybeSingle()

    if (identityError) {
      return refuse(502, `Identity read refused: ${identityError.message}`)
    }

    const brokerageId = userRow?.brokerage_id
    if (!brokerageId) {
      return refuse(403, "Brokerage not configured")
    }

    // BROKERAGE-SCOPED resolve, not the unscoped one. A user holding agents rows
    // in two brokerages got whichever row was oldest, paired with the brokerage
    // from `users` — a mismatched (agentId, brokerageId) pair that makes every
    // branch below return zero rows while reporting success.
    const agentId = await resolveAgentIdInBrokerage(supabase, user.id, brokerageId)

    if (!agentId) {
      return refuse(403, "Agent profile not found")
    }

    // The ONLY caller-supplied parameter besides `type`. It NARROWS — the
    // session scope is applied unconditionally before it is considered.
    const contactIdFilter = searchParams.get("contact_id")

    // Each branch BUILDS a query; none of them awaits one. The single await
    // below is the only place a row ever arrives, so the error check cannot be
    // forgotten in one branch and remembered in another.
    let query: any = null

    switch (dataType) {
      case "transactions": {
        query = supabase
          .from("transactions")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        break
      }

      case "contacts": {
        // contacts.agent_id → agents.id (FK corrected + backfilled in migration 114)
        query = supabase
          .from("contacts")
          .select("*")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
        break
      }

      case "listings": {
        query = supabase
          .from("listings")
          .select("*")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        break
      }

      case "appointments": {
        query = supabase
          .from("showings")
          .select("*")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .gte("scheduled_at", new Date().toISOString())
          .order("scheduled_at", { ascending: true })
        break
      }

      case "showings": {
        query = supabase
          .from("showings")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("scheduled_at", { ascending: false })
        break
      }

      case "offers": {
        query = supabase
          .from("offers")
          .select("*, listings(*), contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        break
      }

      case "referrals": {
        query = supabase
          .from("referrals")
          .select("*")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        break
      }

      case "reviews": {
        query = supabase
          .from("agent_reviews")
          .select("*, contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        break
      }

      case "expenses": {
        // brokerage_id added — this was the one entity branch scoped by a single
        // column. Both live writers (financials.ts:logScopedExpense and
        // agents.ts:addAgentExpense) stamp the tenant at the insert, so the
        // filter costs no rows and the branch now matches its siblings.
        query = supabase
          .from("business_expenses")
          .select("*")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("expense_date", { ascending: false })
        break
      }

      case "commissions": {
        query = supabase
          .from("agent_commissions")
          .select("*, transactions(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        break
      }

      case "open_houses": {
        query = supabase
          .from("open_house_events")
          .select("*, listings(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("event_date", { ascending: false })
        break
      }

      case "tasks": {
        query = supabase
          .from("tasks")
          .select("*")
          .eq("assigned_to_agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("due_date", { ascending: true })
        break
      }

      case "notifications": {
        // notifications.user_id stores the auth user id (users.id), not agents.id
        query = supabase
          .from("notifications")
          .select("*")
          .eq("user_id", user.id)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
          .limit(50)
        break
      }

      case "documents": {
        query = supabase
          .from("transaction_documents")
          .select("*, transactions(*)")
          .eq("uploaded_by", user.id)
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        break
      }

      case "agents": {
        // Broker/admin view only. A plain agent is REFUSED rather than handed an
        // empty array — "[] because you may not see this" and "[] because the
        // roster is empty" must not render as the same screen.
        const role = userRow?.user_type
        if (role !== "broker" && role !== "admin" && role !== "superadmin") {
          return refuse(403, "Team roster requires a broker or admin role")
        }
        query = supabase
          .from("agents")
          .select("*")
          .eq("brokerage_id", brokerageId)
          .order("created_at", { ascending: false })
        break
      }

      case "tours": {
        query = supabase
          .from("tours")
          .select("*, tour_stops(*, listings(*)), contacts(*)")
          .eq("agent_id", agentId)
          .eq("brokerage_id", brokerageId)
          .order("tour_date", { ascending: false })
        break
      }

      case "vendors": {
        // Brokerage-level by nature — a vendor belongs to the tenant, not to one
        // agent. The tenant filter is still session-derived.
        query = supabase
          .from("vendors")
          .select("*")
          .eq("brokerage_id", brokerageId)
          .order("rating", { ascending: false })
        break
      }

      case "communications": {
        // THE FIX. The agent filter is applied UNCONDITIONALLY and first; a
        // caller-supplied contact id may only narrow what is already the
        // caller's own correspondence. The previous shape swapped one for the
        // other, so `?type=communications&contact_id=<any uuid>` returned
        // another brokerage's buyer's message history to any signed-in browser.
        //
        // No tenant column is filtered here on purpose: messages.brokerage_id is
        // NULLABLE (added by migration 030 with no backfill) and at least one
        // live writer — app/actions/ai-auto-response.ts — does not stamp it, so
        // a tenant filter would silently hide the agent's own rows. agent_id is
        // an agents.id resolved from the session and owned by exactly one
        // brokerage, which forecloses the cross-tenant read on its own.
        query = supabase
          .from("messages")
          .select("*, contacts(*)")
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false })
          .limit(100)

        if (contactIdFilter) {
          query = query.eq("contact_id", contactIdFilter)
        }
        break
      }

      default:
        return refuse(400, `Unknown data type: ${dataType}`)
    }

    // THE ONLY READ. `error` is destructured here and nowhere is it optional:
    // a refused query resolves, so without this the endpoint would report an
    // empty book as cheerfully as a denied one — and every table is empty
    // pre-rollout, which is exactly when that lie is hardest to notice.
    const { data: rows, error: readError } = await query

    if (readError) {
      return refuse(502, `Read refused for "${dataType}": ${readError.message}`)
    }

    const data = rows ?? []

    return NextResponse.json({
      success: true,
      data,
      count: Array.isArray(data) ? data.length : 0,
    })
  } catch (error: any) {
    console.error("[Dashboard Data API] Error:", error)
    return refuse(500, error?.message || "Internal server error")
  }
}
