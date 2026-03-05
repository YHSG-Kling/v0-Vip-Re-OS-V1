import { streamText } from "ai"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export const maxDuration = 30

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response("Unauthorized", { status: 401 })

  const { agentId, agentName, insightData } = await req.json() as {
    agentId: string
    agentName: string
    insightData: {
      avgHealthScore: number
      avgSentimentScore: number
      topObjections: string[]
      topBuyingSignals: string[]
      avgResponseTime: number
      teamAvgResponseTime: number
      unansweredCount: number
    }
  }

  const prompt = `Agent: ${agentName}
Avg Health Score: ${insightData.avgHealthScore}%
Avg Sentiment Score: ${insightData.avgSentimentScore}/100
Top Objections Raised: ${insightData.topObjections.join(", ") || "none"}
Top Buying Signals: ${insightData.topBuyingSignals.join(", ") || "none"}
Avg Response Time: ${insightData.avgResponseTime}s (Team avg: ${insightData.teamAvgResponseTime}s)
Unanswered Questions: ${insightData.unansweredCount}`

  const result = streamText({
    model: "anthropic/claude-sonnet-4-20250514",
    system: `You are a real estate sales coach. Analyze this agent's conversation data and provide exactly 3 coaching points as JSON array:
[{"type": "strength"|"improvement"|"action", "title": string, "detail": string}]
Output ONLY valid JSON, no markdown, no explanation.`,
    messages: [{ role: "user", content: prompt }],
  })

  return result.toUIMessageStreamResponse()
}
