import { type NextRequest, NextResponse } from "next/server"
import { streamText } from "ai"
import { createServiceClient } from "@/lib/supabase/service"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"

export async function POST(req: NextRequest) {
  try {
    const { sessionId, message, userId, contactId } = await req.json()

    if (!sessionId || !message || !userId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Verify user has access to this session. pass 11: conversations.agent_id
    // FKs agents(id), not users(id) — filtering by the raw userId matched no
    // row so the user could never access their own chat session (always 403).
    const { resolveAgentId } = await import("@/lib/kernel/agent-identity")
    const streamAgentId = (await resolveAgentId(supabase as any, userId)) ?? userId
    const { data: session, error: sessionError } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", sessionId)
      .eq("agent_id", streamAgentId)
      .single()

    if (sessionError || !session) {
      return NextResponse.json({ error: "Session not found or access denied" }, { status: 403 })
    }

    // Get conversation history
    const { data: messages } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(50)

    // Build conversation context
    const conversationHistory = messages
      ?.map((msg) => {
        const role = msg.sender_type === "agent" ? "user" : "model"
        return `${role}: ${msg.body}`
      })
      .join("\n")

    // Get Them-First analysis
    const complianceCheck = await checkThemFirstCompliance(message)

    // Get lead context if available
    let leadContext = ""
    if (contactId) {
      const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).single()

      if (contact) {
        leadContext = `
Lead Context:
- Name: ${contact.first_name} ${contact.last_name}
- Status: ${contact.status || "unknown"}
- Intent: ${contact.intent || "unknown"}
- Last interaction: ${contact.last_contact_date || "never"}
`
      }
    }

    // Create AI prompt with Them-First compliance
    const systemPrompt = `You are a real estate AI assistant helping agents communicate with leads using the "Them-First" approach.

Them-First Rules:
1. Always focus on the client's needs, not the agent's commission
2. Be empathetic and consultative, not pushy
3. Ask questions to understand their situation
4. Provide value and education
5. Build trust through transparency

${leadContext}

Previous conversation:
${conversationHistory}

Agent's current message: ${message}

Them-First Score: ${complianceCheck.score}%
Violations: ${complianceCheck.violations.join(", ") || "None"}
Suggestions: ${complianceCheck.suggestions.join(", ") || "None"}

Generate a response that helps the agent communicate more effectively while maintaining Them-First principles.`

    // Stream AI response using Vercel AI Gateway
    const result = streamText({
      model: "openai/gpt-4o-mini",
      prompt: systemPrompt,
    })

    // Create a readable stream for the response
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let fullResponse = ""

          for await (const chunk of result.textStream) {
            fullResponse += chunk

            // Send chunk to client
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk, done: false })}\n\n`))
          }

          // Save AI suggestion to database
          // ai_suggestions live columns: session_id, suggestion_type, suggestion_content,
          // confidence_score (no message_id/content/them_first_score columns — the
          // them-first score is still returned to the client in the SSE done event below).
          //
          // TENANT — `session.brokerage_id`, i.e. the CONVERSATION this suggestion
          // hangs off, already read and access-checked above with `select("*")`.
          // It is deliberately NOT taken from a session/ctx: this file is a ROUTE
          // handler on a SERVICE client, `userId` arrives in the POST body, and
          // there is no authenticated caller here to derive a tenant from. The
          // parent row is the only source on this path that cannot be forged into
          // a different tenant than the row it is attached to.
          //
          // Unstamped is not merely untidy here: getChatSession in
          // app/actions/ai-chat.ts reads suggestions back with
          // `.eq("brokerage_id", brokerageId)`, and `NULL = <uuid>` is NULL, so
          // every suggestion this streaming route ever wrote was invisible in the
          // chat UI that asked for it. The `ai_suggestions_set_brokerage` BEFORE
          // INSERT trigger (migration 065) could not save it either — it resolves
          // only from agent_id, which this insert does not set.
          const suggestionBrokerageId = (session.brokerage_id as string | null) ?? null
          if (!suggestionBrokerageId) {
            console.error(
              `[v0] conversation ${sessionId} carries no brokerage_id — ai_suggestions row written untenanted and will not be read back`,
            )
          }
          const { error: suggestionError } = await supabase.from("ai_suggestions").insert({
            brokerage_id: suggestionBrokerageId,
            session_id: sessionId,
            suggestion_type: "response",
            suggestion_content: fullResponse,
            confidence_score: 0.9,
          })
          // supabase-js RESOLVES a refused insert; unread, a lost suggestion is
          // indistinguishable from a stored one.
          if (suggestionError) {
            console.error("[v0] ai_suggestions insert failed:", suggestionError.message)
          }

          // Send completion signal
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ text: "", done: true, them_first_score: complianceCheck.score })}\n\n`,
            ),
          )
          controller.close()
        } catch (error) {
          console.error("[v0] Streaming error:", error)
          controller.error(error)
        }
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  } catch (error) {
    console.error("[v0] Stream endpoint error:", error)
    return NextResponse.json({ error: "Failed to stream AI response" }, { status: 500 })
  }
}
