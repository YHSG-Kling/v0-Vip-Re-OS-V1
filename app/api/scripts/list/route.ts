import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { createServiceClient } from "@/lib/supabase/service"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status") || undefined

    const svc = createServiceClient()
    let query = svc
      .from("scripts")
      .select("*")
      .eq("created_by", auth.userId)
      .order("created_at", { ascending: false })

    if (status) {
      query = query.eq("status", status)
    }

    const { data: scripts, error } = await query
    if (error) throw error

    return NextResponse.json({
      success: true,
      scripts: scripts || [],
      total: scripts?.length || 0,
    })
  } catch (error: any) {
    console.error("[Scripts List API] Error:", error)
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 },
    )
  }
}
