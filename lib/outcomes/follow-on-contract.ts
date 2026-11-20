// lib/outcomes/follow-on-contract.ts — wave 155, lane 155J3 (directive J3 lines 419–430; eval REWARD-001 / REWARD-005 / SCOPE-006)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A FOLLOW-ON IS DURABLE WORK, NEVER A PASSIVE PROMISE. Both persisted follow-on kinds ride ONE queue — public.orchestrator_tasks
// (m931 'bundle_follow_on', written by lib/direct-mail/orchestrate-bundle-send.ts; m974 'next_action_follow_on', written by
// lib/ai-isa/followup-arbiter.ts persistNextActionFollowOn) — and ONE drain (app/api/cron/queue-drain/route.ts). This module is
// NOT a second queue, writer or arbiter: it is the PURE READER of directive J3's per-follow-on record over the payloads those two
// writers already store, so every queued item can be read back as: due trigger · executing owner · approved asset id / version ·
// channel · tenant scope · expiry · last state · receipt · readback · replay once-key · outcome · recovery.
//
// The drain asks `followOnContract(...).runnable` before it hands a row to its executor: a row with no tenant or no replay once-key
// cannot be executed at-most-once, so it is failed with the reason instead of run (fail closed). Every other judgment (reply, seat,
// consent, expiry against the live campaign, unknown outcome) stays with the row's own executor, which re-reads the live rows.
//
// `seatStanding` is the bundle executor's rule for "does this sending seat still sit in this tenant" — the same rule
// lib/sphere/lifetime-touch-arbitration.ts executeLifetimeFollowOn applies inline (status null or 'active', not deleted, same
// brokerage). (lib/kernel/authority-reactions.ts reactToMembershipChange keeps its own seat decision: users row +
// resolveViewerHierarchy.) No I/O, no model, no imports.

export type FollowOnShape = "next_action" | "bundle" | "unknown"

export interface FollowOnRow {
  id: string
  brokerage_id?: string | null
  task_type?: string | null
  status?: string | null
  scheduled_for?: string | null
  attempts?: number | null
  last_error?: string | null
  executed_at?: string | null
  payload?: Record<string, unknown> | null
}

