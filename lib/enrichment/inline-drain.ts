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
 * omitted (the default drain, inside the app runtime only). `seams` are proof doors for the DEFAULT path only:
 * `defaultDrain` replaces the orchestrator, `loadAfter` replaces the import of Next's after-response hook.
 */
export function dispatchInlineEnrichmentDrain(
  target: InlineDrainTarget,
  drain?: InlineEnrichmentDrain | false,
  seams: { defaultDrain?: InlineEnrichmentDrain; loadAfter?: AfterLoader } = {},
): InlineDrainDispatch {
  if (drain === false) return { dispatched: false, reason: "caller_opted_out" }
  let fn: InlineEnrichmentDrain | null = null
  let reason: InlineDrainDispatch["reason"]
  if (drain) { fn = drain; reason = "injected" }
  else {
    const why = inlineDrainEnabledByDefault()
    if (!why) return { dispatched: false, reason: process.env.ENRICHMENT_INLINE_DRAIN === "off" ? "env_off" : "not_app_runtime" }
    fn = seams.defaultDrain ?? defaultInlineDrain; reason = why
  }
  const run = fn
  // Deferred to the microtask queue so the writer's own return value settles first; the catch is the
  // whole error policy — a failed inline drain is the cron's row, not the create door's failure.
  const attempt = (): Promise<void> => Promise.resolve()
    .then(() => run(target))
    .then(() => undefined)
    .catch((err) => console.error(`[enrichment] inline drain for queue row ${target.queueEntryId} failed (the cron backstop will retry):`, err instanceof Error ? err.message : String(err)))
  // An INJECTED seam (a proof, a canary) runs on the next turn exactly as before — no Next runtime is in play. The DEFAULT
  // drain runs inside the app server, where a serverless function is frozen once its response is sent: it is handed to the
  // platform's after-response hook so the function stays alive until the drain settles (wave 143, lane 143D).
  if (reason === "injected") void attempt()
  else void scheduleAfterResponse(attempt, seams.loadAfter)
  return { dispatched: true, reason }
}

/** Loads Next's after-response hook (a seam so a proof can hand in a recorder, a thrower, or leave the real one). */
type AfterLoader = () => Promise<(callback: () => Promise<unknown>) => void>

/**
 * WAVE 143 (lane 143D) — KEEP THE FUNCTION ALIVE UNTIL THE DRAIN SETTLES. At HEAD the default drain was a bare
 * `void Promise.resolve().then(…)`: correct on a long-lived Node process, but on Vercel a function's work after its response
 * is sent is not guaranteed to run (the instance can be frozen), so "enrich as soon as it comes in" quietly became "enrich on
 * the cron" for exactly the doors (form submits, server actions) that matter most — the cron backstop caught it, 15 minutes
 * late. Next 16's `after()` (next/server) schedules work to run after the response and keeps the invocation alive for it.
 * `after()` THROWS outside a request scope (verified on next@16.2.7: "`after` was called outside a request scope"), so a cron
 * run, a script or an import failure falls back to the bare run — the SAME behaviour as before, never a lost drain and
 * never a thrown error into the capture. The capture is never awaited on either path.
 */
async function scheduleAfterResponse(
  job: () => Promise<unknown>,
  loadAfter: AfterLoader = async () => (await import("next/server")).after as (callback: () => Promise<unknown>) => void,
): Promise<"after" | "bare"> {
  try {
    const after = await loadAfter()
    after(job)
    return "after"
  } catch {
    // outside a request scope (or Next unavailable): the bare run — the pre-143D behaviour, the cron stays the backstop
    void job()
    return "bare"
  }
}
