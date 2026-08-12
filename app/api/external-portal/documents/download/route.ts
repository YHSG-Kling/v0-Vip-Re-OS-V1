import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  resolveExternalPartnerIdentity,
  externalPartnerTransactionLane,
  type ExternalPartnerType,
} from "@/lib/kernel/portal-auth"

/**
 * GET /api/external-portal/documents/download?docId=…
 * Hands an external partner (title / lender) the storage URL of a document on a
 * transaction they are attached to.
 *
 * ── WHAT CHANGED, AND WHY `partnerId` AND `partnerType` ARE GONE ─────────────
 *
 * This route used to read `partnerId` and `partnerType` from the query string
 * and use them as the authorization SUBJECT: for `title` it asked
 * `title_company_users.user_id = $partnerId AND transaction_id = …`, for
 * `lender` it resolved `lenderVendorForUser(supabase, $partnerId)` and looked
 * for a `vendor_assignments` row. Both questions are "does the partner named in
 * the URL have access" — never "is the caller that partner". The file contained
 * no `getUser()` call at all, so the caller's own identity was never consulted.
 *
 * Measured live (rolled back), with `set local role authenticated` and each
 * caller's real jwt claims:
 *   · an ordinary agent naming a DIFFERENT user's title row on the same
 *     brokerage satisfied the old membership read — 1 row — and could read the
 *     document, so the route returned `storage_url`;
 *   · under `user_id = auth.uid()` that same caller gets 0, and the real title
 *     partner still gets 1.
 * On the lender lane the same agent gets 0 (user_role_assignments' self policy),
 * but a same-brokerage ADMIN naming the lender's user id gets 1 — the same
 * bypass, one role higher.
 *
 * `partnerId` is REMOVED rather than kept as a cross-check. The ids this route's
 * own UI sends are `vendors.id` (both the vendor and the title dashboard pass
 * one), while the checks compared them to `title_company_users.user_id` and
 * `user_role_assignments.user_id` — different id spaces, so a cross-check would
 * have refused every legitimate title caller while adding no security to the
 * session-derived subject. Leaving a parameter that looks authoritative and is
 * not is exactly the defect being repaired.
 *
 * `partnerType` is REMOVED for the same reason: it CHOSE THE BRANCH, so a
 * caller who is a vendor could take the `title` branch by asking for it. The
 * lanes now come from the classes the session actually holds, and the lane that
 * granted access is what gets reported back and stamped in the audit row.
 *
 * ── HOW THIS ROUTE REFUSES ───────────────────────────────────────────────────
 *   401  no session / invalid session — the caller is anonymous.
 *   404  authenticated, but this caller is not attached to that document
 *        (including "no such document"). Deliberately indistinguishable, so the
 *        route is not a document-existence oracle.
 *   503  a read was REFUSED. supabase-js RESOLVES a refused query, so treating
 *        one as an empty result would turn an outage into a clean 404 — an
 *        authorization gate failing OPEN INTO A DENIAL, which looks fine
 *        forever. Fails closed, and says which kind of closed.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const docId = searchParams.get("docId")

    if (!docId) {
      return NextResponse.json(
        { success: false, error: "Missing required parameter: docId" },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    // ── WHO IS ASKING ────────────────────────────────────────────────────────
    // The authorization subject. It comes from the session and nowhere else.
    const caller = await resolveExternalPartnerIdentity(supabase)
    if (!caller.ok) {
      if (caller.reason === "unauthenticated") {
        return NextResponse.json(
          { success: false, error: "Authentication required" },
          { status: 401 }
        )
      }
      if (caller.reason === "refused") {
        console.error("[external-portal] partner identity read REFUSED:", caller.detail)
        return NextResponse.json(
          { success: false, error: "Access check unavailable" },
          { status: 503 }
        )
      }
      // A real session that holds no partner class — same answer as "not your
      // document", on purpose.
      return NextResponse.json(
        { success: false, error: "Document not found or access denied" },
        { status: 404 }
      )
    }
    const identity = caller.identity

    // documents has no name/file_url/partner_id/partner_type columns. Real cols are
    // document_type/storage_url; partner access is scoped via the document's transaction
    // membership (title_company_users / vendor_assignments), NOT a column on documents.
    // `.maybeSingle()`, not `.single()`: single() turns "no such row" into an ERROR,
    // which the refusal branch below would then report as an outage.
    const { data: document, error: docError } = await supabase
      .from("documents")
      .select("id, document_type, storage_url, transaction_id, brokerage_id, created_at")
      .eq("id", docId)
      .maybeSingle()

    if (docError) {
      console.error("[external-portal] document read REFUSED:", docError.message)
      return NextResponse.json(
        { success: false, error: "Access check unavailable" },
        { status: 503 }
      )
    }
    if (!document) {
      return NextResponse.json(
        { success: false, error: "Document not found or access denied" },
        { status: 404 }
      )
    }

    // Partner scoping: confirm the CALLER is attached to the document's transaction.
    if (!document.transaction_id) {
      // vendor downloads are not modeled via documents.transaction_id — deny by default.
      return NextResponse.json(
        { success: false, error: "Document not found or access denied" },
        { status: 404 }
      )
    }

    // Only the lanes the caller genuinely holds are tried, and each is keyed on
    // the caller's own identity. `grantedVia` is the DERIVED partner type.
    const lane = await externalPartnerTransactionLane(supabase, identity, document.transaction_id)
    if (!lane.ok && lane.reason === "refused") {
      console.error("[external-portal] membership read REFUSED:", lane.detail)
      return NextResponse.json(
        { success: false, error: "Access check unavailable" },
        { status: 503 }
      )
    }
    if (!lane.ok) {
      return NextResponse.json(
        { success: false, error: "Document not found or access denied" },
        { status: 404 }
      )
    }
    const grantedVia: ExternalPartnerType = lane.grantedVia

    // Log download for audit trail.
    //
    // dd_select is `is_platform_admin() OR has_brokerage_access(brokerage_id) OR
    // (user_id = auth.uid())`, and this insert used to stamp only partner_id /
    // partner_type — so the row recording the download was readable by NOBODY
    // but a platform admin. Proven live: the old shape returned 0 rows to its own
    // writer; stamping user_id + brokerage_id returned 1.
    //   · user_id      — the human who downloaded (the auth.uid() lane).
    //   · brokerage_id — the DOCUMENT's tenant, so the brokerage whose document
    //                    left the building can see that it did (the
    //                    has_brokerage_access lane).
    //   · partner_id   — the subject the membership check actually used: the
    //                    caller's user id on the title lane, their vendors.id on
    //                    the lender lane.
    const { error: auditError } = await supabase.from("document_downloads").insert({
      document_id: docId,
      brokerage_id: document.brokerage_id ?? identity.brokerageId,
      user_id: identity.userId,
      partner_id: grantedVia === "lender" ? identity.vendorId : identity.userId,
      partner_type: grantedVia,
      downloaded_at: new Date().toISOString(),
    })
    if (auditError) {
      // Not fatal to the download, but never silent: an unwritten audit row is a
      // download nobody can account for.
      console.error("[external-portal] document_downloads audit insert REFUSED:", auditError.message)
    }

    if (!document.storage_url) {
      return NextResponse.json(
        { success: false, error: "Document file URL not available" },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      partnerType: grantedVia,
      document: {
        id: document.id,
        name: document.document_type,
        fileUrl: document.storage_url,
        downloadedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    console.error("[v0] Error downloading document:", error)
    return NextResponse.json(
      { success: false, error: "Failed to download document" },
      { status: 500 }
    )
  }
}
