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
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import {
  reconcile,
  settleUnknownAction,
  decideSendRecovery,
  recoveryCapabilityKey,
  recoveryBackoffMs,
  SEND_RECOVERY_CAPABILITIES,
  SEND_LEASE_TTL_MINUTES,
  type RecoveryProbe,
  type ClaimRow,
  type UnknownActionRow,
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
  /** WAVE 153 (lane 153S): the tenant the webhook itself names (a per-tenant URL, or the intent the provider echoed back).
   *  A claim owned by ANY OTHER tenant is refused — a provider reference is global, a tenant is not. */
  expectedBrokerageId?: string | null
  /** Proof seam: an injected client. */
  client?: ReturnType<typeof createServiceClient>
}): Promise<IngestTruthResult> {
  try {
    const svc = input.client ?? createServiceClient()
    // `provider_reported_at` is read here, not merely written: see the out-of-order
    // guard below. Correlating on (channel, provider_ref) tells us WHICH claim this
    // is; the stored provider timestamp tells us whether this report is the
    // provider's LATEST word or one that has been overtaken.
    const { data: existing } = await svc
      .from("outcome_reconciliations")
      .select("id, brokerage_id, claimed_status, claimed_at, verdict, escalated_at, claimed_by_manager, entity_type, entity_id, contact_id, lead_id, provider_reported_at")
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
      lead_id?: string | null
      provider_reported_at: string | null
    }

    if (input.expectedBrokerageId && row.brokerage_id !== input.expectedBrokerageId) {
      console.error(`[reconciliation-ledger] WRONG-TENANT provider event refused: ${input.channel} ${input.providerRef} is not the named tenant's`)
      return { ok: false, verdict: null, escalated: false, reason: "wrong tenant — this provider reference belongs to another tenant; nothing recorded" }
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

    // ── AND NEVER OVERWRITE THE PROVIDER'S LATEST WORD WITH AN OLDER ONE ──────
    // The guard above is about the VERDICT walking backwards. This one is about
    // the RECORD walking backwards: webhooks arrive out of order, and the row
    // holds one provider_status / provider_reported_at / provider_detail triple,
    // so a delayed earlier event would overwrite the newer report with a stale
    // status and a stale detail — the ledger would then quote the provider saying
    // something the provider has since superseded, on a board whose entire
    // purpose is to be the provider's word rather than ours.
    // STRICTLY older only, and only when BOTH timestamps parse: equal stamps and
    // an unparseable one both fall through and are recorded, because refusing on
    // an unknown is how a real contradiction would get silently dropped.
    const priorAt = Date.parse(row.provider_reported_at ?? "")
    const incomingAt = Date.parse(input.truth.at ?? "")
    if (Number.isFinite(priorAt) && Number.isFinite(incomingAt) && incomingAt < priorAt) {
      return {
        ok: true,
        verdict: row.verdict,
        escalated: false,
        brokerageId: row.brokerage_id,
        reason: `out-of-order provider event ignored — this report is stamped ${input.truth.at} and the ledger already holds one stamped ${row.provider_reported_at}`,
      }
    }

    const { error: verdictErr } = await svc.from("outcome_reconciliations").update({
      provider_status: input.truth.status,
      provider_reported_at: input.truth.at,
      provider_detail: input.truth.detail ?? null,
      verdict: result.verdict,
      explanation: result.explanation,
      truth_source: result.truthSource,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id)
    if (verdictErr) console.error(`[reconciliation-ledger] reconciliation verdict NOT saved: ${verdictErr.message}`)

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
      // WAVE 150 (lane 150QTV, canary 12): the PERSON half — the staff member who owns this relationship hears it now, on the
      // same once-only guard (escalated_at), with the provider's own words. A heads-up, never a re-send: the arbiter refuses this
      // channel for them from here on (lib/ai-isa/followup-arbiter.ts deliveryFailures) and picks another way.
      const { notifyFailedSend } = await import("@/lib/kernel/completion-tracking")
      const told = await notifyFailedSend(svc, {
        brokerageId: row.brokerage_id, channel: input.channel, contactId: row.contact_id, leadId: row.lead_id ?? null,
        providerStatus: input.truth.status, providerDetail: (input.truth.detail ?? null) as Record<string, unknown> | null, reconciliationId: row.id,
      })
      if (told.error) console.error(`[reconciliation-ledger] failed-send staff notice NOT delivered for ${row.id}: ${told.error}`)
      if (published.ok || told.notified > 0) {
        escalated = true
        await sentinelWrite(svc, svc.from("outcome_reconciliations")
          .update({ escalated_at: new Date().toISOString() }).eq("id", row.id), { table: "outcome_reconciliations", flow: "outcome_reconciliations_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
      }
    }

    return { ok: true, verdict: result.verdict, escalated, brokerageId: row.brokerage_id }
  } catch (e) {
    return { ok: false, verdict: null, escalated: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Read side: the brokerage's reconciliation board. Never throws.
 *
 * THE PROVIDER'S OWN WORDS TRAVEL WITH THE VERDICT (lane W3, 2026-09-01).
 * `provider_detail` and `provider_reported_at` were written by ingestProviderTruth
 * above and read by NOTHING, so the one board that exists to say "the provider
 * contradicted us" could show only OUR sentence about it (`explanation`) and a
 * one-word status. On a disputed claim the provider's own detail — Twilio's error
 * text, Lob's rejection reason — is the evidence, and WHEN the provider said it is
 * what separates a stale report from the current one. Both now ride along.
 */
export async function loadReconciliations(
  brokerageId: string,
  opts: { limit?: number; verdict?: ReconciliationVerdict } = {},
): Promise<Array<{
  id: string; channel: OutcomeChannel; verdict: ReconciliationVerdict
  claimedStatus: string; providerStatus: string | null; claimedAt: string
  explanation: string | null; truthSource: string | null; claimedByManager: string | null
  /** The provider's own words about this touch — the jsonb payload ProviderTruth
   *  carried (`detail`), verbatim. Null until a provider reports. */
  providerDetail: Record<string, unknown> | null
  /** When the provider said it — not when we recorded it. */
  providerReportedAt: string | null
  /**
   * ORPHAN DOCTRINE §1.2 — BUILD THE MISSING HALF (no duplicate existed).
   *
   * `outcome_reconciliations.lead_id` was written by recordClaimedOutcome
   * (:90) and read by NOBODY. A contradicted outcome means a touch the OS
   * claimed to have made did NOT reach the person — and until now the board
   * could say a text failed and not WHO it failed to reach, because a
   * lead-directed touch carries a lead_id and no contact_id. On the lead lane
   * (speed-to-lead, ISA nurture) that is precisely the population where a
   * silent failure costs the most, and it was the population the board could
   * not name.
   */
  leadId: string | null
}>> {
  try {
    const svc = createServiceClient()
    let q = svc.from("outcome_reconciliations")
      .select("id, channel, verdict, claimed_status, provider_status, claimed_at, explanation, truth_source, claimed_by_manager, provider_detail, provider_reported_at, lead_id")
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
      providerDetail: r.provider_detail ?? null,
      providerReportedAt: r.provider_reported_at ?? null,
      leadId: r.lead_id ?? null,
    }))
  } catch {
    return []
  }
}

// ─── SETTLING 'unknown' ACTIONS (wave 98, lane 98B) ──────────────────────────
//
// agent_action_ledger (lib/kernel/action-ledger.ts) marks an action 'unknown' when the provider
// never answered — the message may or may not have left, so the ledger REFUSES to retry it until
// someone settles it. Nothing settled them. This is the reconciler, on THIS ledger (the survivor
// that already holds the provider's word): the 'unknown' row is matched to an
// outcome_reconciliations claim —
//   1. by provider_ref when the ledger row has one (the only correlation that cannot be wrong);
//   2. else by tenant + person (contact_id / lead_id) + channel, with a claim made inside the
//      action's window [created_at, created_at + UNKNOWN_MATCH_WINDOW_MIN];
// and settled from the claim's verdict: confirmed / pending / unverifiable → 'executed' (the
// provider took it), contradicted → 'failed'. With NO matching claim after UNKNOWN_ABANDON_HOURS
// the row is settled 'failed' / outcome 'reconcile_no_evidence' and says so: no provider record
// proves it left, and a later cycle may act again. Younger unmatched rows stay 'unknown' (the
// provider may still report).
// Mounted on the EXISTING reaper net (lib/intelligence/reaper-net.ts, domain
// `unknown_action_outcomes`, lane 'signals' → /api/cron/manager-signals) — no new cron.

// The DECISION is pure and lives beside reconcile() in ./reconciliation (settleUnknownAction);
// this file owns the reads and the guarded, counted writes.

/**
 * LIVE. Settle one tenant's 'unknown' ledger rows. Never throws; every refusal is read and said.
 * The UPDATE is guarded on status='unknown' and COUNTED (an update matching nothing resolves too).
 */
export async function settleUnknownActions(
  brokerageId: string,
  client?: ReturnType<typeof createServiceClient>,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ scanned: number; reaped: number; escalated: number; errors: string[] }> {
  const out = { scanned: 0, reaped: 0, escalated: 0, errors: [] as string[] }
  try {
    const svc = client ?? createServiceClient()
    const now = opts.now ?? new Date()
    const { data: rows, error } = await svc.from("agent_action_ledger")
      .select("id, channel, subject_type, subject_id, provider_ref, created_at, detail")
      .eq("brokerage_id", brokerageId).eq("status", "unknown")
      .order("created_at", { ascending: true }).limit(opts.limit ?? 100)
    if (error) {
      // m687 not applied → nothing to settle; any other refusal is said.
      if (!["42P01", "PGRST205"].includes(error.code ?? "")) out.errors.push(`unknown rows read refused: ${error.message}`)
      return out
    }
    const unknownRows = (rows ?? []) as UnknownActionRow[]
    out.scanned = unknownRows.length
    if (unknownRows.length === 0) return out

    const { data: claims, error: claimErr } = await svc.from("outcome_reconciliations")
      .select("id, channel, provider_ref, contact_id, lead_id, claimed_at, verdict")
      .eq("brokerage_id", brokerageId).gte("claimed_at", unknownRows[0].created_at).limit(1000)
    if (claimErr) {
      out.errors.push(`outcome_reconciliations read refused: ${claimErr.message} — nothing settled`)
      return out
    }
    for (const row of unknownRows) {
      const s = settleUnknownAction(row, (claims ?? []) as ClaimRow[], now)
      if (!s) continue
      const stamp = new Date().toISOString()
      const { data: upd, error: upErr } = await svc.from("agent_action_ledger")
        .update({ status: s.status, outcome: s.outcome, provider_ref: s.providerRef, error: s.error, settled_at: stamp, updated_at: stamp })
        .eq("id", row.id).eq("brokerage_id", brokerageId).eq("status", "unknown")
        .select("id")
      if (upErr) { out.errors.push(`settle ${row.id} refused: ${upErr.message}`); continue }
      if (!Array.isArray(upd) || upd.length !== 1) continue // settled concurrently — not ours to count
      out.reaped++
      if (s.outcome === "reconcile_no_evidence" || s.outcome === "reconciled_contradicted") out.escalated++
    }
    return out
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e))
    return out
  }
}

