// lib/security/credential-rotation.ts
// ─────────────────────────────────────────────────────────────────────────────
// CREDENTIAL ROTATION MONITOR — the schema carried token_expires_at + refresh_token on every
// OAuth credential table but nothing WATCHED them, so a tenant's Google/social/CRM integration
// could silently expire and break the AI team's outbound with no warning. This scans the
// credential tables cross-tenant, classifies each by how close it is to expiry, and escalates
// the expired / expiring-soon ones to platform staff so they're refreshed before they break.
// Pure classifier (testable); loader aggregates; a cron escalates.

import { createServiceClient } from "@/lib/supabase/service"

export const ROTATION_WARN_DAYS = 7

export type RotationStatus = "expired" | "expiring_soon" | "ok" | "no_expiry"

/** PURE: how close is this credential to expiry? */
export function credentialRotationStatus(
  cred: { tokenExpiresAt: string | null },
  now: Date = new Date(),
  warnDays: number = ROTATION_WARN_DAYS,
): RotationStatus {
  if (!cred.tokenExpiresAt) return "no_expiry"
  const exp = Date.parse(cred.tokenExpiresAt)
  if (!Number.isFinite(exp)) return "no_expiry"
  if (exp <= now.getTime()) return "expired"
  if (exp <= now.getTime() + warnDays * 86_400_000) return "expiring_soon"
  return "ok"
}

// The OAuth credential tables that carry token_expires_at + a refresh_token.
const CREDENTIAL_SOURCES: Array<{ table: string; providerCol: string }> = [
  { table: "platform_credentials", providerCol: "platform" },
  { table: "agent_api_credentials", providerCol: "service_type" },
  { table: "social_media_accounts", providerCol: "platform" },
  { table: "calendar_provider_accounts", providerCol: "provider" },
]

export interface RotationRisk {
  table: string
  id: string
  brokerageId: string | null
  provider: string | null
  status: RotationStatus
  tokenExpiresAt: string | null
  hasRefreshToken: boolean
}

type Svc = ReturnType<typeof createServiceClient>

/** Scan the credential tables cross-tenant for expired / expiring-soon OAuth tokens. */
export async function loadRotationRisks(client?: Svc, now: Date = new Date(), warnDays = ROTATION_WARN_DAYS): Promise<RotationRisk[]> {
  const svc = client ?? createServiceClient()
  const risks: RotationRisk[] = []
  const horizon = new Date(now.getTime() + warnDays * 86_400_000).toISOString()

  for (const { table, providerCol } of CREDENTIAL_SOURCES) {
    try {
      const { data } = await svc
        .from(table)
        .select(`id, brokerage_id, token_expires_at, refresh_token, ${providerCol}`)
        .not("token_expires_at", "is", null)
        .lte("token_expires_at", horizon)   // expired OR within the warn window
        .limit(1000)
      for (const r of (data ?? []) as any[]) {
        const status = credentialRotationStatus({ tokenExpiresAt: r.token_expires_at }, now, warnDays)
        if (status === "expired" || status === "expiring_soon") {
          risks.push({
            table, id: r.id, brokerageId: r.brokerage_id ?? null, provider: r[providerCol] ?? null,
            status, tokenExpiresAt: r.token_expires_at, hasRefreshToken: !!r.refresh_token,
          })
        }
      }
    } catch (err) {
      console.warn(`[credential-rotation] scan of ${table} failed:`, (err as any)?.message)
    }
  }
  // Expired first, then soonest-expiring.
  return risks.sort((a, b) => (a.status === "expired" ? 0 : 1) - (b.status === "expired" ? 0 : 1) || Date.parse(a.tokenExpiresAt ?? "") - Date.parse(b.tokenExpiresAt ?? ""))
}

/** Escalate expired / expiring credentials to platform staff (deduped per day). Best-effort. */
export async function escalateRotationRisks(client?: Svc, now: Date = new Date()): Promise<{ risks: number; escalated: boolean }> {
  const svc = client ?? createServiceClient()
  const risks = await loadRotationRisks(svc, now)
  if (risks.length === 0) return { risks: 0, escalated: false }
  const expired = risks.filter((r) => r.status === "expired").length
  try {
    // Deduped to once per day — a rotation alert should nudge, not spam.
    const dayStart = new Date(now.toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString()
    const { count } = await svc
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("type", "credential_rotation_risk")
      .gte("created_at", dayStart)
    if ((count ?? 0) > 0) return { risks: risks.length, escalated: false }

    const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
    await notifyPlatformStaff(svc, {
      type: "credential_rotation_risk",
      title: `⚠️ ${risks.length} integration credential${risks.length === 1 ? "" : "s"} need rotation`,
      body: `${expired} expired + ${risks.length - expired} expiring within ${ROTATION_WARN_DAYS} days across ${new Set(risks.map((r) => r.brokerageId)).size} tenant(s). Refresh them before the AI team's integrations break.`,
      priority: "high",
    })
    return { risks: risks.length, escalated: true }
  } catch (err) {
    console.warn("[credential-rotation] escalation failed:", (err as any)?.message)
    return { risks: risks.length, escalated: false }
  }
}
