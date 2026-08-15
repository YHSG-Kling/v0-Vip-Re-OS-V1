import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { getContactBrief } from "@/lib/contacts/contact-brief"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/contacts/[contactId]/brief
 *
 * Returns the 10-second pre-call/pre-message contact intel.
 * Auth-scoped to the caller's brokerage.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const { contactId } = await params
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { data: row } = await supabase
    .from("contacts")
    .select("id, brokerage_id")
    .eq("id", contactId)
    .maybeSingle()

  if (!row || row.brokerage_id !== auth.brokerageId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const brief = await getContactBrief(contactId)
  if (!brief) return NextResponse.json({ error: "Not found" }, { status: 404 })

  return NextResponse.json(brief)
}