// ─── SEND RECOVERY — the LIVE half (wave 153, lane 153S — owner ruling B10) ─────────────────────────────────────────────────
// "crash mid-send is marked 'outcome unknown' and need to be re-sent automatically." The decision ladder is PURE
// (./reconciliation decideSendRecovery + SEND_RECOVERY_CAPABILITIES — read its header); this owns the reads, the guarded and
// COUNTED writes, the provider status queries, and the ONE re-send door (lib/providers/dispatch.ts redispatchSendIntent).
// Mounted on the EXISTING reaper net (lib/intelligence/reaper-net.ts domain `unknown_action_outcomes`, the 30-minute
// manager-signals cron) ahead of settleUnknownActions — no new cron, no new table, no new outbound system.
//
//   1. A claim left 'proposed' past SEND_LEASE_TTL_MINUTES (the process died between claim and settle) becomes 'unknown' /
//      outcome 'outcome_unknown' — a counted compare-and-set on (status, updated_at), so a live settle always wins.
//   2. Each 'unknown' COMMUNICATION row carrying a persisted send intent is LEASED (compare-and-set on updated_at, a lease
//      TTL and a bounded backoff in detail.send_recovery) so two workers never act on one intent, then walked down the
//      ladder: provider evidence → accepted (record, never resend) / proven never-accepted or idempotent create (flip to
//      'failed' under the lease and re-dispatch with the SAME key — the ledger's own guarded re-claim admits one worker,
//      and every dispatch gate runs again) / cancel (the person replied, the campaign or bundle stopped) / backoff (provider
//      outage or 429) / a VISIBLE exception (stays 'unknown', self_heal_events escalated → the Exception Center).
// Never throws; every refusal is read and said.

