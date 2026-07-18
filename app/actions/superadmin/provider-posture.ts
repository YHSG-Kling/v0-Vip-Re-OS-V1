"use server"

// app/actions/superadmin/provider-posture.ts
// ─────────────────────────────────────────────────────────────────────────────
// Fleet-wide provider posture sweeps — providers-gated, ON DEMAND (each sweep
// makes real vendor calls, so it's a button, not a page-load), audited,
// read-only against every vendor. See lib/platform/provider-posture.ts for
// what each sweep verifies and the honest not-configured states.

import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  getTwilioFleetPosture,
  getSendgridPosture,
  getFullProviderPosture,
  type TwilioFleetPosture,
  type SendgridPosture,
  type FullProviderPosture,
} from "@/lib/platform/provider-posture"

async function audit(svc: ReturnType<typeof createServiceClient>, userId: string, action: string, details: Record<string, unknown>) {
  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: userId, action, target_type: "platform", target_id: "provider_posture",
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[provider-posture audit] failed:", err) }
}

export async function getTwilioFleetPostureAction(): Promise<
  { ok: true; posture: TwilioFleetPosture } | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("providers")
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }

  const svc = createServiceClient()
  const posture = await getTwilioFleetPosture(svc)
  await audit(svc, gate.userId, "provider_posture.twilio_fleet_swept", {
    liveProbes: posture.liveProbes, totalTenants: posture.totalTenants, probedTenants: posture.probedTenants,
    driftedTenants: posture.tenants.filter((t) => t.driftedCount > 0).length,
  })
  return { ok: true, posture }
}

/** The FULL-REGISTRY posture sweep (owner correction to round 24): every
 *  provider the platform manages — derived from the code's own vocabularies,
 *  never a hand-picked trio. DB + env reads only (zero vendor calls), so it is
 *  cheap on demand; the Twilio/SendGrid actions below stay the vendor-calling
 *  deep-dives. */
export async function getFullProviderPostureAction(): Promise<
  { ok: true; posture: FullProviderPosture } | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("providers")
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }

  const svc = createServiceClient()
  const posture = await getFullProviderPosture(svc)
  await audit(svc, gate.userId, "provider_posture.full_registry_swept", {
    providerCount: posture.providerCount,
    needsAttention: posture.needsAttentionCount,
    windowDays: posture.windowDays,
    capped: posture.capped,
  })
  return { ok: true, posture }
}

export async function getSendgridPostureAction(): Promise<
  { ok: true; posture: SendgridPosture } | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("providers")
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }

  const svc = createServiceClient()
  const posture = await getSendgridPosture(svc)
  await audit(svc, gate.userId, "provider_posture.sendgrid_swept", {
    configured: posture.configured,
    validDomains: posture.domains.filter((d) => d.valid).length,
    totalDomains: posture.domains.length,
    unsyncedSpamReports: posture.suppressions?.unsyncedSpamReports ?? null,
  })
  return { ok: true, posture }
}
