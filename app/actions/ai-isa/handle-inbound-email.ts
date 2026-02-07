'use server'

import { handleInboundEmailReply, shouldStopAutoResponding } from '@/lib/ai-isa/conversation-handler'
import { evaluateLeadQualification, persistQualificationSignals } from '@/lib/ai-isa/qualification-evaluator'

export async function processInboundEmail(params: {
  leadId: string
  fromEmail: string
  subject: string
  body: string
  conversationId?: string
}) {
  console.log('[v0] Processing inbound email from lead:', params.leadId)
  
  // Check if we should still auto-respond
  const stopResponding = await shouldStopAutoResponding(params.leadId)
  
  if (stopResponding) {
    console.log('[v0] Auto-responding stopped for lead:', params.leadId)
    return {
      success: true,
      responded: false,
      reason: 'Lead qualified or max exchanges reached'
    }
  }
  
  try {
    // Handle the email and generate response
    const response = await handleInboundEmailReply(params)
    
    // Evaluate qualification after each exchange
    const qualificationSignals = await evaluateLeadQualification(params.leadId)
    
    // Persist qualification signals
    await persistQualificationSignals(params.leadId, qualificationSignals)
    
    // TODO: Send the AI response via email service
    console.log('[v0] Would send AI response:', response.body.substring(0, 100))
    
    return {
      success: true,
      responded: true,
      qualificationSignals,
      responsePreview: response.body.substring(0, 200)
    }
    
  } catch (error: any) {
    console.error('[v0] Inbound email processing error:', error)
    return {
      success: false,
      responded: false,
      error: error.message
    }
  }
}
