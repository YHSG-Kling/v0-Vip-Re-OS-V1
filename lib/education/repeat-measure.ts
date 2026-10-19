// lib/education/repeat-measure.ts
// ─────────────────────────────────────────────────────────────────────────────
// DID THE REPEATS DECREASE? (wave 142, lane 142G; owner: "new education pieces created if subject keeps coming up
// … measure whether repeats decrease"). The curriculum author (lib/education/curriculum-author.ts) proposes an
// AI-authored lesson / help article from a RECURRING signal (support tickets, assistant questions, compliance
// flags, weak drills) and stamps the recurrence count it saw on the proposal's evidence row
// (education.gap_proposed, "the counter the proposal carries"). Once the asset has been PUBLISHED for a full
// window, this module re-counts the SAME topic through the SAME gatherer over the window before and the window
// after publication, writes the verdict as evidence (education.repeat_measured) and, when the repeats did NOT
// decrease, tells the education owner on the bus (education_repeat_finding → recruiting_manager, feed-only: a
// human decides whether to re-author, re-deliver or retire — never an automatic re-author loop).
//
// Honest by construction: one measurement per published asset (deduped on the evidence row); a topic with no
// signal in a window counts as 0 (silence IS the decrease we hoped for); a module without a proposal row gets
// its baseline re-gathered and the evidence says so (baseline_source). Pure trend + a gatherer seam the proof
// injects; no model call anywhere.

import type { ManagerKey } from "@/lib/kernel/manager-registry"
import { EDUCATION_PROPOSED_EVENT } from "@/lib/education/curriculum-author"

type Svc = any

const REPEAT_MEASURE_WINDOW_DAYS = 30
/** @proofSeam the proof reads the evidence rows by this type */
export const EDUCATION_REPEAT_EVENT = "education.repeat_measured"
/** @proofSeam the proof reads the finding signals by this type (catalogued in lib/kernel/signal-registry.ts) */
export const EDUCATION_REPEAT_SIGNAL_TYPE = "education_repeat_finding"
/** The education owner (MAINTENANCE_DOMAINS.curriculum_author) and the operational reporter the bus already uses. */
/** @proofSeam the proof asserts the finding reaches this owner */
export const EDUCATION_REPEAT_OWNER: ManagerKey = "recruiting_manager"
const EDUCATION_REPEAT_REPORTER: ManagerKey = "cron_manager"
/** The gap-tag prefixes the author stamps for recurrence-driven assets (the measurable ones). */
const MEASURABLE_TAG = /^(support|question|compliance|objection):/

type RepeatTrend = "decreased" | "unchanged" | "increased" | "no_baseline"

/** PURE: the verdict. A null baseline (never counted) cannot be compared; silence after (0) is a decrease. */
/** @proofSeam the proof asserts the four verdicts directly */
export function repeatTrend(before: number | null, after: number): RepeatTrend {
  if (before === null || !Number.isFinite(before)) return "no_baseline"
  if (after < before) return "decreased"
  if (after > before) return "increased"
  return "unchanged"
}

interface RepeatMeasureDeps {
  /** The ONE gatherer (curriculum-author gatherGapSignals) — the proof injects a deterministic one. */
  gather?: (svc: Svc, brokerageId: string, until: Date, opts: { window: { since: Date; until: Date } }) => Promise<Array<{ topicKey: string; weakCount: number }>>
  now?: Date
}

interface RepeatMeasureResult { modules: number; measured: number; decreased: number; findings: number; skipped: number; errors: string[] }

const defaultGather: NonNullable<RepeatMeasureDeps["gather"]> = async (svc, brokerageId, until, opts) => {
  const { gatherGapSignals } = await import("@/lib/education/curriculum-author")
  return gatherGapSignals(svc, brokerageId, until, opts)
}

/**
 * Measure every PUBLISHED AI-authored asset on this tenant whose after-window has elapsed and that has not been
 * measured yet. Never throws; refused reads are counted in `errors` (a refused read is never "no modules").
 */
