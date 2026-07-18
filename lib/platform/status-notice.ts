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
//
// PROVIDER-DOWN → PROPOSED NOTICE: the health-check cron (app/api/cron/
// health-check/route.ts) PROPOSES a prefilled notice when a platform-critical
// provider records consecutive DOWN checks. The proposal lives in the SAME
// status_notice jsonb under `proposed: {...}`, alongside (never overwriting)
// any active notice. It is NOT tenant-visible until a superadmin publishes it
// one-click from the status-notice panel. When the provider recovers, an
// unpublished proposal is auto-withdrawn; a PUBLISHED notice is never
// auto-cleared — staff own the all-clear.

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

/** A health-check-proposed notice awaiting superadmin publish/dismiss. */
export interface ProposedStatusNotice {
  severity: StatusNoticeSeverity
  message: string
  /** The service_status.service_key that tripped the proposal (e.g. "twilio"). */
  provider: string
  /** Why it was proposed, e.g. "3 consecutive failed health checks". */
  reason: string
  proposedAt: string
  source: "health-check"
}

/** The full stored state: the (possibly active) notice + any pending proposal. */
export interface StatusNoticeState {
  notice: StatusNotice
  proposed: ProposedStatusNotice | null
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

/** PURE: resolve a stored `proposed` blob; anything malformed → no proposal. */
export function resolveProposedStatusNotice(raw: any): ProposedStatusNotice | null {
  if (!raw || typeof raw !== "object") return null
  const message = typeof raw.message === "string" ? raw.message.trim().slice(0, 500) : ""
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : ""
  if (!message || !provider) return null
  return {
    severity: SEVERITIES.includes(raw.severity) ? raw.severity : "degraded",
    message,
    provider,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 200) : "",
    proposedAt: typeof raw.proposedAt === "string" && !Number.isNaN(Date.parse(raw.proposedAt))
      ? raw.proposedAt
      : new Date(0).toISOString(),
    source: "health-check",
  }
}

/** PURE: resolve the whole stored jsonb into { notice, proposed }. */
export function resolveStatusNoticeState(raw: any): StatusNoticeState {
  return {
    notice: resolveStatusNotice(raw),
    proposed: resolveProposedStatusNotice((raw ?? {})?.proposed),
  }
}

// ─── Provider → honest tenant-facing capability copy ─────────────────────────
// The proposal names the CAPABILITY a tenant would notice, never the vendor's
// internals. Keys are service_status.service_key values the health-check probes.

const PROVIDER_CAPABILITY: Record<string, string> = {
  supabase_db: "loading and saving your data",
  anthropic: "AI drafting and assistant features",
  sendgrid: "outbound email",
  twilio: "text messaging and phone calls",
  stripe: "billing and payments",
  vapi: "the AI phone receptionist",
}

