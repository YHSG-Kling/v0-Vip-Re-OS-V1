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

    const { data: flag, error } = await supabase
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
      .maybeSingle()

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

    const { data: flag, error } = await supabase
      .from("compliance_flags")
      .update({
        status,
        resolution_notes: notes,
        resolved_at: status === "resolved" ? new Date().toISOString() : null,
      })
      .eq("id", flagId)
      .eq("brokerage_id", auth.brokerageId)
      .select()
      .maybeSingle()

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
