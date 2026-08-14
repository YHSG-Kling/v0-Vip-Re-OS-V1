// POST /api/chat/stream
//
// THE PRIVATE (AGENT) CHAT LANE — and only that lane.
//
// This route reads `conversations` / `messages` / `ai_suggestions`, which are
// the AUTHENTICATED agent-coaching tables written by app/actions/ai-chat.ts.
// The PUBLIC website-visitor lane is a different route on different tables:
// app/api/widget/message reads `chat_sessions` / `chat_messages` and carries its
// own credential (`chat_sessions.widget_session_token`, minted server-side by
// app/api/widget/session). Nothing public has ever pointed here, so this route
// is now authenticated outright rather than growing a second token system for a
// lane that already has one somewhere else.
//
// WHAT CHANGED AND WHY (task #178 called this an IDOR — it was two of them):
//
//   1. IDENTITY CAME FROM THE REQUEST BODY. The POST body carried `userId`, the
//      route resolved an agents.id from it and then checked the conversation
//      against THAT agent. That authorizes the session against the CLAIMED user,
//      never the caller against the session — anyone holding a conversation id
//      could pass the matching userId and stream another tenant's thread plus
//      the 50 messages of history the prompt embeds. `userId` is no longer an
//      input at all: the tenant comes from `getAgentContext()` (which also
//      carries the platform-staff act-as seam), and the conversation read is
//      anchored to it exactly as `getChatSession` in app/actions/ai-chat.ts is.
//
//   2. `contactId` WAS AN UNSCOPED READ OF ANY CONTACT. `select("*").eq("id",
//      contactId)` on a service client, with the name/status injected into the
//      system prompt and echoed back by the model — a cross-tenant contact-PII
//      read that needed no session id whatsoever. The read is now scoped by the
//      resolved brokerage, so a foreign contact id finds nothing.
//
// The service client is gone from every authorization read: those now run as the
// CALLER, so RLS is a real backstop instead of being bypassed (it also narrows an
// `agent` user to their own contacts for free, via agent_read_own_contacts). The
// only service-client use left is the post-stream suggestion insert, which runs
// after the response body has started and therefore outside the request's cookie
// context — the same reason app/api/widget/message and app/api/internal/ai-chat
// use a service client in their `onFinish`.
//
// NOTE on the tenant filters below: `conversations_tenant_select` is
// `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())`, so an
// UNSTAMPED conversation is readable by every tenant. The explicit
// `.eq("brokerage_id", …)` is what excludes it, and excluding is the right
// direction here — an untenanted conversation belongs to no one.

import { type NextRequest, NextResponse } from "next/server"
import { streamText } from "ai"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveModel } from "@/lib/ai/resolve-model"
import { redactSensitive } from "@/lib/data-guard"
import { checkAIFairUse } from "@/lib/ai/fair-use"
import { estimateTokens } from "@/lib/ai/cost-tracking"
import { isValidUUID } from "@/lib/validations"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"

