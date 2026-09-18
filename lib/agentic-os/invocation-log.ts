// lib/agentic-os/invocation-log.ts
// Audit + continued-learning log for the Agentic API. Every INVOKE decision (and its
// outcome) is recorded so the platform has (a) an audit trail of what agents did, and
// (b) a learning corpus — decision distribution, which capabilities get denied for a
// missing scope, which connectors are most invoked, drift/error rates. Fire-and-forget:
// logging must never break the invocation path.
//
// The decision→outcome mapping is pure + exported so it is unit-tested without a DB.

import { createServiceClient } from "@/lib/supabase/service"

export type InvocationOutcome = "executed" | "planned" | "denied" | "error"

/** Pure: collapse a planner/route decision into a coarse outcome for rollups. */
export function outcomeForDecision(decision: string): InvocationOutcome {
  switch (decision) {
    case "executed":
      return "executed"
    case "execute":
    case "requires_confirmation":
    case "no_executor":
      return "planned"
    case "unauthorized":
    case "invalid_input":
    case "blocked":
    case "not_connected":
      return "denied"
    case "error":
      return "error"
    default:
      return "planned"
  }
}

export interface InvocationLogInput {
  capability: string
  kind: "vendor" | "app" | "connected"
  verb?: string | null
  decision: string
  brokerageId?: string | null
  callerVia?: string | null
  authorized?: boolean | null
  durationMs?: number | null
  error?: string | null
  detail?: Record<string, unknown>
}

/**
 * Record one invocation. Never throws — a logging failure is swallowed so it can't break
 * the caller. Returns true when the row was written.
 */
export async function recordInvocation(input: InvocationLogInput): Promise<boolean> {
  try {
    const svc = createServiceClient()
    const { error } = await svc.from("agentic_invocation_log").insert({
      capability: input.capability,
      kind: input.kind,
      verb: input.verb ?? null,
      decision: input.decision,
      outcome: outcomeForDecision(input.decision),
      brokerage_id: input.brokerageId ?? null,
      caller_via: input.callerVia ?? null,
      authorized: input.authorized ?? null,
      duration_ms: input.durationMs ?? null,
      error: input.error ?? null,
      detail: input.detail ?? {},
    })
    return !error
  } catch {
    return false
  }
}

// ── READER: the half this log was written for and never got ──────────────────
//
// BUILT 2026-08-26 (orphan doctrine §1.2). The header above declares two
// purposes for this table — an AUDIT TRAIL of what agents did, and a LEARNING
// CORPUS ("decision distribution, which capabilities get denied for a missing
// scope, which connectors are most invoked, drift/error rates"). Neither
// existed. recordInvocation() was the ONLY code anywhere that named
// agentic_invocation_log (verified comment-stripped across app/ lib/ hooks/
// scripts/), so five of its columns — verb, caller_via, authorized, duration_ms
// and detail — were written by every /api/agentic-os call and read by nobody,
// forever. There was no duplicate reader to merge onto and no other surface
// where the answer lives, so the missing half is BUILT.
//
// Consumed by app/dashboard/superadmin/api-tokens/page.tsx, beside the Bearer
// credentials that authenticate the calls this log records — the audit trail
// belongs next to the thing being audited.
//
// PLATFORM-WIDE BY DESIGN, and that is a deliberate scope decision, not an
// oversight: the caller is a superadmin surface gated by requirePlatformCapability,
// and §4 lets platform see all tenants. `brokerageId` narrows it to one tenant
// for the tenant-scoped case; it is never taken from a request body.

export interface InvocationCapabilityRollup {
  capability: string
  kind: string
  /** The action word this capability performs, as recorded on the row. */
  verb: string | null
  total: number
  executed: number
  planned: number
  /** Refused — the "denied for a missing scope" signal the header asks for. */
  denied: number
  errored: number
  /** Rows whose `authorized` flag was explicitly false. */
  unauthorized: number
  /** Mean duration over rows that recorded one; null when none did. */
  avgDurationMs: number | null
  /** Distinct caller surfaces seen (e.g. "mcp", a token label). */
  callerVias: string[]
  /** Most recent error text, so a failing capability names its failure. */
  lastError: string | null
  lastAtIso: string
}

export interface InvocationSummary {
  ok: true
  sinceIso: string
  scannedRows: number
  /** True when the scan hit `limit` — the numbers are a floor, not a total. */
  truncated: boolean
  totals: { executed: number; planned: number; denied: number; errored: number }
  byCapability: InvocationCapabilityRollup[]
  /** Capabilities whose calls were refused for a missing scope, worst first. */
  deniedForScope: InvocationCapabilityRollup[]
}

