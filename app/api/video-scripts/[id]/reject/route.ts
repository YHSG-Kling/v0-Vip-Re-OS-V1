import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"

const REJECT_ROLES = ["broker", "admin", "superadmin"]

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  if (!REJECT_ROLES.includes(auth.userType)) {
    return NextResponse.json({ error: "Only brokers and admins can reject scripts" }, { status: 403 })
  }

  // Verify the script belongs to the caller's brokerage before mutating
  const svc = createServiceClient()
  const { data: existing } = await svc
    .from("video_scripts_library")
    .select("brokerage_id")
    .eq("id", id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: "Script not found" }, { status: 404 })
  if (existing.brokerage_id !== auth.brokerageId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { error } = await supabase
    .from("video_scripts_library")
    .update({ approval_status: "rejected" })
    .eq("id", id)
    .eq("brokerage_id", auth.brokerageId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