export async function POST(req: NextRequest) {
  try {
    const { sessionId, message, contactId } = await req.json()

    if (!sessionId || !message) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }
    if (!isValidUUID(sessionId)) {
      return NextResponse.json({ error: "Invalid session id" }, { status: 400 })
    }
    if (contactId && !isValidUUID(contactId)) {
      return NextResponse.json({ error: "Invalid contact id" }, { status: 400 })
    }

    // THE TENANT, FROM THE SESSION. Never from the body — see header.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const supabase = await createClient()

    // Verify the caller's own tenant owns this conversation. Scoped by the
    // resolved brokerage rather than by an agent id so a conversation shared
    // through message_access_control stays reachable — the same gate
    // getChatSession/sendChatMessage apply.
    const { data: session, error: sessionError } = await supabase
      .from("conversations")
      .select("id, brokerage_id, contact_id")
      .eq("id", sessionId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    // supabase-js RESOLVES a refused read, so a denial arrives as `data: null`
    // with an error rather than a throw. A refusal is not the same answer as
    // "no such conversation" — say so instead of laundering it into a 403.
    if (sessionError) {
      console.error("[v0] chat stream session lookup failed:", sessionError.message)
      return NextResponse.json({ error: "Could not verify session access" }, { status: 500 })
    }
    if (!session) {
      return NextResponse.json({ error: "Session not found or access denied" }, { status: 403 })
    }

    // Get conversation history. Already tenant-anchored: the conversation this
    // filters on was just proven to belong to the caller's brokerage, and the
    // read runs under the caller's own RLS.
    const { data: messages, error: messagesError } = await supabase
      .from("messages")
      .select("sender_type, body")
      .eq("conversation_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(50)

    if (messagesError) {
      console.error("[v0] chat stream history read failed:", messagesError.message)
      return NextResponse.json({ error: "Could not load conversation history" }, { status: 500 })
    }

    // Build conversation context
    const conversationHistory = messages
      ?.map((msg) => {
        const role = msg.sender_type === "agent" ? "user" : "model"
        return `${role}: ${msg.body}`
      })
      .join("\n")

    // Get Them-First analysis
    const complianceCheck = await checkThemFirstCompliance(message)

    // Get lead context if available.
    //
    // SCOPED BY THE RESOLVED TENANT, not by the caller-supplied id alone — a
    // foreign contact id finds nothing rather than being read and narrated into
    // the prompt. An explicit column list rather than `select("*")` for the same
    // reason: only what the prompt actually uses leaves the database.
    //
    // `intent` and `last_contact_date` were read here and DO NOT EXIST on
    // contacts (verified live) — `select("*")` made that undetectable, so the
    // prompt printed "Intent: unknown / Last interaction: never" for every lead
    // that had both. The real columns are intent_score and last_contacted_at.
    let leadContext = ""
    if (contactId) {
      const { data: contact, error: contactError } = await supabase
        .from("contacts")
        .select("first_name, last_name, status, intent_score, last_contacted_at")
        .eq("id", contactId)
        .eq("brokerage_id", ctx.brokerageId)
        .maybeSingle()

      if (contactError) {
        console.error("[v0] chat stream contact read failed:", contactError.message)
        return NextResponse.json({ error: "Could not load lead context" }, { status: 500 })
      }

      if (contact) {
        leadContext = `
Lead Context:
- Name: ${contact.first_name} ${contact.last_name}
- Status: ${contact.status || "unknown"}
- Intent score: ${contact.intent_score ?? "unknown"}
- Last interaction: ${contact.last_contacted_at || "never"}
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

    // Data Guard — the prompt above carries contact PII and up to 50 messages of
    // agent↔client history, so high-confidence secrets (SSN, EIN, card PAN, bank
    // account) get redacted before anything leaves for the model. Same scrub the
    // lib/ai chokepoints apply; done here because the streaming path has no
    // routed equivalent to inherit it from.
    const safeSystemPrompt = redactSensitive(systemPrompt).text

    // Fair-use pre-flight — this endpoint burns subscription-included AI tokens
    // on every call, so trip BEFORE the call rather than after the counter has
    // already exceeded. Fails OPEN on error by design.
    const fairUse = await checkAIFairUse({
      brokerageId: ctx.brokerageId,
      addTokens: estimateTokens(safeSystemPrompt) + 1000,
    })
    if (!fairUse.allowed) {
      return NextResponse.json(
        { error: fairUse.message ?? "AI fair-use limit reached for this billing period." },
        { status: 429 },
      )
    }

    // Stream AI response using Vercel AI Gateway
    const result = streamText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: safeSystemPrompt,
    })

    // The tenant anchor for the deferred write, captured here while the request
    // context still exists.
    const suggestionBrokerageId = ctx.brokerageId
    const suggestionAgentId = ctx.agentId

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
          // TENANT — the caller's own brokerage, resolved from the session above
          // and proven to own this conversation. It used to be read off
          // `session.brokerage_id` because "there is no authenticated caller
          // here"; there is one now, and it cannot be forged into another tenant.
          // The conversation read is `.eq("brokerage_id", …)`, so this is never
          // NULL and the row can no longer be written untenanted — which
          // mattered, because getChatSession reads suggestions back with
          // `.eq("brokerage_id", brokerageId)` and `NULL = <uuid>` is NULL, so
          // every unstamped suggestion was invisible in the chat UI that asked
          // for it. agent_id is stamped for the same reason: the
          // ai_suggestions_select policy has an `agent_id = current_user_agent_id()`
          // clause that an unstamped row can never satisfy.
          //
          // SERVICE CLIENT, deliberately: this runs after the response body has
          // started, outside the request's cookie context, so a session client
          // cannot authenticate here. The row's tenant is fixed above, not
          // derived from anything the stream can see.
          const service = createServiceClient()
          const { error: suggestionError } = await service.from("ai_suggestions").insert({
            brokerage_id: suggestionBrokerageId,
            agent_id: suggestionAgentId,
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
