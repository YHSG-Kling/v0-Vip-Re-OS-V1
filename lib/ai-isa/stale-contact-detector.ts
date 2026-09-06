/**
 * lib/ai-isa/stale-contact-detector.ts
 *
 * Detects contacts that are eligible for AI ISA re-engagement because they
 * have gone stale or ghosted. Called by the cron job and by the ISA console.
 *
 * ── THE THREE-WAY DIVERGENCE THIS MODULE NOW ENDS ───────────────────────────
 *
 * The header sentence above claimed two callers and, until this pass, had
 * NEITHER: nothing in app/ or lib/ named a single export here, while
 * lib/ai-isa/reengagement-policy.ts's own header declared this file one of its
 * "production runners". The same rule had instead been hand-written THREE times
 * against THREE DIFFERENT staleness columns:
 *
 *   · here                                     — contacts.last_contacted_at  (correct)
 *   · app/api/cron/stale-contact-monitor       — contacts.created_at
 *   · app/dashboard/stale/actions.ts           — contacts.updated_at
 *
 * That is not a stylistic split, it produced user-visible wrong behaviour:
 *
 *   1. The cron's `created_at` filter carried the comment "contacts.last_contacted_at
 *      is not in schema — filter on created_at as fallback". MEASURED against
 *      scripts/schema-snapshot.ts, contacts DOES carry last_contacted_at (as well
 *      as ai_outreach_paused, isa_reengage_allowed and deleted_at). So the column
 *      existed the whole time, and filtering on created_at means EVERY contact
 *      older than the threshold is permanently "stale" no matter how recently the
 *      agent spoke to them — the cron re-engaged actively-worked relationships.
 *   2. The dashboard's `updated_at` filter disagreed with the cron while its own
 *      comment called itself a "mirror of stale-contact-monitor cron query". The
 *      "I just touched" button bumped updated_at, so the row left the agent's
 *      dashboard and the cron — reading created_at — auto-messaged them anyway.
 *   3. Neither copy excluded an OPEN TRANSACTION, ai_outreach_paused, or
 *      deleted_at, all of which this module and staleContactEligibility do. A
 *      client under contract was inside the cron's stale net.
 *
 * NOTHING WAS DELETED WITHOUT MERGING FIRST. The two inline copies each held two
 * exclusions this module lacked, and both were carried over before their queries
 * were removed:
 *   · statuses 'archived' / 'inactive' → NON_ENGAGEABLE_CONTACT_STATUSES in the
 *     pure policy, so they are now tested rather than duplicated.
 *   · "must have an assigned agent" (`.not('agent_id','is',null)`) → the
 *     requireAssignedAgent option below.
 *   · the dashboard's per-agent scope → the agentId option below.
 *
 * Stale: last_contacted_at older than the brokerage-configured stale_days
 *        threshold (default 14 days) and no active transaction.
 *
 * Ghosted: agent sent 2+ outreach attempts with no response in the last
 *          30 days and last_contacted_at is > ghosted_days (default 21) ago.
 *
 * Contacts are excluded from detection when:
 *   - dnc_status = true
 *   - ai_outreach_paused = true
 *   - isa_reengage_allowed = false
 *   - status = 'closed' | 'do_not_contact'
 *   - active transaction exists (under_contract, closing, active)
 */

import { createServiceClient } from '@/lib/supabase/service'
import { isLifetimeCustomerType } from '@/lib/contact-types'
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"
import {
  staleContactEligibility,
  NON_ENGAGEABLE_CONTACT_STATUSES,
  DEFAULT_STALE_DAYS,
  DEFAULT_GHOSTED_DAYS,
  DEFAULT_MAX_BATCH,
} from '@/lib/ai-isa/reengagement-policy'

// ── Default thresholds (overridable per brokerage via ai_isa_settings) ──────
// Re-exported from the pure policy module so callers keep one import surface.
export { DEFAULT_STALE_DAYS, DEFAULT_GHOSTED_DAYS, DEFAULT_MAX_BATCH }

// ── Types ────────────────────────────────────────────────────────────────────

export interface StaleContact {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  contact_type: string | null
  buyer_stage: string | null
  last_contacted_at: string | null
  preferred_channel: string | null
  tcpa_consent: boolean
  ai_outreach_paused: boolean
  isa_reengage_allowed: boolean
  agent_id: string | null
  brokerage_id: string
  days_since_contact: number
  detection_type: 'stale' | 'ghosted'
}

