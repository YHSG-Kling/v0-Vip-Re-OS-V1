import { createClient } from "@/lib/supabase/server"
import {
  createEducationalResource,
  assignResource,
  getProgressDashboard,
} from "@/lib/kernel/education"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const brokerageId = request.nextUrl.searchParams.get("brokerageId")

  if (!brokerageId) {
    return NextResponse.json({ error: "Missing brokerageId" }, { status: 400 })
  }

  try {
    const { data: resources } = await supabase
      .from("educational_moments")
      .select("*")
      .eq("brokerage_id", brokerageId)

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
