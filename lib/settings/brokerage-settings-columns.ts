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
