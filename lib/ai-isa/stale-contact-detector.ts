/**
 * lib/ai-isa/stale-contact-detector.ts
 *
 * Detects contacts that are eligible for AI ISA re-engagement because they
 * have gone stale or ghosted. Called by the cron job and by the ISA console.
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
import {
  staleContactEligibility,
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
  const { data: candidates, error } = await supabase
    .from('contacts')
    .select(
      `id, first_name, last_name, email, phone,
       contact_type, buyer_stage, last_contacted_at, preferred_channel,
       tcpa_consent, ai_outreach_paused, isa_reengage_allowed,
       agent_id, brokerage_id, dnc_status, status, deleted_at`
    )
    .eq('brokerage_id', brokerageId)
    .or('last_contacted_at.lt.' + staleDate + ',last_contacted_at.is.null')
    .eq('dnc_status', false)
    .eq('ai_outreach_paused', false)
    .neq('status', 'do_not_contact')
    .is('deleted_at', null)
    .order('last_contacted_at', { ascending: true, nullsFirst: true })
    .limit(maxBatch * 3) // over-fetch to filter after active-transaction check

  if (error || !candidates) return []

  // Exclude contacts with active transactions in bulk using IN filter
  const ids = candidates.map((c) => c.id)
  const { data: activeTxContacts } = ids.length
    ? await supabase
        .from('transactions')
        .select('contact_id')
        .in('contact_id', ids)
        .in('status', ['active', 'under_contract', 'closing'])
    : { data: [] }

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
      },
      { now: nowDate, staleDays },
    )
    if (!elig.eligible) continue

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

  if (error || !outreachRows) return []

  // Deduplicate by contact_id, keep oldest sent_at per contact
  const contactMap = new Map<string, string>()
  for (const row of outreachRows) {
    if (row.contact_id && !contactMap.has(row.contact_id)) {
      contactMap.set(row.contact_id, row.sent_at)
    }
  }

  if (!contactMap.size) return []

  const ids = Array.from(contactMap.keys())

  const { data: contacts, error: contactErr } = await supabase
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
    .eq('ai_outreach_paused', false)
    .neq('status', 'do_not_contact')
    .is('deleted_at', null)

  if (contactErr || !contacts) return []

  // Filter out active-transaction contacts
  const { data: activeTxContacts } = ids.length
    ? await supabase
        .from('transactions')
        .select('contact_id')
        .in('contact_id', ids)
        .in('status', ['active', 'under_contract', 'closing'])
    : { data: [] }

  const blockedIds = new Set((activeTxContacts ?? []).map((t: any) => t.contact_id))

  const now = Date.now()
  const results: StaleContact[] = []

  for (const c of contacts) {
    if (blockedIds.has(c.id)) continue
    if (c.isa_reengage_allowed === false) continue

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

  for (const c of [...stale, ...ghosted]) {
    if (!seen.has(c.id)) {
      seen.add(c.id)
      combined.push(c)
    }
  }

  return combined
}
