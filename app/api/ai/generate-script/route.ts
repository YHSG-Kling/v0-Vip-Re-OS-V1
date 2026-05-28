import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { generateAIResponse } from "@/lib/ai"

export async function POST(req: Request) {
  // Auth guard — agentId and brokerageId always from session, never from body
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { purpose, persona, contactName, keyPoints } = await req.json()

    const response = await generateAIResponse({
      prompt: `Generate a ${purpose} video script for ${contactName || "a client"} (${persona} persona).

THEM FIRST STRUCTURE (critical):
1. First 40% - Acknowledge their feelings and situation with deep empathy
2. Next 25% - Build trust through relatability and credibility
3. Next 25% - Deliver value (what they'll learn/gain)
4. Final 10% - Briefly mention your solution/services

Key points to include: ${keyPoints || "none"}

Rules:
- NEVER start with "I" or talk about yourself in first 40%
- Focus on THEIR feelings, concerns, hopes
- Write conversationally, like texting a friend
- Keep under 90 seconds (200-250 words)
- Be authentic and empathetic

Generate the script now:`,
      metadata: {
        userId: auth.userId,
        brokerageId: auth.brokerageId,
        feature: "video_script_generation",
      },
    })

    return NextResponse.json({ script: response.text })
  } catch (error: any) {
    console.error("[generate-script] Error:", error)
    return NextResponse.json({ error: "Failed to generate script", details: error.message }, { status: 500 })
  }
}
