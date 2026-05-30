import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"

const APPROVE_ROLES = ["broker", "admin", "superadmin"]

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  if (!APPROVE_ROLES.includes(auth.userType)) {
    return NextResponse.json({ error: "Only brokers and admins can approve scripts" }, { status: 403 })
  }

  // Verify the script belongs to the caller's brokerage before mutating
  const svc = createServiceClient()
  const { data: existing } = await svc
    .from("video_scripts_library")
    .select("brokerage_id, agent_id")
    .eq("id", id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: "Script not found" }, { status: 404 })
  if (existing.brokerage_id !== auth.brokerageId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { data: script, error } = await supabase
    .from("video_scripts_library")
    .update({
      approval_status: "approved",
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("brokerage_id", auth.brokerageId)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data: video, error: videoError } = await supabase
    .from("video_assets")
    .insert({
      brokerage_id: script.brokerage_id,
      agent_id: existing.agent_id,  // use the script's agent, not the approver
      script,
      status: "queued",
      video_type: script.script_purpose || "custom",
    })
    .select()
    .single()

  if (videoError) {
    return NextResponse.json({ error: videoError.message }, { status: 500 })
  }

  return NextResponse.json({ script, video })
}
