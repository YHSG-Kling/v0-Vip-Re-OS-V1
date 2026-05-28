// app/api/cron/connector-health/route.ts
// Connectivity API Agent cron. Proactively scans every brokerage's connector fleet and
// records health into connector_health_log — the attention rows (expired / expiring_soon /
// auth_failed / shape_drift) ARE the superadmin alert feed surfaced in the connectors panel.
//
// Two modes:
//   default      — credential-POSTURE scan (token expiry, active flags). Cheap; the scheduled
//                  run that flags expiring OAuth tokens before they lapse.
//   ?probe=1     — additionally runs the LIVE adaptive probe (real vendor health call +
//                  field-drift detection) for connectors that have a resolvable credential.
//
// Auth: CRON_SECRET (lib/cron-auth). Writes via the service client (RLS-exempt by design).
import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { scanConnectivity } from "@/lib/agentic-os/resolve-connectivity"
import { resolveConnection } from "@/lib/integrations/connection-manager"
import { probeConnector, PROBE_SPECS } from "@/lib/agentic-os/connector-probe"

const ATTENTION = new Set(["expired", "expiring_soon", "auth_failed", "shape_drift"])

export async function GET(req: Request) {
  const unauthorized = verifyCronAuth(req)
  if (unauthorized) return unauthorized

  const probeLive = new URL(req.url).searchParams.get("probe") === "1"
  const svc = createServiceClient()

  const { data: brokerages, error } = await svc.from("brokerages").select("id").limit(2000)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const now = new Date()
  let scanned = 0
  let rowsWritten = 0
  let attention = 0
  const rows: Array<Record<string, unknown>> = []

  for (const b of brokerages ?? []) {
    const brokerageId = b.id as string
    scanned++
    const report = await scanConnectivity({ brokerageId, now })

    for (const c of report.connectors) {
      // Skip connectors the brokerage never wired up — no signal, no noise.
      if (c.status === "disconnected" && !c.actionRequired) continue

      let status = c.status as string
      let httpStatus: number | null = null
      let drifted = false
      let error: string | null = null
      const detail: Record<string, unknown> = { source: c.source, expiresAt: c.expiresAt }

      // Live adaptive probe (opt-in) — real vendor health + field-drift detection.
      if (probeLive && c.status !== "disconnected") {
        try {
          const conn = await resolveConnection({ brokerageId, provider: c.provider })
          if (conn) {
            const probe = await probeConnector(c.provider, {
              apiKey: conn.apiKey, apiSecret: conn.apiSecret, accessToken: conn.accessToken, config: conn.config,
            })
            if (probe) {
              httpStatus = probe.httpStatus
              drifted = probe.drifted
              error = probe.error
              // A live failure overrides posture; drift surfaces as shape_drift.
              if (probe.status === "auth_failed" || probe.status === "shape_drift") status = probe.status
              if (probe.drift) detail.drift = probe.drift
            }
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
      }

      const isAttention = ATTENTION.has(status) || drifted
      if (isAttention) attention++
      rows.push({
        brokerage_id: brokerageId, provider: c.provider, transport: c.transport,
        status, drifted, http_status: httpStatus, detail, error, checked_at: now.toISOString(),
      })
    }
  }

  // Owner-scoped self-heal — the per-brokerage scan above resolves brokerage-level credentials
  // only, so a VENDOR / TEAM / AGENT that connected its own account would never be probed and its
  // connection error (auth_failed / shape_drift = the vendor changed/updated their API) would go
  // undetected. Probe every active owner-scoped credential that has a health spec so those errors
  // surface in the same attention feed. (Live probe only.)
  if (probeLive) {
    const { data: ownerRows } = await svc
      .from("platform_credentials")
      .select("brokerage_id, owner_type, owner_id, platform, api_key, refresh_token, access_token, config")
      .in("owner_type", ["vendor", "contact", "team", "agent"])
      .eq("is_active", true)
      .limit(2000)

    for (const r of ownerRows ?? []) {
      const provider = r.platform as string
      if (!PROBE_SPECS[provider]) continue // only providers with a known liveness endpoint
      try {
        const probe = await probeConnector(provider, {
          apiKey: (r.api_key as string) ?? null,
          // The connect flow stores a provider secret under config.auth_token (e.g. Twilio auth
          // token); fall back to api_secret for any provider that uses that key.
          apiSecret: ((r.config as any)?.auth_token as string) ?? ((r.config as any)?.api_secret as string) ?? null,
          accessToken: (r.access_token as string) ?? null,
          config: (r.config as Record<string, unknown>) ?? null,
        })
        if (!probe) continue
        const isAttention = ATTENTION.has(probe.status) || probe.drifted
        if (isAttention) attention++
        rows.push({
          brokerage_id: r.brokerage_id, provider, transport: "owner",
          status: probe.status, drifted: probe.drifted, http_status: probe.httpStatus,
          detail: { owner_type: r.owner_type, owner_id: r.owner_id, ...(probe.drift ? { drift: probe.drift } : {}) },
          error: probe.error, checked_at: now.toISOString(),
        })
      } catch (err) {
        rows.push({
          brokerage_id: r.brokerage_id, provider, transport: "owner",
          status: "unreachable", drifted: false, http_status: null,
          detail: { owner_type: r.owner_type, owner_id: r.owner_id },
          error: err instanceof Error ? err.message : String(err), checked_at: now.toISOString(),
        })
      }
    }
  }

  // Batch insert in chunks (Supabase caps payload size).
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error: insErr } = await svc.from("connector_health_log").insert(chunk)
    if (!insErr) rowsWritten += chunk.length
  }

  return NextResponse.json({
    success: true,
    timestamp: now.toISOString(),
    mode: probeLive ? "posture+probe" : "posture",
    results: { brokeragesScanned: scanned, healthRowsWritten: rowsWritten, attentionItems: attention },
  })
}