type RecoverySvc = ReturnType<typeof createServiceClient>

export interface RecoveryLedgerRow {
  id: string
  channel: string | null
  action: string
  provider: string | null
  provider_ref: string | null
  subject_type: string
  subject_id: string | null
  idempotency_key: string | null
  attempts: number | null
  detail: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

interface PersistedIntent {
  v?: number
  action?: string
  channel?: string
  cycle?: string | null
  key_source?: string
  provider_scope?: { brokerage_id?: string; team_id?: string | null; user_id?: string | null; send_as_user_id?: string | null }
  replay?: { kind: "email" | "sms" | "direct_mail"; params: Record<string, unknown>; ledger: Record<string, unknown> } | null
}
interface RecoveryState {
  attempts?: number
  lease_until?: string | null
  next_at?: string | null
  last_at?: string
  last_decision?: string
  capability?: string
  exception?: { why: string; at: string; capability: string } | null
}

export interface SendRecoveryDeps {
  now?: Date
  /** The provider question for one row: which capability applies and what the provider says. */
  probe?: (row: RecoveryLedgerRow, svc: RecoverySvc, brokerageId: string) => Promise<{ capKey: string; probe: RecoveryProbe }>
  /** Is the intent still relevant (no reply since, campaign / bundle still on)? A read that fails is `unreadable`. */
  relevance?: (svc: RecoverySvc, brokerageId: string, row: RecoveryLedgerRow) => Promise<{ cancel: string | null; unreadable: string | null }>
  /** The re-send door (default: lib/providers/dispatch.ts redispatchSendIntent). */
  redispatch?: (replay: PersistedIntent["replay"], idempotencyKey: string) => Promise<{ success: boolean; providerKey: string; messageId?: string; error?: string }>
  /** The visible exception (default: self_heal_events escalated → the Exception Center). */
  escalate?: (svc: RecoverySvc, brokerageId: string, row: RecoveryLedgerRow, why: string, capKey: string) => Promise<void>
}

export interface SendRecoveryResult {
  promoted: number
  scanned: number
  reconciled: number
  retried: number
  cancelled: number
  deferred: number
  exceptions: number
  errors: string[]
}

const RECOVERY_COLS = "id, channel, action, provider, provider_ref, subject_type, subject_id, idempotency_key, attempts, detail, created_at, updated_at"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function intentOf(row: { detail: Record<string, unknown> | null }): PersistedIntent | null {
  const i = row.detail?.["send_intent"] as PersistedIntent | undefined
  return i && typeof i.v === "number" ? i : null
}
function recoveryStateOf(row: { detail: Record<string, unknown> | null }): RecoveryState {
  return ((row.detail?.["send_recovery"] as RecoveryState | undefined) ?? {})
}

/**
 * LIVE. One tenant's crash-mid-send recovery pass. See the section header. Tenant-pinned on every read and write.
 */
export async function recoverOutcomeUnknownSends(
  brokerageId: string,
  client?: RecoverySvc,
  deps: SendRecoveryDeps = {},
  opts: { limit?: number } = {},
): Promise<SendRecoveryResult> {
  const out: SendRecoveryResult = { promoted: 0, scanned: 0, reconciled: 0, retried: 0, cancelled: 0, deferred: 0, exceptions: 0, errors: [] }
  try {
    const svc = client ?? createServiceClient()
    const now = deps.now ?? new Date()
    const nowIso = now.toISOString()

    // ── 1. THE DEAD CLAIM → outcome unknown ──────────────────────────────────────────────────────────────────────────────
    const leaseCutoff = new Date(now.getTime() - SEND_LEASE_TTL_MINUTES * 60_000).toISOString()
    const { data: stale, error: staleErr } = await svc.from("agent_action_ledger").select("id, updated_at")
      .eq("brokerage_id", brokerageId).eq("status", "proposed").eq("risk_class", "COMMUNICATION")
      .lt("updated_at", leaseCutoff).order("updated_at", { ascending: true }).limit(opts.limit ?? 100)
    if (staleErr) {
      if (!["42P01", "PGRST205"].includes(staleErr.code ?? "")) out.errors.push(`stale claims read refused: ${staleErr.message}`)
      return out
    }
    for (const s of (stale ?? []) as Array<{ id: string; updated_at: string }>) {
      const { data: moved, error: mErr } = await svc.from("agent_action_ledger")
        .update({ status: "unknown", outcome: "outcome_unknown", error: `the sending process stopped between the claim and the provider's answer (no settle within ${SEND_LEASE_TTL_MINUTES} min) — outcome unknown, reconciled before any re-send`, updated_at: nowIso })
        .eq("id", s.id).eq("brokerage_id", brokerageId).eq("status", "proposed").eq("updated_at", s.updated_at)
        .select("id")
      if (mErr) { out.errors.push(`promote ${s.id} refused: ${mErr.message}`); continue }
      if (Array.isArray(moved) && moved.length === 1) out.promoted++
    }

    // ── 2. EACH UNKNOWN SEND INTENT, under a lease ───────────────────────────────────────────────────────────────────────
    const { data: rows, error: rowsErr } = await svc.from("agent_action_ledger").select(RECOVERY_COLS)
      .eq("brokerage_id", brokerageId).eq("status", "unknown").eq("risk_class", "COMMUNICATION")
      .order("created_at", { ascending: true }).limit(opts.limit ?? 100)
    if (rowsErr) { out.errors.push(`unknown sends read refused: ${rowsErr.message}`); return out }
    const unknownRows = (rows ?? []) as RecoveryLedgerRow[]
    if (unknownRows.length === 0) return out

    const { data: claims, error: claimErr } = await svc.from("outcome_reconciliations")
      .select("id, channel, provider_ref, contact_id, lead_id, claimed_at, verdict")
      .eq("brokerage_id", brokerageId).gte("claimed_at", unknownRows[0].created_at).limit(1000)
    if (claimErr) { out.errors.push(`outcome_reconciliations read refused: ${claimErr.message} — nothing recovered`); return out }

    const probeFn = deps.probe ?? liveRecoveryProbe
    const relevanceFn = deps.relevance ?? liveRecoveryRelevance
    const redispatch = deps.redispatch ?? (async (replay, key) => (await import("@/lib/providers/dispatch")).redispatchSendIntent(replay as never, key))
    const escalate = deps.escalate ?? liveRecoveryEscalation

    for (const row of unknownRows) {
      const rec = recoveryStateOf(row)
      if (rec.exception) continue // already a visible exception — a person owns it now
      if (rec.lease_until && Date.parse(rec.lease_until) > now.getTime()) continue // another worker holds it
      if (rec.next_at && Date.parse(rec.next_at) > now.getTime()) continue // backing off
      out.scanned++
      const intent = intentOf(row)
      const attempts = (rec.attempts ?? 0) + 1

      // THE LEASE — compare-and-set on updated_at; COUNTED (an update matching nothing resolves too).
      const leaseStamp = new Date(now.getTime() + out.scanned).toISOString() // unique per row in this pass
      const leased: RecoveryState = { ...rec, attempts, lease_until: new Date(now.getTime() + SEND_LEASE_TTL_MINUTES * 60_000).toISOString(), last_at: nowIso }
      const { data: got, error: leaseErr } = await svc.from("agent_action_ledger")
        .update({ detail: { ...(row.detail ?? {}), send_recovery: leased }, updated_at: leaseStamp })
        .eq("id", row.id).eq("brokerage_id", brokerageId).eq("status", "unknown").eq("updated_at", row.updated_at)
        .select("id")
      if (leaseErr) { out.errors.push(`lease ${row.id} refused: ${leaseErr.message}`); continue }
      if (!Array.isArray(got) || got.length !== 1) continue // another worker won the lease

      const write = async (patch: Record<string, unknown>, decision: string, extra: Partial<RecoveryState> = {}): Promise<boolean> => {
        const state: RecoveryState = { ...leased, lease_until: null, last_decision: decision, ...extra }
        const { data: w, error: wErr } = await svc.from("agent_action_ledger")
          .update({ ...patch, detail: { ...(row.detail ?? {}), send_recovery: state }, updated_at: new Date().toISOString() })
          .eq("id", row.id).eq("brokerage_id", brokerageId).eq("status", "unknown").eq("updated_at", leaseStamp)
          .select("id")
        if (wErr) { out.errors.push(`recovery write ${row.id} refused: ${wErr.message}`); return false }
        return Array.isArray(w) && w.length === 1
      }

      // (a) the provider's own evidence first: a claim / webhook already on outcome_reconciliations.
      const evidence = settleUnknownAction(row, (claims ?? []) as ClaimRow[], now)
      if (evidence && evidence.outcome.startsWith("reconciled_")) {
        if (await write({ status: evidence.status, outcome: evidence.outcome, provider_ref: evidence.providerRef, error: evidence.error, settled_at: nowIso }, evidence.outcome)) out.reconciled++
        continue
      }

      // No persisted intent (a pre-153S row, or a non-dispatch communication action): nothing to reconcile it against and
      // nothing to replay — the visible exception, never a guess.
      if (!intent) {
        const why = "outcome unknown: this communication carries no persisted send intent (no key / replay on record); not re-sent"
        if (await write({}, "exception", { exception: { why, at: nowIso, capability: "unknown" } })) { out.exceptions++; await escalate(svc, brokerageId, row, why, "unknown") }
        continue
      }

      let capKey = "unknown"
      let probe: RecoveryProbe
      try { ({ capKey, probe } = await probeFn(row, svc, brokerageId)) } catch (e) { probe = { kind: "unavailable", why: e instanceof Error ? e.message : String(e) } }
      const capability = SEND_RECOVERY_CAPABILITIES[capKey] ?? SEND_RECOVERY_CAPABILITIES.unknown
      let relevance: { cancel: string | null; unreadable: string | null } = { cancel: null, unreadable: null }
      if (probe.kind !== "accepted") {
        try { relevance = await relevanceFn(svc, brokerageId, row) } catch (e) { relevance = { cancel: null, unreadable: e instanceof Error ? e.message : String(e) } }
      }
      const decision = decideSendRecovery({
        capability, probe, relevance, attempts,
        ageHours: (now.getTime() - Date.parse(row.created_at)) / 3_600_000,
        hasReplay: !!intent.replay && !!row.idempotency_key,
      })

      if (decision.action === "settle_accepted") {
        if (await write({ status: "executed", outcome: "reconciled_provider_accepted", provider_ref: decision.providerRef ?? row.provider_ref, error: null, settled_at: nowIso }, "accepted", { capability: capKey })) out.reconciled++
      } else if (decision.action === "cancel") {
        if (await write({ status: "skipped", outcome: "recovery_cancelled", error: decision.why, settled_at: nowIso }, "cancelled", { capability: capKey })) out.cancelled++
      } else if (decision.action === "backoff") {
        if (await write({}, "backoff", { capability: capKey, next_at: new Date(now.getTime() + recoveryBackoffMs(attempts)).toISOString() })) out.deferred++
      } else if (decision.action === "exception") {
        if (await write({}, "exception", { capability: capKey, exception: { why: decision.why, at: nowIso, capability: capKey } })) {
          out.exceptions++
          await escalate(svc, brokerageId, row, decision.why, capKey)
        }
      } else {
        // RETRY — the same key. 'failed' (outcome names why) under OUR lease, so only this worker re-dispatches; the
        // dispatcher's claim then re-claims the row (failed → proposed, attempts + 1, guarded) and runs every gate again.
        const flipped = await write({ status: "failed", outcome: `recovery_retry_${decision.basis}`, error: decision.basis === "never_accepted" ? "the provider proved it never accepted this send — re-sent automatically with the same key" : "the provider documents idempotent creation on this key — re-sent with the same key (the provider returns the original if it was taken)" }, `retry_${decision.basis}`, { capability: capKey, next_at: new Date(now.getTime() + recoveryBackoffMs(attempts)).toISOString() })
        if (!flipped) continue
        const r = await redispatch(intent.replay ?? null, row.idempotency_key as string)
        out.retried++
        if (!r.success && r.providerKey !== "action_ledger_gate") {
          // The dispatcher settled the row itself (a gate refusal → skipped, a provider refusal → failed, a timeout → unknown
          // again and back here next pass). Said, not hidden.
          console.warn(`[send-recovery] re-dispatch of ${row.id} did not send: ${r.providerKey} ${r.error ?? ""}`)
        }
      }
    }
    return out
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e))
    return out
  }
}

