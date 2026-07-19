import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformStaffAuth } from "@/lib/kernel/api-auth"

/**
 * Raw scraped-lead inspection + state updates.
 *
 * ACCESS POLICY (owner): RAW LEADS = PLATFORM ONLY. The raw_scraped_leads
 * bench is platform-owned pre-promotion inventory (mirrors migration 035's
 * platform-only RLS): NO tenant surface or action reads raw records — the
 * promotion pipeline processes them server-side and tenants first see the
 * data as promoted `leads`. This route previously admitted ANY authenticated
 * brokerage user via requireAuth + a service client (RLS bypassed); it is now
 * platform staff (superadmin / support) only. Platform staff may optionally
 * narrow to one brokerage with ?brokerage_id=.
 */

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requirePlatformStaffAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const searchParams = request.nextUrl.searchParams
    const source = searchParams.get("source")
    const status = searchParams.get("status") || "pending"
    const limit = parseInt(searchParams.get("limit") || "100")
    const brokerageId = searchParams.get("brokerage_id")

    const svc = createServiceClient()

    let query = svc
      .from("raw_scraped_leads")
      .select("*")
      .eq("processing_status", status)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (brokerageId) {
      query = query.eq("brokerage_id", brokerageId)
    }

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
  // ACCESS POLICY (owner): RAW LEADS = PLATFORM ONLY — see GET above. State
  // updates on raw rows are a platform-staff repair verb, never a tenant one.
  const supabase = await createClient()
  const auth = await requirePlatformStaffAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()
    const { id, processing_status, error_message } = body

    if (!id) {
      return NextResponse.json({ error: "Missing id parameter" }, { status: 400 })
    }

    const svc = createServiceClient()

    const { data: row } = await svc
      .from("raw_scraped_leads")
      .select("brokerage_id")
      .eq("id", id)
      .maybeSingle()
    if (!row) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (processing_status) updates.processing_status = processing_status
    if (error_message !== undefined) updates.error_message = error_message

    const { data, error } = await svc
      .from("raw_scraped_leads")
      .update(updates)
      .eq("id", id)
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
