import { NextResponse } from "next/server"
import type { InsiderEditNewsletter } from "@/types"

export async function POST(request: Request) {
  try {
    const newsletter = (await request.json()) as InsiderEditNewsletter

    // In production, this would save to database
    // For now, return success with updated timestamp
    const savedNewsletter: InsiderEditNewsletter = {
      ...newsletter,
      status: "ready",
      updatedAt: new Date().toISOString(),
    }

    return NextResponse.json(savedNewsletter)
  } catch (error) {
    console.error("[InsiderEditSave] Error:", error)
    return NextResponse.json({ error: "Failed to save newsletter" }, { status: 500 })
  }
}
