// lib/security/credential-rotation.ts
// ─────────────────────────────────────────────────────────────────────────────
// CREDENTIAL ROTATION MONITOR — the schema carried token_expires_at + refresh_token on every
// OAuth credential table but nothing WATCHED them, so a tenant's Google/social/CRM integration
// could silently expire and break the AI team's outbound with no warning. This scans the
// credential tables cross-tenant, classifies each by how close it is to expiry, and escalates
// the expired / expiring-soon ones to platform staff so they're refreshed before they break.
// Pure classifier (testable); loader aggregates; a cron escalates.

import { createServiceClient } from "@/lib/supabase/service"
import { isEncryptionConfigured, type SecretStorageRefusalCode } from "@/lib/security/secret-crypto"

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

/**
 * The credential tables that carry token_expires_at.
 *
 * THE COLUMN NAMES ARE PER-TABLE AND THEY ARE NOT INTERCHANGEABLE. This list
 * declared calendar_provider_accounts' provider column as `provider`; the column
 * is `provider_type`, and that table has NO refresh_token column at all
 * (verified live). So the scan below selected two columns that do not exist,
 * PostgREST answered with an error, and — because the query result is
 * destructured as `{ data }` with the error discarded — `data` came back null
 * and the loop ran zero times. The try/catch could not help either: supabase-js
 * RESOLVES a failed query rather than throwing.
 *
 * The effect is the one that matters for a security monitor: it reported on
 * three of the four sources it claims to cover, and a silently-expired calendar
 * token was never once flagged. A monitor with a hole in it is worse than no
 * monitor, because the green result is trusted.
 *
 * `hasRefreshToken` marks which tables actually store a token to exchange.
 * calendar_provider_accounts stamps an expiry but holds no tokens — the real
 * OAuth material lives in platform_credentials / agent_api_credentials — so it
 * can be WATCHED for staleness but can never be auto-refreshed. It needs a
 * human to reconnect, and saying so is the point.
 */
