/**
 * lib/documents/autonomy-ratchet.ts
 *
 * THE POLICY AUTONOMY RATCHET — autonomy is EARNED per brokerage from
 * that brokerage's OWN approval history, never assumed. The
 * policy_decisions ledger records every amber proposal the document
 * kernel raised AND every human resolution (adopt / keep). When a
 * specific amber SHAPE (e.g. "correct the closing date from a scanned
 * closing disclosure") has been human-approved ≥ RATCHET_MIN_APPROVALS
 * times with ZERO declines, the kernel proposes — TO THE BROKER — raising
 * that one shape to green for their tenancy. The broker grants or
 * declines on the feed; a grant lands in managed_agents.config
 * (doc_kernel_grants) — the SAME policy-reference row the autonomy-gate /
 * Trust Scorecard already govern per manager, no new governance surface.
 *
 * Once granted, the deriver acts autonomously on that shape (adopt the
 * date / track the deadline) and records a GREEN policy decision naming
 * the grant — the trail stays complete. DEADLINE shapes only: stage
 * advances move business-visible state and stay human-approved forever
 * by design.
 *
 * The evidence math is PURE. Nothing here loosens a legal gate — this is
 * the deal-file trust ladder, not consent/FH/TCPA (those never ratchet).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { recordPolicyDecision } from "./policy-decisions"
import { consumeSignal, loadOpenSignal, type KernelActor } from "./kernel-review-core"

type Svc = SupabaseClient<any, any, any>

export const RATCHET_MIN_APPROVALS = 10

/** The two ratchetable amber shapes, per deadline_type. Stage shapes are
 *  deliberately NOT ratchetable. */
export type RatchetMode = "deadline_correction" | "deadline_propose"

export const shapeKey = (mode: RatchetMode, deadlineType: string): string => `${mode}:${deadlineType}`

export interface ShapeStats {
  shape: string
  mode: RatchetMode
  deadlineType: string
  approvals: number
  declines: number
}

export interface ResolutionRow {
  recommended_action: string | null
  target_id: string | null
  evidence_json: Record<string, unknown> | null
}

/** PURE: aggregate the human resolutions in policy_decisions into
 *  per-shape approval/decline counts. A "correction" resolved an existing
 *  tracked date (evidence carries current_date); a "propose" tracked a
 *  new one (current_date null). */
export function computeShapeStats(rows: ResolutionRow[]): ShapeStats[] {
  const byShape = new Map<string, ShapeStats>()
  for (const r of rows) {
    const action = r.recommended_action ?? ""
    if (action !== "human_adopted_document_date" && action !== "human_kept_tracked_date") continue
    const deadlineType = (r.target_id ?? "").trim()
    if (!deadlineType) continue
    const hadCurrent = r.evidence_json?.current_date !== null && r.evidence_json?.current_date !== undefined
    const mode: RatchetMode = hadCurrent ? "deadline_correction" : "deadline_propose"
    const key = shapeKey(mode, deadlineType)
    const s = byShape.get(key) ?? { shape: key, mode, deadlineType, approvals: 0, declines: 0 }
    if (action === "human_adopted_document_date") s.approvals++
    else s.declines++
    byShape.set(key, s)
  }
  return [...byShape.values()]
}

/** PURE: does this shape's history earn a ratchet proposal? A single
 *  decline resets trust to zero — the broker's judgment differs from the
 *  documents somewhere, so the shape stays human. */
export function decideAutonomyRatchet(stats: ShapeStats): boolean {
  return stats.declines === 0 && stats.approvals >= RATCHET_MIN_APPROVALS
}

/** The granted shapes for a brokerage (managed_agents.config.doc_kernel_grants
 *  on the deal_coordinator row — the existing autonomy policy surface). */
export async function loadDocKernelGrants(svc: Svc, brokerageId: string): Promise<Set<string>> {
  try {
    const { data } = await svc
      .from("managed_agents")
      .select("config")
      .eq("brokerage_id", brokerageId)
      .eq("agent_kind", "deal_coordinator")
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    const grants = ((data as any)?.config?.doc_kernel_grants ?? []) as unknown
    return new Set(Array.isArray(grants) ? grants.map(String) : [])
  } catch {
    return new Set() // fail CLOSED for autonomy grants — no grant record, no autonomous act
  }
}

