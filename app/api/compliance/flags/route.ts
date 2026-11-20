import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

// TOMBSTONE (§1.3 orphan doctrine — scripts/handler-parity-census.ts,
// 2026-09-11): GET used to live here — zero in-tree callers (this file's own
// prior tombstone already noted it read nothing off the request, which is
// what let the census's method-parity check name it: the same query, scoped
// to session brokerage_id with the same agent-only narrowing, already runs
// as the SURVIVOR at lib/application/compliance-monitoring.ts::
// getComplianceViolationsService (exported as getComplianceViolations,
// app/actions/compliance-monitoring.ts:195) — the reader
// app/compliance/violations/page.tsx has called since it shipped. Two
// spellings of "read this brokerage's compliance flags" is exactly §6's
// defect; this one had no caller, so it is the copy that goes.
//
// BUILT (§1.2 orphan doctrine — scripts/handler-parity-census.ts, 2026-09-11):
// app/compliance/violations/new/page.tsx has POSTed here since it shipped —
// `method: 'POST'` in its handleSubmit — and this route exported only
// GET/PATCH, so every manual "Flag New Violation" submission ran as a
// guaranteed 405 and the page's own `if (res.ok)` guard silently ate the
// failure (the empty catch below it never saw an error either, since fetch
// only rejects on a network failure, not a non-2xx status). No duplicate
// manual-flag writer exists elsewhere in the tree — every other
// compliance_flags insert (lib/kernel/consistency-guardian.ts,
// lib/kernel/manager-signals.ts, lib/ai/models.ts, lib/services/
// communication.service.tsx) is an AUTOMATED detector firing its own
// violation_type, not a human-authored flag — so this is the missing half,
// not a second copy of one that already existed.
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  // Only brokers/admins/compliance officers may HAND-AUTHOR a flag — the same
  // roster PATCH already gates, so authoring and resolving share one gate.
  if (!["broker", "broker_owner", "admin", "compliance_officer"].includes(auth.userType)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const violationType = typeof body?.violation_type === "string" ? body.violation_type.trim() : ""
    const description = typeof body?.description === "string" ? body.description.trim() : ""
    const severityInput = typeof body?.severity === "string" ? body.severity : "medium"
    const severity = (["low", "medium", "high", "critical"].includes(severityInput) ? severityInput : "medium") as
      "low" | "medium" | "high" | "critical"
    const agentIdInput = typeof body?.agent_id === "string" && body.agent_id.trim() ? body.agent_id.trim() : null

    if (!violationType) {
      return NextResponse.json({ success: false, error: "Violation type is required" }, { status: 400 })
    }

    // TENANT FROM THE SESSION (CLAUDE.md §4) — agent_id is the only field the
    // wire may name, and it does not TRUST it: re-read and require the SAME
    // brokerage before it is attached to the flag.
    let agentId: string | null = null
    if (agentIdInput) {
      const { data: agentRow, error: agentErr } = await supabase
        .from("agents")
        .select("id, brokerage_id")
        .eq("id", agentIdInput)
        .maybeSingle()
      if (agentErr) {
        return NextResponse.json({ success: false, error: `Could not verify that agent: ${agentErr.message}` }, { status: 500 })
      }
      if (!agentRow || agentRow.brokerage_id !== auth.brokerageId) {
        return NextResponse.json({ success: false, error: "That agent is not in your brokerage." }, { status: 403 })
      }
      agentId = agentRow.id
    }

    const { data: flag, error } = await ledgered(auth, { action: "compliance.flag.create", subject: { type: "agent", id: agentId, ref: agentId ? null : "manual_flag" }, riskClass: "LOW_RISK_WRITE", detail: { violation_type: violationType, severity } }, async () => supabase
      .from("compliance_flags")
      .insert({
        brokerage_id: auth.brokerageId,
        agent_id: agentId,
        user_id: auth.userId,
        violation_type: violationType,
        content_type: "manual_flag",
        flagged_content: description || violationType,
        severity,
        // LIVE CHECK vocabulary: flagged/reviewed/resolved/overridden (never 'open').
        status: "flagged",
        detected_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle().then((r) => ({ ...r, success: !r.error && !!r.data })))

    if (error) {
      console.error("[Compliance Flag Create] DB error:", error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, flag })
  } catch (error: any) {
    console.error("[Compliance Flag Create] Error:", error)
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  // Only brokers/admins/compliance officers can update flags
  // SCOPE LADDER (kept inline — admits compliance_officer): 'superadmin'
  // removed — dead as users.user_type (0 live rows); broker_owner added —
  // storable seat that owns the brokerage.
  if (!["broker", "broker_owner", "admin", "compliance_officer"].includes(auth.userType)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 })
  }

  try {
    const { flagId, status, notes } = await request.json()

    if (!flagId) {
      return NextResponse.json({ success: false, error: "Flag ID required" }, { status: 400 })
    }

    const { data: flag, error } = await ledgered(auth, { action: "compliance.flag.update", subject: { type: "compliance_flag", id: typeof flagId === "string" ? flagId : null }, riskClass: "LOW_RISK_WRITE", detail: { status: typeof status === "string" ? status : null } }, async () => supabase
      .from("compliance_flags")
      .update({
        status,
        resolution_notes: notes,
        resolved_at: status === "resolved" ? new Date().toISOString() : null,
      })
      .eq("id", flagId)
      .eq("brokerage_id", auth.brokerageId)
      .select()
      .maybeSingle().then((r) => ({ ...r, success: !r.error && !!r.data })))

    if (error) {
      console.error("[Compliance Flag Update] DB error:", error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    if (!flag) {
      return NextResponse.json(
        { success: false, error: "Flag not found or access denied" },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true, flag })
  } catch (error: any) {
    console.error("[Compliance Flag Update] Error:", error)
    return NextResponse.json(
      { success: false, error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * WAVE 155 (lane 155R9, G12): ONE agent_action_ledger receipt per session write — ledgerSessionAction
 * (lib/kernel/action-ledger.ts) does the claim → run → settle. Who and which tenant come from the SESSION (CLAUDE.md §4);
 * "session" resolves them through getAgentContext. NO idempotency key: a person's second save runs again and leaves a
 * second receipt. The export's value comes back unchanged; a refused claim (only a malformed action name, caught by
 * test:action-ledger §14) throws instead of returning a value of another shape. No session tenant → the write runs exactly
 * as before, unrecorded (agent_action_ledger.brokerage_id is NOT NULL — there is no valid row to write).
 * @proofSeam scripts/ledger-receipts-transaction2-guard.ts
 */
async function ledgered<T>(
  who: { userId?: string | null; brokerageId?: string | null; agentId?: string | null } | null | undefined | "session",
  what: { action: string; subject: { type: string; id?: string | null; ref?: string | null }; riskClass: string; detail?: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const seat = who === "session" ? await (await import("@/lib/identity/get-agent-context")).getAgentContext() : who
  if (!seat?.userId || !seat.brokerageId) return run()
  const id = what.subject.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(what.subject.id) ? what.subject.id : null
  const subject = { type: what.subject.type, id, ref: id ? what.subject.ref ?? null : what.subject.ref ?? what.subject.id ?? null }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  let ran = false
  const r = await ledgerSessionAction({ brokerageId: seat.brokerageId, action: what.action, actor: { type: "user", userId: seat.userId, agentId: seat.agentId ?? null }, subject, riskClass: what.riskClass, reasonCode: "HUMAN_REQUESTED", detail: what.detail ?? null }, async () => { ran = true; return run() })
  if (!ran) throw new Error((r as { error?: string }).error ?? "action ledger refused the claim")
  return r as T
}
