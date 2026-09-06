import { createClient } from "@/lib/supabase/server"
import {
  createEducationalResource,
} from "@/lib/kernel/education"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const brokerageId = request.nextUrl.searchParams.get("brokerageId")

  if (!brokerageId) {
    return NextResponse.json({ error: "Missing brokerageId" }, { status: 400 })
  }

  try {
    // Post-1042: educational_moments collapsed into learning_modules
    const { data: resources } = await supabase
      .from("learning_modules")
      .select("id, title, summary, body, channels, estimated_minutes, view_count, is_ai_generated, status, published_at, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("status", "published")
      .order("created_at", { ascending: false })

    return NextResponse.json({ resources })
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch resources" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: authData } = await supabase.auth.getUser()

  if (!authData?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await request.json()
    const result = await createEducationalResource(supabase, {
      title: body.title,
      description: body.description,
      contentType: body.contentType,
      content: body.content,
      estimatedMinutes: body.estimatedMinutes,
      createdBy: authData.user.id,
      brokerageId: body.brokerageId,
    })

    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: "Failed to create resource" }, { status: 500 })
  }
}
