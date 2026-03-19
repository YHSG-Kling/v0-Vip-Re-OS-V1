import { NextResponse } from "next/server"
import { generateAIResponse } from "@/lib/ai"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function POST(req: Request) {
  const { purpose, persona, contactName, keyPoints } = await req.json()

  // Get actor context for governance
  const agentCtx = await getAgentContext()
  const actorContext = agentCtx
    ? { userId: agentCtx.userId, brokerageId: agentCtx.brokerageId }
    : undefined

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
      userId: actorContext?.userId,
      brokerageId: actorContext?.brokerageId,
      feature: "video_script_generation",
    },
  })

  return NextResponse.json({ script: response.text })
}
