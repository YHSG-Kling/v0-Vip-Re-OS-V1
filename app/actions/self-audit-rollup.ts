"use server"

/**
 * app/actions/self-audit-rollup.ts — sentinel-gated doorway to the
 * first-week telemetry rollup (lib/platform/self-audit-rollup). Read-only.
 */

import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { computeSelfAuditRollup, type SelfAuditRollup } from "@/lib/platform/self-audit-rollup"

export async function loadSelfAuditRollup(): Promise<{ success: boolean; error?: string; rollup?: SelfAuditRollup }> {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.ok) return { success: false, error: gate.error ?? "Forbidden" }

  const rollup = await computeSelfAuditRollup(createServiceClient())
  return { success: true, rollup }
}
