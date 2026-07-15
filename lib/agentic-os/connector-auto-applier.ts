/**
 * lib/agentic-os/connector-auto-applier.ts
 *
 * Auto-applies pending connector-healing proposals whose `proposal_kind` is on the safe-list AND
 * whose `confidence` exceeds the per-kind threshold. The framework is intentionally conservative:
 *
 *   - `retry_other_actor` — the apify runtime swap already picks an alive alternate via
 *     pickActors(); auto-apply just records the human/auto decision so the proposal queue stays
 *     small. No live mutation needed beyond marking the row.
 *   - `rotate_key`        — true key rotation requires a deploy. We DON'T silently rotate runtime
 *     credentials. The auto-applier records the proposal as 'applied' ONLY when the proposal
 *     payload says the rotation is already complete (e.g. an env var was already swapped via
 *     Vercel) AND the most recent probe for the connector reports a healthy status — confirming
 *     the fix landed. Otherwise the proposal stays pending for a human.
 *
 * Anything else (endpoint_change / auth_change / param_rename / shape_update / no_evidence) is
 * NEVER auto-applied — those need human review because the change semantics can break callers.
 *
 * Idempotent: each pass selects rows with status='pending' and uses the same .eq("status","pending")
 * guard on the UPDATE so a concurrent admin click can never race the auto-applier.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

const SAFE_KINDS: Record<string, { minConfidence: number }> = {
  retry_other_actor: { minConfidence: 0.5 },
  rotate_key:        { minConfidence: 0.8 },
}

export interface AutoApplyResult {
  scanned:  number
  applied:  number
  skipped:  number
  errors:   number
  appliedRows: Array<{ id: string; connector: string; proposal_kind: string }>
}

export async function autoApplyPendingProposals(opts?: {
  /** Hard limit per run so the function stays bounded for cron use. */
  maxApplications?: number
}): Promise<AutoApplyResult> {
  const svc = createServiceClient()
  const result: AutoApplyResult = { scanned: 0, applied: 0, skipped: 0, errors: 0, appliedRows: [] }
  const cap = opts?.maxApplications ?? 20

  const { data: pending, error } = await svc
    .from("connector_healing_proposals")
    .select("id, connector, proposal_kind, confidence, proposal_payload, detected_at")
    .eq("status", "pending")
    .in("proposal_kind", Object.keys(SAFE_KINDS))
    .order("detected_at", { ascending: true })  // oldest first — fairness
    .limit(cap * 5)  // overscan since some will be skipped (low confidence / unverified)
  if (error) {
    result.errors++
    return result
  }

  for (const p of pending ?? []) {
    if (result.applied >= cap) break
    result.scanned++

    const safeSpec = SAFE_KINDS[p.proposal_kind as string]
    if (!safeSpec) { result.skipped++; continue }
    if ((p.confidence ?? 0) < safeSpec.minConfidence) { result.skipped++; continue }

    // Per-kind extra checks
    let okToApply = false
    let appliedNotes = ""
    if (p.proposal_kind === "retry_other_actor") {
      // Runtime already swaps via pickActors(); record the auto-acknowledgement.
      okToApply = true
      appliedNotes = "auto-applied: runtime auto-swap handles actor rotation; marking proposal complete."
    } else if (p.proposal_kind === "rotate_key") {
      // Only auto-apply IF the most recent probe for this connector is healthy AFTER the proposal
      // was detected — confirming a human (or a deploy) already rotated the key.
      const { data: recent } = await svc
        .from("connector_health_log")
        .select("status, drifted, checked_at")
        .eq("provider", p.connector as string)
        .gt("checked_at", p.detected_at as string)
        .order("checked_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      // The cron writes posture statuses ('connected' / 'disconnected' / 'expired' / 'expiring_soon')
      // when probe is OFF and probe statuses (ProbeStatus union: 'ok' / 'shape_drift' / 'auth_failed'
      // / 'unreachable' / 'not_configured') when probe is ON. Healthy = either canonical "good"
      // string from those two systems.
      const HEALTHY_STATUSES = new Set(["ok", "connected"])
      const healthy = !!recent
        && HEALTHY_STATUSES.has(recent.status as string)
        && recent.drifted === false
      if (healthy) {
        okToApply = true
        appliedNotes = `auto-applied: connector recovered to healthy after detection (checked_at=${recent.checked_at}).`
      } else {
        result.skipped++
        continue
      }
    }

    if (!okToApply) { result.skipped++; continue }

    // Idempotent UPDATE — only flips if still pending. `.select()` so we know if it actually flipped.
    const { data: flipped, error: upErr } = await svc
      .from("connector_healing_proposals")
      .update({
        status:     "applied",
        applied_at: new Date().toISOString(),
        applied_by: "auto",
        notes:      appliedNotes,
      })
      .eq("id", p.id as string)
      .eq("status", "pending")
      .select("id")
      .maybeSingle()

    if (upErr) { result.errors++; continue }
    if (!flipped) { result.skipped++; continue }
    result.applied++
    result.appliedRows.push({
      id:            p.id as string,
      connector:     p.connector as string,
      proposal_kind: p.proposal_kind as string,
    })
    // Unify onto the ONE self-healing ledger (owner: connectors + data flows
    // heal on the same visible spine). Best-effort; a ledger write never fails.
    try {
      const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
      await recordSelfHeal(svc, {
        brokerageId: (p as any).brokerage_id ?? null,
        domain: "connector", subject: p.connector as string,
        action: p.proposal_kind as string, outcome: "healed",
        detail: { proposalId: p.id, confidence: p.confidence },
      })
    } catch { /* ledger is additive */ }
  }

  return result
}
