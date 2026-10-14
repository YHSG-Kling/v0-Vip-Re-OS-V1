// lib/lead-pipeline/source-lifetime-health-runner.ts
//
// Live side of SOURCE LIFETIME-HEALTH attribution — the close-rate learner (source-conversion-runner)
// stops at lead→contact→close, but a source can convert cheaply and still produce relationships that
// rot. This runner walks the FULL lifetime arc: leads.source → the contact each lead became → that
// contact's live relationship-health band (thriving … dormant), folds it through the pure
// aggregateSourceHealth grader, and RECORDS each source's verdict onto the existing ai_feedback_log
// (system "source_lifetime_health", keyed by source) so scraper source viability accumulates lifetime
// quality over time — not just first-close conversion. Read-mostly (one feedback row per source per
// run); never throws into the caller.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { aggregateSourceHealth, type SourceHealthInput, type SourceHealthSummary } from "./source-health"
import { getHealthPrioritizedContacts } from "@/lib/intelligence/health-prioritizer-runner"
import { recordLearningOutcome } from "@/lib/intelligence/learning-outcomes-runner"
// Same walk, different axis: this runner grades SOURCES by lifetime health; the
// autopsy grades CHANNELS by which one earned the last engagement before the fork.
import { outcomeAutopsy, aggregateAutopsyByChannel, type AutopsyRecord, type AutopsyTouch, type ChannelOutcomeStat } from "@/lib/intelligence/outcome-autopsy"

type Svc = ReturnType<typeof createServiceClient>

export interface SourceLifetimeHealthResult {
  summaries: SourceHealthSummary[]
  /** sources graded a money-pit: they convert but the relationships fade (cheap_but_fading). */
  fading: string[]
  /** sources that produce relationships that LAST (lasting). */
  lasting: string[]
  outcomesRecorded: number
  /**
   * Which CHANNEL earned the last engagement before a relationship reached thriving
   * (win) or churned to dormant (loss). Reply rate says what gets opened; this says
   * what actually preceded the outcome.
   */
  channelOutcomes: ChannelOutcomeStat[]
}

/**
 * Compute + record per-source lifetime health for a brokerage over a trailing window.
 *
 * @param opts.recordOutcomes — persist each source verdict onto ai_feedback_log (default true). The
 *        verdict maps to an outcome: lasting → win, cheap_but_fading → loss, else neutral — so the
 *        source's lifetime track record builds over runs (read back by the source viability loop).
 */
export async function loadSourceLifetimeHealth(
  brokerageId: string,
  opts: { sinceDays?: number; minVolume?: number; recordOutcomes?: boolean; now?: string } = {},
  client?: Svc,
): Promise<SourceLifetimeHealthResult> {
  const svc = client ?? createServiceClient()
  const empty: SourceLifetimeHealthResult = { summaries: [], fading: [], lasting: [], outcomesRecorded: 0, channelOutcomes: [] }
  const since = new Date(Date.now() - (opts.sinceDays ?? 180) * 86_400_000).toISOString()

  // 1. The arc's first leg: which CONVERTED contact each source produced.
  const { data: leads } = await svc.from("leads")
    .select("source, contact_id")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", since)
    .not("contact_id", "is", null)
    .limit(10_000)
  const leadRows = (leads ?? []) as { source: string | null; contact_id: string | null }[]
  if (leadRows.length === 0) return empty

  // A contact can be reached by more than one source row; first non-null source wins (the origin).
  const sourceByContact = new Map<string, string>()
  for (const l of leadRows) {
    if (l.contact_id && l.source && !sourceByContact.has(l.contact_id)) sourceByContact.set(l.contact_id, l.source)
  }
  if (sourceByContact.size === 0) return empty

  // 2. The arc's second leg: the LIVE relationship-health band of each produced contact. Reuse the
  //    canonical health computation (no drift) and index by contact.
  const ranked = await getHealthPrioritizedContacts(svc, brokerageId, { limit: 10_000, now: opts.now })
  const bandByContact = new Map(ranked.map((r) => [r.contactId, r.band]))

  // 3. Grade each source by the lifetime health of the contacts it actually produced (pure).
  const items: SourceHealthInput[] = []
  for (const [contactId, source] of sourceByContact) {
    const band = bandByContact.get(contactId)
    if (band) items.push({ source, band })
  }
  if (items.length === 0) return empty
  const summaries = aggregateSourceHealth(items, { minVolume: opts.minVolume })

  // 4. RECORD each source's verdict so scraper viability accumulates lifetime quality over time.
  let outcomesRecorded = 0
  if (opts.recordOutcomes !== false) {
    for (const s of summaries) {
      if (s.verdict === "insufficient_data") continue // don't teach on thin data
      const outcome = s.verdict === "lasting" ? "win" : s.verdict === "cheap_but_fading" ? "loss" : "neutral"
      const r = await recordLearningOutcome({
        brokerageId,
        system: "source_lifetime_health",
        outcome,
        label: `${s.source}: ${s.verdict} (${Math.round(s.healthRate * 100)}% lasting over ${s.total})`,
        detail: { source: s.source, verdict: s.verdict, healthRate: s.healthRate, total: s.total, healthy: s.healthy, decayed: s.decayed },
      }, svc).catch(() => ({ ok: false }))
      if ((r as any).ok) outcomesRecorded++
    }
  }

  // 5. WIN/LOSS AUTOPSY — only the decided ends of the band count as an outcome; the
  //    middle is still in play and would dilute the signal.
  const decided: Array<{ contactId: string; outcome: "win" | "loss" }> = []
  for (const r of ranked) {
    if (r.band === "thriving") decided.push({ contactId: r.contactId, outcome: "win" })
    else if (r.band === "dormant") decided.push({ contactId: r.contactId, outcome: "loss" })
  }
  let channelOutcomes: ChannelOutcomeStat[] = []
  if (decided.length > 0) {
    const ids = decided.map((d) => d.contactId).slice(0, 1000)
    const { data: msgs } = await svc
      .from("messages")
      .select("contact_id, type, direction, created_at")
      .eq("brokerage_id", brokerageId)
      .in("contact_id", ids)
    const touchesByContact = new Map<string, AutopsyTouch[]>()
    for (const m of (msgs ?? []) as any[]) {
      const list = touchesByContact.get(m.contact_id) ?? []
      // An INBOUND message IS the reply — that is what replied_at marks here.
      list.push({
        channel: m.type ?? null,
        at: m.created_at ?? null,
        replied_at: m.direction === "inbound" ? (m.created_at ?? null) : null,
      })
      touchesByContact.set(m.contact_id, list)
    }
    const records: AutopsyRecord[] = decided
      .filter((d) => touchesByContact.has(d.contactId))
      .map((d) => outcomeAutopsy(touchesByContact.get(d.contactId)!, d.outcome))
    channelOutcomes = aggregateAutopsyByChannel(records)
  }

  return {
    summaries,
    fading: summaries.filter((s) => s.verdict === "cheap_but_fading").map((s) => s.source),
    lasting: summaries.filter((s) => s.verdict === "lasting").map((s) => s.source),
    outcomesRecorded,
    channelOutcomes,
  }
}
