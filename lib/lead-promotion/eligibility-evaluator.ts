// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published evaluatePromotionEligibility(rawRecordId) as a
// public HTTP door — a GATED one (the session/tenant compare below, which
// stays) — that nobody addressed: its only importer is the barrel
// lib/lead-promotion/index.ts:2, whose only value importer is
// scripts/raw-lead-promotion-simulator.ts:72, and that imports the ungated CORE
// rather than this door. No app/ module, route, or client component calls it
// (re-verified 2026-09-03). So the directive published nothing anyone needed.
// `server-only` makes a future client import fail at build time instead of
// bundling the service credential. The gate is kept exactly as it was — it is
// now the in-process tenant check for whichever server caller wires this door
// next, and scripts/lead-pipeline-simulator.ts and
// scripts/conversion-gate-auto-enrichment-simulator.ts both pin its shape.
import "server-only"

import { getAgentContext } from '@/lib/identity'
import { createServiceClient } from '@/lib/supabase/service'
import { evaluatePromotionEligibilityCore } from './eligibility-core'

/**
 * PUBLIC DOOR — gated. See eligibility-core.ts for why this split exists.
 *
 * Gate first, then the service client — the pattern named at
 * lib/kernel/manager-registry.ts. The tenant comes from the SESSION and is
 * compared against the record's own brokerage_id; it is never accepted from
 * the caller. FAILS CLOSED: no session, or a record belonging to another
 * brokerage, is refused with the SAME message as a missing record, so this
 * cannot be used to probe which ids exist.
 */
export async function evaluatePromotionEligibility(rawRecordId: string) {
  const REFUSAL = { eligible: false as const, reason: 'Raw record not found' }

  let brokerageId: string | null | undefined
  try {
    ({ brokerageId } = await getAgentContext())
  } catch {
    return REFUSAL
  }
  if (!brokerageId) return REFUSAL

  const { data, error } = await createServiceClient()
    .from('raw_scraped_leads')
    .select('brokerage_id')
    .eq('id', rawRecordId)
    .maybeSingle()

  if (error || !data || data.brokerage_id !== brokerageId) return REFUSAL

  return evaluatePromotionEligibilityCore(rawRecordId)
}
