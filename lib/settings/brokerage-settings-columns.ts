/**
 * lib/settings/brokerage-settings-columns.ts — the writers of brokerage_settings' two
 * tenant-configurable REAL COLUMNS that had a reader and no writer (lane 86H).
 * ─────────────────────────────────────────────────────────────────────────────
 * Read live 2026-09-27 (project hrvaqgvukzxfskkcrwbt): both are real columns, NOT keys in
 * the `settings` jsonb, so they do not go through lib/settings/brokerage-settings-merge.ts
 * (that module is the one writer of the jsonb; it merges keys, and there are no keys here):
 *
 *   review_request_delay_days       INTEGER NULL, no default   (migration 061)
 *     reader: app/api/cron/review-request-on-close — NULL → lib/reputation/review-request-
 *     delay.ts REVIEW_REQUEST_DEFAULT_DELAY_DAYS, so NULL is how "reset to default" is written.
 *   live_agent_face_provider_order  TEXT[] NOT NULL DEFAULT ARRAY['did','simli']  (m627)
 *     reader: lib/live-agent/face-render.ts resolveFaceRenderProvider. NOT NULL, so "reset"
 *     writes the default order itself.
 *
 * Each write is ONE upsert on the live UNIQUE (brokerage_id) that names only its own column
 * (+ updated_at), so no other column or settings key is touched, and a brokerage with no row
 * yet gets one. It is COUNTED (CLAUDE.md §3): `.select("id")` must return exactly one row —
 * zero rows is a REFUSAL, never "saved". Bumping updated_at also moves the version
 * mergeBrokerageSettings compares, so a jsonb merge racing this write re-reads rather than
 * overwriting a row it did not read (its compare-and-set is equality on updated_at).
 *
 * The caller passes a service client it has ALREADY gated (CLAUDE.md §4: gate first); the
 * tenant is the brokerageId it resolved from the SESSION. Values are re-validated here, so
 * no caller can store what the reader cannot honour.
 *
 * VERSIONED (wave 101, lane 101A, m696): both columns are tenant operating policy. Each save reads
 * the value it replaces (a refused read refuses the save), and after the counted write appends an
 * immutable version through lib/kernel/tenant-policy.ts appendTenantPolicyVersion — the one
 * appender — attributed to the caller's session actor.
 */
import "server-only"
import { validateReviewRequestDelay } from "@/lib/reputation/review-request-delay"
import { validateFaceProviderOrder, type FaceRenderProvider } from "@/lib/live-agent/face-render"
import { appendTenantPolicyVersion, type PolicyActor } from "@/lib/kernel/tenant-policy"
import { LIFETIME_CONVERSION_POLICY_KEY } from "@/lib/kernel/lifetime-conversion"
import { mergeBrokerageSettings } from "@/lib/settings/brokerage-settings-merge"
import { FOLLOWUP_POLICY_KEY, resolveFollowupPolicy } from "@/lib/ai-isa/followup-policy"
import { ASKABLE_REVIEW_PLATFORMS, REPUTATION_PROFILES_KEY, parseReputationProfiles } from "@/lib/reputation/review-ask-policy"

type ColumnWriteResult<T> = { ok: true; rowId: string; value: T } | { ok: false; error: string }

/** Exactly one row back, or a refusal that says which setting was not saved. */
function countedOne<T>(
  noun: string,
  res: { data: unknown; error: { message: string } | null },
  value: T,
): ColumnWriteResult<T> {
  if (res.error) return { ok: false, error: `${noun} was not saved (${res.error.message}).` }
  const rows = Array.isArray(res.data) ? (res.data as Array<{ id?: string }>) : []
  if (rows.length !== 1 || !rows[0]?.id) {
    return { ok: false, error: `${noun} was not saved — the write matched ${rows.length} brokerage settings rows, not 1.` }
  }
  return { ok: true, rowId: rows[0].id, value }
}

