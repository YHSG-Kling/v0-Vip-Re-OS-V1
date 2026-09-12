// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published triggerInitialScoring(leadId) as a public HTTP door
// with no gate: a service client re-scoring and UPDATING any leads.id a session
// chose to name (the tenant is read from the lead row, never checked against
// the caller). Every caller is in-process server code (re-verified 2026-09-03):
//   · lib/lead-promotion/index.ts:6 (the barrel), whose only value importer is
//     scripts/raw-lead-promotion-simulator.ts:72 (tsx, outside the bundle) —
//     no app/ module, route, or client component calls triggerInitialScoring
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the service credential.
import "server-only"

import { createServiceClient } from '@/lib/supabase/service'
import type { StandardTimeline } from '@/constants/crm-standards'

/**
 * Points contributed by `leads.timeline` (0-10). NOT exported — nothing outside
 * this module reads it, and until 2026-09-03 this file was `'use server'`, where
 * every export was a public HTTP endpoint and had to be async (see the header).
 */
const TIMELINE_URGENCY_POINTS: Record<StandardTimeline, number> = {
  immediate:     10,
  '1-3_months':   7,
  '3-6_months':   4,
  '6-12_months':  0,
  '12+_months':   0,
  researching:    0,
}

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

  // TENANT ANCHOR, HOISTED ABOVE THE TRY. The catch below files an
  // automation_errors row and `lead` is scoped inside the try, so the anchor has
  // to live out here. Re-reading the lead from inside the error handler is the
  // trap: that read can itself be refused, and code that reports a failure must
  // never be able to lose it.
  let scoringBrokerageId: string | null = null

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

    // The lead is the record this scoring run — and any failure of it — is filed
    // against.
    scoringBrokerageId = (lead.brokerage_id as string | null) ?? null

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
    //
    // REPOINTED to the one timeline vocabulary (constants/crm-standards.ts:
    // STANDARD_TIMELINES). These three tests used the SPACED spelling
    // ('1-3 months'), which no writer of leads.timeline has ever produced —
    // so outside 'immediate' this factor was structurally worth 0 and nothing
    // errored, because it is string equality against a free-text column.
    //
    // The ladder is a Record over the vocabulary rather than an if-chain so
    // that adding or removing a member is a TYPE ERROR here, not a silent
    // zero. Members worth no urgency points are spelled out as 0 on purpose:
    // an omission and a deliberate zero must not look the same.
    score += TIMELINE_URGENCY_POINTS[lead.timeline as StandardTimeline] ?? 0

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
    
    // Record scoring failure in automation_errors. TENANT: the hoisted anchor.
    // Null means the lead was never read (the "Lead not found for scoring" path),
    // which is precisely the case with no tenant to attribute the failure to —
    // and the failure is already on the console line above, so nothing is lost by
    // declining to file a row the automations console can neither see nor
    // resolve (`workflows.ts:531` treats `.eq("brokerage_id", …)` as an ownership
    // check and returns "Forbidden" on a miss).
    if (!scoringBrokerageId) {
      console.error(
        `[v0] Initial scoring: no brokerage resolved for lead ${leadId} before the failure — automation_errors row NOT written rather than written where the console can neither see nor resolve it`,
      )
      return
    }
    const { error: scoringLogError } = await supabase
      .from('automation_errors')
      .insert({
        brokerage_id: scoringBrokerageId,
        workflow_name: 'initial_lead_scoring',
        error_message: error.message,
        context_json: JSON.stringify({ leadId }),
        severity: 'medium',
        status: 'open',
        created_at: new Date().toISOString(),
      })
    if (scoringLogError) {
      console.error('[v0] Initial scoring: automation_errors insert refused:', scoringLogError.message)
    }
  }
}
