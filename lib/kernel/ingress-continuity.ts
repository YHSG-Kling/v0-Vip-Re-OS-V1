// lib/kernel/ingress-continuity.ts
//
// INGRESS CONTINUITY (cron_manager) — the owner's Continuity Engine vision,
// ingress half: "data gets stuck between one webhook and where it belongs."
// A provider webhook that arrives and matches NOTHING is today's silent loss:
// the route returns 200 (so the provider never retries) and the signal —
// e.g. "this envelope is fully signed" — evaporates. The classic cause is a
// RACE (the provider fires before our dispatch stamps the envelope id) or a
// transient DB failure during the match.
//
// The fix is a DEAD-LETTER + RECONCILIATION loop, not a bigger webhook:
//   1. Every e-sign completion webhook, after running the finalizers, PROBES
//      whether the envelope matched ANY artifact of record. Zero matches →
//      the event is parked as an ingress dead letter (never dropped).
//   2. The daily reconciler re-probes each pending letter. The moment the
//      artifact exists (dispatch caught up), it REPLAYS the same idempotent
//      finalizers the webhook would have run — the stuck data flows to where
//      it belongs, and the heal lands on the unified self_heal_events ledger.
//   3. A letter that never matches within INGRESS_MAX_ATTEMPTS is marked
//      abandoned and escalated to platform staff with full context — the
//      exception path, never a silent grave.
//
// Pure decision core (testable). The REPLAY side — the registry of per-kind runners
// and the daily reconciliation worker — lives in lib/kernel/ingress-reconciliation.ts
// (wave 147, integrator: it reuses lib/esign-webhooks/finalize-packet verbatim, and
// that import pulled the whole e-sign finalizer subtree into every page that only
// needed the pull-drift sentinel below — proxy-graph budget).

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/** Daily reconciler ticks a letter gets before it's abandoned + escalated (~1 month of patience). */
export const INGRESS_MAX_ATTEMPTS = 30

export type EsignIngressProvider = "dotloop" | "docusign" | "skyslope" | "authentisign"

export type IngressDecision = "replay" | "wait" | "abandon"

/** PURE: what to do with one pending dead letter this tick. */
export function decideIngressAction(input: { matched: boolean; attempts: number }): IngressDecision {
  if (input.matched) return "replay"
  if (input.attempts + 1 >= INGRESS_MAX_ATTEMPTS) return "abandon"
  return "wait"
}

/**
 * Does this envelope ref match ANY artifact of record? Probes every table the
 * dispatch chain stamps: signature packets (both), offers, listing agreements,
 * voice-cockpit documents, and BBAs. One true = the webhook had somewhere to land.
 */
// Module-private since 2026-09-07 — no importer outside this file (lane O / opposite-missing cascade).
export async function envelopeHasAnyArtifact(svc: Svc, envelopeId: string): Promise<boolean> {
  if (!envelopeId) return false
  const probes = await Promise.all([
    svc.from("signature_requests").select("id", { count: "exact", head: true }).eq("provider_envelope_id", envelopeId),
    svc.from("contract_signatures").select("id", { count: "exact", head: true }).eq("provider_envelope_id", envelopeId),
    svc.from("offers").select("id", { count: "exact", head: true }).eq("provider_envelope_id", envelopeId),
    svc.from("listing_agreements").select("id", { count: "exact", head: true }).eq("provider_ref", envelopeId),
    svc.from("documents").select("id", { count: "exact", head: true }).filter("metadata->>signature_request_id", "eq", envelopeId),
    svc.from("buyer_broker_agreements").select("id", { count: "exact", head: true }).eq("signature_request_id", envelopeId),
  ])
  return probes.some((p) => (p.count ?? 0) > 0)
}

/**
 * Park ANY unmatched ingress event as a dead letter. Idempotent (unique on
 * provider+kind+ref) and best-effort — continuity bookkeeping never fails a
 * webhook response. Each event_kind has a replay runner in the reconciler.
 */