export async function saveReviewRequestDelayDays(
  svc: any,
  brokerageId: string,
  days: number | null,
  actor?: PolicyActor,
): Promise<ColumnWriteResult<number | null>> {
  if (!brokerageId) return { ok: false, error: "No brokerage to save the review request delay for — nothing was written." }
  const v = validateReviewRequestDelay(days)
  if (!v.ok) return { ok: false, error: v.error }
  const prior = await readPrior(svc, brokerageId, "review_request_delay_days")
  if (!prior.ok) return prior
  const res = await svc
    .from("brokerage_settings")
    .upsert(
      { brokerage_id: brokerageId, review_request_delay_days: v.days, updated_at: new Date().toISOString() },
      { onConflict: "brokerage_id" },
    )
    .select("id")
  const out = countedOne("Review request delay", res, v.days)
  if (out.ok) await versionColumn(svc, brokerageId, "review_request_delay_days", v.days, prior.value, actor)
  return out
}

export async function saveLiveFaceProviderOrder(
  svc: any,
  brokerageId: string,
  order: unknown,
  actor?: PolicyActor,
): Promise<ColumnWriteResult<FaceRenderProvider[]>> {
  if (!brokerageId) return { ok: false, error: "No brokerage to save the live face provider order for — nothing was written." }
  const v = validateFaceProviderOrder(order)
  if (!v.ok) return { ok: false, error: v.error }
  const prior = await readPrior(svc, brokerageId, "live_agent_face_provider_order")
  if (!prior.ok) return prior
  const res = await svc
    .from("brokerage_settings")
    .upsert(
      { brokerage_id: brokerageId, live_agent_face_provider_order: v.order, updated_at: new Date().toISOString() },
      { onConflict: "brokerage_id" },
    )
    .select("id")
  const out = countedOne("Live face provider order", res, v.order)
  if (out.ok) await versionColumn(svc, brokerageId, "live_agent_face_provider_order", v.order, prior.value, actor)
  return out
}

type PolicyColumn = "review_request_delay_days" | "live_agent_face_provider_order"

/** The value this save replaces. A refused read refuses — history never starts from a guess. */
async function readPrior(svc: any, brokerageId: string, column: PolicyColumn): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const { data, error } = await svc.from("brokerage_settings").select(column).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `The current ${column} could not be read (${error.message}) — nothing was written.` }
  return { ok: true, value: (data as Record<string, unknown> | null)?.[column] ?? null }
}

async function versionColumn(svc: any, brokerageId: string, column: PolicyColumn, value: unknown, previous: unknown, actor: PolicyActor | undefined): Promise<void> {
  const v = await appendTenantPolicyVersion(svc, {
    brokerageId, policyKey: column, value, previous,
    actor: actor ?? { type: "system", reason: "column write without a named actor" },
  })
  if (!v.ok) console.error(`[brokerage-settings-columns] policy version of ${column} NOT recorded:`, v.error)
}

/**
 * settings.lifetime_conversion — the tenant's lifetime-conversion policy. The reader is
 * lib/kernel/lifetime-conversion.ts (wave 142C: "CLOSED / PAYOUT PENDING" holds the conversion until the
 * agent's payout is recorded when require_payout_verified is true); this is its ONE door (opposite-missing
 * 1b at wave-142 integration — the key was read and never written). A jsonb KEY, so the write goes through
 * the ONE settings writer, mergeBrokerageSettings (settings-merge-race: compare-and-set by key, never a
 * replace), which versions the key through TENANT_POLICY_SETTINGS_KEYS.
 */
export async function saveLifetimeConversionPolicy(
  svc: any,
  brokerageId: string,
  policy: { requirePayoutVerified: boolean },
  actor?: PolicyActor,
): Promise<ColumnWriteResult<{ require_payout_verified: boolean }>> {
  if (!brokerageId) return { ok: false, error: "No brokerage to save the lifetime conversion policy for — nothing was written." }
  if (typeof policy?.requirePayoutVerified !== "boolean") return { ok: false, error: "requirePayoutVerified must be true or false." }
  const value = { require_payout_verified: policy.requirePayoutVerified }
  const m = await mergeBrokerageSettings(svc, brokerageId, { [LIFETIME_CONVERSION_POLICY_KEY]: value }, { policy: actor })
  if (!m.ok) return { ok: false, error: m.error }
  return { ok: true, rowId: m.rowId, value }
}

