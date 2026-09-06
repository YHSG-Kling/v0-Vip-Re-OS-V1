// lib/campaign-sequences/sequence-conversion.ts
// ─────────────────────────────────────────────────────────────────────────────
// A SEQUENCE CONVERSION IS A DEAL, AND NOTHING WAS EVER MEASURING IT.
//
// The sequence engine has THREE places to record that a sequence worked:
//
//   sequence_enrollments.status = 'converted'   (in the CHECK, alongside
//                                                'completed' — deliberately a
//                                                distinct outcome)
//   sequence_enrollments.converted_at
//   campaign_sequences.conversions_total
//
// Every one of them is dead. conversions_total is written exactly twice in the
// codebase, both times as `conversions_total: 0` at sequence creation; nothing
// ever increments it. status='converted' and converted_at have no writer at
// all. A fourth place — workflow_step_runs.converted_at /
// conversion_value_cents / attribution_source — was declared for "per-step
// revenue attribution" and also never written; it is dropped in m302 rather
// than revived, because the real attribution engine already exists.
//
// The consequence was a report that could only ever show zero:
// /dashboard/campaigns/workflow-reports and the admin dashboard widget both
// display "Conversions" and "Conversion Value" for every brokerage, sourced
// from columns with no writer. A permanent zero rendered in the same typeface
// as a measurement is worse than no tile — it reads as "your sequences convert
// nobody" rather than "nobody is counting".
//
// ── THE SIGNAL THAT IS REAL ──────────────────────────────────────────────────
// lib/marketing/attribution.ts already answers the harder version of this
// question for CAMPAIGNS: when a transaction closes, credit the campaigns whose
// touchpoints reached that contact inside a 180-day lookback, across four
// models. It runs daily from /api/cron/marketing-attribution-engine.
//
// A sequence conversion is the same event seen from the sequence side: the
// contact a sequence was working reached a deal. So this resolver rides the
// same cron pass and the same transactions — no second schedule, no second
// definition of "converted", no new vendor of truth. It is deliberately the
// STRICTER, simpler claim (did this enrollment's contact transact after being
// enrolled?) rather than a fifth attribution model, because a sequence's job is
// to produce a deal, not to argue about how much of one it deserves. The
// dollar-splitting stays in the attribution engine where it is already solved.
//
// Idempotent: only enrollments not already marked converted are touched, so a
// re-run of the cron (or a transaction that flips under_contract → closed)
// changes nothing the second time.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

/** How far back an enrollment may have started and still claim the deal. Matches
 *  the marketing attribution engine's LOOKBACK_DAYS so the two agree on what
 *  "this touch preceded this close" means. */
const LOOKBACK_DAYS = 180

export interface SequenceConversionResult {
  transactionId: string
  enrollmentsConverted: number
  sequencesCredited: string[]
}

/**
 * Mark every sequence enrollment that was working this transaction's contact as
 * converted, and roll the count onto its sequence.
 *
 * Service-role; the caller (the attribution cron) owns auth. Returns null when
 * the transaction has no contact to trace back — an honest nothing, not a zero.
 */
export async function resolveSequenceConversions(
  svc: SupabaseClient,
  transactionId: string,
): Promise<SequenceConversionResult | null> {
  const { data: txn } = await svc
    .from("transactions")
    .select("id, brokerage_id, status, buyer_contact_id, seller_contact_id, contact_id, close_date, contract_date, updated_at")
    .eq("id", transactionId)
    .maybeSingle()
  if (!txn) return null

  const contactIds = [txn.buyer_contact_id, txn.seller_contact_id, txn.contact_id]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
  if (contactIds.length === 0) return null

  // The moment the deal became real — what the enrollment must PRECEDE.
  const convertedAt = (txn.close_date ?? txn.contract_date ?? txn.updated_at ?? new Date().toISOString()) as string
  const enrolledSince = new Date(new Date(convertedAt).getTime() - LOOKBACK_DAYS * 86_400_000).toISOString()

  // Enrollments still open (or completed) for these contacts, started before the
  // deal and inside the lookback. Already-converted rows are excluded so this is
  // idempotent; cancelled/unsubscribed rows are excluded because a sequence the
  // contact opted out of did not convert them.
  const { data: enrollments } = await svc
    .from("sequence_enrollments")
    .select("id, sequence_id, contact_id, enrolled_at, status")
    .in("contact_id", contactIds)
    .in("status", ["active", "completed", "paused"])
    .gte("enrolled_at", enrolledSince)
    .lte("enrolled_at", convertedAt)

  const rows = (enrollments ?? []) as Array<{ id: string; sequence_id: string }>
  if (rows.length === 0) {
    return { transactionId, enrollmentsConverted: 0, sequencesCredited: [] }
  }

  const { error } = await svc
    .from("sequence_enrollments")
    .update({ status: "converted", converted_at: convertedAt })
    .in("id", rows.map(r => r.id))
  if (error) throw new Error(`sequence conversion update failed: ${error.message}`)

  // Roll the per-sequence counter the sequences list already renders.
  const perSequence = new Map<string, number>()
  for (const r of rows) perSequence.set(r.sequence_id, (perSequence.get(r.sequence_id) ?? 0) + 1)

  for (const [sequenceId, count] of perSequence) {
    const { data: seq } = await svc
      .from("campaign_sequences")
      .select("conversions_total")
      .eq("id", sequenceId)
      .maybeSingle()
    await svc
      .from("campaign_sequences")
      .update({ conversions_total: Number(seq?.conversions_total ?? 0) + count })
      .eq("id", sequenceId)
  }

  return {
    transactionId,
    enrollmentsConverted: rows.length,
    sequencesCredited: [...perSequence.keys()],
  }
}