/** PURE: prefill the proposal copy for a provider that keeps failing checks. */
export function composeProviderDownNotice(
  serviceKey: string,
  serviceName: string | null,
  consecutiveFailures: number,
): { severity: StatusNoticeSeverity; message: string; reason: string } {
  const capability = PROVIDER_CAPABILITY[serviceKey] ?? `features that rely on ${serviceName || serviceKey}`
  return {
    severity: "degraded",
    message:
      `We're currently seeing a service disruption affecting ${capability}. ` +
      `Some of these actions may be delayed or fail until service recovers — we're monitoring closely and will post the all-clear here.`,
    reason: `${consecutiveFailures} consecutive failed health checks`,
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

/** Read notice + pending proposal (superadmin panel). Fails soft. */
export async function loadStatusNoticeState(client?: Svc): Promise<StatusNoticeState> {
  try {
    const svc = client ?? createServiceClient()
    const { data } = await svc.from("platform_settings").select("status_notice").limit(1).maybeSingle()
    return resolveStatusNoticeState((data as any)?.status_notice)
  } catch {
    return { notice: { ...INACTIVE_NOTICE }, proposed: null }
  }
}

/** Read the raw singleton jsonb + row id (internal write helper). */
async function readSingleton(svc: Svc): Promise<{ id: string | null; raw: any }> {
  const { data } = await svc
    .from("platform_settings")
    .select("id, status_notice")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  return { id: (data as any)?.id ?? null, raw: (data as any)?.status_notice ?? null }
}

/** Write the singleton's status_notice jsonb verbatim (internal). */
async function writeSingleton(svc: Svc, id: string | null, value: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString()
  if (id) {
    const { error } = await svc.from("platform_settings").update({ status_notice: value, updated_at: now }).eq("id", id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await svc.from("platform_settings").insert({ status_notice: value })
    if (error) throw new Error(error.message)
  }
}

/** PURE: fold a state back into the stored jsonb shape. */
function toStoredValue(notice: StatusNotice, proposed: ProposedStatusNotice | null): Record<string, unknown> {
  return { ...notice, ...(proposed ? { proposed } : {}) }
}

/**
 * Write the singleton's status_notice. Caller gates + audits (superadmin action).
 * A pending health-check proposal is PRESERVED by default (staff publishing a
 * manual notice never silently discards it); pass clearProposed when the
 * proposal itself is being published or dismissed.
 */
export async function saveStatusNotice(
  svc: Svc,
  input: { active: boolean; severity: StatusNoticeSeverity; message: string; startedAt?: string | null; clearProposed?: boolean },
): Promise<StatusNotice> {
  const now = new Date().toISOString()
  const value = resolveStatusNotice({
    active: input.active,
    severity: input.severity,
    message: input.message,
    startedAt: input.active ? (input.startedAt ?? now) : null,
    updatedAt: now,
  })
  const { id, raw } = await readSingleton(svc)
  const proposed = input.clearProposed ? null : resolveProposedStatusNotice((raw ?? {})?.proposed)
  await writeSingleton(svc, id, toStoredValue(value, proposed))
  return value
}

/**
 * HEALTH-CHECK HOOK: store a PROPOSED notice alongside whatever is live.
 * Never touches the active notice; never publishes anything. A same-provider
 * proposal is refreshed in place (original proposedAt kept); a pending
 * proposal for a DIFFERENT provider is left alone — first incident wins the
 * single proposal slot until staff act on it.
 */
export async function proposeStatusNotice(
  svc: Svc,
  input: { provider: string; severity: StatusNoticeSeverity; message: string; reason: string },
): Promise<{ stored: boolean; proposed: ProposedStatusNotice | null }> {
  const { id, raw } = await readSingleton(svc)
  const state = resolveStatusNoticeState(raw)
  if (state.proposed && state.proposed.provider !== input.provider) {
    console.log(
      `[status-notice] proposal for "${input.provider}" skipped — a proposal for "${state.proposed.provider}" is already pending staff review`,
    )
    return { stored: false, proposed: state.proposed }
  }
  const proposed: ProposedStatusNotice = {
    severity: SEVERITIES.includes(input.severity) ? input.severity : "degraded",
    message: input.message.trim().slice(0, 500),
    provider: input.provider,
    reason: input.reason.slice(0, 200),
    proposedAt: state.proposed?.proposedAt ?? new Date().toISOString(),
    source: "health-check",
  }
  await writeSingleton(svc, id, toStoredValue(state.notice, proposed))
  return { stored: true, proposed }
}

/**
 * HEALTH-CHECK HOOK: the provider recovered — withdraw its UNPUBLISHED
 * proposal. A PUBLISHED (active) notice is never auto-cleared; staff own the
 * all-clear. Returns true when a proposal was withdrawn.
 */
export async function withdrawProposedStatusNotice(svc: Svc, provider: string): Promise<boolean> {
  const { id, raw } = await readSingleton(svc)
  const state = resolveStatusNoticeState(raw)
  if (!state.proposed || state.proposed.provider !== provider) return false
  await writeSingleton(svc, id, toStoredValue(state.notice, null))
  console.log(
    `[status-notice] auto-withdrew proposed notice for provider "${provider}" — health checks recovered before staff published it`,
  )
  return true
}

/** SUPERADMIN: dismiss the pending proposal (any provider). Notice untouched. */
export async function clearProposedStatusNotice(svc: Svc): Promise<StatusNoticeState> {
  const { id, raw } = await readSingleton(svc)
  const state = resolveStatusNoticeState(raw)
  if (state.proposed) await writeSingleton(svc, id, toStoredValue(state.notice, null))
  return { notice: state.notice, proposed: null }
}
