import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

// TOMBSTONE — this handler took the framework's Request object and read NOTHING
// from it: no query string, no body, no header. Every input it uses comes from the
// SESSION (CLAUDE.md §4 — the tenant is never a request field). A route handler
// may be declared with no parameters at all, and leaving an unread `request` in the
// signature advertises a filter this endpoint does not honour.
export async function GET() {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { data, error } = await supabase
      .from("prospects")
      .select("*, prospect_context(*)")
      .eq("brokerage_id", auth.brokerageId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return NextResponse.json(data)
  } catch (error) {
    console.error("[prospects] Error fetching prospects:", error)
    return NextResponse.json({ error: "Failed to fetch prospects" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const { name, email, phone } = body

    const { data, error } = await supabase
      .from("prospects")
      .insert({ name, email, phone, brokerage_id: auth.brokerageId })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json(data)
  } catch (error) {
    console.error("[prospects] Error creating prospect:", error)
    return NextResponse.json({ error: "Failed to create prospect" }, { status: 500 })
  }
}