export async function measureEducationRepeats(svc: Svc, params: { brokerageId: string }, deps: RepeatMeasureDeps = {}): Promise<RepeatMeasureResult> {
  const out: RepeatMeasureResult = { modules: 0, measured: 0, decreased: 0, findings: 0, skipped: 0, errors: [] }
  const now = deps.now ?? new Date()
  const gather = deps.gather ?? defaultGather
  const windowMs = REPEAT_MEASURE_WINDOW_DAYS * 86_400_000
  const cutoff = new Date(now.getTime() - windowMs).toISOString()

  const { data: mods, error } = await svc.from("learning_modules")
    .select("id, gap_tags, published_at, status, is_ai_generated")
    .eq("brokerage_id", params.brokerageId).eq("is_ai_generated", true).eq("status", "published").lte("published_at", cutoff).limit(200)
  if (error) { out.errors.push(`learning_modules read refused: ${error.message}`); return out }

  for (const m of (mods ?? []) as Array<{ id: string; gap_tags: string[] | null; published_at: string | null }>) {
    out.modules++
    const topicKey = (m.gap_tags ?? []).find((t) => MEASURABLE_TAG.test(String(t))) ?? null
    if (!topicKey || !m.published_at) { out.skipped++; continue }

    // Once per asset — the evidence row is the dedupe.
    const { data: done, error: doneErr } = await svc.from("lifecycle_events").select("id")
      .eq("event_type", EDUCATION_REPEAT_EVENT).eq("entity_type", "learning_module").eq("entity_id", m.id).limit(1)
    if (doneErr) { out.errors.push(`${m.id}: dedupe read refused: ${doneErr.message}`); continue }
    if (((done ?? []) as unknown[]).length > 0) { out.skipped++; continue }

    const published = new Date(m.published_at)
    const before = { since: new Date(published.getTime() - windowMs), until: published }
    const after = { since: published, until: new Date(published.getTime() + windowMs) }

    // Baseline: the counter the proposal carried; else re-gathered (and the evidence says which).
    let baseline: number | null = null
    let baselineSource: "proposal_row" | "regathered" | "none" = "none"
    const { data: prop, error: propErr } = await svc.from("lifecycle_events").select("id, metadata")
      .eq("event_type", EDUCATION_PROPOSED_EVENT).eq("entity_type", "learning_module").eq("entity_id", m.id).limit(1)
    if (propErr) out.errors.push(`${m.id}: proposal read refused: ${propErr.message}`)
    const carried = ((prop ?? []) as Array<{ metadata?: Record<string, unknown> | null }>)[0]?.metadata?.repeats_before
    if (typeof carried === "number") { baseline = carried; baselineSource = "proposal_row" }
    else {
      try { baseline = (await gather(svc, params.brokerageId, before.until, { window: before })).find((s) => s.topicKey === topicKey)?.weakCount ?? 0; baselineSource = "regathered" }
      catch (e) { out.errors.push(`${m.id}: baseline gather failed: ${e instanceof Error ? e.message : String(e)}`) }
    }

    let afterCount = 0
    try { afterCount = (await gather(svc, params.brokerageId, after.until, { window: after })).find((s) => s.topicKey === topicKey)?.weakCount ?? 0 }
    catch (e) { out.errors.push(`${m.id}: after gather failed: ${e instanceof Error ? e.message : String(e)}`); continue }

    const trend = repeatTrend(baseline, afterCount)
    try {
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      const ev = await emitKernelEvent({
        event: EDUCATION_REPEAT_EVENT, brokerageId: params.brokerageId, entityType: "learning_module", entityId: m.id, auditOnly: true, client: svc,
        dedupeKey: `repeat:${m.id}`, dedupeWindowSec: 7 * 86_400,
        metadata: { topic_key: topicKey, before: baseline, after: afterCount, trend, baseline_source: baselineSource, window_days: REPEAT_MEASURE_WINDOW_DAYS, published_at: m.published_at, measured_at: now.toISOString() },
      })
      if (!ev.inserted) { out.errors.push(`${m.id}: evidence row refused: ${ev.error ?? "not inserted"}`); continue }
    } catch (e) { out.errors.push(`${m.id}: evidence row failed: ${e instanceof Error ? e.message : String(e)}`); continue }
    out.measured++
    if (trend === "decreased") { out.decreased++; continue }

    // Not decreased (or never comparable) → the education owner's feed, once per asset (the bus dedupes per entity).
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const r = await publishManagerSignal({
        brokerageId: params.brokerageId, fromManager: EDUCATION_REPEAT_REPORTER, toManager: EDUCATION_REPEAT_OWNER,
        signalType: EDUCATION_REPEAT_SIGNAL_TYPE, entityType: "learning_module", entityId: m.id,
        message: trend === "no_baseline"
          ? `A published AI lesson (${topicKey.replace(/_/g, " ")}) has no recurrence baseline to compare against — ${afterCount} repeat(s) in the ${REPEAT_MEASURE_WINDOW_DAYS} days after it went live.`
          : `A published AI lesson (${topicKey.replace(/_/g, " ")}) did not reduce the repeats: ${baseline} before → ${afterCount} after (${REPEAT_MEASURE_WINDOW_DAYS}-day windows). Re-author, re-deliver or retire?`,
        payload: { topic_key: topicKey, before: baseline, after: afterCount, trend, baseline_source: baselineSource },
      }, svc)
      if (r.ok) out.findings++
      else out.errors.push(`${m.id}: finding not published: ${r.reason}`)
    } catch (e) { out.errors.push(`${m.id}: finding failed: ${e instanceof Error ? e.message : String(e)}`) }
  }
  return out
}

/** Autonomous: measure across every brokerage (rides the weekly education-delivery cron beside the author). */
export async function runEducationRepeatMeasureAll(svc: Svc, deps: RepeatMeasureDeps = {}): Promise<{ brokerages: number; measured: number; findings: number; errors: number }> {
  const out = { brokerages: 0, measured: 0, findings: 0, errors: 0 }
  const { data: rows, error } = await svc.from("brokerages").select("id").limit(1000)
  if (error) { console.error("[repeat-measure] brokerages read refused:", error.message); return out }
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await measureEducationRepeats(svc, { brokerageId: b.id }, deps); out.measured += r.measured; out.findings += r.findings; out.errors += r.errors.length }
    catch (e) { out.errors++; console.error("[repeat-measure]", b.id, e instanceof Error ? e.message : String(e)) }
  }
  return out
}
