import { NextResponse } from "next/server"
import { createServerClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

export async function GET() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createServerClient()

  const { data: videos, error } = await supabase
    .from("video_assets")
    .select("*, script:video_scripts_library(*)")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ videos })
}
