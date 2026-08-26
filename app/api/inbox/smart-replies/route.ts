import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { generateSmartReplies } from "@/lib/inbox/smart-replies"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/inbox/smart-replies
 * Body: { inboundBody, channel, contactId?, recentThread? }
 *
 * Returns three quick-reply suggestions tuned to the channel.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const body = await req.json().catch(() => ({}))
  const inboundBody = String(body?.inboundBody ?? "").trim()
  if (!inboundBody) {
    return NextResponse.json({ error: "inboundBody required" }, { status: 400 })
  }
  const channel = ["sms", "email", "in_app", "portal"].includes(body?.channel)
    ? body.channel
    : "sms"

  let contactName: string | null = null
  let contactType: string | null = null
  if (body?.contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, contact_type, brokerage_id")
      .eq("id", body.contactId)
      .maybeSingle()
    if (contact && contact.brokerage_id === auth.brokerageId) {
      contactName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || null
      contactType = contact.contact_type ?? null
    }
  }

  // generateSmartReplies now also reports what the call SPENT (SmartReplyUsage)
  // so callers that keep their own ledger have a real figure instead of a
  // guess. This route does not ledger, so it takes the replies only.
  const { replies } = await generateSmartReplies({
    inboundBody,
    channel,
    contactName,
    contactType,
    recentThread: Array.isArray(body?.recentThread) ? body.recentThread : undefined,
    // §4 — from requireAuth, never from `body`. This route keeps no ledger of
    // its own, so the routed lane is the single writer for this call.
    brokerageId: auth.brokerageId,
    userId: auth.userId,
  })

  return NextResponse.json({ replies })
}
