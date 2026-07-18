"use server"

// app/actions/superadmin/demo-tenant.ts
// ─────────────────────────────────────────────────────────────────────────────
// Superadmin surface for the persistent DEMO SHOWCASE TENANT (see
// lib/platform/demo-tenant.ts). Two actions:
//
//   getDemoTenantStatusAction       — read: does it exist, row counts, last reset
//   createOrResetDemoTenantAction   — write: provision (canonical signup path)
//                                     and/or wipe + re-seed the demo dataset
//
// Gating: the 'tenants' platform capability (write-required for the mutation),
// same as manual subscriber provisioning. Every mutation writes a
// superadmin_audit_log row (success AND failure). The destructive wipe is
// additionally hard-guarded inside lib/platform/demo-tenant.ts — it re-checks
// is_demo = true on the target row and refuses anything else.

import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import {
  getDemoTenantSnapshot,
  resetDemoTenant,
  type DemoTenantSnapshot,
  type DemoSeededTable,
} from "@/lib/platform/demo-tenant"

export interface DemoTenantStatusResult {
  ok: boolean
  error?: string
  status?: DemoTenantSnapshot
}

export interface CreateOrResetDemoTenantResult {
  ok: boolean
  error?: string
  created?: boolean
  brokerageId?: string
  slug?: string | null
  counts?: Record<DemoSeededTable, number>
}

async function writeAudit(actorUserId: string, action: string, targetId: string | null, details: Record<string, unknown>): Promise<void> {
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
    console.error("[demo-tenant] audit log write failed:", err)
  }
}

/** Read-only status for the "Demo showcase" card. */
export async function getDemoTenantStatusAction(): Promise<DemoTenantStatusResult> {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }
  const status = await getDemoTenantSnapshot()
  return { ok: true, status }
}

/**
 * Provision the demo tenant if missing (through the canonical signup path),
 * then wipe + re-seed its dataset. Idempotent; audited; write-gated.
 */
export async function createOrResetDemoTenantAction(): Promise<CreateOrResetDemoTenantResult> {
  const gate = await requirePlatformCapability("tenants", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }

  const result = await resetDemoTenant()
  const action = !result.ok
    ? "demo_tenant.reset_failed"
    : result.created
      ? "demo_tenant.created"
      : "demo_tenant.reset"

  await writeAudit(gate.userId, action, result.brokerage?.id ?? null, {
    created: result.created ?? false,
    slug: result.brokerage?.slug ?? null,
    seed_counts: result.counts ?? null,
    error: result.error ?? null,
  })

  if (!result.ok) return { ok: false, error: result.error ?? "Demo tenant reset failed" }

  revalidatePath("/dashboard/superadmin/brokerages")
  return {
    ok: true,
    created: result.created,
    brokerageId: result.brokerage?.id,
    slug: result.brokerage?.slug ?? null,
    counts: result.counts,
  }
}
