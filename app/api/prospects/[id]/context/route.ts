import { type NextRequest, NextResponse } from "next/server"
import { supabase } from "@/services/supabase"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    console.error("[v0] Error fetching prospect context:", error)
    return NextResponse.json({ error: "Failed to fetch prospect context" }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    const { emotion, situation, pain_point, timeline, life_context, what_helps } = body

    // Upsert prospect context
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
        {
          onConflict: "prospect_id",
        },
      )
      .select()
      .single()

    if (error) throw error

    return NextResponse.json(data)
  } catch (error) {
    console.error("[v0] Error saving prospect context:", error)
    return NextResponse.json({ error: "Failed to save prospect context" }, { status: 500 })
  }
}
