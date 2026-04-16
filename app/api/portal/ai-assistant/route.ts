import { createClient } from "@/lib/supabase/server"
import { generateAIResponse } from "@/lib/ai"
import { NextResponse } from "next/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function POST(request: Request) {
  try {
    const { contactId, message, persona, isBuyer, isSeller, conversationHistory } = await request.json()
    
    // Get actor context for governance
    const agentCtx = await getAgentContext()
    const actorContext = agentCtx
      ? { userId: agentCtx.userId, brokerageId: agentCtx.brokerageId }
      : undefined

    const supabase = await createClient()

    // Fetch contact context
    const { data: contact } = await supabase
      .from("contacts")
      .select(`
        *,
        listings (*),
        transactions (*, transaction_milestones (*)),
        offers (*),
        showing_requests (*),
        saved_properties (*)
      `)
      .eq("id", contactId)
      .single()

    // Build context for AI
    const contextParts: string[] = []

    if (contact) {
      contextParts.push(`Client Name: ${contact.first_name || contact.name}`)
      contextParts.push(`Client Type: ${isBuyer ? "Buyer" : isSeller ? "Seller" : "Both"}`)
      contextParts.push(`Persona: ${persona}`)

      if (contact.transactions?.length > 0) {
        const activeTx = contact.transactions[0]
        contextParts.push(`Active Transaction: ${activeTx.property_address || "In Progress"}`)
        contextParts.push(`Transaction Status: ${activeTx.status}`)

        const pendingMilestones = activeTx.transaction_milestones?.filter((m: any) => m.status === "pending") || []
        if (pendingMilestones.length > 0) {
          contextParts.push(
            `Next Milestones: ${pendingMilestones
              .slice(0, 3)
              .map((m: any) => m.milestone_name)
              .join(", ")}`,
          )
        }
      }

      if (contact.offers?.length > 0) {
        const activeOffer = contact.offers.find((o: any) => o.status !== "closed" && o.status !== "rejected")
        if (activeOffer) {
          contextParts.push(
            `Active Offer: $${activeOffer.offer_amount?.toLocaleString()} - Status: ${activeOffer.status}`,
          )
        }
      }

      if (contact.showing_requests?.length > 0) {
        const upcomingShowings = contact.showing_requests.filter(
          (s: any) => s.status === "confirmed" && new Date(s.confirmed_date) > new Date(),
        )
        if (upcomingShowings.length > 0) {
          contextParts.push(`Upcoming Showings: ${upcomingShowings.length}`)
        }
      }

      if (contact.saved_properties?.length > 0) {
        contextParts.push(`Saved Properties: ${contact.saved_properties.length}`)
      }

      if (contact.listings?.length > 0) {
        const listing = contact.listings[0]
        contextParts.push(`Listing Address: ${listing.address || listing.property_address}`)
        contextParts.push(
          `Listing Price: $${listing.price?.toLocaleString() || listing.asking_price?.toLocaleString()}`,
        )
        contextParts.push(`Listing Status: ${listing.status}`)
      }
    }

    // Build persona-specific instructions
    const personaInstructions: Record<string, string> = {
      first_time_buyer: `This is a first-time home buyer who may not know real estate terminology. Explain things simply, be encouraging, and proactively offer to explain any terms you use. Be patient and supportive.`,
      military_buyer: `This client is active military or a veteran. Be respectful of their service, knowledgeable about VA loans, BAH, PCS moves, and military-specific benefits. Use appropriate terminology.`,
      luxury_buyer: `This is a luxury property buyer. Maintain a sophisticated, professional tone. Focus on exclusivity, privacy, investment value, and premium amenities. Be concise and respectful of their time.`,
      investor: `This is a real estate investor. Focus on numbers, ROI, cap rates, cash flow, and market data. Be analytical and provide data-driven insights.`,
      divorce: `This client is going through a divorce. Be extremely sensitive, neutral, and professional. Never take sides. Focus on logistics and process. Maintain strict confidentiality.`,
      probate: `This client is handling an estate/probate sale. Be compassionate and patient. They may be grieving. Explain probate-specific requirements clearly but gently.`,
      senior: `This is a senior client. Use clear, simple language. Be patient and thorough. Offer to explain things multiple times if needed. Be warm and reassuring.`,
      default: `Be helpful, professional, and friendly. Focus on the client's needs and provide clear, actionable information.`,
    }

    const systemPrompt = `You are a helpful AI real estate assistant for a client portal. You help clients understand their home buying/selling journey, answer questions, and guide them through the process.

CONTEXT ABOUT THIS CLIENT:
${contextParts.join("\n")}

PERSONA-SPECIFIC INSTRUCTIONS:
${personaInstructions[persona] || personaInstructions.default}

IMPORTANT GUIDELINES:
1. Be warm, helpful, and professional
2. Use "you" and "your" extensively - focus on THEIR needs
3. If you don't know something specific about their transaction, acknowledge it and suggest they check their dashboard or contact their agent
4. Provide actionable next steps when possible
5. Keep responses concise but complete (2-4 sentences for simple questions, more for complex explanations)
6. If they ask about something you can help navigate to, include a suggestion to visit that section
7. Never make up specific dates, prices, or details - refer to what's in the context or suggest they check their dashboard
8. Be encouraging and supportive - buying/selling a home is stressful!

RESPONSE FORMAT:
Respond naturally in a conversational tone. At the end, you may suggest 2-3 follow-up questions they might have (format as a JSON array called "suggestions") and any relevant navigation actions (format as a JSON array called "actions" with objects containing "label" and "action" keys).

Example response format:
Your answer here...

{"suggestions": ["Question 1?", "Question 2?"], "actions": [{"label": "View Dashboard", "action": "dashboard"}]}`

    // Build the full prompt with system context and conversation history
    const fullPrompt = `${systemPrompt}

Previous conversation:
${conversationHistory.map((m: any) => `${m.role}: ${m.content}`).join("\n")}

User: ${message}

Please respond as the AI assistant.`

    const response = await generateAIResponse({
      prompt: fullPrompt,
      metadata: {
        userId: actorContext?.userId ?? "",
        brokerageId: actorContext?.brokerageId,
        feature: "portal_message",
      },
    })
    const text = response.text

    // Parse response for suggestions and actions
    let responseText = text
    let suggestions: string[] = []
    let actions: { label: string; action: string }[] = []

    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*"suggestions"[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        suggestions = parsed.suggestions || []
        actions = parsed.actions || []
        responseText = text.replace(jsonMatch[0], "").trim()
      } catch {
        // JSON parsing failed, use text as-is
      }
    }

    return NextResponse.json({
      response: responseText,
      suggestions,
      actions,
    })
  } catch (error) {
    console.error("Portal AI Assistant error:", error)
    return NextResponse.json(
      {
        response: "I apologize, but I'm having trouble right now. Please try again or contact your agent directly.",
        suggestions: ["Contact my agent", "View my dashboard"],
        actions: [{ label: "Go to Dashboard", action: "dashboard" }],
      },
      { status: 200 },
    )
  }
}