/** The LIVE provider question. SMS: the actor's carrier (the same resolver the send used) and, for Twilio, the account's
 *  Message list for the recipient. Mail: Lob's list filtered by the intent key in metadata. Email / others: no wired query. */
async function liveRecoveryProbe(row: RecoveryLedgerRow, _svc: RecoverySvc, brokerageId: string): Promise<{ capKey: string; probe: RecoveryProbe }> {
  const intent = intentOf(row)
  const params = (intent?.replay?.params ?? {}) as Record<string, unknown>
  const scope = intent?.provider_scope ?? {}
  if (row.channel === "sms") {
    const { resolveSMSProviderForActor } = await import("@/lib/providers/messaging/resolve-sms-provider")
    const resolved = await resolveSMSProviderForActor({ brokerageId, userId: scope.user_id ?? null, teamId: scope.team_id ?? null })
    const capKey = recoveryCapabilityKey("sms", resolved.providerName)
    if (capKey !== "twilio_sms") return { capKey, probe: { kind: "indeterminate", why: `${resolved.providerName} offers no wired status query` } }
    const to = typeof params.to === "string" ? params.to : null
    const body = typeof params.message === "string" ? params.message.trim() : ""
    if (!to || !body) return { capKey, probe: { kind: "indeterminate", why: "the intent names no recipient / body to look up" } }
    // The read-only list lives with the Twilio adapter (lib/providers/messaging/sms-adapters.ts) — this file never holds a
    // raw provider call.
    const { listTwilioMessagesTo } = await import("@/lib/providers/messaging/sms-adapters")
    const res = await listTwilioMessagesTo(resolved.credentials, to)
    return { capKey, probe: twilioListVerdict(res, row.created_at, body) }
  }
  if (row.channel === "direct_mail") {
    const key = row.idempotency_key
    const apiKey = process.env.LOB_API_KEY
    if (!key || !apiKey) return { capKey: "lob_direct_mail", probe: { kind: "unavailable", why: !key ? "no intent key" : "Lob is not configured" } }
    const { lobIntentKey } = await import("@/lib/providers/dispatch")
    const piece = params.pieceType === "postcard" ? "postcards" : params.pieceType === "self_mailer" ? "self_mailers" : "letters"
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<{ data?: Array<{ id: string }> }>({
      connector: "lob", baseUrl: "https://api.lob.com", path: `/v1/${piece}`, method: "GET",
      query: { "metadata[intent_key]": lobIntentKey(key), limit: "2" }, auth: { style: "basic", username: apiKey, password: "" }, timeoutMs: 15_000,
    })
    return { capKey: "lob_direct_mail", probe: lobListVerdict(res) }
  }
  if (row.channel === "email") {
    const capKey = recoveryCapabilityKey("email", scope.send_as_user_id ? "personal" : "sendgrid")
    return { capKey, probe: { kind: "indeterminate", why: "no provider status query proves an email was or was not accepted (only its webhook can, and none matched)" } }
  }
  return { capKey: recoveryCapabilityKey(row.channel, null), probe: { kind: "indeterminate", why: `no recovery query for channel ${row.channel ?? "unknown"}` } }
}

