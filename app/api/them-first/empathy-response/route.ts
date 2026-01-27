import { NextResponse } from "next/server"
import { getEmpathyResponse, getAllEmpathyResponses, listAllPersonas } from "@/lib/them-first/empathy-library"

export async function POST(req: Request) {
  try {
    const { personaId, painPoint } = await req.json()

    if (!personaId) {
      return NextResponse.json({ error: "personaId is required" }, { status: 400 })
    }

    // If no pain point provided, return all responses for persona
    if (!painPoint) {
      const responses = getAllEmpathyResponses(personaId)
      return NextResponse.json({ responses })
    }

    // Get specific empathy response
    const response = getEmpathyResponse(personaId, painPoint)

    if (!response) {
      return NextResponse.json({ error: "No matching empathy response found" }, { status: 404 })
    }

    return NextResponse.json(response)
  } catch (error: any) {
    console.error("[v0] Empathy response error:", error)
    return NextResponse.json({ error: error.message || "Failed to get empathy response" }, { status: 500 })
  }
}

export async function GET() {
  try {
    const personas = listAllPersonas()
    return NextResponse.json({ personas })
  } catch (error: any) {
    console.error("[v0] List personas error:", error)
    return NextResponse.json({ error: error.message || "Failed to list personas" }, { status: 500 })
  }
}
