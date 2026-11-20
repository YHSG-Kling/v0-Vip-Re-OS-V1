/**
 * lib/video/body-visual-rule-ledger.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEDGER of learned body-visual rule changes — per tenant, audited,
 * reversible, and read by the director at commission time.
 *
 * OWNER (wave 80, verbatim): "if there is any changes to the registry rule
 * for the purpose allowable autonomous ai can learn."
 *
 * ── ALREADY EXISTED — REUSED ────────────────────────────────────────────────
 *   · lib/managers/learning-loop.ts — the manager learning loop keeps its
 *     learned adjustments on brokerage_settings.settings.learned_adjustments
 *     with a human OFF-SWITCH in settings.learned_vetoes; this ledger lives
 *     beside it on the SAME jsonb (settings.body_visual_rule_overrides) and
 *     honours the SAME veto map (key `body_visual:<purpose>`), so a broker's
 *     veto on a learned visual rule reads like every other veto. jsonb, no
 *     column, no CHECK (scripts/schema-snapshot.ts brokerage_settings.settings;
 *     scripts/check-vocabularies.ts carries no CHECK on it) — no migration;
 *     m663 unused.
 *   · lib/kernel/manager-signals.ts publishManagerSignal — the humans are told
 *     through the existing manager-signal rail (asset_manager →
 *     compliance_officer / campaign_orchestrator, signal_type
 *     body_visual_rule_changed / _reverted); loadRecentManagerTalk surfaces it
 *     on the Command Center like every other signal.
 *   · lib/video/body-visual-model.ts — the BOUNDS (checkRuleOverrideBounds)
 *     and the application (resolvePurposeRule). This module never widens a
 *     rule: an override that fails the bounds is refused here AND skipped by
 *     the resolver if it were ever written by hand.
 *   · lib/video/format-learning.ts recommendBodyVisualRuleAdjustment — the
 *     PROPOSER, gated on a real sample and a clear margin like every other
 *     learned pick in this repo.
 *
 * AUTONOMOUS, BOUNDED, LOGGED, REVERSIBLE: applyBodyVisualRuleOverride writes
 * the entry and raises the signal in one call; revertBodyVisualRuleOverride
 * stamps reverted_at (the entry stays — the ledger is append-only) and raises
 * the reversal. Every write is COUNTED (CLAUDE.md §3).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { mergeBrokerageSettings } from "@/lib/settings/brokerage-settings-merge"
import { checkRuleOverrideBounds, type BodyVisualRuleOverride } from "@/lib/video/body-visual-model"

type Svc = ReturnType<typeof createServiceClient>

const BODY_VISUAL_OVERRIDES_KEY = "body_visual_rule_overrides"
/** The veto key the manager learning loop's off-switch reads (settings.learned_vetoes). */
export function bodyVisualVetoKey(purpose: string): string { return `body_visual:${purpose}` }