export async function parkIngressEvent(svc: Svc, input: {
  provider: string
  eventKind: string
  externalRef: string
  payload: Record<string, unknown>
}): Promise<{ parked: boolean }> {
  try {
    if (!input.externalRef) return { parked: false }
    const { error: parkErr } = await svc.from("ingress_dead_letters").upsert({
      provider: input.provider,
      event_kind: input.eventKind,
      external_ref: input.externalRef,
      payload: input.payload,
      status: "pending",
    }, { onConflict: "provider,event_kind,external_ref", ignoreDuplicates: true })
    if (parkErr) console.error(`[ingress-continuity] dead letter NOT parked — the event may be lost: ${parkErr.message}`)
    return { parked: true }
  } catch {
    return { parked: false }
  }
}

/** PURE: stable content hash (djb2) — dedupes exact webhook redeliveries of an unreadable payload. */
export function payloadHash(raw: unknown): string {
  const s = JSON.stringify(raw) ?? ""
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Park a payload the schema-adaptation layer could not read (missing required
 * facts) + ledger the escalation. One call from any drifted-connector route.
 */
export async function quarantineDriftedPayload(svc: Svc, input: {
  connector: string
  source: string
  raw: unknown
  missing: string[]
  eventType?: string | null
}): Promise<{ parked: boolean; ref: string }> {
  const ref = `sdq:${input.connector}:${payloadHash(input.raw)}`
  const r = await parkIngressEvent(svc, {
    provider: input.connector,
    eventKind: "schema_drift_quarantine",
    externalRef: ref,
    payload: { source: input.source, event_type: input.eventType ?? null, raw: input.raw, missing: input.missing },
  })
  try {
    const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
    await recordSelfHeal(svc, {
      brokerageId: null, domain: "data_flow", subject: ref, action: "none", outcome: "escalated",
      detail: { flow: "schema_drift", connector: input.connector, missing: input.missing, reason: "provider payload is missing required facts — quarantined for review, never guessed" },
    })
  } catch { /* the parked letter is the record of truth */ }
  return { parked: r.parked, ref }
}

/**
 * PULL-SIDE DRIFT SENTINEL: call after normalizing any provider PULL — when
 * the provider returned rows and the normalizer kept none, the shape has
 * drifted. Ledgers the escalation + quarantines ONE content-hashed sample
 * (the evidence an engineer needs to teach the contract), deduped so a
 * drifting provider doesn't flood the queue. Best-effort, never throws.
 */
export async function reportPullDrift(svc: Svc, input: {
  connector: string
  source: string
  received: number
  kept: number
  sample: unknown
}): Promise<{ drifted: boolean }> {
  try {
    const { detectPullDrift } = await import("@/lib/kernel/schema-adaptation")
    const verdict = detectPullDrift({ received: input.received, kept: input.kept })
    if (!verdict.drifted) return { drifted: false }
    await quarantineDriftedPayload(svc, {
      connector: input.connector,
      source: input.source,
      raw: input.sample,
      missing: ["(pull drift — all rows dropped by the normalizer)"],
      eventType: null,
    })
    return { drifted: true }
  } catch {
    return { drifted: false }
  }
}

/**
 * Call from every e-sign completion webhook AFTER the finalizers ran: if the
 * envelope matched nothing, park it as a dead letter instead of losing it.
 */
export async function ensureEsignIngressContinuity(svc: Svc, input: {
  provider: EsignIngressProvider
  envelopeId: string | null
}): Promise<{ parked: boolean }> {
  try {
    if (!input.envelopeId) return { parked: false }
    const matched = await envelopeHasAnyArtifact(svc, input.envelopeId)
    if (matched) return { parked: false }
    return await parkIngressEvent(svc, {
      provider: input.provider,
      eventKind: "esign_envelope_completed",
      externalRef: input.envelopeId,
      payload: { envelopeId: input.envelopeId, provider: input.provider },
    })
  } catch {
    return { parked: false }
  }
}

// TOMBSTONE (wave 147, integrator, 2026-10-31): IngressReconciliationResult, ReplayAttempt, DeadLetterRow, attemptReplay and
// runIngressReconciliation MOVED verbatim to lib/kernel/ingress-reconciliation.ts. Reason: proxy-graph budget — the replay
// registry imports lib/esign-webhooks/finalize-packet (and the Meta / ShowingTime ingest rails), 24–32 modules that every page
// reaching reportPullDrift (lib/property/rentcast.ts, lib/external/batchdata-client.ts) was paying for without ever replaying a
// dead letter. The one caller of the worker, app/api/cron/deal-health-scan/route.ts, imports the new module. Nothing else changed.
