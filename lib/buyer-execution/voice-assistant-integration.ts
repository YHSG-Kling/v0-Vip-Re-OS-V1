/**
 * System 5.1: Voice Assistant Integration for Buyer Execution
 * 
 * Enables voice assistant to:
 * - Answer "What's next?" queries
 * - Explain journey progress
 * - Help configure search
 * - Schedule tours (with gate enforcement)
 * - Provide buyer-friendly guidance
 * 
 * CRITICAL: Voice assistant MUST call execution logic and enforce ALL gates
 */

import { getBuyerJourneyStatus, enforceFinancialGate, getBuyerFriendlyMessage, logBuyerExecutionEvent, type BuyerExecutionContext } from './buyer-execution-engine'
import { searchPropertiesCore as searchPropertiesWithNaturalLanguage } from '@/lib/buyer-search'

export interface VoiceAssistantRequest {
  contactId: string
  intent: 'explain_progress' | 'whats_next' | 'search_properties' | 'schedule_tour' | 'general_question'
  transcript: string
  userId?: string
}

export interface VoiceAssistantResponse {
  success: boolean
  spokenResponse: string
  displayData?: Record<string, unknown>
  actionsRequired?: string[]
  error?: string
}

/**
 * Handle voice assistant request for buyer
 * Routes to appropriate handler based on intent
 */
