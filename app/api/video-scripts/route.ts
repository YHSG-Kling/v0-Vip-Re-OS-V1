import { NextResponse } from "next/server"
import { createServerClient } from "@/lib/supabase/server"

export async function GET(req: Request) {
  const supabase = await createServerClient()
  const { searchParams } = new URL(req.url)
  const status = searchParams.get("status")

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let query = supabase
    .from("video_scripts")
    .select("*, contact:contacts(*)")
    .eq("agent_id", user.id)
    .order("created_at", { ascending: false })

  if (status) {
    query = query.eq("approval_status", status)
  }

  const { data: scripts, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ scripts })
}

export async function POST(req: Request) {
  const supabase = await createServerClient()
  const body = await req.json()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()

  const { data: script, error } = await supabase
    .from("video_scripts")
    .insert({
      ...body,
      agent_id: user.id,
      brokerage_id: profile?.brokerage_id,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ script })
}