const CREDENTIAL_SOURCES: Array<{ table: string; providerCol: string; hasRefreshToken: boolean }> = [
  { table: "platform_credentials", providerCol: "platform", hasRefreshToken: true },
  { table: "agent_api_credentials", providerCol: "service_type", hasRefreshToken: true },
  { table: "social_media_accounts", providerCol: "platform", hasRefreshToken: true },
  { table: "calendar_provider_accounts", providerCol: "provider_type", hasRefreshToken: false },
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

  for (const { table, providerCol, hasRefreshToken } of CREDENTIAL_SOURCES) {
    try {
      // Only ask for refresh_token where the column exists — selecting a column
      // a table does not have fails the WHOLE query, taking the rows that do
      // exist down with it.
      const columns = ["id", "brokerage_id", "token_expires_at", providerCol]
      if (hasRefreshToken) columns.push("refresh_token")

      const { data, error } = await svc
        .from(table)
        .select(columns.join(", "))
        .not("token_expires_at", "is", null)
        .lte("token_expires_at", horizon)   // expired OR within the warn window
        .limit(1000)

      // READ THE ERROR. supabase-js RESOLVES a failed query instead of throwing,
      // so the catch below never sees a bad column name — which is exactly how
      // one of the four sources went unscanned without a single log line. A
      // monitor that cannot tell "no risks" from "the query failed" reports
      // healthy either way.
      if (error) {
        console.error(`[credential-rotation] scan of ${table} FAILED (source not covered):`, error.message)
        continue
      }

      for (const r of (data ?? []) as any[]) {
        const status = credentialRotationStatus({ tokenExpiresAt: r.token_expires_at }, now, warnDays)
        if (status === "expired" || status === "expiring_soon") {
          risks.push({
            table, id: r.id, brokerageId: r.brokerage_id ?? null, provider: r[providerCol] ?? null,
            status, tokenExpiresAt: r.token_expires_at,
            hasRefreshToken: hasRefreshToken ? !!r.refresh_token : false,
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

// ── SECRET STORAGE POSTURE (wave 139E — owner: secrets FAIL CLOSED, "actionable platform incident") ──
// A refused NEW secret write (lib/security/secret-crypto.ts SecretStorageRefusedError) and the daily
// posture sweep raise ONE platform-staff incident through the same notifyPlatformStaff survivor the
// rotation escalation above uses. No incident ever carries a secret value — only the store, the
// surface, the tenant id and the fix.

/** The secret columns of the four credential stores (scripts/schema-snapshot.ts verified). */
const SECRET_STORE_COLUMNS: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
  { table: "agent_api_credentials", columns: ["api_key", "api_secret", "access_token", "refresh_token"] },
  { table: "integration_credentials", columns: ["api_key", "api_secret"] },
  { table: "platform_credentials", columns: ["api_key", "access_token", "refresh_token"] },
  { table: "social_media_accounts", columns: ["access_token", "refresh_token"] },
]

const SECRET_STORAGE_INCIDENT = "secret_storage_unconfigured"
const SECRET_LEGACY_PLAINTEXT_INCIDENT = "secret_legacy_plaintext"

/** Once per UTC day per incident type. A refused dedupe read RAISES anyway — a duplicate beats silence. */
async function incidentRaisedToday(svc: Svc, type: string, now: Date): Promise<boolean> {
  const dayStart = new Date(now.toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString()
  const { count, error } = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("type", type).gte("created_at", dayStart)
  if (error) return false
  return (count ?? 0) > 0
}

/**
 * The actionable platform incident for a REFUSED new secret write. `brokerageId` is the tenant whose
 * write was refused (from the caller's session, never a body) — named so staff know whom to tell.
 */
export async function raiseSecretStorageIncident(
  svc: Svc,
  input: { surface: string; brokerageId: string | null; code: SecretStorageRefusalCode; now?: Date },
): Promise<{ raised: boolean; notified: number }> {
  const now = input.now ?? new Date()
  try {
    if (await incidentRaisedToday(svc, SECRET_STORAGE_INCIDENT, now)) return { raised: false, notified: 0 }
    const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
    const notified = await notifyPlatformStaff(svc, {
      type: SECRET_STORAGE_INCIDENT,
      title: "Secret storage is not configured — new tenant secrets are being refused",
      body: `${input.code}: a new secret write on ${input.surface}${input.brokerageId ? ` (tenant ${input.brokerageId})` : ""} was refused because SECRETS_ENCRYPTION_KEY is not set. Nothing was stored in plaintext. Fix: set SECRETS_ENCRYPTION_KEY (64 hex chars or 32-byte base64) in Production and redeploy, then ask the tenant to reconnect.`,
      entityType: input.brokerageId ? "brokerage" : null,
      entityId: input.brokerageId,
      priority: "high",
    })
    return { raised: notified > 0, notified }
  } catch (err) {
    console.error("[secret-storage] incident not raised:", (err as Error)?.message)
    return { raised: false, notified: 0 }
  }
}

interface SecretStoragePosture {
  keyConfigured: boolean
  /** Rows per `table.column` holding a non-envelope (legacy plaintext) value. Values are never selected. */
  legacyPlaintext: Record<string, number>
  legacyPlaintextTotal: number
  /** Store columns whose census read was refused — never reported as 0. */
  unreadable: string[]
  incidents: string[]
}

/**
 * Daily posture sweep (wired: lib/platform/os-sentinel.ts runOsSentinelSweep). COUNTS legacy plaintext
 * secrets per store column (head count — no secret value is selected) and raises the platform incident
 * when the key is missing or legacy plaintext remains. Read-only: it never rewrites a stored value.
 */
export async function reportSecretStoragePosture(svc: Svc, now: Date = new Date()): Promise<SecretStoragePosture> {
  const keyConfigured = isEncryptionConfigured()
  const legacyPlaintext: Record<string, number> = {}
  const unreadable: string[] = []
  for (const { table, columns } of SECRET_STORE_COLUMNS) {
    for (const col of columns) {
      const { count, error } = await svc.from(table).select("id", { count: "exact", head: true }).not(col, "is", null).not(col, "like", "enc:v1:%")
      if (error) { unreadable.push(`${table}.${col}`); continue }
      if ((count ?? 0) > 0) legacyPlaintext[`${table}.${col}`] = count ?? 0
    }
  }
  const legacyPlaintextTotal = Object.values(legacyPlaintext).reduce((a, b) => a + b, 0)
  const incidents: string[] = []
  if (!keyConfigured) {
    const r = await raiseSecretStorageIncident(svc, { surface: "posture sweep", brokerageId: null, code: "secrets_key_missing", now })
    if (r.raised) incidents.push(SECRET_STORAGE_INCIDENT)
  }
  if (legacyPlaintextTotal > 0 || unreadable.length > 0) {
    try {
      if (!(await incidentRaisedToday(svc, SECRET_LEGACY_PLAINTEXT_INCIDENT, now))) {
        const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
        const n = await notifyPlatformStaff(svc, {
          type: SECRET_LEGACY_PLAINTEXT_INCIDENT,
          title: `${legacyPlaintextTotal} stored secret${legacyPlaintextTotal === 1 ? "" : "s"} still in legacy plaintext`,
          body: `Legacy plaintext by store: ${Object.entries(legacyPlaintext).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}${unreadable.length ? `; census UNREADABLE (not zero): ${unreadable.join(", ")}` : ""}. They still read (backward-compatible) and were not modified. Fix: have the owners reconnect once SECRETS_ENCRYPTION_KEY is set.`,
          priority: "medium",
        })
        if (n > 0) incidents.push(SECRET_LEGACY_PLAINTEXT_INCIDENT)
      }
    } catch (err) {
      console.error("[secret-storage] legacy-plaintext report not raised:", (err as Error)?.message)
    }
  }
  return { keyConfigured, legacyPlaintext, legacyPlaintextTotal, unreadable, incidents }
}
