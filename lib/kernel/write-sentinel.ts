/**
 * lib/kernel/write-sentinel.ts
 *
 * THE WRITE SENTINEL — pass 4's answer to the bug class that hid every defect
 * the last three passes hand-hunted: best-effort DB writes silenced with
 * `.then(() => {}, () => {})` or a bare `await` that never checks `{ error }`.
 *
 * supabase-js does NOT throw on a rejected row — it RESOLVES with { error }.
 * The old silencers therefore hid two distinct failures:
 *   (a) the resolved { error } (FK violation, CHECK violation, NOT NULL) —
 *       the silent killer: the code path "succeeds" while the row is lost;
 *   (b) a genuine rejection (network, timeout).
 *
 * sentinelWrite keeps the best-effort CONTRACT (the caller's flow never
 * breaks, nothing throws) but makes the loss OBSERVABLE: every failure lands
 * on the append-only self_heal_events ledger (domain data_flow, action
 * 'best_effort_write', outcome 'failed') — the same ledger the repair digest
 * ranks and the Exception Center reads. A drifted CHECK literal or a wrong
 * id-class FK now announces itself in the weekly digest instead of silently
 * eating months of rows.
 *
 * The ledger write itself is best-effort (recordSelfHeal never throws), so
 * the sentinel can never make a webhook 500 — same guarantee as before, plus
 * eyes.
 *
 * Usage (replaces `.then(undefined, () => {})` / unchecked awaits):
 *   await sentinelWrite(svc, svc.from("voice_calls").insert({...}), {
 *     table: "voice_calls", flow: "voice_call_ledger", brokerageId,
 *   })
 */

import { recordSelfHeal } from "./self-heal-ledger"

export interface SentinelWriteContext {
  /** The table being written — the digest groups losses by it. */
  table: string
  /** The business flow the write belongs to (e.g. 'isa_outreach_record'). */
  flow: string
  brokerageId?: string | null
}

/**
 * Await a supabase write, swallow failure for the caller (best-effort
 * contract preserved), but ledger every loss. Returns true when the write
 * actually landed.
 */
export async function sentinelWrite(
  svc: any,
  op: PromiseLike<{ error?: { message?: string; code?: string } | null }>,
  ctx: SentinelWriteContext,
): Promise<boolean> {
  try {
    const result = await op
    const err = (result as any)?.error
    if (!err) return true
    await recordSelfHeal(svc, {
      brokerageId: ctx.brokerageId ?? null,
      domain: "data_flow",
      subject: `${ctx.flow}:${ctx.table}`,
      action: "best_effort_write",
      outcome: "failed",
      detail: {
        flow: ctx.flow,
        table: ctx.table,
        message: String(err.message ?? "").slice(0, 300),
        code: err.code ?? null,
      },
    })
    return false
  } catch (err) {
    await recordSelfHeal(svc, {
      brokerageId: ctx.brokerageId ?? null,
      domain: "data_flow",
      subject: `${ctx.flow}:${ctx.table}`,
      action: "best_effort_write",
      outcome: "failed",
      detail: {
        flow: ctx.flow,
        table: ctx.table,
        message: err instanceof Error ? err.message.slice(0, 300) : "rejected",
        code: null,
      },
    }).catch(() => null)
    return false
  }
}