export async function handleBuyerVoiceRequest(
  request: VoiceAssistantRequest
): Promise<VoiceAssistantResponse> {
  const { contactId, intent, transcript, userId } = request
  
  const context: BuyerExecutionContext = {
    contactId,
    userId,
    source: 'voice_assistant'
  }
  
  // Log voice interaction
  await logBuyerExecutionEvent({
    contactId,
    eventType: 'buyer.voice.interaction',
    userId,
    source: 'voice_assistant',
    metadata: {
      intent,
      transcript,
    }
  })
  
  try {
    switch (intent) {
      case 'explain_progress':
        return await explainProgressVoice(context)
      
      case 'whats_next':
        return await explainWhatsNextVoice(context)
      
      case 'search_properties':
        return await searchPropertiesVoice(context, transcript)
      
      case 'schedule_tour':
        return await scheduleTourVoice(context, transcript)
      
      default:
        return {
          success: false,
          spokenResponse: "I'm not sure how to help with that. Can you rephrase?",
        }
    }
  } catch (error) {
    console.error('[voice-assistant] Error handling request:', error)
    return {
      success: false,
      spokenResponse: "I encountered an error. Please try again or contact your agent.",
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Explain buyer's current progress
 */
async function explainProgressVoice(
  context: BuyerExecutionContext
): Promise<VoiceAssistantResponse> {
  const statusResult = await getBuyerJourneyStatus(context)
  
  if (!statusResult.success || !statusResult.status) {
    return {
      success: false,
      spokenResponse: "I'm having trouble accessing your journey status. Please contact your agent."
    }
  }
  
  const status = statusResult.status
  const message = getBuyerFriendlyMessage(status)
  
  const spokenResponse = `${message.greeting} ${message.statusMessage}. ${message.encouragement}`
  
  return {
    success: true,
    spokenResponse,
    displayData: {
      progressPercentage: status.progressPercentage,
      currentState: status.currentState,
      milestones: status.milestones,
    }
  }
}

/**
 * Explain what the buyer should do next
 */
async function explainWhatsNextVoice(
  context: BuyerExecutionContext
): Promise<VoiceAssistantResponse> {
  const statusResult = await getBuyerJourneyStatus(context)
  
  if (!statusResult.success || !statusResult.status) {
    return {
      success: false,
      spokenResponse: "I'm having trouble accessing your journey status. Please contact your agent."
    }
  }
  
  const status = statusResult.status
  const message = getBuyerFriendlyMessage(status)
  
  let spokenResponse = message.nextAction
  
  // Add context based on blockers
  if (status.blockers.length > 0) {
    spokenResponse = `Before you can continue, ${status.blockers[0].toLowerCase()}. Once that's done, you'll be able to ${status.canSearch ? 'search for properties' : 'move forward'}.`
  } else if (status.nextSteps.length > 0) {
    spokenResponse = `Your next step is to ${status.nextSteps[0].toLowerCase()}.`
    
    if (status.nextSteps.length > 1) {
      spokenResponse += ` After that, you can ${status.nextSteps[1].toLowerCase()}.`
    }
  }
  
  return {
    success: true,
    spokenResponse,
    displayData: {
      nextSteps: status.nextSteps,
      blockers: status.blockers,
      canSearch: status.canSearch,
      canTour: status.canTour,
      canOffer: status.canOffer,
    }
  }
}

/**
 * Handle property search via voice
 * ENFORCES financial verification gate
 */
async function searchPropertiesVoice(
  context: BuyerExecutionContext,
  transcript: string
): Promise<VoiceAssistantResponse> {
  // 1. Enforce financial gate
  const gateCheck = await enforceFinancialGate(context, 'search')
  
  if (!gateCheck.allowed) {
    return {
      success: false,
      spokenResponse: `I can't search for properties yet. ${gateCheck.reason}. Please upload your pre-approval letter or proof of funds, then I'll be happy to help you search.`,
      actionsRequired: ['financial_verification']
    }
  }
  
  // 2. Execute search
  const searchResult = await searchPropertiesWithNaturalLanguage({
    contactId: context.contactId,
    naturalLanguageQuery: transcript,
    options: {
      limit: 5, // Voice should return fewer results
      logSignals: true,
    }
  })
  
  if (!searchResult.success) {
    return {
      success: false,
      spokenResponse: "I had trouble searching for properties. Can you try rephrasing your request?"
    }
  }
  
  if (!searchResult.results || searchResult.results.length === 0) {
    return {
      success: true,
      spokenResponse: "I didn't find any properties matching your criteria right now. Would you like to adjust your search?"
    }
  }
  
  // 3. Format voice response
  const resultCount = searchResult.results.length
  const topResult = searchResult.results[0]
  
  const spokenResponse = `I found ${resultCount} ${resultCount === 1 ? 'property' : 'properties'} for you. The top match is a ${topResult.bedrooms} bedroom, ${topResult.bathrooms} bathroom ${topResult.property_type} in ${topResult.city} for ${formatPrice(topResult.price)}. ${topResult.headline} Would you like to hear more details or see the others?`
  
  return {
    success: true,
    spokenResponse,
    displayData: {
      results: searchResult.results.map(r => ({
        listing_id: r.listing_id,
        headline: r.headline,
        price: r.price,
        bedrooms: r.bedrooms,
        bathrooms: r.bathrooms,
        city: r.city,
        property_type: r.property_type,
      })),
      totalFound: resultCount,
    }
  }
}

/**
 * PURE. The property the buyer NAMED, straight out of what they said — or null.
 *
 * Deliberately conservative: it recognises a street-address shape (a house number
 * followed by a street word) and nothing else. It does NOT try to resolve the
 * property to a listing row — that is entity resolution's job, and guessing a listing
 * from a voice transcript is how the wrong home ends up on a showing request.
 * A null here simply means "ask", which is the behaviour that was always there.
 */
function extractSpokenPropertyReference(transcript: string): string | null {
  const said = (transcript ?? "").trim()
  if (!said) return null
  const m = said.match(
    /\b\d{1,6}\s+[A-Za-z0-9'.-]+(?:\s+[A-Za-z0-9'.-]+){0,3}\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|place|pl|way|terrace|ter|circle|cir|parkway|pkwy)\b\.?/i,
  )
  if (!m) return null
  return m[0].replace(/\.$/, "").trim()
}

/**
 * Handle tour scheduling via voice
 * ENFORCES financial verification gate
 */
async function scheduleTourVoice(
  context: BuyerExecutionContext,
  transcript: string
): Promise<VoiceAssistantResponse> {
  // 1. Enforce financial gate
  const gateCheck = await enforceFinancialGate(context, 'tour')
  
  if (!gateCheck.allowed) {
    return {
      success: false,
      spokenResponse: `I can't schedule tours yet. ${gateCheck.reason}. Please complete your financial verification first.`,
      actionsRequired: ['financial_verification']
    }
  }
  
  // 2. Check journey status
  const statusResult = await getBuyerJourneyStatus(context)
  
  if (!statusResult.success || !statusResult.status) {
    return {
      success: false,
      spokenResponse: "I'm having trouble accessing your account. Please contact your agent."
    }
  }
  
  if (!statusResult.status.canTour) {
    return {
      success: false,
      spokenResponse: "You're not quite ready to schedule tours yet. Let me help you get set up for searching first.",
      actionsRequired: ['search_configuration']
    }
  }
  
  // 3. Delegate to showing management system
  //
  // `transcript` — WHAT THE BUYER ACTUALLY SAID — was accepted by this handler and
  // read by NOTHING until 2026-08-24, while its sibling `searchPropertiesVoice` above
  // hands the same string straight to the search. So a buyer who said "book me a tour
  // of 412 Oak Street on Saturday" was answered with "Can you tell me which property
  // you're interested in visiting?" — the assistant asking for the one thing it had
  // just been told. On a voice surface that is the difference between an assistant and
  // a form.
  //
  // The property reference is not RESOLVED here — that is entity resolution's job
  // (app/actions/voice-assistant/core/resolve-entities.ts) and this handler is still
  // the guidance stub its note says it is. What changes is that the spoken reply stops
  // discarding the utterance, and the reference travels in displayData so the step
  // that does the booking does not have to ask a second time.
  const spokenProperty = extractSpokenPropertyReference(transcript)

  return {
    success: true,
    spokenResponse: spokenProperty
      ? `I can help you schedule a tour of ${spokenProperty}. Let me get that in front of your agent — what day and time work for you?`
      : "I can help you schedule a tour! Can you tell me which property you're interested in visiting? You can say the address or describe the property.",
    displayData: {
      canTour: true,
      spokenPropertyReference: spokenProperty,
      nextAction: 'property_selection',
    }
  }
}

/**
 * Format price for voice output
 */
function formatPrice(price: number | null): string {
  if (!price) return 'price not available'
  
  if (price >= 1000000) {
    const millions = (price / 1000000).toFixed(1)
    return `$${millions} million`
  } else {
    const thousands = Math.round(price / 1000)
    return `$${thousands} thousand`
  }
}