export interface DetectionThresholds {
  staleDays: number
  ghostedDays: number
  maxBatch: number
  /**
   * Restrict detection to ONE agent's book (contacts.agent_id — an agents.id,
   * never a users.id). Absorbed from app/dashboard/stale/actions.ts, whose
   * per-agent read was the only reason it kept its own copy of this query.
   */
  agentId: string | null
  /**
   * Skip contacts with no assigned agent. Absorbed from the cron's
   * `.not('agent_id','is',null)`; see staleContactEligibility for why.
   */
  requireAssignedAgent: boolean
  /**
   * Return dormant contacts whose ISA switch is OFF as well.
   *
   * FOR AGENT-FACING SURFACES ONLY — never for a sender. The returned rows carry
   * `isa_reengage_allowed` / `ai_outreach_paused` so the caller can badge them,
   * and the caller is responsible for not dispatching to them. This is the
   * dormancy LISTING, not a licence to send.
   *
   * Absorbed from app/dashboard/stale/actions.ts, whose query never filtered
   * those two flags: its UI shows an "ISA off" badge, and turning the switch
   * back on is only possible from a row the agent can still see. Without this
   * option, folding that query into the detector would have made every paused
   * contact invisible and therefore unrecoverable.
   */
  includeIsaDisabled: boolean
}

// ── detectStaleContacts ───────────────────────────────────────────────────────

/**
 * Returns contacts that are stale AND eligible for AI ISA re-engagement.
 * Does NOT trigger any outreach — call engageContact() per result.
 */
export async function detectStaleContacts(
  brokerageId: string,
  thresholds: Partial<DetectionThresholds> = {},
): Promise<StaleContact[]> {
  const supabase = createServiceClient()

  const staleDays   = thresholds.staleDays   ?? DEFAULT_STALE_DAYS
  const maxBatch    = thresholds.maxBatch     ?? DEFAULT_MAX_BATCH
  const staleDate   = new Date(Date.now() - staleDays * 86_400_000).toISOString()

  // Fetch stale candidates — contacts whose last_contacted_at is before the threshold
  let q = supabase
    .from('contacts')
    .select(
      `id, first_name, last_name, email, phone,
       contact_type, buyer_stage, last_contacted_at, preferred_channel,
       tcpa_consent, ai_outreach_paused, isa_reengage_allowed,
       agent_id, brokerage_id, dnc_status, status, deleted_at`
    )
    .eq('brokerage_id', brokerageId)
    // LIFETIME contacts are stale on a LONGER horizon (LIFETIME_STALE_DAYS), so the
    // query cannot pre-filter them out at `staleDays` — the pure predicate applies
    // the right threshold per contact_type below. `is.null` keeps never-contacted
    // rows, which the predicate scores as maximally stale.
    .or('last_contacted_at.lt.' + staleDate + ',last_contacted_at.is.null')
    .eq('dnc_status', false)
    // The exclusion vocabulary carried over from the two inline copies, applied
    // from ONE list so the query and the post-fetch predicate cannot disagree.
    .not('status', 'in', `(${NON_ENGAGEABLE_CONTACT_STATUSES.join(',')})`)
    .is('deleted_at', null)
    .order('last_contacted_at', { ascending: true, nullsFirst: true })
    .limit(maxBatch * 3) // over-fetch to filter after active-transaction check

  // The ISA-switch flags gate the SEND, not the LISTING — so they are only
  // pre-filtered at the query for send-side callers. An agent console asking for
  // includeIsaDisabled must still see paused rows in order to un-pause them; the
  // pure predicate reports them ineligible either way (see `dormant`).
  if (!thresholds.includeIsaDisabled) q = q.eq('ai_outreach_paused', false)

  if (thresholds.agentId) q = q.eq('agent_id', thresholds.agentId)
  else if (thresholds.requireAssignedAgent) q = q.not('agent_id', 'is', null)

  const { data: candidates, error } = await q

  // supabase-js RESOLVES a failed query, so `data` alone would read a permission
  // denial as "no stale contacts" and the cron would report a clean run having
  // silently engaged nobody.
  if (error) {
    console.error('[detectStaleContacts] contacts read refused:', error.message)
    return []
  }
  if (!candidates) return []

  // Exclude contacts with active transactions in bulk using IN filter
  const ids = candidates.map((c) => c.id)
  const { data: activeTxContacts, error: txErr } = ids.length
    ? await supabase
        .from('transactions')
        .select('contact_id')
        .in('contact_id', ids)
        .in('status', [...TRANSACTION_STATUSES_OPEN])
    : { data: [] as Array<{ contact_id: string | null }>, error: null }

  // FAIL CLOSED. This probe is the only thing standing between a client who is
  // under contract and an automated "haven't heard from you" touch. Read it as an
  // empty result and every such client lands in the batch, so a refusal must stop
  // the run rather than widen it.
  if (txErr) {
    console.error('[detectStaleContacts] active-transaction probe refused:', txErr.message)
    return []
  }

  const blockedIds = new Set((activeTxContacts ?? []).map((t: any) => t.contact_id))

  const nowDate = new Date()
  const results: StaleContact[] = []

  for (const c of candidates) {
    // Authoritative pure eligibility — encodes every exclusion (dnc / paused /
    // reengage-disallowed / do-not-contact / deleted / active-transaction / not-yet-stale).
    const elig = staleContactEligibility(
      {
        last_contacted_at:    c.last_contacted_at,
        dnc_status:           c.dnc_status,
        ai_outreach_paused:   c.ai_outreach_paused,
        isa_reengage_allowed: c.isa_reengage_allowed,
        status:               c.status,
        deleted_at:           c.deleted_at,
        hasActiveTransaction: blockedIds.has(c.id),
        // Past clients get the long-horizon threshold (quarterly-ish), not the bi-weekly active cadence.
        is_lifetime:          isLifetimeCustomerType((c as { contact_type?: string | null }).contact_type),
        agent_id:             c.agent_id,
      },
      { now: nowDate, staleDays, requireAssignedAgent: thresholds.requireAssignedAgent },
    )
    // `eligible` for a sender; `dormant` for an agent console that must still see
    // (and be able to un-pause) a contact whose ISA switch is off. The two differ
    // ONLY on ai_outreach_paused / isa_reengage_allowed — every hard stop clears both.
    if (!(thresholds.includeIsaDisabled ? elig.dormant : elig.eligible)) continue

    results.push({
      id:                  c.id,
      first_name:          c.first_name,
      last_name:           c.last_name,
      email:               c.email,
      phone:               c.phone,
      contact_type:        c.contact_type,
      buyer_stage:         c.buyer_stage,
      last_contacted_at:   c.last_contacted_at,
      preferred_channel:   c.preferred_channel,
      tcpa_consent:        c.tcpa_consent ?? false,
      ai_outreach_paused:  c.ai_outreach_paused ?? false,
      isa_reengage_allowed: c.isa_reengage_allowed ?? true,
      agent_id:            c.agent_id,
      brokerage_id:        c.brokerage_id,
      days_since_contact:  elig.daysSinceContact,
      detection_type:      'stale',
    })

    if (results.length >= maxBatch) break
  }

  return results
}

