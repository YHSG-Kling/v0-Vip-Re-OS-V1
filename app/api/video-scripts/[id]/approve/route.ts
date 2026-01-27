import { NextResponse } from "next/server"
import { createServerClient } from "@/lib/supabase/server"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: script, error } = await supabase
    .from("video_scripts")
    .update({
      approval_status: "approved",
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data: video, error: videoError } = await supabase
    .from("video_assets")
    .insert({
      brokerage_id: script.brokerage_id,
      agent_id: user.id,
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
