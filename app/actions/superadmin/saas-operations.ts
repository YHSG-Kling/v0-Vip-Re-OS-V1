"use server"

// app/actions/superadmin/saas-operations.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM SUPPORT MISSIONS — the staff decision door (wave 108B). The platform-sentinel cron
// (lib/platform/saas-operations.ts) opens a support mission in PROPOSED when a tenant's usage
// anomaly is diagnosed; platform staff APPROVE (→ ACTIVE: staff take the work) or DISMISS
// (→ CANCELLED). An ACTIVE mission completes on its own when the next sweep sees usage recover.
//
// Gate: requirePlatformCapability("sentinel", { requireWrite: true }) — fail closed. The subject
// tenant is NEVER taken from the caller: the mission is read by id under platform scope and its own
// brokerage_id is used (CLAUDE.md §4 — no body-supplied brokerageId on a service client). The move
// goes through transitionMission (ledger row + mission_events — LAW 5); nothing here contacts the
// tenant.

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { PLATFORM_SUPPORT_SUBJECT_TYPE, transitionMission } from "@/lib/kernel/missions"

export async function decidePlatformSupportMission(input: { missionId: string; decision: "approve" | "dismiss"; reason?: string }): Promise<{ ok: boolean; error?: string; state?: string }> {
  const gate = await requirePlatformCapability("sentinel", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!input?.missionId || (input.decision !== "approve" && input.decision !== "dismiss")) return { ok: false, error: "missionId and a decision (approve | dismiss) are required" }
  const svc = createServiceClient()
  const { data, error } = await svc.from("missions").select("id, brokerage_id, state").eq("id", input.missionId).eq("subject_type", PLATFORM_SUPPORT_SUBJECT_TYPE).maybeSingle()
  if (error) return { ok: false, error: `Mission could not be read: ${error.message}` }
  if (!data) return { ok: false, error: "No platform support mission with that id." }
  const to = input.decision === "approve" ? "ACTIVE" : "CANCELLED"
  const reason = String(input.reason ?? "").trim() || (input.decision === "approve" ? "platform staff took the support work" : "platform staff dismissed the support mission")
  const r = await transitionMission({ brokerageId: data.brokerage_id as string, missionId: data.id as string, to, reason, actor: { type: "user", id: gate.userId, scope: "platform" } }, svc as any)
  if (!r.ok) return { ok: false, error: r.reason }
  revalidatePath("/dashboard/superadmin/sentinel")
  return { ok: true, state: r.mission.state }
}
