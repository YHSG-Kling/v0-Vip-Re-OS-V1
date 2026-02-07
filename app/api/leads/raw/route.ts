import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const brokerage_id = searchParams.get("brokerage_id")
    const source = searchParams.get("source")
    const status = searchParams.get("status") || "pending"
    const limit = parseInt(searchParams.get("limit") || "100")

    const supabase = createServiceClient()

    let query = supabase
      .from("raw_scraped_leads")
      .select("*")
      .eq("processing_status", status)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (brokerage_id) {
      query = query.eq("brokerage_id", brokerage_id)
    }

    if (source) {
      query = query.eq("source", source)
    }

    const { data, error } = await query

    if (error) {
      console.error("[v0] Error fetching raw leads:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data, count: data.length })
  } catch (error) {
    console.error("[v0] Unexpected error in raw leads API:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, processing_status, error_message } = body

    if (!id) {
      return NextResponse.json(
        { error: "Missing id parameter" },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const updates: any = { updated_at: new Date().toISOString() }
    if (processing_status) updates.processing_status = processing_status
    if (error_message !== undefined) updates.error_message = error_message

    const { data, error } = await supabase
      .from("raw_scraped_leads")
      .update(updates)
      .eq("id", id)
      .select()
      .single()

    if (error) {
      console.error("[v0] Error updating raw lead:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error("[v0] Unexpected error in raw leads update:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
