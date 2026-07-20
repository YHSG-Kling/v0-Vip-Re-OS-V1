"use server"

// app/actions/superadmin/deal-room-demo.ts
// ─────────────────────────────────────────────────────────────────────────────
// Superadmin surface for THE DEAL ROOM DEMO (lib/platform/deal-room-demo.ts) —
// the staged end-to-end deal story on the sanctioned demo tenant. Three actions:
//
//   getDealRoomDemoStatusAction — read: demo tenant + which story beats exist
//   seedDealRoomDemoAction      — write: teardown-previous → canonical baseline
//                                 → replay the story through the REAL rails
//   teardownDealRoomDemoAction  — write: remove ONLY the marked story rows
//                                 (FK order, residue-swept)
//
// Gating mirrors demo-tenant.ts: the 'tenants' platform capability, write-
// required for mutations. Every mutation writes a superadmin_audit_log row
// (success AND failure). The library layer re-checks is_demo = true on every
// destructive path — nothing here can be pointed at a production tenant.

import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import {
  seedDealRoomDemo,
  teardownDealRoomDemo,
  getDealRoomDemoStatus,
  type DealRoomSeedReport,
  type DealRoomStatus,
  type TeardownReport,
} from "@/lib/platform/deal-room-demo"

async function writeAudit(
  actorUserId: string, action: string, targetId: string | null, details: Record<string, unknown>,
): Promise<void> {
  try {
    const svc = createServiceClient()
    const { data: profile } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId,
      actor_email: (profile as { email?: string } | null)?.email ?? null,
      action,
      target_type: "brokerage",
      target_id: targetId,
      details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[deal-room-demo] audit log write failed:", err)
  }
}

export interface DealRoomStatusActionResult {
  ok: boolean
  error?: string
  status?: DealRoomStatus
}

/** Read-only status for the presenter page. */
export async function getDealRoomDemoStatusAction(): Promise<DealRoomStatusActionResult> {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const status = await getDealRoomDemoStatus()
  return { ok: true, status }
}

/**
 * Seed the full Deal Room story on the sanctioned demo tenant. Idempotent;
 * audited; write-gated; refuses (a) any non-demo target and (b) a demo tenant
 * carrying real-looking unmarked rows (the demo-day guard).
 */
export async function seedDealRoomDemoAction(): Promise<DealRoomSeedReport> {
  const gate = await requirePlatformCapability("tenants", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden", steps: [] }

  const report = await seedDealRoomDemo()
  await writeAudit(gate.userId, report.ok ? "deal_room_demo.seeded" : "deal_room_demo.seed_failed", report.brokerageId ?? null, {
    ok: report.ok,
    error: report.error ?? null,
    steps: report.steps.map((s) => `${s.beat} [${s.rail}] ${s.ok ? "ok" : "FAILED"}`),
    deliberation: report.deliberation ?? null,
    guard_suspects: report.guardSuspects ?? null,
  })
  if (report.ok) {
    revalidatePath("/dashboard/superadmin/demo-room")
    revalidatePath("/dashboard/superadmin/brokerages")
  }
  return report
}

/** Tear the story down — ONLY marked rows, FK order, residue-swept. Audited. */
export async function teardownDealRoomDemoAction(): Promise<TeardownReport> {
  const gate = await requirePlatformCapability("tenants", { requireWrite: true })
  if (!gate.ok || !gate.userId) {
    return { ok: false, error: gate.error ?? "Forbidden", deleted: {}, residue: [], errors: [] }
  }
  const report = await teardownDealRoomDemo()
  await writeAudit(gate.userId, report.ok ? "deal_room_demo.teardown" : "deal_room_demo.teardown_failed", null, {
    ok: report.ok,
    error: report.error ?? null,
    deleted: report.deleted,
    residue: report.residue,
    errors: report.errors.slice(0, 10),
  })
  if (report.ok) revalidatePath("/dashboard/superadmin/demo-room")
  return report
}