/** PURE. Twilio's Message list for the recipient → a probe verdict. A page that does not reach back past the attempt cannot
 *  prove absence; a message in the window whose body is not ours cannot prove presence.
 *  @proofSeam exported so scripts/send-recovery-guard.ts drives it with recorded shapes. */
export function twilioListVerdict(
  res: { ok: boolean; status: number | null; data: { messages?: Array<{ sid: string; body: string | null; date_created: string | null }> } | null; error: string | null },
  attemptedAt: string,
  body: string,
): RecoveryProbe {
  if (!res.ok) return { kind: "unavailable", why: `Twilio list ${res.status ?? "transport"}: ${res.error ?? "no answer"}${res.status === 429 ? " (rate limited)" : ""}` }
  const msgs = res.data?.messages ?? []
  const start = Date.parse(attemptedAt) - 120_000
  const end = Date.parse(attemptedAt) + SEND_LEASE_TTL_MINUTES * 60_000
  const inWindow = msgs.filter((m) => { const t = Date.parse(m.date_created ?? ""); return Number.isFinite(t) && t >= start && t <= end })
  const ours = inWindow.find((m) => (m.body ?? "").includes(body))
  if (ours) return { kind: "accepted", providerRef: ours.sid }
  if (inWindow.length > 0) return { kind: "indeterminate", why: "Twilio holds a message to this number in the attempt's window whose body is not this intent's" }
  const oldest = msgs.reduce((min, m) => Math.min(min, Date.parse(m.date_created ?? "") || Infinity), Infinity)
  if (msgs.length >= 50 && !(oldest < start)) return { kind: "indeterminate", why: "Twilio's page does not reach back past the attempt — absence not proven" }
  return { kind: "not_accepted" }
}