async function readSettings(svc: Svc, brokerageId: string): Promise<{ exists: boolean; settings: Record<string, unknown> } | { error: string }> {
  const { data, error } = await svc.from("brokerage_settings").select("id, settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { error: error.message }
  return { exists: !!data, settings: (((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>) }
}

function entriesOf(settings: Record<string, unknown>): BodyVisualRuleOverride[] {
  const raw = settings[BODY_VISUAL_OVERRIDES_KEY]
  return Array.isArray(raw) ? (raw as BodyVisualRuleOverride[]).filter((o) => o && typeof o.id === "string" && typeof o.purpose === "string") : []
}

/** The ledger key, merged BY KEY through the one settings writer (86C): `mutate` runs on the
 *  entries the database holds AT WRITE TIME (version-checked, counted), so a concurrent apply,
 *  revert or any other feature's key is re-read and kept, never overwritten by a stale copy. */
async function writeEntries(svc: Svc, brokerageId: string, mutate: (fresh: BodyVisualRuleOverride[]) => BodyVisualRuleOverride[]): Promise<{ ok: boolean; reason?: string }> {
  const write = await mergeBrokerageSettings(svc, brokerageId, (settings) => ({ [BODY_VISUAL_OVERRIDES_KEY]: mutate(entriesOf(settings)) }))
  return write.ok ? { ok: true } : { ok: false, reason: write.error }
}

/**
 * The LIVE overrides for a tenant — what the director passes to
 * stageBodyVisualPlan. Reverted entries and vetoed purposes are left out;
 * the resolver re-checks the bounds. A refused read returns [] and says so
 * on the console (never a silent "no learning" that hides an RLS refusal).
 */
export async function loadBodyVisualRuleOverrides(brokerageId: string, client?: Svc): Promise<BodyVisualRuleOverride[]> {
  if (!brokerageId) return []
  const svc = client ?? createServiceClient()
  const read = await readSettings(svc, brokerageId)
  if ("error" in read) { console.error(`[body-visual-rule-ledger] brokerage_settings read refused for ${brokerageId}: ${read.error}`); return [] }
  const vetoes = (read.settings.learned_vetoes ?? {}) as Record<string, boolean>
  return entriesOf(read.settings).filter((o) => !o.revertedAt && vetoes[bodyVisualVetoKey(o.purpose)] !== true && checkRuleOverrideBounds(o).ok)
}

/** Every entry, live or reverted — the human-oversight read. */
export async function listBodyVisualRuleOverrides(brokerageId: string, client?: Svc): Promise<BodyVisualRuleOverride[]> {
  const svc = client ?? createServiceClient()
  const read = await readSettings(svc, brokerageId)
  return "error" in read ? [] : entriesOf(read.settings)
}

export type LedgerResult = { ok: true; override: BodyVisualRuleOverride; signalId: string | null } | { ok: false; reason: string }

/**
 * APPLY a proposed override autonomously — after the bounds, never before —
 * write the ledger entry, and tell the humans through the manager-signal
 * rail. Idempotent per (purpose, change): an identical live entry is returned
 * rather than duplicated.
 */
export async function applyBodyVisualRuleOverride(
  brokerageId: string,
  proposal: Omit<BodyVisualRuleOverride, "id" | "appliedAt" | "revertedAt">,
  client?: Svc,
): Promise<LedgerResult> {
  if (!brokerageId) return { ok: false, reason: "brokerageId required" }
  const svc = client ?? createServiceClient()
  const candidate: BodyVisualRuleOverride = { ...proposal, id: `bvr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, appliedAt: new Date().toISOString(), revertedAt: null }
  const bounds = checkRuleOverrideBounds(candidate)
  if (!bounds.ok) return { ok: false, reason: `refused — outside the learning bounds: ${bounds.reason}` }
  const read = await readSettings(svc, brokerageId)
  if ("error" in read) return { ok: false, reason: `brokerage_settings read refused: ${read.error}` }
  const vetoes = (read.settings.learned_vetoes ?? {}) as Record<string, boolean>
  if (vetoes[bodyVisualVetoKey(candidate.purpose)] === true) return { ok: false, reason: `a broker veto stands on learned visual rules for ${candidate.purpose} (learned_vetoes.${bodyVisualVetoKey(candidate.purpose)})` }
  const entries = entriesOf(read.settings)
  const same = entries.find((o) => !o.revertedAt && o.purpose === candidate.purpose && JSON.stringify(o.change) === JSON.stringify(candidate.change))
  if (same) return { ok: true, override: same, signalId: null }
  // Re-judged on the FRESH ledger: an identical live entry written concurrently is not doubled.
  const wrote = await writeEntries(svc, brokerageId, (fresh) => fresh.some((o) => !o.revertedAt && o.purpose === candidate.purpose && JSON.stringify(o.change) === JSON.stringify(candidate.change)) ? fresh : [...fresh, candidate])
  if (!wrote.ok) return { ok: false, reason: `ledger write refused: ${wrote.reason}` }
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const change = candidate.change.kind === "prefer_treatment"
    ? `prefer ${candidate.change.treatment} on ${candidate.change.segmentKind} segments`
    : `prefer the ${candidate.change.background} background`
  const signal = await publishManagerSignal({
    brokerageId, fromManager: "asset_manager", toManager: "compliance_officer",
    signalType: "body_visual_rule_changed",
    message: `Learned body-visual rule applied for ${candidate.purpose}: ${change} (sample ${candidate.sample}). ${candidate.why} Reversible: revertBodyVisualRuleOverride("${candidate.id}"); veto: learned_vetoes.${bodyVisualVetoKey(candidate.purpose)}.`,
    entityType: "body_visual_rule_override", entityId: candidate.id,
    payload: { override: candidate, revertible: true, veto_key: bodyVisualVetoKey(candidate.purpose) },
  }, svc)
  return { ok: true, override: candidate, signalId: signal.ok ? (signal.signalId ?? null) : null }
}

/** REVERT a live override (append-only: the entry stays, stamped) and tell the humans. */
export async function revertBodyVisualRuleOverride(brokerageId: string, overrideId: string, reason: string, client?: Svc): Promise<LedgerResult> {
  if (!brokerageId || !overrideId) return { ok: false, reason: "brokerageId + overrideId required" }
  const svc = client ?? createServiceClient()
  const read = await readSettings(svc, brokerageId)
  if ("error" in read) return { ok: false, reason: `brokerage_settings read refused: ${read.error}` }
  const entries = entriesOf(read.settings)
  const target = entries.find((o) => o.id === overrideId)
  if (!target) return { ok: false, reason: `no override ${overrideId} on this tenant's ledger` }
  if (target.revertedAt) return { ok: true, override: target, signalId: null }
  const reverted: BodyVisualRuleOverride = { ...target, revertedAt: new Date().toISOString() }
  const wrote = await writeEntries(svc, brokerageId, (fresh) => fresh.map((o) => (o.id === overrideId && !o.revertedAt ? reverted : o)))
  if (!wrote.ok) return { ok: false, reason: `ledger write refused: ${wrote.reason}` }
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const signal = await publishManagerSignal({
    brokerageId, fromManager: "asset_manager", toManager: "compliance_officer",
    signalType: "body_visual_rule_reverted",
    message: `Learned body-visual rule ${overrideId} for ${target.purpose} reverted: ${reason}`,
    entityType: "body_visual_rule_override", entityId: `${overrideId}:reverted`,
    payload: { override: reverted, reason },
  }, svc)
  return { ok: true, override: reverted, signalId: signal.ok ? (signal.signalId ?? null) : null }
}
