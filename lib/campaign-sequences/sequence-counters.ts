// lib/campaign-sequences/sequence-counters.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SEQUENCE LIST'S TWO COUNTERS, RECONCILED FROM THE ENROLLMENTS (wave 84E).
//
// campaign_sequences carries three rolled-up counters the sequences list
// (app/dashboard/campaigns/sequences/SequencesListClient.tsx: "enrolled",
// "completed", completion %) and the lifetime gifting panel
// (app/lifetime-customers/components/campaigns-gifting-panel.tsx) render:
//
//   enrollments_total  — bumped by rpc('increment_sequence_enrollments') on THREE of
//                        the SEVEN enrollment writers (enrollment-engine, enroll-in-
//                        sequence, event-fanout). auto-enroll, long-term-nurture,
//                        voice-delegation and /api/workflow/trigger insert without it,
//                        so the tile under-counted by design.
//   completions_total  — written exactly once, as `0` at sequence creation
//                        (app/actions/campaign-sequences.ts). NO writer ever moved it:
//                        no rpc, no trigger (read live 2026-09-26: 0 triggers on
//                        sequence_enrollments / campaign_sequences; the only counter
//                        function is increment_sequence_enrollments). Every sequence
//                        read "0 completed · 0%" forever — the same permanent-zero class
//                        lib/campaign-sequences/sequence-conversion.ts closed for
//                        conversions_total. opposite-missing 1b cannot see it: a
//                        constant `0` at creation counts as a writer.
//   conversions_total  — owned by sequence-conversion.ts (incremented when a deal closes);
//                        NOT touched here.
//
// The missing half is built as a RECONCILIATION, not a seventh increment site: the
// counters are recomputed from sequence_enrollments (the one truth) on the daily
// marketing-attribution-engine cron that already rolls conversions_total. Idempotent,
// self-healing for every writer that skipped the rpc, and it never needs a new DB
// function (no migration).
//
// COMPLETION means the enrollment ran to its end: status 'completed', or 'converted'
// with a completed_at (sequence-conversion flips completed → converted and keeps the
// timestamp). 'unenrolled' also stamps completed_at (enrollment-engine unenrollContact)
// and is NOT a completion — the same rule app/actions/workflow-reports.ts applies to its
// average-completion figure.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface SequenceEnrollmentTallyRow {
  sequence_id: string
  status: string | null
  completed_at: string | null
}

/** PURE — did this enrollment run to its end? (unenrolled is a pull-out, not a finish) */
export function isSequenceCompletion(row: Pick<SequenceEnrollmentTallyRow, "status" | "completed_at">): boolean {
  if (row.status === "completed") return true
  return row.status === "converted" && !!row.completed_at
}

/** PURE — per-sequence enrollments / completions from the enrollment rows. */
export function tallySequenceCounters(rows: ReadonlyArray<SequenceEnrollmentTallyRow>): Map<string, { enrollments: number; completions: number }> {
  const out = new Map<string, { enrollments: number; completions: number }>()
  for (const r of rows) {
    if (!r.sequence_id) continue
    const cur = out.get(r.sequence_id) ?? { enrollments: 0, completions: 0 }
    cur.enrollments += 1
    if (isSequenceCompletion(r)) cur.completions += 1
    out.set(r.sequence_id, cur)
  }
  return out
}

export interface SequenceCounterRollup {
  sequencesRead: number
  enrollmentsRead: number
  updated: number
  unchanged: number
  /** Updates that resolved with 0 rows (§3: a matched-nothing write is not a success). */
  unmatched: number
  /** A refused read/write, by table — never rendered as "nothing to do". */
  refused: Record<string, string>
}

const PAGE = 1000

/**
 * Recompute campaign_sequences.enrollments_total / completions_total from
 * sequence_enrollments and write only the rows that drifted. Service client
 * (cron): every tenant's sequences, each counter derived from that sequence's own
 * enrollments, so no value crosses a tenant.
 */
export async function rollupSequenceCounters(svc: Pick<SupabaseClient, "from">): Promise<SequenceCounterRollup> {
  const out: SequenceCounterRollup = { sequencesRead: 0, enrollmentsRead: 0, updated: 0, unchanged: 0, unmatched: 0, refused: {} }

  const sequences: Array<{ id: string; enrollments_total: number | null; completions_total: number | null }> = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc.from("campaign_sequences")
      .select("id, enrollments_total, completions_total")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { out.refused.campaign_sequences = error.message; return out }
    const rows = (data ?? []) as typeof sequences
    sequences.push(...rows)
    if (rows.length < PAGE) break
  }
  out.sequencesRead = sequences.length
  if (sequences.length === 0) return out

  const enrollments: SequenceEnrollmentTallyRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc.from("sequence_enrollments")
      .select("sequence_id, status, completed_at")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { out.refused.sequence_enrollments = error.message; return out }
    const rows = (data ?? []) as SequenceEnrollmentTallyRow[]
    enrollments.push(...rows)
    if (rows.length < PAGE) break
  }
  out.enrollmentsRead = enrollments.length

  const tally = tallySequenceCounters(enrollments)
  for (const s of sequences) {
    const t = tally.get(s.id) ?? { enrollments: 0, completions: 0 }
    if (Number(s.enrollments_total ?? 0) === t.enrollments && Number(s.completions_total ?? 0) === t.completions) {
      out.unchanged += 1
      continue
    }
    const { data, error } = await svc.from("campaign_sequences")
      .update({ enrollments_total: t.enrollments, completions_total: t.completions })
      .eq("id", s.id)
      .select("id")
    if (error) { out.refused.campaign_sequences_update = error.message; continue }
    if (!data || data.length === 0) { out.unmatched += 1; continue }
    out.updated += 1
  }
  return out
}
