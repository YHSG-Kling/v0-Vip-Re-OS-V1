import { NextRequest, NextResponse } from "next/server"
import { getPortalMessages } from "@/app/actions/portal-messages"

/**
 * GET /api/portal/messages/[contactId]
 * Returns all messages for a contact ordered by created_at ascending.
 *
 * CONSOLIDATED (w6s3). This route used to carry its OWN inline copy of the portal
 * access rules and its own `client_portal_messages` query. That copy had drifted
 * from the shared gate in two directions:
 *   · it recognised a contact only by EMAIL match, so a portal client linked by
 *     `contacts.contact_user_id` with a different login email was refused their own
 *     message thread;
 *   · it admitted only admin/broker/superadmin as staff, so an assigned contact's
 *     team_lead / tc / agent colleague in the same brokerage was refused, while the
 *     shared gate allows them.
 *
 * Survivor: `app/actions/portal-messages.ts:getPortalMessages`, which is the gated
 * (`lib/portal/require-contact-access.ts:requireContactAccess`), brokerage-scoped
 * reader — the exact capability this route duplicated. There is now one gate and one
 * query for portal message history; the SWR poller in
 * `app/portal/[contactId]/messages/messages-client.tsx` keeps its endpoint unchanged.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
) {
  try {
    const { contactId } = await params
    if (!contactId) {
      return NextResponse.json({ error: "Contact ID is required" }, { status: 400 })
    }

    const res = await getPortalMessages(contactId)

    if (!res.success) {
      // requireContactAccess distinguishes these deliberately — a refused read
      // ("Access check failed") must NOT be reported as a clean 404.
      const status =
        res.error === "Unauthorized" ? 401
        : res.error === "Forbidden" ? 403
        : res.error === "Contact not found" ? 404
        : 500
      return NextResponse.json({ error: res.error ?? "Failed to load messages" }, { status })
    }

    return NextResponse.json({ messages: res.messages ?? [] })
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