export type InvocationSummaryResult = InvocationSummary | { ok: false; error: string }

/**
 * Roll up the invocation log over a recent window.
 *
 * A REFUSAL IS REPORTED AS A REFUSAL. recordInvocation() above swallows its
 * errors on purpose — logging must never break an invocation — but a READER that
 * swallowed them would render an empty audit trail, which reads as "no agent has
 * ever called anything" and is exactly the silent zero §2 forbids. So this
 * destructures error and returns ok:false.
 */
export async function summarizeInvocations(opts?: {
  days?: number
  limit?: number
  brokerageId?: string | null
}): Promise<InvocationSummaryResult> {
  const days = Math.max(1, Math.min(90, Math.floor(opts?.days ?? 14)))
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 2000)))
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  let svc: ReturnType<typeof createServiceClient>
  try {
    svc = createServiceClient()
  } catch (e: any) {
    return { ok: false, error: `service client unavailable: ${e?.message ?? String(e)}` }
  }

  let q = svc
    .from("agentic_invocation_log")
    .select("capability, kind, verb, decision, outcome, caller_via, authorized, duration_ms, error, detail, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (opts?.brokerageId) q = q.eq("brokerage_id", opts.brokerageId)

  const { data, error } = await q
  if (error) return { ok: false, error: `agentic_invocation_log read refused: ${error.message}` }

  const rows = data ?? []
  const acc = new Map<string, InvocationCapabilityRollup & { _durSum: number; _durN: number; _vias: Set<string> }>()
  const totals = { executed: 0, planned: 0, denied: 0, errored: 0 }

  for (const r of rows) {
    const capability = (r.capability as string | null) ?? "(unnamed)"
    const kind = (r.kind as string | null) ?? "(unknown)"
    const key = `${kind}::${capability}`
    let a = acc.get(key)
    if (!a) {
      a = {
        capability, kind, verb: (r.verb as string | null) ?? null,
        total: 0, executed: 0, planned: 0, denied: 0, errored: 0, unauthorized: 0,
        avgDurationMs: null, callerVias: [], lastError: null,
        lastAtIso: r.created_at as string,
        _durSum: 0, _durN: 0, _vias: new Set<string>(),
      }
      acc.set(key, a)
    }
    // Rows arrive newest-first, so the first verb/created_at seen is the latest.
    if (a.verb === null && r.verb) a.verb = r.verb as string
    a.total++

    // Prefer the stored outcome; fall back to the pure mapping when a historic
    // row predates the column, so an old row is bucketed rather than dropped.
    const outcome = ((r.outcome as string | null) ?? outcomeForDecision((r.decision as string | null) ?? "")) as InvocationOutcome
    if (outcome === "executed") { a.executed++; totals.executed++ }
    else if (outcome === "denied") { a.denied++; totals.denied++ }
    else if (outcome === "error") { a.errored++; totals.errored++ }
    else { a.planned++; totals.planned++ }

    if (r.authorized === false) a.unauthorized++
    const dur = r.duration_ms == null ? null : Number(r.duration_ms)
    if (dur != null && Number.isFinite(dur)) { a._durSum += dur; a._durN++ }
    const via = (r.caller_via as string | null) ?? null
    if (via) a._vias.add(via)
    // `detail` carries the WHY — missing connections, the selected provider, the
    // over-budget flag, the mcp marker. Surface it on the newest failure so a
    // refusal is diagnosable instead of just counted.
    if (!a.lastError && (outcome === "error" || outcome === "denied")) {
      const detail = (r.detail ?? null) as Record<string, unknown> | null
      const missing = Array.isArray(detail?.missing) ? (detail!.missing as unknown[]).join(", ") : null
      a.lastError =
        (r.error as string | null) ??
        (missing ? `missing connection: ${missing}` : null) ??
        (detail && Object.keys(detail).length ? JSON.stringify(detail).slice(0, 200) : null)
    }
  }

  const byCapability: InvocationCapabilityRollup[] = [...acc.values()]
    .map(a => {
      const { _durSum, _durN, _vias, ...rest } = a
      return { ...rest, avgDurationMs: _durN ? Math.round(_durSum / _durN) : null, callerVias: [..._vias].sort() }
    })
    .sort((x, y) => y.total - x.total)

  return {
    ok: true,
    sinceIso,
    scannedRows: rows.length,
    truncated: rows.length >= limit,
    totals,
    byCapability,
    deniedForScope: byCapability.filter(c => c.unauthorized > 0).sort((x, y) => y.unauthorized - x.unauthorized),
  }
}
