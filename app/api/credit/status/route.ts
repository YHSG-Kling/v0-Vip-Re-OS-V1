import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { supabaseService } from "@/services/supabaseService"

/**
 * GET /api/credit/status?contactId=<contacts.id>
 * (legacy spelling ?leadId= is still accepted for one release — see below)
 *
 * The ONLY reader of the credit lane (credit_status has no other reader in the
 * tree). Its caller is app/credit-pipeline/page.tsx — the ManageCreditAccountDialog
 * fetches this route when it opens and renders the credit file (score / DTI /
 * last_updated / notes) and the credit-related activity beside the posture form
 * that WRITES contacts.credit_status (lane B, 2026-09-03; the route was 6b —
 * addressed by nothing in the tree — until then). FIXED (lane N3a 2026-09-01,
 * CLAUDE.md §4):
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
    // IDENTITY CLASS (lane W3 2026-09-01, owner ruling: "a file names contact as
    // leadid not contactid"): this value has ALWAYS been a contacts.id — every
    // sink is contacts-class (getContactById reads `contacts`, getCreditStatus's
    // own parameter is named contactId, and credit_status has no lead_id column).
    // The canonical spelling is now ?contactId=. The legacy ?leadId= spelling is
    // accepted for ONE RELEASE because an off-repo caller of this public route
    // cannot be disproved; remove the fallback after that window.
    // WINDOW STATUS (lane B, 2026-09-03): NOT proven closed — the ruling is two
    // days and no tagged release old (`git tag` is empty), and
    // scripts/identity-class-guard.ts:1293-1297 pins this exact fallback as
    // present. Removing it is a guard change outside this lane; the in-tree
    // caller (app/credit-pipeline/page.tsx) already spells ?contactId=.
    const contactId = searchParams.get("contactId") ?? searchParams.get("leadId")

    if (!contactId) {
      return NextResponse.json({ success: false, error: "contactId is required" }, { status: 400 })
    }

    // Tenant-scoped point read — proves the contact belongs to the caller's
    // brokerage before the credit file or activity log is touched.
    const contact = await supabaseService.getContactById(contactId, auth.brokerageId)
    if (!contact) {
      // Fail closed: a foreign, deleted, or unknown id is the same answer.
      return NextResponse.json({ success: false, error: "Contact not found" }, { status: 404 })
    }

    const creditStatus = await supabaseService.getCreditStatus(contactId, auth.brokerageId)
    // Safe only AFTER the tenant check above — getContactActivities itself has
    // no tenant predicate, and the contact has just been proven to be ours.
    const interactionHistory = await supabaseService.getContactActivities(contactId)

    return NextResponse.json({
      success: true,
      // Renamed from `lead:` — the payload is and always was a contacts row.
      contact,
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
