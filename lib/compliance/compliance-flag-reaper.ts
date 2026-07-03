// ─── COMPLIANCE-FLAG REAPER (Compliance Officer) ─────────────────────────────
// Nothing-falls-through guard for the highest-stakes domain: a Fair-Housing /
// consent / content flag that was RAISED but never reviewed, aged past its
// severity SLA, is escalated to the brokerage's compliance owners (the human
// compliance officer, else broker/admins). A dropped compliance flag is the one
// thing that must never sit silently. Pure SLA policy in compliance-flag-policy.ts.

import { createServiceClient } from "@/lib/supabase/service"
import { classifyStuckComplianceFlag, slaHoursForSeverity } from "./compliance-flag-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface ComplianceFlagReapResult {
  scanned: number
  escalated: number
}

// Who owns compliance oversight for a brokerage — the human compliance officer
// first, then broker/admins. Returns user ids (may be several).
async function resolveComplianceOwners(svc: Svc, brokerageId: string): Promise<string[]> {
  // TIER-SAFE — compliance/broker staff when present; the solo agent otherwise (their own oversight).
  const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
  return resolveOrgRecipients(svc, brokerageId, { roles: ["compliance_officer", "broker", "broker_admin", "admin"], limit: 20 })
}

export async function reapStuckComplianceFlags(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<ComplianceFlagReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: ComplianceFlagReapResult = { scanned: 0, escalated: 0 }

  const { data: rows } = await svc
    .from("compliance_flags")
    .select("id, status, severity, detected_at, agent_id, violation_type")
    .eq("brokerage_id", brokerageId)
    .eq("status", "flagged")
    .limit(opts?.limit ?? 200)

  if (!rows || rows.length === 0) return result

  let owners: string[] | null = null // resolved lazily, only if there's a stuck flag

  for (const row of rows as Array<{
    id: string; status: string | null; severity: string | null
    detected_at: string | null; agent_id: string | null; violation_type: string | null
  }>) {
    result.scanned++
    if (classifyStuckComplianceFlag({ status: row.status, severity: row.severity, detectedAt: row.detected_at, now }) !== "escalate") {
      continue
    }

    // Idempotent: one open escalation per flag (regardless of how many owners).
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", "compliance_flag_stuck")
      .eq("entity_id", row.id)
      .eq("is_read", false)
      .limit(1)
    if (prior && prior.length > 0) continue

    if (owners === null) owners = await resolveComplianceOwners(svc, brokerageId)
    // Fall back to the agent whose content was flagged if no compliance owner exists.
    const recipients = owners.length > 0 ? owners : (row.agent_id ? [row.agent_id] : [])
    if (recipients.length === 0) continue

    const sla = slaHoursForSeverity(row.severity)
    const sev = (row.severity ?? "unspecified").toString()
    const vtype = (row.violation_type ?? "compliance").toString().replace(/_/g, " ")
    for (const userId of recipients) {
      await svc.from("notifications").insert({
        user_id: userId,
        brokerage_id: brokerageId,
        type: "compliance_flag_stuck",
        title: "⚖️ A compliance flag is past its review window",
        body: `A ${sev}-severity ${vtype} flag has sat unreviewed past its ${sla}h SLA. Review it now — Fair-Housing and consent issues can't wait.`,
        entity_type: "compliance_flag",
        entity_id: row.id,
        priority: sev.toLowerCase() === "low" ? "medium" : "high",
        is_read: false,
      })
    }
    result.escalated++
  }

  return result
}
