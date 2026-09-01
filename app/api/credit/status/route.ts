import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { supabaseService } from "@/services/supabaseService"

/**
 * GET /api/credit/status?leadId=<contacts.id>
 *
 * The ONLY reader of the credit lane (credit_status has no other reader in the
 * tree). KEPT for that reason — building this route a caller is another lane's
 * item — and FIXED (lane N3a 2026-09-01, CLAUDE.md §4):
 *
 * The query-string leadId used to flow straight into SERVICE-ROLE reads
 * (getContactById / getCreditStatus) with no brokerage predicate, so any
 * authenticated agent could read any tenant's contact + credit file by id.
 * The tenant now comes from the SESSION via requireAuth (which fails closed on
 * a user with no brokerage), both service reads REQUIRE that tenant, and the
 * activity read only runs after the contact is proven to be this tenant's —
 * a foreign id 404s before anything else is read.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response
    if (!auth.agentId) {
      return NextResponse.json({ success: false, error: "Agent profile not found" }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const leadId = searchParams.get("leadId")

    if (!leadId) {
      return NextResponse.json({ success: false, error: "leadId is required" }, { status: 400 })
    }

    // Tenant-scoped point read — proves the contact belongs to the caller's
    // brokerage before the credit file or activity log is touched.
    const contact = await supabaseService.getContactById(leadId, auth.brokerageId)
    if (!contact) {
      // Fail closed: a foreign, deleted, or unknown id is the same answer.
      return NextResponse.json({ success: false, error: "Contact not found" }, { status: 404 })
    }

    const creditStatus = await supabaseService.getCreditStatus(leadId, auth.brokerageId)
    // Safe only AFTER the tenant check above — getContactActivities itself has
    // no tenant predicate, and the contact has just been proven to be ours.
    const interactionHistory = await supabaseService.getContactActivities(leadId)

    return NextResponse.json({
      success: true,
      lead: contact,
      creditStatus,
      // `activity_type` on the live activities table — the old `interaction_type` came
      // from a table that never existed, so this filter could only ever match nothing.
      creditLog: interactionHistory.filter((i: { activity_type?: string | null }) => i.activity_type === "credit-related"),
    })
  } catch (error: any) {
    console.error("[v0] Error fetching credit status:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
