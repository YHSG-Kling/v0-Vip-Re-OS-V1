import { createClient } from "@/lib/supabase/server"
import { generateAIResponse } from "@/lib/ai"
import { NextResponse } from "next/server"
import { requireContactAccess } from "@/lib/portal/require-contact-access"

export async function POST(request: Request) {
  try {
    const { contactId, message, persona, isBuyer, isSeller, conversationHistory } = await request.json()

    // ── AUTHORIZATION (added lane G5 2026-08-28) ──────────────────────────────
    // This handler had NO auth of any kind. It took `contactId` from the request
    // BODY and returned that contact's whole row embedded with their listings,
    // transactions, offers and showing requests — to anyone who could POST to
    // the URL, from any tenant or none, while billing the AI to the platform.
    // A route file is reachable by URL whether or not the app addresses it, so
    // "nothing calls it" was never the mitigation it looked like.
    //
    // The gate is the shared one whose own header says it exists so that portal
    // server actions AND portal API routes "cannot be called for an arbitrary
    // contactId": it admits the contact themselves (linked user id, matching
    // email, or an accepted unexpired invite) and same-brokerage staff, and it
    // FAILS CLOSED on a refused read rather than reporting "not found".
    //
    // It also replaces getAgentContext() for the actor context. That resolves an
    // AGENT identity, and the caller here is normally the CONTACT — so on the
    // ordinary portal turn it produced no actor at all, and the AI governance
    // rails received `undefined`. The gate returns the caller's real users.id
    // and the contact's tenant, which is what the ledger needs to bill.
    if (!contactId || typeof contactId !== "string") {
      return NextResponse.json({ error: "contactId is required" }, { status: 400 })
    }
    const access = await requireContactAccess(contactId)
    if (!access.ok) {
      const status = access.error === "Unauthorized" ? 401
        : access.error === "Contact not found" ? 404
        : access.error === "Forbidden" ? 403
        : 500
      return NextResponse.json({ error: access.error }, { status })
    }
    const actorContext = { userId: access.userId, brokerageId: access.brokerageId }

    const supabase = await createClient()

    // Fetch contact context.
    //
    // TWO AMBIGUOUS PAIRS lived in this one select, and either alone made PostgREST
    // refuse the WHOLE request (PGRST201) — not just the offending embed:
    //   • contacts ↔ listings carries TWO FKs (listings_contact_id_fkey,
    //     listings_seller_contact_id_fkey). Named seller_contact_id: a listing attached
    //     to a portal client is the home THEY are selling, and seller_contact_id is the
    //     column the listing rails actually write (listing-lifecycle-core.ts,
    //     kernel-bridges.ts, present-to-seller.ts); legacy listings.contact_id is unset.
    //   • contacts ↔ transactions carries THREE FKs (contact_id, buyer_contact_id,
    //     seller_contact_id). Named contact_id — the client on the deal, matching how
    //     every other portal page reads a client's deals (see the calendar page's
    //     .eq("contact_id", contactId)); the side-specific links would hide a deal
    //     whenever this client sits on the other side.
    // Because supabase-js RESOLVES the refusal, `contact` was simply null and this
    // route quietly fed the model an EMPTY context block on every single turn — the
    // assistant answered every client as if it knew nothing about them.
    //
    // Embeds now name the columns this route reads (no `select("*")` inside an embed,
    // defect #214). Doing so exposed three phantom reads below, fixed with them:
    // offers.offer_amount → offer_price, showing_requests.confirmed_date →
    // requested_date, and listings.property_address / listings.price, which do not
    // exist at all (the real ones are address / list_price).
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select(`
        *,
        listings!listings_seller_contact_id_fkey (id, address, list_price, status),
        transactions!transactions_contact_id_fkey (id, property_address, status, transaction_milestones (id, milestone_name, status)),
        offers (id, offer_price, status),
        showing_requests (id, status, requested_date),
        saved_properties (id)
      `)
      .eq("id", contactId)
      .single()

    if (contactError) {
      // Check the error: an unchecked read reports a refusal as an absence, which is
      // how the ambiguity above survived. The catch below returns the honest fallback.
      throw contactError
    }

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
          // offers.offer_amount does not exist; offer_price is the canonical column
          // (same rename the seller portal already made).
          contextParts.push(
            `Active Offer: $${activeOffer.offer_price?.toLocaleString()} - Status: ${activeOffer.status}`,
          )
        }
      }

      if (contact.showing_requests?.length > 0) {
        // showing_requests.confirmed_date does not exist — requested_date is the real
        // column, so `new Date(undefined)` was NaN and this filter could never be true.
        const upcomingShowings = contact.showing_requests.filter(
          (s: any) => s.status === "confirmed" && new Date(s.requested_date) > new Date(),
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
        // listings has no property_address / price / asking_price column — address and
        // list_price are the real ones, so the old fallbacks were unreachable.
        contextParts.push(`Listing Address: ${listing.address}`)
        contextParts.push(`Listing Price: $${listing.list_price?.toLocaleString()}`)
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

    // THE ONE ANSWER DECISION (wave 155, lanes 155F / 155F2). This is the portal assistant's live "Something else" door, and
    // it sent the model's text to a client UNSCREENED: a closing date, a lender status or a figure the model made up reached
    // the client as an answer. Now the question is classified first; a deal fact is answered from the tenant's own records
    // or not at all; and a general answer is the model's draft with every figure, date and status it cannot source removed
    // (the client context this route already loaded counts as a source). When the answer is not enough, the responsible
    // agent gets one task — the same decision and the same task the tutor, the home assistant and the widget use.
    let suggestions: string[] = []
    let actions: { label: string; action: string }[] = []
    const qad = await import("@/lib/portal/question-answer-decision")
    const svc = (await import("@/lib/supabase/service")).createServiceClient()
    const question = String(message ?? "")
    const decision = await qad.decidePortalAnswer(svc, {
      brokerageId: access.brokerageId, contactId, question, agentName: null, extraSourceText: contextParts.join("\n"),
      generalAnswer: async () => {
        const raw = (await generateAIResponse({
          prompt: fullPrompt,
          metadata: { userId: actorContext?.userId ?? "", brokerageId: actorContext?.brokerageId, feature: "portal_message" },
        })).text
        // The model appends its follow-up chips as a JSON block. Split it off BEFORE the screen: only the prose is an
        // answer, and a screen that edits prose must not be handed JSON to edit.
        const jsonMatch = raw.match(/\{[\s\S]*"suggestions"[\s\S]*\}/)
        if (!jsonMatch) return raw
        try {
          const parsed = JSON.parse(jsonMatch[0])
          suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((x: unknown) => typeof x === "string").slice(0, 3) : []
          actions = Array.isArray(parsed.actions) ? parsed.actions.filter((x: any) => x && typeof x.label === "string" && typeof x.action === "string").slice(0, 3) : []
        } catch {
          // not parseable — drop the block rather than show a client raw JSON
        }
        return raw.replace(jsonMatch[0], "").trim()
      },
    })
    const responseText = decision.text
    // Follow-up chips belong to a model answer that survived as written. A deterministic, held or refused answer shows none.
    if (decision.modelCalls === 0 || decision.answered !== "sourced") { suggestions = []; actions = [] }
    const { data: assigned, error: assignedError } = await svc.from("contacts").select("agent_id").eq("id", contactId).eq("brokerage_id", access.brokerageId).maybeSingle()
    if (assignedError) console.error("[portal/ai-assistant] the contact's agent could not be read — no task routed:", assignedError.message)
    const ding = await qad.fileQuestionDing(svc, {
      brokerageId: access.brokerageId, contactId, sessionId: null,
      agentId: (assigned as { agent_id?: string | null } | null)?.agent_id ?? null,
      question, decision, surface: "buyer_assistant",
    })
    if (decision.plan.notify && !ding.filed && !ding.deduped && ding.notified === 0) console.error("[portal/ai-assistant] question task not filed:", ding.reason)

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