/**
 * settings.followup_policy — the tenant's follow-up policy (wave 143, lane 143E). THE ONE door for it; the reader is
 * lib/ai-isa/followup-policy.ts loadFollowupPolicy. A jsonb KEY, so the write goes through mergeBrokerageSettings (compare-and-set
 * by key), which versions it through TENANT_POLICY_SETTINGS_KEYS. The submitted value is VALIDATED, never silently clamped: any
 * field the reader would have to correct (a send window wider than the legal 8-21, a moment key the touchpoint CHECK refuses, …)
 * refuses the save and says which. `null` clears the policy (the platform defaults apply again). Only known keys are stored.
 */
export async function saveFollowupPolicy(
  svc: any,
  brokerageId: string,
  policy: unknown,
  actor?: PolicyActor,
): Promise<ColumnWriteResult<Record<string, unknown> | null>> {
  if (!brokerageId) return { ok: false, error: "No brokerage to save the follow-up policy for — nothing was written." }
  let value: Record<string, unknown> | null = null
  if (policy !== null) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return { ok: false, error: "The follow-up policy must be an object (or null to reset)." }
    const KNOWN = ["guidance", "guardrails", "reengagement", "sphere", "nurture", "postClose", "arbiter"] as const
    value = {}
    for (const k of KNOWN) if ((policy as Record<string, unknown>)[k] !== undefined) value[k] = (policy as Record<string, unknown>)[k]
    const resolved = resolveFollowupPolicy(value)
    if (resolved.adjustments.length > 0) return { ok: false, error: `The follow-up policy was not saved — ${resolved.adjustments.join("; ")}.` }
  }
  const m = await mergeBrokerageSettings(svc, brokerageId, { [FOLLOWUP_POLICY_KEY]: value ?? undefined }, { policy: actor })
  if (!m.ok) return { ok: false, error: m.error }
  return { ok: true, rowId: m.rowId, value }
}

/**
 * settings.reputation_profiles — where a review request points and whether the agent approves each one (wave 143, lane 143E).
 * Reader: lib/reputation/review-ask-policy.ts parseReputationProfiles. A link the reader would refuse (placeholder text, a host
 * that is not the platform's, not https) refuses the SAVE, so the form can say why. `null` clears (no request is sent until a
 * real link exists again).
 */
export async function saveReputationProfiles(
  svc: any,
  brokerageId: string,
  profiles: unknown,
  actor?: PolicyActor,
): Promise<ColumnWriteResult<Record<string, unknown> | null>> {
  if (!brokerageId) return { ok: false, error: "No brokerage to save the reputation profiles for — nothing was written." }
  let value: Record<string, unknown> | null = null
  if (profiles !== null) {
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return { ok: false, error: "The reputation profiles must be an object (or null to clear)." }
    const KNOWN = [...ASKABLE_REVIEW_PLATFORMS, "agents", "approval", "platform_order"] as const
    value = {}
    for (const k of KNOWN) if ((profiles as Record<string, unknown>)[k] !== undefined) value[k] = (profiles as Record<string, unknown>)[k]
    const parsed = parseReputationProfiles({ [REPUTATION_PROFILES_KEY]: value })
    if (parsed.rejected.length > 0) return { ok: false, error: `The reputation profiles were not saved — ${parsed.rejected.map((r) => `${r.where}: ${r.reason}`).join("; ")}.` }
  }
  const m = await mergeBrokerageSettings(svc, brokerageId, { [REPUTATION_PROFILES_KEY]: value ?? undefined }, { policy: actor })
  if (!m.ok) return { ok: false, error: m.error }
  return { ok: true, rowId: m.rowId, value }
}
