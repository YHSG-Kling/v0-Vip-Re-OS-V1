import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

// Deliberately unread — the prospect comes from the ROUTE PARAM, the tenant from the
// session. The Request keeps its position because the route context is passed second.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { id } = await params
    const { data, error } = await supabase
      .from("prospect_context")
      .select("*, prospects(*)")
      .eq("prospect_id", id)
      .single()

    if (error) throw error

    return NextResponse.json(data)
  } catch (error) {
    console.error("[prospects] Error fetching prospect context:", error)
    return NextResponse.json({ error: "Failed to fetch prospect context" }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { id } = await params
    const body = await request.json()
    const { emotion, situation, pain_point, timeline, life_context, what_helps } = body

    const { data, error } = await supabase
      .from("prospect_context")
      .upsert(
        {
          prospect_id: id,
          emotion,
          situation,
          pain_point,
          timeline,
          life_context,
          what_helps,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "prospect_id" },
      )
      .select()
      .single()

    if (error) throw error

    return NextResponse.json(data)
  } catch (error) {
    console.error("[prospects] Error saving prospect context:", error)
    return NextResponse.json({ error: "Failed to save prospect context" }, { status: 500 })
  }
}
