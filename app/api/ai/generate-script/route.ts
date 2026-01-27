import { NextResponse } from "next/server"
import { generateText } from "ai"

export async function POST(req: Request) {
  const { purpose, persona, contactName, keyPoints } = await req.json()

  const { text: script } = await generateText({
    model: "openai/gpt-4o-mini",
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
  })

  return NextResponse.json({ script })
}
