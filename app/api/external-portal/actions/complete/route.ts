import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  resolveExternalPartnerIdentity,
  externalPartnerTransactionLane,
  type ExternalPartnerType,
} from "@/lib/kernel/portal-auth"

/**
 * POST /api/external-portal/actions/complete
 * Records that an external partner completed one of their next actions.
 *
 * ── WHAT THIS ROUTE ACTUALLY MUTATES ────────────────────────────────────────
 * One row in `audit_log`. It does not advance a job, a milestone or a document —
 * nothing else in the tree changes when it is called. That is worth stating
 * plainly, because the route's name promises more than it does; the repair below
 * does not invent the missing mutation, it makes the record honest.
 *
 * ── WHY THE `referral_partners` CHECK IS GONE ───────────────────────────────
 * It read `referral_partners` by the caller-supplied `partnerId` + `partnerType`
 * and 403'd when nothing came back. That is the W22-1 defect (the subject came
 * from the request), and it was also checking the WRONG RAIL, which is why it
 * never admitted anybody:
 *   · `referral_partners` is the brokerage's referral CRM — `agent_id` NOT NULL,
 *     tenant-scoped RLS — not a portal identity. Its live
 *     `referral_partners_partner_type_check` admits
 *     real_estate_agent | mortgage_broker | title_company | home_inspector |
 *     contractor | insurance_agent | attorney | property_manager | other,
 *     while this route's only caller (`app/vendor/dashboard/page.tsx`) sends
 *     "vendor". `.eq("partner_type", "vendor")` can never match a row that
 *     exists, so every real portal caller got 403.
 *   · The id it sent is `vendors.id`, and the query compared it to
 *     `referral_partners.id` — different id spaces again.
 *   · Live: `referral_partners` holds 0 rows.
 * The caller's partner identity now comes from the same session rail the rest of
 * the portal uses (`title_company_users` / `user_role_assignments` → `vendors`),
 * which is what `requireVendorActor` / `requireTitleActor` already check.
 *
 * `partnerId` and `partnerType` are no longer read from the body — see the long
 * note in `documents/download/route.ts` for why a cross-check would have been
 * theatre. The existing caller may keep sending them; they are ignored, and the
 * response reports the partner type that was DERIVED.
 *
 * ── HOW THIS ROUTE REFUSES ──────────────────────────────────────────────────
 *   401  no session — the caller is anonymous.
 *   403  a real session that holds no external-partner class, or that is not
 *        attached to the transaction it named.
 *   503  a read was REFUSED (supabase-js resolves refusals; a gate must not
 *        fail open into a denial and hide an outage).
 */
export async function POST(request: NextRequest) {
  try {
    const { actionId, context } = await request.json()

    if (!actionId) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
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
      return NextResponse.json(
        { success: false, error: "Not authorized — your account is not an external partner" },
        { status: 403 }
      )
    }
    const identity = caller.identity

    // The transaction, when one is named, is verified rather than recorded on
    // trust: an audit row asserting a deal the caller has nothing to do with is
    // worse than one with no deal on it at all.
    const claimedTransactionId: string | null =
      typeof context?.transactionId === "string" && context.transactionId ? context.transactionId : null

    let grantedVia: ExternalPartnerType = identity.partnerTypes[0]
    if (claimedTransactionId) {
      const lane = await externalPartnerTransactionLane(supabase, identity, claimedTransactionId)
      if (!lane.ok && lane.reason === "refused") {
        console.error("[external-portal] membership read REFUSED:", lane.detail)
        return NextResponse.json(
          { success: false, error: "Access check unavailable" },
          { status: 503 }
        )
      }
      if (!lane.ok) {
        return NextResponse.json(
          { success: false, error: "Not authorized for this transaction" },
          { status: 403 }
        )
      }
      grantedVia = lane.grantedVia
    }

    // Log action completion to audit_log for compliance tracking.
    //
    // `al_select` is `is_platform_admin() OR (user_id = auth.uid())`, and this
    // insert used to stamp `user_id: null` with the comment "External partner
    // action, not user-initiated". Under the owner ruling that partners ARE auth
    // users that comment was false, and its consequence was that the only record
    // of the action was invisible to the partner who performed it — and to
    // everyone else except a platform admin. The partner's own uid is the honest
    // stamp and the one the policy reads.
    //
    // The write is awaited and its `error` destructured: supabase-js resolves a
    // refused insert, so the previous `.then(…)` pair could report success on a
    // row that was never written.
    const { error: auditError } = await supabase
      .from("audit_log")
      .insert({
        action: "action_completed",
        entity_type: "partner_action",
        entity_id: actionId,
        user_id: identity.userId,
        after: {
          action_id: actionId,
          partner_id: grantedVia === "title" ? identity.userId : identity.vendorId,
          partner_type: grantedVia,
          transaction_id: claimedTransactionId,
          completed_at: new Date().toISOString(),
        },
      })
    if (auditError) {
      // Don't fail the request if audit logging fails — but never silently.
      console.error("[external-portal] audit_log insert REFUSED:", auditError.message)
    }

    return NextResponse.json({ success: true, partnerType: grantedVia })
  } catch (error) {
    console.error("[v0] Error completing action:", error)
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    )
  }
}