/** PURE. Lob's metadata-filtered list → a probe verdict. @proofSeam */
export function lobListVerdict(res: { ok: boolean; status: number | null; data: { data?: Array<{ id: string }> } | null; error: string | null }): RecoveryProbe {
  if (!res.ok) return { kind: "unavailable", why: `Lob list ${res.status ?? "transport"}: ${res.error ?? "no answer"}${res.status === 429 ? " (rate limited)" : ""}` }
  const pieces = res.data?.data ?? []
  return pieces.length > 0 ? { kind: "accepted", providerRef: pieces[0].id } : { kind: "not_accepted" }
}

/** LIVE relevance: a reply since the attempt, a stopped campaign enrollment, a deactivated bundle. A read that fails is
 *  `unreadable` (→ backoff, never a send). Tenant-pinned. */
async function liveRecoveryRelevance(svc: RecoverySvc, brokerageId: string, row: RecoveryLedgerRow): Promise<{ cancel: string | null; unreadable: string | null }> {
  const intent = intentOf(row)
  if (row.subject_type === "contact" && row.subject_id) {
    const { data, error } = await svc.from("messages").select("id").eq("brokerage_id", brokerageId).eq("contact_id", row.subject_id)
      .eq("direction", "inbound").gt("created_at", row.created_at).limit(1)
    if (error) return { cancel: null, unreadable: `reply check: ${error.message}` }
    if ((data ?? []).length > 0) return { cancel: "the contact replied after this send was attempted — the conversation moved on; not re-sent", unreadable: null }
  } else if (row.subject_type === "lead" && row.subject_id) {
    const { data, error } = await svc.from("lead_conversation_history").select("id").eq("brokerage_id", brokerageId).eq("lead_id", row.subject_id)
      .eq("direction", "inbound").gt("created_at", row.created_at).limit(1)
    if (error) return { cancel: null, unreadable: `reply check: ${error.message}` }
    if ((data ?? []).length > 0) return { cancel: "the lead replied after this send was attempted; not re-sent", unreadable: null }
  }
  const enrollment = /^enrollment:([0-9a-f-]{36}):step:/i.exec(intent?.cycle ?? "")?.[1]
  if (enrollment && UUID.test(enrollment)) {
    const { data, error } = await svc.from("sequence_enrollments").select("status").eq("id", enrollment).eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { cancel: null, unreadable: `enrollment check: ${error.message}` }
    const status = (data as { status?: string } | null)?.status ?? null
    if (status !== "active") return { cancel: `the campaign enrollment is ${status ?? "gone"} — the step is not re-sent`, unreadable: null }
  }
  const bundleDispatch = /^bundle_follow_on:([0-9a-f-]{36}):/i.exec(row.idempotency_key ?? "")?.[1]
  if (bundleDispatch && UUID.test(bundleDispatch)) {
    const { data: d, error: dErr } = await svc.from("campaign_bundle_dispatches").select("bundle_id").eq("id", bundleDispatch).eq("brokerage_id", brokerageId).maybeSingle()
    if (dErr) return { cancel: null, unreadable: `bundle dispatch check: ${dErr.message}` }
    const bundleId = (d as { bundle_id?: string } | null)?.bundle_id ?? null
    if (!bundleId) return { cancel: "the bundle dispatch no longer exists in this tenant", unreadable: null }
    const { data: b, error: bErr } = await svc.from("campaign_bundles").select("is_active").eq("id", bundleId).eq("brokerage_id", brokerageId).maybeSingle()
    if (bErr) return { cancel: null, unreadable: `bundle check: ${bErr.message}` }
    if (!(b as { is_active?: boolean } | null)?.is_active) return { cancel: "the bundle was deactivated — its pieces are not re-sent", unreadable: null }
  }
  return { cancel: null, unreadable: null }
}

