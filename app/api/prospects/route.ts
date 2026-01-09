import { type NextRequest, NextResponse } from "next/server"
import { supabase } from "@/services/supabase"

export async function GET(request: NextRequest) {
  try {
    const { data, error } = await supabase
      .from("prospects")
      .select("*, prospect_context(*)")
      .order("created_at", { ascending: false })

    if (error) throw error

    return NextResponse.json(data)
  } catch (error) {
    console.error("[v0] Error fetching prospects:", error)
    return NextResponse.json({ error: "Failed to fetch prospects" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, email, phone } = body

    const { data, error } = await supabase.from("prospects").insert({ name, email, phone }).select().single()

    if (error) throw error

    return NextResponse.json(data)
  } catch (error) {
    console.error("[v0] Error creating prospect:", error)
    return NextResponse.json({ error: "Failed to create prospect" }, { status: 500 })
  }
}
