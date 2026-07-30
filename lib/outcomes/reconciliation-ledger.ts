// lib/outcomes/reconciliation-ledger.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE WRITE SIDE OF OUTCOME RECONCILIATION.
//
// Two entry points, and the asymmetry between them is the design:
//
//   recordOutcomeClaim   called at DISPATCH time, by the sender. Opens a row at
//                        verdict 'pending' — never 'confirmed'. Handing something to
//                        a provider is not proof it arrived, and the OS used to treat
//                        those as the same fact.
//   ingestProviderTruth  called by a PROVIDER WEBHOOK. Reconciles against the open
//                        row and, when the provider contradicts us, escalates to the
//                        manager that made the claim.
//
// A contradiction is the only state that raises anybody. Confirmation is silent —
// a team that announces its successes is noise; a team that announces the touch a
// client never received is doing its job.
//
// Never throws. A reconciliation failure must not fail a send (the send already
// happened) and must not fail a webhook (the provider will stop retrying and the
// truth is lost forever). Both callers get a result they can log.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import {
  reconcile,
  TRUTH_SOURCES,
  type OutcomeChannel,
  type ProviderTruth,
  type ReconciliationVerdict,
} from "./reconciliation"

/** The signal a contradicted outcome publishes. Catalogued in signal-registry. */
export const OUTCOME_CONTRADICTED_SIGNAL = "outcome_contradicted" as const

export interface RecordClaimInput {
  brokerageId: string
  channel: OutcomeChannel
  /** The provider's id for what we sent. Without it the claim can never be proven. */
  providerRef: string | null
  claimedStatus: string
  entityType?: string | null
  entityId?: string | null
  contactId?: string | null
  leadId?: string | null
  /** The manager accountable for this touch — it hears about a contradiction. */
  claimedByManager?: ManagerKey | null
}

/**
 * Open a reconciliation row at dispatch time.
 *
 * A claim with NO providerRef on a verifiable lane is recorded as `pending` with the
 * reference missing — deliberately visible, because a send we cannot correlate is a
 * send we can never prove, and that is worth seeing rather than silently dropping.
 */
