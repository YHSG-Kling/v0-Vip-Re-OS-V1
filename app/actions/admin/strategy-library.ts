"use server"

/**
 * app/actions/admin/strategy-library.ts — the tenant-admin doors of the PLATFORM STRATEGY LIBRARY
 * (wave 107, lane 107E; m725).
 *
 * Tenant-admin only (TENANT_ADMIN_USER_TYPES via isTenantAdminGrantRole), tenant from the SESSION
 * (requireCallerTenant — no argument names a brokerage), gate first, then the service client (CLAUDE.md §4).
 *   listStrategyLibraryAction()                 every platform version + this brokerage's activation,
 *                                               the benchmark (107F seam) and the recommended authority
 *   activateLibraryStrategyFormAction(formData) activate a version — the local adaptation is computed and
 *                                               RECORDED (lib/kernel/strategy-engine.ts activateLibraryStrategy)
 */

import { revalidatePath } from "next/cache"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { isTenantAdminGrantRole } from "@/lib/auth/resolve-user-role"
import { createServiceClient } from "@/lib/supabase/service"
import type { StrategyLibraryEntry } from "@/lib/kernel/strategy-engine"

type Gate = { ok: true; brokerageId: string; userId: string } | { ok: false; error: string }

async function requireStrategyAdmin(): Promise<Gate> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  if (!isTenantAdminGrantRole(caller.userType)) return { ok: false, error: "Only a broker, owner, admin, team lead or compliance officer can manage the strategy library." }
  return { ok: true, brokerageId: caller.brokerageId, userId: caller.userId }
}

export async function listStrategyLibraryAction(): Promise<{ ok: true; entries: StrategyLibraryEntry[]; edition: number; learning: string; learningReason: string | null; readRefused: string | null } | { ok: false; error: string }> {
  const gate = await requireStrategyAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  const { listStrategyLibrary } = await import("@/lib/kernel/strategy-engine")
  const r = await listStrategyLibrary(gate.brokerageId, createServiceClient())
  return { ok: true, ...r }
}

export async function activateLibraryStrategyFormAction(formData: FormData): Promise<void> {
  const gate = await requireStrategyAdmin()
  if (!gate.ok) { console.warn(`[strategy-library] activation refused: ${gate.error}`); return }
  const key = String(formData.get("key") ?? "")
  const version = Number(formData.get("version") ?? "")
  if (!/^[a-z][a-z0-9_]*$/.test(key) || !Number.isInteger(version) || version < 1) { console.warn("[strategy-library] activation refused: key/version malformed"); return }
  const { activateLibraryStrategy } = await import("@/lib/kernel/strategy-engine")
  const r = await activateLibraryStrategy({ brokerageId: gate.brokerageId, key, version, actorUserId: gate.userId }, createServiceClient())
  if (!r.ok) console.warn(`[strategy-library] ${key}@v${version} not activated: ${r.reason}`)
  revalidatePath("/dashboard/admin/manager-trust")
}
