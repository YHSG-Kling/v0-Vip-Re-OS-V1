import { generateAIResponse } from "@/lib/ai"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export const maxDuration = 30

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response("Unauthorized", { status: 401 })

  // Get actor context for governance
  const agentCtx = await getAgentContext()
  const actorContext = agentCtx
    ? { userId: agentCtx.userId, brokerageId: agentCtx.brokerageId }
    : undefined

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
  // WAVE 155 (lane 155R19): ONE receipt (session user, SESSION tenant) for the coaching draft; the spend stays on the AI cost ledger. A non-2xx answer settles it failed.
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const ledgered = await ledgerSessionAction({ brokerageId: agentCtx.brokerageId ?? "", action: "coaching.insight.generate", actor: { type: "user", userId: user.id }, subject: { type: "user", id: user.id }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async () => { const res = await (async (): Promise<Response> => {

  const response = await generateAIResponse({
    prompt: `You are a real estate sales coach. Analyze this agent's conversation data and provide exactly 3 coaching points as JSON array:
[{"type": "strength"|"improvement"|"action", "title": string, "detail": string}]
Output ONLY valid JSON, no markdown, no explanation.

${prompt}`,
    metadata: {
      userId: user.id,
      brokerageId: actorContext?.brokerageId,
      feature: "coaching_insight",
    },
  })
  const text = response.text

  // Parse and validate the JSON before returning
  let points: { type: string; title: string; detail: string }[]
  try {
    const match = text.match(/\[[\s\S]*\]/)
    points = JSON.parse(match ? match[0] : text)
    if (!Array.isArray(points)) throw new Error("Not an array")
  } catch {
    return Response.json({ error: "Could not parse coaching response" }, { status: 500 })
  }

  return Response.json(points)
  })(); return { success: res.ok, error: res.ok ? undefined : `HTTP ${res.status}`, res } })
  return "res" in ledgered ? ledgered.res : Response.json({ error: ledgered.error ?? "Not recorded" }, { status: 500 })
}
