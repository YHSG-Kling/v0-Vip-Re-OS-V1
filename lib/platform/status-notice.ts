// lib/platform/status-notice.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM → TENANT STATUS/INCIDENT NOTICE — the missing half of incident
// communication. platform_announcements reach platform STAFF only; when the
// platform is degraded (provider outage, incident, maintenance window) the
// TENANTS had no surface telling them. This is the tenant-facing broadcast:
// one notice on the platform_settings SINGLETON (status_notice jsonb — see
// scripts/l61-s01-retention-offer-status-notice.sql), set by superadmin,
// rendered on the tenant "What's new & platform status" page.
//
// Follows the platform-controls idiom: pure resolver + singleton read/write on
// the service client; readers fail soft (column absent / row absent → no
// notice — a missing broadcast is never an error state for a tenant page).

import { createServiceClient } from "@/lib/supabase/service"

export type StatusNoticeSeverity = "info" | "degraded" | "outage"

export interface StatusNotice {
  active: boolean
  severity: StatusNoticeSeverity
  message: string
  startedAt: string | null
  updatedAt: string | null
}

export const INACTIVE_NOTICE: StatusNotice = {
  active: false, severity: "info", message: "", startedAt: null, updatedAt: null,
}

const SEVERITIES: StatusNoticeSeverity[] = ["info", "degraded", "outage"]

/** PURE: merge a stored status_notice jsonb into a safe shape; bad values fall back. */
export function resolveStatusNotice(raw: any): StatusNotice {
  const r = raw ?? {}
  const message = typeof r.message === "string" ? r.message.trim().slice(0, 500) : ""
  const active = r.active === true && message.length > 0
  return {
    active,
    severity: SEVERITIES.includes(r.severity) ? r.severity : "info",
    message,
    startedAt: typeof r.startedAt === "string" && !Number.isNaN(Date.parse(r.startedAt)) ? r.startedAt : null,
    updatedAt: typeof r.updatedAt === "string" && !Number.isNaN(Date.parse(r.updatedAt)) ? r.updatedAt : null,
  }
}

type Svc = ReturnType<typeof createServiceClient>

/** Read the tenant-facing status notice (singleton). Fails soft to "no notice". */
export async function loadStatusNotice(client?: Svc): Promise<StatusNotice> {
  try {
    const svc = client ?? createServiceClient()
    const { data } = await svc.from("platform_settings").select("status_notice").limit(1).maybeSingle()
    return resolveStatusNotice((data as any)?.status_notice)
  } catch {
    return { ...INACTIVE_NOTICE }
  }
}

/** Write the singleton's status_notice. Caller gates + audits (superadmin action). */
export async function saveStatusNotice(
  svc: Svc,
  input: { active: boolean; severity: StatusNoticeSeverity; message: string; startedAt?: string | null },
): Promise<StatusNotice> {
  const now = new Date().toISOString()
  const value = resolveStatusNotice({
    active: input.active,
    severity: input.severity,
    message: input.message,
    startedAt: input.active ? (input.startedAt ?? now) : null,
    updatedAt: now,
  })
  const { data: existing } = await svc.from("platform_settings").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle()
  if (existing) {
    const { error } = await svc.from("platform_settings").update({ status_notice: value, updated_at: now }).eq("id", (existing as any).id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await svc.from("platform_settings").insert({ status_notice: value })
    if (error) throw new Error(error.message)
  }
  return value
}
