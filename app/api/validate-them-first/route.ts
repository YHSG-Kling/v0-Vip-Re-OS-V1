import { NextResponse } from "next/server"
import { validateThemFirstContent } from "@/lib/them-first"

export async function POST(req: Request) {
  try {
    const { content, contentType, personaId } = await req.json()

    if (!content || content.length < 10) {
      return NextResponse.json({ error: "Content too short to validate (minimum 10 characters)" }, { status: 400 })
    }

    const validation = await validateThemFirstContent(content, contentType, personaId)

    return NextResponse.json(validation)
  } catch (error: any) {
    console.error("[v0] Them First validation error:", error)
    return NextResponse.json({ error: error.message || "Validation failed" }, { status: 500 })
  }
}
