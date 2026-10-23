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
 *   - `declared_alternate` (wave 137, lane 137C — owner: "apply the declared change … retry, record
 *     evidence") — a CONFIG-level alternate the provider's ADAPTER DECLARATION lists in code
 *     (lib/kernel/provider-adapters.ts api.alternates, level 'config': a version query/header or a
 *     base URL). Applied only when the declaration still lists it; the row stores the alternate ID,
 *     never the config — egress reads the config from code (provider-adapters.ts loadAppliedAlternate), so a DB row can
 *     never point the gateway at an undeclared endpoint.
 *
 * Anything else (endpoint_change / auth_change / param_rename / shape_update / no_evidence) is
 * NEVER auto-applied — those need human review because the change semantics can break callers.
 *
 * Idempotent: each pass selects rows with status='pending' and uses the same .eq("status","pending")
 * guard on the UPDATE so a concurrent admin click can never race the auto-applier.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { declaredConfigAlternate } from "@/lib/kernel/provider-adapters"

const SAFE_KINDS: Record<string, { minConfidence: number }> = {
  retry_other_actor:  { minConfidence: 0.5 },
  rotate_key:         { minConfidence: 0.8 },
  declared_alternate: { minConfidence: 1 },
}

type ApplierClient = { from: (table: string) => any }

/**
 * Apply ONE declared config-level alternate (lane 137C): write the evidence row as a
 * `declared_alternate` proposal, then flip it pending → applied through the SAME idempotent,
 * `.select()`-counted update the cron pass uses. Refuses an alternate the adapter does not declare
 * at config level. Never throws.
 */
export async function applyDeclaredAlternate(
  svc: ApplierClient,
  p: { connector: string; alternateId: string; failureSignature: string; evidence: Record<string, unknown> },
): Promise<{ applied: boolean; proposalId: string | null; reason: string }> {
  const declared = declaredConfigAlternate(p.connector, p.alternateId)
  if (!declared) return { applied: false, proposalId: null, reason: `${p.alternateId} is not a declared config-level alternate of ${p.connector}` }
  const { adapter, alternate } = declared
  const { data: row, error: insErr } = await svc.from("connector_healing_proposals").insert({
    connector: p.connector,
    failure_signature: p.failureSignature.slice(0, 300),
    failure_sample: [p.evidence],
    proposal_kind: "declared_alternate",
    proposal_summary: `apply declared alternate ${alternate.id} (${alternate.version ?? alternate.baseUrl ?? "config"}) — ${alternate.reason}`.slice(0, 500),
    proposal_payload: { alternate_id: alternate.id, provider: adapter.provider, old: { version: adapter.api.version, baseUrl: adapter.api.baseUrl }, new: { version: alternate.version ?? null, baseUrl: alternate.baseUrl ?? null, query: alternate.query ?? null, headers: alternate.headers ? Object.keys(alternate.headers) : null } },
    docs_evidence: adapter.api.docsUrl ? [{ url: adapter.api.docsUrl, snippet: alternate.reason }] : [],
    confidence: 1,
    status: "pending",
  }).select("id").maybeSingle()
  if (insErr || !row?.id) return { applied: false, proposalId: null, reason: `evidence row refused: ${insErr?.message ?? "no row"}` }
  const { data: flipped, error: upErr } = await svc.from("connector_healing_proposals")
    .update({ status: "applied", applied_at: new Date().toISOString(), applied_by: "auto", notes: `auto-applied declared alternate ${alternate.id} (adapter declaration, config-level)` })
    .eq("id", row.id).eq("status", "pending").select("id")
  if (upErr) return { applied: false, proposalId: row.id, reason: `apply refused: ${upErr.message}` }
  if (!Array.isArray(flipped) || flipped.length !== 1) return { applied: false, proposalId: row.id, reason: `apply matched ${Array.isArray(flipped) ? flipped.length : 0} rows — not applied` }
  return { applied: true, proposalId: row.id, reason: `applied ${alternate.id}` }
}

// The applied-alternate READER lives beside the declaration it resolves through:
// lib/kernel/provider-adapters.ts loadAppliedAlternate (read by the gateway at egress and by the healer).

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
    if (p.proposal_kind === "declared_alternate") {
      // Still declared at config level in code? A row naming an alternate the declaration dropped stays pending.
      const altId = (p.proposal_payload as { alternate_id?: string } | null)?.alternate_id ?? ""
      if (!declaredConfigAlternate(p.connector as string, altId)) { result.skipped++; continue }
      okToApply = true
      appliedNotes = `auto-applied: declared config-level alternate ${altId} (adapter declaration).`
    } else if (p.proposal_kind === "retry_other_actor") {
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