// ── detectGhostedContacts ─────────────────────────────────────────────────────

/**
 * Returns contacts that have been ghosted — agent sent outreach but received
 * no reply in ghostedDays. Reads isa_outreach_log for sent events.
 */
export async function detectGhostedContacts(
  brokerageId: string,
  thresholds: Partial<DetectionThresholds> = {},
): Promise<StaleContact[]> {
  const supabase = createServiceClient()

  const ghostedDays = thresholds.ghostedDays ?? DEFAULT_GHOSTED_DAYS
  const maxBatch    = thresholds.maxBatch    ?? DEFAULT_MAX_BATCH
  const ghostedDate = new Date(Date.now() - ghostedDays * 86_400_000).toISOString()

  // Contacts that had an outreach but no reply_at
  const { data: outreachRows, error } = await supabase
    .from('isa_outreach_log')
    .select('contact_id, sent_at, replied_at')
    .eq('brokerage_id', brokerageId)
    .lt('sent_at', ghostedDate)
    .is('replied_at', null)
    .order('sent_at', { ascending: true })
    .limit(maxBatch * 3)

  if (error) {
    console.error('[detectGhostedContacts] isa_outreach_log read refused:', error.message)
    return []
  }
  if (!outreachRows) return []

  // Deduplicate by contact_id, keep oldest sent_at per contact
  const contactMap = new Map<string, string>()
  for (const row of outreachRows) {
    if (row.contact_id && !contactMap.has(row.contact_id)) {
      contactMap.set(row.contact_id, row.sent_at)
    }
  }

  if (!contactMap.size) return []

  const ids = Array.from(contactMap.keys())

  let cq = supabase
    .from('contacts')
    .select(
      `id, first_name, last_name, email, phone,
       contact_type, buyer_stage, last_contacted_at, preferred_channel,
       tcpa_consent, ai_outreach_paused, isa_reengage_allowed,
       agent_id, brokerage_id, dnc_status, status, deleted_at`
    )
    .in('id', ids)
    .eq('brokerage_id', brokerageId)
    .eq('dnc_status', false)
    .not('status', 'in', `(${NON_ENGAGEABLE_CONTACT_STATUSES.join(',')})`)
    .is('deleted_at', null)

  if (!thresholds.includeIsaDisabled) cq = cq.eq('ai_outreach_paused', false)

  if (thresholds.agentId) cq = cq.eq('agent_id', thresholds.agentId)
  else if (thresholds.requireAssignedAgent) cq = cq.not('agent_id', 'is', null)

  const { data: contacts, error: contactErr } = await cq

  if (contactErr) {
    console.error('[detectGhostedContacts] contacts read refused:', contactErr.message)
    return []
  }
  if (!contacts) return []

  // Filter out active-transaction contacts
  const { data: activeTxContacts, error: txErr } = ids.length
    ? await supabase
        .from('transactions')
        .select('contact_id')
        .in('contact_id', ids)
        .in('status', [...TRANSACTION_STATUSES_OPEN])
    : { data: [] as Array<{ contact_id: string | null }>, error: null }

  // Fail closed for the same reason as the stale path: an unread probe means a
  // client under contract is treated as ghosting them.
  if (txErr) {
    console.error('[detectGhostedContacts] active-transaction probe refused:', txErr.message)
    return []
  }

  const blockedIds = new Set((activeTxContacts ?? []).map((t: any) => t.contact_id))

  const now = Date.now()
  const results: StaleContact[] = []

  for (const c of contacts) {
    if (blockedIds.has(c.id)) continue
    // The ISA switch blocks the SEND, not the agent-console LISTING — same split
    // the stale path applies through staleContactEligibility's `dormant`.
    if (!thresholds.includeIsaDisabled && c.isa_reengage_allowed === false) continue

    const firstOutreach = contactMap.get(c.id) ?? null
    const daysSince = firstOutreach
      ? Math.floor((now - new Date(firstOutreach).getTime()) / 86_400_000)
      : 0

    results.push({
      id:                  c.id,
      first_name:          c.first_name,
      last_name:           c.last_name,
      email:               c.email,
      phone:               c.phone,
      contact_type:        c.contact_type,
      buyer_stage:         c.buyer_stage,
      last_contacted_at:   c.last_contacted_at,
      preferred_channel:   c.preferred_channel,
      tcpa_consent:        c.tcpa_consent ?? false,
      ai_outreach_paused:  c.ai_outreach_paused ?? false,
      isa_reengage_allowed: c.isa_reengage_allowed ?? true,
      agent_id:            c.agent_id,
      brokerage_id:        c.brokerage_id,
      days_since_contact:  daysSince,
      detection_type:      'ghosted',
    })

    if (results.length >= maxBatch) break
  }

  return results
}