export async function recordOutcomeClaim(
  input: RecordClaimInput,
): Promise<{ ok: boolean; id?: string; reason?: string }> {
  try {
    const svc = createServiceClient()
    const spec = TRUTH_SOURCES[input.channel]
    const verdict: ReconciliationVerdict = spec.source === null ? "unverifiable" : "pending"

    const row = {
      brokerage_id: input.brokerageId,
      channel: input.channel,
      provider_ref: input.providerRef,
      claimed_status: input.claimedStatus,
      claimed_at: new Date().toISOString(),
      verdict,
      truth_source: spec.source,
      explanation: spec.source === null
        ? `The ${input.channel} lane has no provider signal that could prove this.`
        : `Handed to the provider; ${spec.source} has not reported yet.`,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      contact_id: input.contactId ?? null,
      lead_id: input.leadId ?? null,
      claimed_by_manager: input.claimedByManager ?? null,
      updated_at: new Date().toISOString(),
    }

    // A retried dispatch can reuse a provider ref; upsert on the unique
    // (channel, provider_ref) so the ledger holds ONE row per touch. Rows with a
    // null ref cannot conflict, so they insert.
    const { data, error } = input.providerRef
      ? await svc.from("outcome_reconciliations")
          .upsert(row, { onConflict: "channel,provider_ref" })
          .select("id").maybeSingle()
      : await svc.from("outcome_reconciliations")
          .insert(row).select("id").maybeSingle()

    if (error) return { ok: false, reason: error.message }
    return { ok: true, id: (data as { id: string } | null)?.id }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export interface IngestTruthResult {
  ok: boolean
  verdict: ReconciliationVerdict | null
  /** True when this call flipped a claim to contradicted AND told a manager. */
  escalated: boolean
  /**
   * The brokerage that owns the touch, when the reference matched a claim.
   *
   * Returned so a webhook can scope its OWN follow-up reads by tenant. A provider
   * reference is globally unique, so a webhook is tempted to look up the related row
   * by reference alone — and test:tenant-scope is right to refuse that: with
   * platform-managed Twilio subaccounts two tenants can share an account, and
   * "unique in practice" is not a tenancy boundary. The ledger row is the authority
   * on whose touch this was, and this hands that authority to the caller.
   */
  brokerageId?: string
  reason?: string
}

/**
 * A provider reports. Reconcile, persist, and escalate a contradiction ONCE.
 *
 * Correlation is by (channel, provider_ref) — the provider's own id, which is the
 * only correlation that cannot be wrong. An unknown reference is NOT an error and
 * NOT a new row: it means the webhook is reporting on something this OS did not
 * send (a hand-sent test from the provider console, another environment sharing the
 * account), and inventing a claim for it would put a touch in the ledger that never
 * came from us.
 */
export async function ingestProviderTruth(input: {
  channel: OutcomeChannel
  providerRef: string
  truth: ProviderTruth
}): Promise<IngestTruthResult> {
  try {
    const svc = createServiceClient()
    const { data: existing } = await svc
      .from("outcome_reconciliations")
      .select("id, brokerage_id, claimed_status, claimed_at, verdict, escalated_at, claimed_by_manager, entity_type, entity_id, contact_id")
      .eq("channel", input.channel)
      .eq("provider_ref", input.providerRef)
      .maybeSingle()

    if (!existing) {
      return { ok: true, verdict: null, escalated: false, reason: "no matching claim — not ours to record" }
    }
    const row = existing as {
      id: string; brokerage_id: string; claimed_status: string; claimed_at: string
      verdict: ReconciliationVerdict; escalated_at: string | null
      claimed_by_manager: string | null; entity_type: string | null
      entity_id: string | null; contact_id: string | null
    }

    const result = reconcile(
      {
        channel: input.channel,
        providerRef: input.providerRef,
        claimedStatus: row.claimed_status,
        claimedAt: row.claimed_at,
      },
      input.truth,
    )

    // NEVER walk a terminal verdict backwards. Twilio can emit a late 'sent' after
    // 'delivered', and Lob emits in_transit events after processed_for_delivery —
    // downgrading a proven outcome to pending would erase the proof.
    const terminal = row.verdict === "confirmed" || row.verdict === "contradicted"
    if (terminal && result.verdict === "pending") {
      return { ok: true, verdict: row.verdict, escalated: false, reason: "already terminal — late in-flight event ignored" }
    }

    await svc.from("outcome_reconciliations").update({
      provider_status: input.truth.status,
      provider_reported_at: input.truth.at,
      provider_detail: input.truth.detail ?? null,
      verdict: result.verdict,
      explanation: result.explanation,
      truth_source: result.truthSource,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id)

    // ── THE LOOP: a false claim reaches the manager that made it ─────────────
    // Once. escalated_at is the guard, so a provider that re-sends a failure event
    // does not re-raise it.
    let escalated = false
    if (result.needsManager && !row.escalated_at) {
      const claimer = (row.claimed_by_manager ?? "campaign_orchestrator") as ManagerKey
      // The Data Steward observes provider truth (connection integrity is its
      // charter); when the Steward itself made the claim, the Cron Manager reports —
      // a signal never routes a manager to itself.
      const fromManager: ManagerKey = claimer === "data_steward" ? "cron_manager" : "data_steward"
      const published = await publishManagerSignal({
        brokerageId: row.brokerage_id,
        fromManager,
        toManager: claimer,
        signalType: OUTCOME_CONTRADICTED_SIGNAL,
        message: result.explanation,
        entityType: row.entity_type ?? input.channel,
        // entity_id is a uuid column — pass the claim's own entity when it is one,
        // never the provider's string reference.
        entityId: row.entity_id,
        contactId: row.contact_id,
        payload: {
          channel: input.channel,
          provider_ref: input.providerRef,
          provider_status: input.truth.status,
          claimed_status: row.claimed_status,
          reconciliation_id: row.id,
        },
        dedupe: false,
      }, svc)
      if (published.ok) {
        escalated = true
        await svc.from("outcome_reconciliations")
          .update({ escalated_at: new Date().toISOString() }).eq("id", row.id)
      }
    }

    return { ok: true, verdict: result.verdict, escalated, brokerageId: row.brokerage_id }
  } catch (e) {
    return { ok: false, verdict: null, escalated: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Read side: the brokerage's reconciliation board. Never throws. */
export async function loadReconciliations(
  brokerageId: string,
  opts: { limit?: number; verdict?: ReconciliationVerdict } = {},
): Promise<Array<{
  id: string; channel: OutcomeChannel; verdict: ReconciliationVerdict
  claimedStatus: string; providerStatus: string | null; claimedAt: string
  explanation: string | null; truthSource: string | null; claimedByManager: string | null
}>> {
  try {
    const svc = createServiceClient()
    let q = svc.from("outcome_reconciliations")
      .select("id, channel, verdict, claimed_status, provider_status, claimed_at, explanation, truth_source, claimed_by_manager")
      .eq("brokerage_id", brokerageId)
      .order("claimed_at", { ascending: false })
      .limit(opts.limit ?? 100)
    if (opts.verdict) q = q.eq("verdict", opts.verdict)
    const { data } = await q
    return ((data ?? []) as any[]).map((r) => ({
      id: r.id, channel: r.channel, verdict: r.verdict,
      claimedStatus: r.claimed_status, providerStatus: r.provider_status,
      claimedAt: r.claimed_at, explanation: r.explanation,
      truthSource: r.truth_source, claimedByManager: r.claimed_by_manager,
    }))
  } catch {
    return []
  }
}
