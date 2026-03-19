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

    // Verify user has access to this session
    const { data: session, error: sessionError } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", sessionId)
      .eq("agent_id", userId)
      .single()

    if (sessionError || !session) {
      return NextResponse.json({ error: "Session not found or access denied" }, { status: 403 })
    }

    // Get conversation history
    const { data: messages } = await supabase
      .from("messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(50)

    // Build conversation context
    const conversationHistory = messages
      ?.map((msg) => {
        const role = msg.sender_type === "agent" ? "user" : "model"
        return `${role}: ${msg.message}`
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
          await supabase.from("ai_suggestions").insert({
            session_id: sessionId,
            message_id: null, // Will be linked when message is sent
            suggestion_type: "response",
            content: fullResponse,
            them_first_score: complianceCheck.score,
            confidence: 0.9,
          })

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