/** Persist a grant (or revoke) on the deal_coordinator managed_agents row. */
export async function writeDocKernelGrant(
  svc: Svc,
  input: { brokerageId: string; shape: string; grant: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const { data: row } = await svc
    .from("managed_agents")
    .select("id, config")
    .eq("brokerage_id", input.brokerageId)
    .eq("agent_kind", "deal_coordinator")
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const existing = new Set<string>((((row as any)?.config?.doc_kernel_grants ?? []) as unknown[]).map(String))
  if (input.grant) existing.add(input.shape)
  else existing.delete(input.shape)
  const grants = [...existing]

  if (row) {
    const config = { ...(((row as any).config ?? {}) as Record<string, unknown>), doc_kernel_grants: grants }
    const { error } = await svc.from("managed_agents").update({ config, updated_at: new Date().toISOString() }).eq("id", (row as any).id)
    return { ok: !error, error: error?.message }
  }
  const { error } = await svc.from("managed_agents").insert({
    brokerage_id: input.brokerageId,
    agent_kind: "deal_coordinator",
    config: { doc_kernel_grants: grants },
  })
  return { ok: !error, error: error?.message }
}

export interface RatchetSweepResult {
  shapesQualified: number
  proposed: number
}

/** The periodic sweep: find shapes that EARNED autonomy and propose the
 *  grant to the broker (feed proposal, open-signal + payload dedupe).
 *  Rides the deadline-watcher cron — no new cron. */
export async function runAutonomyRatchetSweep(
  svc: Svc,
  input: { brokerageId: string },
): Promise<RatchetSweepResult> {
  const out: RatchetSweepResult = { shapesQualified: 0, proposed: 0 }

  const { data: rows } = await svc
    .from("policy_decisions")
    .select("recommended_action, target_id, evidence_json")
    .eq("brokerage_id", input.brokerageId)
    .eq("target_type", "transaction_deadline")
    .in("recommended_action", ["human_adopted_document_date", "human_kept_tracked_date"])
    .limit(2000)

  const stats = computeShapeStats((rows ?? []) as ResolutionRow[])
  const granted = await loadDocKernelGrants(svc, input.brokerageId)

  for (const s of stats) {
    if (!decideAutonomyRatchet(s)) continue
    if (granted.has(s.shape)) continue
    out.shapesQualified++

    // Dedupe: an unactioned (or previously declined) proposal for this shape
    // inside 30 days stands — the broker said "not yet", don't re-ask weekly.
    const dedupSince = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { data: dup } = await svc.from("manager_signals")
      .select("id")
      .eq("brokerage_id", input.brokerageId)
      .eq("signal_type", "autonomy_ratchet_proposal")
      .contains("payload", { shape: s.shape })
      .gte("created_at", dedupSince)
      .limit(1)
      .maybeSingle()
    if (dup) continue

    const verb = s.mode === "deadline_correction" ? "correct" : "track"
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const sig = await publishManagerSignal({
      brokerageId: input.brokerageId,
      fromManager: "deal_coordinator",
      toManager: "compliance_officer",
      signalType: "autonomy_ratchet_proposal",
      message: `Earned autonomy: you've approved ${s.approvals} of ${s.approvals} document-kernel proposals to ${verb} the ${s.deadlineType.replace(/_/g, " ")} deadline from scanned documents — zero declines. Grant the Deal Coordinator this one move and it runs green from now on (every act still recorded in the policy ledger; revoke any time).`,
      payload: { shape: s.shape, mode: s.mode, deadline_type: s.deadlineType, approvals: s.approvals, declines: s.declines },
      dedupe: false, // entity-less — the payload-contains check above is the dedupe
    }, svc)
    if (sig.ok) out.proposed++
  }

  return out
}

/** The broker's decision on a ratchet proposal (feed buttons; broker/admin
 *  only — enforced by the calling action). */
export async function resolveAutonomyRatchetCore(
  svc: Svc,
  actor: KernelActor,
  input: { signalId: string; grant: boolean },
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const sig = await loadOpenSignal(svc, input.signalId, actor.brokerageId, "autonomy_ratchet_proposal")
  if (!sig) return { ok: false, error: "Proposal not found or already resolved" }
  const p = sig.payload as { shape?: string; deadline_type?: string; approvals?: number }
  if (!p.shape) return { ok: false, error: "Proposal payload is incomplete" }

  if (input.grant) {
    const w = await writeDocKernelGrant(svc, { brokerageId: actor.brokerageId, shape: p.shape, grant: true })
    if (!w.ok) return { ok: false, error: w.error ?? "Grant write failed" }
  }

  await recordPolicyDecision(svc, {
    brokerageId: actor.brokerageId,
    targetType: "autonomy_grant",
    targetId: p.shape,
    verdict: {
      decision: "green",
      reasons: [input.grant
        ? `broker granted autonomy on ${p.shape} after ${p.approvals ?? "?"} consecutive approvals`
        : `broker declined the autonomy grant on ${p.shape} — the shape stays human-approved`],
      recommendedAction: input.grant ? "autonomy_granted" : "autonomy_grant_declined",
      requiredApproverRole: null,
    },
    evidence: { resolved_by_user_id: actor.userId, shape: p.shape },
  })
  const message = input.grant
    ? `Granted — the Deal Coordinator now handles ${String(p.deadline_type ?? p.shape).replace(/_/g, " ")} dates from documents autonomously (every act stays on the policy ledger).`
    : "Declined — the shape stays human-approved."
  await consumeSignal(svc, input.signalId, message)
  return { ok: true, message }
}
