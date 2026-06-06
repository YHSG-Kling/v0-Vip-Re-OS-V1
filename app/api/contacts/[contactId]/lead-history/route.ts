import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export const dynamic = "force-dynamic"

// GET /api/contacts/[contactId]/lead-history
//
// Returns lead-lineage rows for a contact via the contact_lead_history
// view (migration 039). The view is SECURITY INVOKER, so RLS on the
// underlying `contacts` table gates visibility: agents see only the
// lineage of contacts assigned to them; brokers see brokerage scope;
// platform admin sees everything. Direct reads of the `leads` table
// remain restricted by migration 034.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { contactId } = await params

  const { data, error } = await supabase
    .from("contact_lead_history")
    .select("*")
    .eq("contact_id", contactId)
    .order("lead_created_at", { ascending: false })

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, history: data ?? [] })
}
