/**
 * lib/enrichment/inline-drain.ts — ENRICH AS SOON AS THE ROW COMES IN (wave 142, lane 142D).
 *
 * Owner, verbatim: "enrichment should happen as soon as a new contact or form submission comes in."
 * At HEAD every create door already QUEUED a lead_enrichment_queue row (the ONE writer per track —
 * lib/enrichment/contact-enrichment-core.ts queueContactEnrichment / lead-enrichment-core.ts
 * queueLeadEnrichment), but the row was DRAINED only by the 15-minute cron
 * (app/api/cron/enrichment-processor → lib/lead-pipeline/enrichment-orchestrator.ts processEnrichmentQueue).
 * So "as soon as" meant "within a quarter of an hour", and a form confirmation that needed the enriched
 * person had nothing to show.
 *
 * THIS MODULE IS THE DISPATCH, NOT A SECOND DRAINER (LAW 2 — one canonical path): the SAME
 * processEnrichmentQueue runs, for the ONE row just written (`opts.queueEntryId`), fire-and-forget, right
 * after the queue write. Every gate the drain already applies — the owner's live-deal suppression, the
 * vendor budget pre-flight, the provider route, the per-decision purchase rule, consent/DNC scrubs,
 * provenance — applies unchanged; the cron stays the backstop for every row the inline run could not finish
 * (a budget refusal, a provider in cool-down, a process that died mid-row). The create door is NEVER blocked:
 * the dispatch returns before the drain has done anything, and a drain that throws is logged, never raised.
 *
 * WHEN THE DEFAULT DRAIN RUNS. Only inside the application server (NEXT_RUNTIME is set — Next.js defines it
 * for every server bundle), or when ENRICHMENT_INLINE_DRAIN=on says so explicitly; ENRICHMENT_INLINE_DRAIN=off
 * is the kill switch. A script, a proof or a canary that drives a queue writer therefore never reaches a
 * provider by accident (the drain's free OSINT lane is real egress) — it injects `inlineDrain` to prove the
 * dispatch, or passes `false` to opt out. PURE (no server-only, no client): the drain itself is imported
 * lazily so this module never pulls the orchestrator's graph into a queue writer's importers.
 */

export interface InlineDrainTarget {
  brokerageId: string
  queueEntryId: string
}

/** The drain to run for ONE queue row — the default is processEnrichmentQueue(brokerageId, { queueEntryId }). */
export type InlineEnrichmentDrain = (target: InlineDrainTarget) => Promise<unknown>

export interface InlineDrainDispatch {
  dispatched: boolean
  reason: "injected" | "app_runtime" | "env_on" | "caller_opted_out" | "not_app_runtime" | "env_off"
}

/** PURE — does the DEFAULT drain run here? (The injected seam always runs.) */
export function inlineDrainEnabledByDefault(env: Record<string, string | undefined> = process.env): InlineDrainDispatch["reason"] | null {
  if (env.ENRICHMENT_INLINE_DRAIN === "off") return null
  if (env.ENRICHMENT_INLINE_DRAIN === "on") return "env_on"
  return env.NEXT_RUNTIME ? "app_runtime" : null
}

const defaultInlineDrain: InlineEnrichmentDrain = async (target) => {
  const { processEnrichmentQueue } = await import("@/lib/lead-pipeline/enrichment-orchestrator")
  return processEnrichmentQueue(target.brokerageId, { queueEntryId: target.queueEntryId })
}

/**
 * Fire-and-forget: schedule the drain for the row just written and return at once. Never throws, never
 * awaits the drain. `drain` — an injected seam (always runs), `false` (the caller opts out: cron only), or
 * omitted (the default drain, inside the app runtime only).
 */
export function dispatchInlineEnrichmentDrain(target: InlineDrainTarget, drain?: InlineEnrichmentDrain | false): InlineDrainDispatch {
  if (drain === false) return { dispatched: false, reason: "caller_opted_out" }
  let fn: InlineEnrichmentDrain | null = null
  let reason: InlineDrainDispatch["reason"]
  if (drain) { fn = drain; reason = "injected" }
  else {
    const why = inlineDrainEnabledByDefault()
    if (!why) return { dispatched: false, reason: process.env.ENRICHMENT_INLINE_DRAIN === "off" ? "env_off" : "not_app_runtime" }
    fn = defaultInlineDrain; reason = why
  }
  const run = fn
  // Deferred to the microtask queue so the writer's own return value settles first; the catch is the
  // whole error policy — a failed inline drain is the cron's row, not the create door's failure.
  void Promise.resolve()
    .then(() => run(target))
    .catch((err) => console.error(`[enrichment] inline drain for queue row ${target.queueEntryId} failed (the cron backstop will retry):`, err instanceof Error ? err.message : String(err)))
  return { dispatched: true, reason }
}