// ── detectAllEligibleContacts ─────────────────────────────────────────────────

/**
 * Combined detection — stale + ghosted, deduped by contact ID.
 *
 * GHOSTED WINS A TIE, and that ordering is the point of the function rather than
 * a detail. A contact who is merely quiet and a contact who was MESSAGED and did
 * not answer are different situations, and engageContact already branches on the
 * difference: `reason === 'ghosted'` routes the call to the 'ghost_recovery'
 * purpose (buildCallContext) and arms the situational voicemail's fresh hook.
 * Ghosted rows arrive second, so an insertion order of [stale, ghosted] would
 * hand every dual-detected contact the WEAKER label and leave the recovery path
 * unreachable — which is exactly how it stayed unreachable while this function
 * had no caller at all.
 */
export async function detectAllEligibleContacts(
  brokerageId: string,
  thresholds: Partial<DetectionThresholds> = {},
): Promise<StaleContact[]> {
  const [stale, ghosted] = await Promise.all([
    detectStaleContacts(brokerageId, thresholds),
    detectGhostedContacts(brokerageId, thresholds),
  ])

  const seen = new Set<string>()
  const combined: StaleContact[] = []

  for (const c of [...ghosted, ...stale]) {
    if (!seen.has(c.id)) {
      seen.add(c.id)
      combined.push(c)
    }
  }

  return combined
}
