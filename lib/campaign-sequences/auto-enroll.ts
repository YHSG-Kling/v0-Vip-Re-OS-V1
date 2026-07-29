// lib/campaign-sequences/auto-enroll.ts
// ─────────────────────────────────────────────────────────────────────────────
// AUTONOMOUS ENROLMENT — the contact signs up, the campaign starts. No human
// step, no cron catch-up, no "review and start a drip campaign" nudge sitting in
// somebody's notifications.
//
// OWNER RULING: "the campaigns should be automatically keyed off when the contact
// signs up for those campaigns automatically (autonomous)."
//
// WHAT THIS REPLACES. Two capture flows each hand-rolled their own lookup for a
// follow-up sequence, and both asked for a literal the column's CHECK does not
// admit — `sequence_type = 'seller_nurture'` / `'lead_magnet'`,
// `trigger_event = 'home_value_submitted'`. Neither matched anything, ever, so
// neither capture enrolled anybody. The home-value flow even notified the agent
// "Review and start a drip campaign", which is the manual fallback for an
// automation that was never firing.
//
// Selection is by (brokerage, source_key, contact_type, persona) — the two
// audience axes m293/m294 added. contact_type is who they are to us (buyer,
// seller, both, lifetime); persona is the SITUATION that brought them (first
// time, divorce, probate, fsbo, downsize, senior, …). They are independent, and
// pickSequence ranks most-specific-first across both. A sequence with no
// source_key is never auto-selected: unkeyed means hand-run.
//
// IDEMPOTENT. Re-running the capture (a double form post, a retried webhook)
// must not enrol twice, so an existing non-terminal enrolment short-circuits.
//
// BEST-EFFORT BY CONTRACT. Never throws into the caller. A capture that succeeds
// must not be rolled back because its follow-up campaign could not start — the
// contact is the thing that matters; the drip is recoverable.

import {
  normalizeContactSource,
  normalizeContactPersona,
  contactTypeForSource,
  type CampaignKeyedSource,
  type CampaignContactType,
  type CampaignPersona,
} from "@/lib/campaigns/contact-sources"

/** Accepts either the RLS-scoped server client or the service client. */
type AnyClient = { from: (table: string) => any }

/**
 * sequence_enrollments.status values that mean "already in this sequence".
 * Terminal ones (completed, converted, cancelled, unenrolled, unsubscribed) do
 * NOT block a fresh enrolment — a past client who comes back through the
 * home-value tool should start the drip again.
 */
export const ACTIVE_ENROLLMENT_STATUSES = ["active", "paused", "authority_blocked"] as const

export interface AutoEnrollInput {
  brokerageId: string
  contactId: string
  /** Raw contacts.source as written by the capture; normalized here. */
  source: string | null | undefined
  /** contacts.contact_type — buyer | seller | both | lifetime. */
  contactType?: string | null
  /** contacts.contact_persona — the SITUATION (first_time, divorce, probate, …). */
  contactPersona?: string | null
  /** agents.id of the enrolling agent, when the capture knows it. */
  enrolledBy?: string | null
  /** Delay before the first step. Defaults to 24h, matching the prior behaviour. */
  firstStepDelayMs?: number
  now?: Date
}

export interface AutoEnrollResult {
  enrolled: boolean
  sequenceId?: string
  /** Why nothing happened. Always set when enrolled is false. */
  reason?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * PURE — pick the best sequence for a contact, MOST SPECIFIC FIRST.
 *
 * The two axes are independent, so specificity is a 4-rung ladder. A campaign
 * written for a divorcing seller must beat one written for sellers generally,
 * which must beat one written for "anyone from this source":
 *
 *   1. contact_type AND persona both match   (divorcing seller)
 *   2. contact_type matches, persona is any  (any seller)
 *   3. persona matches, contact_type is any  (anyone divorcing)
 *   4. both any                              (anyone from this source)
 *
 * A sequence that names a DIFFERENT contact_type or persona is never selected —
 * enrolling a first-time buyer into a probate campaign is worse than not firing.
 */
export function pickSequence<T extends { id: string; contact_type?: string | null; persona?: string | null }>(
  candidates: T[],
  contactType: CampaignContactType,
  persona: CampaignPersona | null,
): T | null {
  if (!candidates.length) return null
  const typeOk = (c: T) => c.contact_type == null || c.contact_type === contactType
  const personaOk = (c: T) => c.persona == null || c.persona === persona
  const eligible = candidates.filter((c) => typeOk(c) && personaOk(c))
  if (!eligible.length) return null
  return (
    eligible.find((c) => c.contact_type === contactType && c.persona != null && c.persona === persona) ??
    eligible.find((c) => c.contact_type === contactType && c.persona == null) ??
    eligible.find((c) => c.contact_type == null && c.persona != null && c.persona === persona) ??
    eligible.find((c) => c.contact_type == null && c.persona == null) ??
    null
  )
}

/**
 * Enrol a freshly captured contact into the sequence keyed to their source.
 * Returns `{ enrolled: false, reason }` for every non-error no-op so a caller can
 * log why nothing started instead of guessing.
 */
export async function autoEnrollContact(
  db: AnyClient,
  input: AutoEnrollInput,
): Promise<AutoEnrollResult> {
  try {
    const sourceKey: CampaignKeyedSource | null = normalizeContactSource(input.source)
    if (!sourceKey) return { enrolled: false, reason: `source '${input.source ?? ""}' is not campaign-keyed` }

    const contactType = contactTypeForSource(sourceKey, input.contactType)
    const persona = normalizeContactPersona(input.contactPersona)

    // Fetch every keyed sequence for this source and let pickSequence rank them.
    // Filtering both nullable axes in PostgREST needs an .or() per axis, and a
    // brokerage has a handful of keyed sequences at most — ranking in memory is
    // simpler to read and cannot get the precedence subtly wrong.
    const { data: candidates, error: seqErr } = await db
      .from("campaign_sequences")
      .select("id, contact_type, persona")
      .eq("brokerage_id", input.brokerageId)
      .eq("source_key", sourceKey)
      .eq("is_active", true)
      .limit(50)

    if (seqErr) return { enrolled: false, reason: seqErr.message }

    const sequence = pickSequence(candidates ?? [], contactType, persona)
    if (!sequence) {
      return {
        enrolled: false,
        reason: `no active sequence for source '${sourceKey}' contact_type '${contactType}' persona '${persona ?? "any"}'`,
      }
    }

    // Idempotence: already in this sequence and not finished with it.
    const { data: existing } = await db
      .from("sequence_enrollments")
      .select("id, status")
      .eq("contact_id", input.contactId)
      .eq("sequence_id", sequence.id)
      .in("status", [...ACTIVE_ENROLLMENT_STATUSES])
      .limit(1)
      .maybeSingle()

    if (existing) return { enrolled: false, sequenceId: sequence.id, reason: "already enrolled" }

    const now = input.now ?? new Date()
    const delay = input.firstStepDelayMs ?? DAY_MS

    const { error: enrErr } = await db.from("sequence_enrollments").insert({
      contact_id: input.contactId,
      sequence_id: sequence.id,
      brokerage_id: input.brokerageId,
      enrolled_by: input.enrolledBy ?? null,
      status: "active",
      current_step: 1,
      next_step_at: new Date(now.getTime() + delay).toISOString(),
    })

    if (enrErr) return { enrolled: false, sequenceId: sequence.id, reason: enrErr.message }
    return { enrolled: true, sequenceId: sequence.id }
  } catch (e) {
    return { enrolled: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