/** The VISIBLE exception: self_heal_events escalated (the Exception Center's reader, lib/kernel/exception-center.ts). */
async function liveRecoveryEscalation(svc: RecoverySvc, brokerageId: string, row: RecoveryLedgerRow, why: string, capKey: string): Promise<void> {
  const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
  await recordSelfHeal(svc, {
    brokerageId, domain: "connector", subject: `send_recovery:${row.channel ?? "unknown"}`, action: "outcome_unknown_send", outcome: "escalated",
    detail: { ledger_id: row.id, action: row.action, channel: row.channel, subject_type: row.subject_type, subject_id: row.subject_id, capability: capKey, why, attempted_at: row.created_at, door: "a person decides: confirm with the recipient / provider console, then resend or close" },
  })
}

/**
 * A PROVIDER EVENT THAT NAMES OUR INTENT (Lob echoes the piece's metadata.intent_key on every event). When the process died
 * after Lob accepted the piece but before the claim was written, ingestProviderTruth finds no claim — this settles the
 * intent's own ledger row from the provider's word and opens the missing claim so later events reconcile normally.
 * Monotonic: only an 'unknown' / 'proposed' row moves (executed / failed / skipped are never overwritten). Tenant: the row's
 * own tenant; a claim already owned by another tenant is refused by ingestProviderTruth's expectedBrokerageId.
 */
