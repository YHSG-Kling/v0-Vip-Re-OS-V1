'use server'

import { createServiceClient } from '@/lib/supabase/service'

/**
 * Triggers internal-only lead scoring after promotion.
 * 
 * This function is separated from promotion because scoring is
 * a downstream intelligence activity, not part of the promotion decision.
 * 
 * DOES NOT:
 * - Contact the lead
 * - Assign agents
 * - Send notifications
 * 
 * DOES:
 * - Calculate lead_score based on enrichment data
 * - Update lead record with score
 */
export async function triggerInitialScoring(leadId: string): Promise<void> {
  const supabase = createServiceClient()

  try {
    // Fetch the lead data for scoring
    const { data: lead, error: fetchError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()

    if (fetchError || !lead) {
      throw new Error('Lead not found for scoring')
    }

    // Calculate lead score based on available data
    let score = 0

    // Scoring factors (internal intelligence only):
    
    // 1. Enrichment confidence (0-30 points)
    if (lead.enrichment_confidence) {
      score += Math.floor(lead.enrichment_confidence * 30)
    }

    // 2. Motivation confidence (0-25 points)
    if (lead.motivation_confidence) {
      score += Math.floor(lead.motivation_confidence * 25)
    }

    // 3. Contact completeness (0-20 points)
    if (lead.email) score += 10
    if (lead.phone) score += 10

    // 4. Property interest specificity (0-15 points)
    if (lead.property_interest) score += 15

    // 5. Timeline urgency (0-10 points)
    if (lead.timeline === 'immediate') score += 10
    else if (lead.timeline === '1-3 months') score += 7
    else if (lead.timeline === '3-6 months') score += 4

    // Cap score at 100
    score = Math.min(score, 100)

    // Update lead with calculated score
    await supabase
      .from('leads')
      .update({ 
        lead_score: score,
        updated_at: new Date().toISOString()
      })
      .eq('id', leadId)

    console.log(`[v0] Initial scoring complete for lead ${leadId}: score=${score}`)
  } catch (error: any) {
    // Log error but don't throw - scoring failure shouldn't block promotion
    console.error(`[v0] Initial scoring failed for lead ${leadId}:`, error.message)
    
    // Record scoring failure in automation_errors
    await supabase
      .from('automation_errors')
      .insert({
        workflow_name: 'initial_lead_scoring',
        error_message: error.message,
        context_json: JSON.stringify({ leadId }),
        severity: 'medium',
        status: 'open',
        created_at: new Date().toISOString(),
      })
  }
}