export interface FollowOnContract {
  shape: FollowOnShape
  due_trigger: { trigger: string | null; waits_for: string[]; at: string | null }
  owner: { manager: string | null; seat: string | null }
  asset: { table: string | null; id: string | null; version: string | null }
  channel: string[]
  tenant: string | null
  /** The recorded expiry (next-action: its window end; bundle: the carrying campaign's end, read live by the executor). */
  expires_at: string | null
  last_state: string | null
  receipt: string | null
  readback: { executed_at: string | null; decided_at: string | null }
  once_key: string | null
  outcome: string | null
  recovery: { waits: number; requeues: number; deferrals: number }
  /** Fields a follow-on of this shape should carry and this row does not (honest gaps — never filled in). */
  gaps: string[]
  /** False = the drain must not execute it (no tenant or no once-key: a re-run could not be at-most-once). */
  runnable: boolean
  refusal: string | null
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

/** PURE. Which writer's shape a payload has — by its own fields, never by a restated task-type spelling. */
export function followOnShape(payload: Record<string, unknown> | null | undefined): FollowOnShape {
  const p = obj(payload)
  if (s(p.bundle_item_id) && s(p.bundle_dispatch_id)) return "bundle"
  if (s(p.planner) && s(p.subject_id)) return "next_action"
  return "unknown"
}

/** PURE. Directive J3's record of ONE queued follow-on, read from what its writer stored. `liveExpiry` = an expiry the caller read live. */
export function followOnContract(row: FollowOnRow, liveExpiry: string | null = null): FollowOnContract {
  const p = obj(row.payload)
  const shape = followOnShape(p)
  const outcome = obj(p.outcome)
  const gaps: string[] = []
  let c: Omit<FollowOnContract, "gaps" | "runnable" | "refusal" | "shape" | "tenant" | "last_state" | "readback" | "once_key" | "outcome" | "recovery">
  if (shape === "next_action") {
    const actor = obj(p.actor)
    const art = obj(actor.artifact)
    const origin = obj(p.origin)
    const elig = obj(p.eligibility)
    c = {
      due_trigger: { trigger: s(p.trigger), waits_for: strs(p.waits_for), at: s(row.scheduled_for) },
      owner: { manager: s(p.manager), seat: s(actor.agent_id) },
      asset: { table: s(art.table), id: s(art.id), version: null },
      channel: strs(elig.channels).length ? strs(elig.channels) : strs(origin.channels),
      expires_at: s(obj(p.window).end) ?? liveExpiry,
      receipt: s(outcome.provider_message_id) ?? s(origin.provider_message_id),
    }
    if (!c.due_trigger.trigger) gaps.push("due_trigger")
    if (!c.owner.manager) gaps.push("owner.manager")
  } else if (shape === "bundle") {
    const sender = obj(p.sender)
    const item = obj(p.item)
    c = {
      due_trigger: { trigger: "previous_item_settled", waits_for: strs(p.depends_on), at: s(row.scheduled_for) },
      owner: { manager: s(p.manager), seat: s(sender.user_id) ?? s(sender.agent_user_id) },
      asset: { table: s(item.preset_id) ? `${s(item.channel)}_preset` : null, id: s(item.preset_id), version: null },
      channel: s(item.channel) ? [s(item.channel) as string] : [],
      expires_at: s(p.expires_at) ?? liveExpiry,
      receipt: s(outcome.message_id),
    }
    if (!c.owner.manager) gaps.push("owner.manager")
    if (c.channel.length === 0) gaps.push("channel")
  } else {
    c = { due_trigger: { trigger: null, waits_for: [], at: s(row.scheduled_for) }, owner: { manager: null, seat: null }, asset: { table: null, id: null, version: null }, channel: [], expires_at: liveExpiry, receipt: null }
    gaps.push("shape")
  }
  const tenant = s(row.brokerage_id)
  const onceKey = s(p.idempotency_key)
  const refusal = !tenant
    ? "the follow-on names no tenant — it is never executed (tenant scope comes from the row, never guessed)"
    : !onceKey
      ? "the follow-on has no replay once-key — a re-run could not be at-most-once, so it is never executed"
      : null
  return {
    shape,
    ...c,
    tenant,
    last_state: s(row.status) ? `${row.status}${s(p.state) ? `:${p.state}` : ""}` : null,
    readback: { executed_at: s(row.executed_at), decided_at: s(outcome.decided_at) },
    once_key: onceKey,
    outcome: s(outcome.status),
    recovery: { waits: n(p.recovery_waits), requeues: n(p.recovery_requeues), deferrals: n(p.deferrals) },
    gaps: [...gaps, ...(tenant ? [] : ["tenant"]), ...(onceKey ? [] : ["once_key"])],
    runnable: refusal === null,
    refusal,
  }
}

/** PURE. A sending seat's standing in a tenant from its users row: live (status null or 'active', not deleted, same brokerage),
 *  gone (anything else, including no row), unreadable (the read was refused — the caller holds, never sends and never cancels). */
export function seatStanding(
  read: { row: { brokerage_id?: string | null; status?: string | null; deleted_at?: string | null } | null; error: { message: string } | null },
  brokerageId: string,
): { standing: "live" | "gone" | "unreadable"; why: string } {
  if (read.error) return { standing: "unreadable", why: `the seat could not be read (${read.error.message})` }
  const u = read.row
  if (!u) return { standing: "gone", why: "the sending seat no longer exists" }
  if (u.brokerage_id !== brokerageId) return { standing: "gone", why: "the sending seat no longer sits in this tenant" }
  if (u.deleted_at) return { standing: "gone", why: "the sending seat was removed" }
  if (u.status != null && u.status !== "active") return { standing: "gone", why: `the sending seat is ${u.status}` }
  return { standing: "live", why: "the sending seat is active in this tenant" }
}

/** PURE. Has a recorded expiry passed? Unknown (null) never expires anything — and never invents a deadline. */
export function followOnExpired(expiresAt: string | null, now: Date): boolean {
  if (!expiresAt) return false
  const t = Date.parse(expiresAt)
  return Number.isFinite(t) && t <= now.getTime()
}