export async function acceptIntentFromProviderEvent(input: {
  intentKey: string
  channel: OutcomeChannel
  providerRef: string
  client?: RecoverySvc
}): Promise<{ ok: boolean; brokerageId: string | null; moved: boolean; reason: string }> {
  try {
    const svc = input.client ?? createServiceClient()
    const { data, error } = await svc.from("agent_action_ledger").select("id, brokerage_id, status, subject_type, subject_id").eq("idempotency_key", input.intentKey).maybeSingle()
    if (error) return { ok: false, brokerageId: null, moved: false, reason: `intent read refused: ${error.message}` }
    const row = data as { id: string; brokerage_id: string; status: string; subject_type: string; subject_id: string | null } | null
    if (!row) return { ok: true, brokerageId: null, moved: false, reason: "no intent with this key — not ours to record" }
    if (row.status !== "unknown" && row.status !== "proposed") return { ok: true, brokerageId: row.brokerage_id, moved: false, reason: `intent already ${row.status} — a later truth is never overwritten` }
    const stamp = new Date().toISOString()
    const { data: moved, error: mErr } = await svc.from("agent_action_ledger")
      .update({ status: "executed", outcome: "reconciled_provider_event", provider_ref: input.providerRef, error: null, settled_at: stamp, updated_at: stamp })
      .eq("id", row.id).eq("brokerage_id", row.brokerage_id).in("status", ["unknown", "proposed"]).select("id")
    if (mErr) return { ok: false, brokerageId: row.brokerage_id, moved: false, reason: `intent settle refused: ${mErr.message}` }
    const didMove = Array.isArray(moved) && moved.length === 1
    if (didMove) {
      await recordOutcomeClaim({
        brokerageId: row.brokerage_id, channel: input.channel, providerRef: input.providerRef, claimedStatus: "accepted_recovered",
        entityType: input.channel, contactId: row.subject_type === "contact" ? row.subject_id : null, leadId: row.subject_type === "lead" ? row.subject_id : null,
        claimedByManager: "campaign_orchestrator",
      })
    }
    return { ok: true, brokerageId: row.brokerage_id, moved: didMove, reason: didMove ? "the provider's event settled the intent" : "settled concurrently" }
  } catch (e) {
    return { ok: false, brokerageId: null, moved: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
