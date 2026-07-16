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

// Per-brokerage probes + per-provider AI healer call (Exa search + Anthropic) can take 60–120s
// in aggregate. Without an explicit maxDuration the Vercel default (10–15s) would kill the route
// mid-Anthropic-call and the connector_health_log batch insert at the end would never run.
export const maxDuration = 300

const ATTENTION = new Set(["expired", "expiring_soon", "auth_failed", "shape_drift", "silent_gap"])

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

  // ── PLATFORM-KEYED PROVIDER PROBES (Integration Guardian coverage audit) ────
  // Lob / ElevenLabs / D-ID / RentCast serve every tenant from platform env keys —
  // no per-brokerage credential row, so the loops above never probed them and an
  // expired platform key was invisible until a tenant's send/render failed. Probe
  // each once per run; failures ledger PLATFORM-scoped on self_heal_events (the
  // repair digest + Continuity Board already read that rail).
  let platformProbed = 0
  let platformFailures = 0
  if (probeLive) {
    const { PLATFORM_PROVIDER_KEYS } = await import("@/lib/agentic-os/connector-probe")
    for (const [provider, envVar] of Object.entries(PLATFORM_PROVIDER_KEYS)) {
      const key = process.env[envVar]
      if (!key) continue // not configured on this deployment — no signal, no noise
      platformProbed++
      try {
        const probe = await probeConnector(provider, { apiKey: key })
        if (probe && probe.status !== "ok") {
          platformFailures++
          attention++
          await svc.from("self_heal_events").insert({
            brokerage_id: null,
            domain: "data_flow",
            subject: `platform_provider:${provider}`,
            action: "provider_probe",
            outcome: "failed",
            detail: { provider, status: probe.status, http_status: probe.httpStatus, drifted: probe.drifted, message: probe.error ?? probe.status },
          })
        }
      } catch (err) {
        platformFailures++
        await svc.from("self_heal_events").insert({
          brokerage_id: null,
          domain: "data_flow",
          subject: `platform_provider:${provider}`,
          action: "provider_probe",
          outcome: "failed",
          detail: { provider, status: "unreachable", message: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }

  // ── ACCOUNTING SILENT-GAP WATCH (the spec's 'silent gap' failure class) ─────
  // accounting_sync_log is the ONE accounting ledger (quickbooks_sync_log was a
  // fake-writer twin, retired in the QB egress consolidation). A row stuck in
  // pending/running >24h means the sync died with NO error anywhere. Surface
  // each affected tenant ('silent_gap' is in the ATTENTION set) so the healer +
  // superadmin board see it.
  {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const { data: stuck } = await svc
      .from("accounting_sync_log")
      .select("brokerage_id, sync_type, started_at")
      .in("status", ["pending", "running"])
      .lt("started_at", dayAgo)
      .limit(200)
    const byBrokerage = new Map<string, { count: number; oldest: string }>()
    for (const s of ((stuck ?? []) as Array<{ brokerage_id: string; started_at: string }>)) {
      const g = byBrokerage.get(s.brokerage_id) ?? { count: 0, oldest: s.started_at }
      g.count++
      if (s.started_at < g.oldest) g.oldest = s.started_at
      byBrokerage.set(s.brokerage_id, g)
    }
    for (const [brokerageId, g] of byBrokerage) {
      attention++
      rows.push({
        brokerage_id: brokerageId, provider: "quickbooks", transport: "brokerage",
        status: "silent_gap", drifted: false, http_status: null,
        detail: { stuck_syncs: g.count, oldest_started_at: g.oldest, hint: "sync rows stuck in_progress >24h — the worker died without an error" },
        error: null, checked_at: now.toISOString(),
      })
    }
  }

  // Batch insert in chunks (Supabase caps payload size).
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error: insErr } = await svc.from("connector_health_log").insert(chunk)
    if (!insErr) rowsWritten += chunk.length
  }

  // ── AI HEALER TRIGGER ──────────────────────────────────────────────────────
  // For every provider that produced an actionable failure THIS run (auth_failed / shape_drift),
  // ask the AI healer for a proposed fix. Deduped: skip providers that already have a `pending`
  // proposal in the last 24h so we don't spam the proposals table or burn LLM tokens. Capped at
  // HEAL_MAX_PER_RUN proposals per cron tick. Only runs in probe mode — posture-only is too cheap
  // a signal to burn an LLM call on.
  const HEAL_MAX_PER_RUN = 5
  let healingProposed = 0
  let healingSkippedExisting = 0
  if (probeLive) {
    const actionable = rows.filter(r => r.status === 'auth_failed' || r.status === 'shape_drift')
    const byProvider = new Map<string, typeof actionable>()
    for (const r of actionable) {
      const k = String(r.provider)
      const arr = byProvider.get(k) ?? []
      arr.push(r)
      byProvider.set(k, arr)
    }
    // Deterministic, fair coverage: oldest-last-healed providers go first so a starvation set of
    // >HEAL_MAX_PER_RUN concurrent failures rotates across runs instead of always healing the
    // same alphabetical prefix.
    const providers = Array.from(byProvider.keys())
    const { data: lastHealed } = await svc
      .from('connector_healing_proposals')
      .select('connector, detected_at')
      .in('connector', providers)
      .order('detected_at', { ascending: false })
    const lastByProv = new Map<string, string>()
    for (const r of lastHealed ?? []) {
      const k = (r as any).connector as string
      if (!lastByProv.has(k)) lastByProv.set(k, (r as any).detected_at as string)
    }
    providers.sort((a, b) => (lastByProv.get(a) ?? '').localeCompare(lastByProv.get(b) ?? ''))

    const since24h = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()
    for (const provider of providers) {
      if (healingProposed >= HEAL_MAX_PER_RUN) break
      const failures = byProvider.get(provider)!
      // Dedup: ANY non-final-applied proposal in the last 24h (pending / rejected / superseded)
      // covers this signal. Includes rejected so a "false positive" admin reject is honored
      // until the next 24h window; admins can still re-trigger by clearing the row.
      const { data: existing } = await svc
        .from('connector_healing_proposals')
        .select('id, status')
        .eq('connector', provider)
        .in('status', ['pending', 'rejected', 'superseded'])
        .gte('detected_at', since24h)
        .limit(1)
        .maybeSingle()
      if (existing) { healingSkippedExisting++; continue }
      try {
        const { proposeConnectorHealing } = await import('@/lib/agentic-os/connector-healer')
        await proposeConnectorHealing({
          connector: provider,
          failures: failures.slice(0, 10).map((r): { status: number | null; path: string | null; error: string | null; at: string } => {
            // For shape_drift the actual diff lives in detail.drift; without forwarding it the
            // healer's LLM has no payload to reason on and produces generic guesses.
            const driftDetail = (r.detail as any)?.drift
            const errorText =
              (r.error as string | null)
              ?? (r.status === 'shape_drift' && driftDetail ? `shape_drift: ${JSON.stringify(driftDetail).slice(0, 500)}` : null)
              ?? (r.status as string)
            return {
              status: (r.http_status as number | null) ?? null,
              path:   null,
              error:  errorText,
              at:     (r.checked_at as string) ?? now.toISOString(),
            }
          }),
        })
        healingProposed++
      } catch (err) {
        // Healer is best-effort — never break the cron on a healing failure.
        console.error('[connector-health] healer trigger failed for', provider, err)
      }
    }
  }

  // ── PROACTIVE TENANT NUDGE ─────────────────────────────────────────────────
  // The superadmin health log is the operator feed; this reaches the BROKERAGE
  // OWNER before an expiring/broken connection silently breaks their marketing.
  // Deduped per attention-signature so re-runs never spam.
  let nudged = 0
  try {
    const { runConnectionNudgeAll } = await import("@/lib/agentic-os/connection-nudge")
    nudged = (await runConnectionNudgeAll(svc)).notified
  } catch (e) { console.error("[connector-health] tenant nudge:", e) }

  return NextResponse.json({
    success: true,
    timestamp: now.toISOString(),
    mode: probeLive ? "posture+probe" : "posture",
    results: {
      brokeragesScanned: scanned,
      healthRowsWritten: rowsWritten,
      attentionItems:    attention,
      healingProposed,
      healingSkippedExisting,
      tenantNudged:      nudged,
    },
  })
}
