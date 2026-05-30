import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"

/**
 * Raw scraped-lead inspection + state updates. Was previously open to the
 * world — anyone could enumerate any brokerage's scraped lead inventory by
 * passing a brokerage_id query param, and update any row's processing_status.
 *
 * Now scoped to the caller's brokerage via session-resolved brokerage_id.
 * The body/query value for brokerage_id is ignored (defense against ID
 * substitution).
 */

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const searchParams = request.nextUrl.searchParams
    const source = searchParams.get("source")
    const status = searchParams.get("status") || "pending"
    const limit = parseInt(searchParams.get("limit") || "100")

    const svc = createServiceClient()

    let query = svc
      .from("raw_scraped_leads")
      .select("*")
      .eq("processing_status", status)
      .eq("brokerage_id", auth.brokerageId)  // always scope to caller's brokerage
      .order("created_at", { ascending: false })
      .limit(limit)

    if (source) {
      query = query.eq("source", source)
    }

    const { data, error } = await query

    if (error) {
      console.error("[leads/raw] Error fetching raw leads:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data, count: data.length })
  } catch (error) {
    console.error("[leads/raw] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const { id, processing_status, error_message } = body

    if (!id) {
      return NextResponse.json({ error: "Missing id parameter" }, { status: 400 })
    }

    const svc = createServiceClient()

    // Verify the row belongs to the caller's brokerage before mutating.
    const { data: row } = await svc
      .from("raw_scraped_leads")
      .select("brokerage_id")
      .eq("id", id)
      .maybeSingle()
    if (!row) return NextResponse.json({ error: "Lead not found" }, { status: 404 })
    if (row.brokerage_id !== auth.brokerageId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (processing_status) updates.processing_status = processing_status
    if (error_message !== undefined) updates.error_message = error_message

    const { data, error } = await svc
      .from("raw_scraped_leads")
      .update(updates)
      .eq("id", id)
      .eq("brokerage_id", auth.brokerageId)
      .select()
      .single()

    if (error) {
      console.error("[leads/raw] Error updating raw lead:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (error) {
    console.error("[leads/raw] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
