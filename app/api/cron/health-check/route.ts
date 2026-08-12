import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { DECOMMISSIONED_PROVIDERS } from "@/lib/platform/provider-posture"

// Service check configuration
const SERVICE_CHECKS: Record<
  string,
  {
    type: "db" | "api" | "integration"
    checkFn: (supabase: ReturnType<typeof createClient>) => Promise<{
      status: "healthy" | "degraded" | "down" | "unknown"
      responseTimeMs: number
      errorMessage?: string
      httpStatusCode?: number
    }>
  }
> = {
  supabase_db: {
    type: "db",
    checkFn: async (supabase) => {
      const start = Date.now()
      try {
        const { error } = await supabase.from("brokerages").select("id").limit(1)
        const responseTimeMs = Date.now() - start
        if (error) {
          return {
            status: "down",
            responseTimeMs,
            errorMessage: error.message,
          }
        }
        const status = responseTimeMs < 500 ? "healthy" : responseTimeMs < 2000 ? "degraded" : "down"
        return { status, responseTimeMs }
      } catch (err) {
        return {
          status: "down",
          responseTimeMs: Date.now() - start,
          errorMessage: err instanceof Error ? err.message : "Unknown error",
        }
      }
    },
  },
  anthropic: {
    type: "api",
    checkFn: async () => {
      const start = Date.now()
      // Check Anthropic status page
      const response = await callConnector<{ status?: { indicator?: string } }>({
        connector: "anthropic-status", baseUrl: "https://status.anthropic.com", path: "/api/v2/status.json",
        method: "GET", auth: { style: "none" }, timeoutMs: 5000,
      })
      const responseTimeMs = Date.now() - start
      if (!response.ok) {
        return { status: "degraded", responseTimeMs, httpStatusCode: response.status ?? 0, errorMessage: response.error ?? undefined }
      }
      const status = response.data?.status?.indicator === "none" ? "healthy" : "degraded"
      return { status, responseTimeMs, httpStatusCode: response.status ?? 0 }
    },
  },
  sendgrid: {
    type: "api",
    checkFn: async () => {
      const start = Date.now()
      const response = await callConnector({
        connector: "sendgrid-status", baseUrl: "https://status.sendgrid.com", path: "/api/v2/status.json",
        method: "GET", auth: { style: "none" }, timeoutMs: 5000,
      })
      const responseTimeMs = Date.now() - start
      return {
        status: response.ok ? "healthy" : "degraded",
        responseTimeMs,
        httpStatusCode: response.status ?? 0,
        ...(response.ok ? {} : { errorMessage: response.error ?? undefined }),
      }
    },
  },
  twilio: {
    type: "api",
    checkFn: async () => {
      const start = Date.now()
      const response = await callConnector({
        connector: "twilio-status", baseUrl: "https://status.twilio.com", path: "/api/v2/status.json",
        method: "GET", auth: { style: "none" }, timeoutMs: 5000,
      })
      const responseTimeMs = Date.now() - start
      return {
        status: response.ok ? "healthy" : "degraded",
        responseTimeMs,
        httpStatusCode: response.status ?? 0,
        ...(response.ok ? {} : { errorMessage: response.error ?? undefined }),
      }
    },
  },
  stripe: {
    type: "api",
    checkFn: async () => {
      const start = Date.now()
      const stripeKey = process.env.STRIPE_SECRET_KEY
      if (!stripeKey) {
        return { status: "unknown" as const, responseTimeMs: 0, errorMessage: "No API key configured" }
      }
      const response = await callConnector({
        connector: "stripe", baseUrl: "https://api.stripe.com", path: "/v1/balance",
        method: "GET", auth: { style: "bearer", token: stripeKey }, timeoutMs: 5000,
      })
      const responseTimeMs = Date.now() - start
      return {
        status: response.ok ? "healthy" : (response.status ? "degraded" : "down"),
        responseTimeMs,
        httpStatusCode: response.status ?? 0,
        ...(response.ok ? {} : { errorMessage: response.error ?? undefined }),
      }
    },
  },
}

// PROVIDER-DOWN → STATUS-NOTICE PROPOSAL: when a platform-critical provider
// (service_status.is_critical) records this many consecutive DOWN checks
// (service_status.consecutive_failures — incremented per down check, reset on
// healthy), the cron PROPOSES a prefilled tenant status notice for superadmin
// one-click publish. Never auto-published; withdrawn automatically if checks
// recover before staff publish (a PUBLISHED notice is never auto-cleared).
const CONSECUTIVE_DOWN_THRESHOLD = 2

// RAW CHECK OUTCOME → SERVICE_STATUS ROLLUP.
//
// These are two CHECK-constrained vocabularies over the same concept and they
// are NOT the same set. The ledger (system_health_checks.status) records the raw
// outcome and admits 'timeout' and 'error'; the rollup
// (service_status.current_status) is the summary and does not. Writing the raw
// value into both — which is what this cron used to do — means any raw status
// the rollup does not admit is refused by the database, and because the write
// was undestructured the refusal was invisible.
//
// The mapping is explicit so a new raw outcome cannot silently fail to roll up:
// anything that is not a recognised rollup state degrades to 'down', which is
// the safe direction for a monitoring surface. Never map an unproven state to
// 'healthy'.
type RawCheckStatus = "healthy" | "degraded" | "down" | "unknown" | "timeout" | "error"
type RollupStatus = "healthy" | "degraded" | "down" | "unknown"

function rollupStatus(raw: RawCheckStatus): RollupStatus {
  switch (raw) {
    case "healthy":
    case "degraded":
    case "down":
    case "unknown":
      return raw
    case "timeout":
    case "error":
      return "down"
  }
}

// Integration services that check brokerage_integrations table
const INTEGRATION_SERVICES = [
  "dotloop",
  "docusign",
  "quickbooks",
  "xero",
  "batchdata",
  "zenrows",
  "google_cse",
  "apify",
]

export async function POST(request: NextRequest) {
  // Validate CRON_SECRET
  const cronSecret = request.headers.get("x-cron-secret")
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startTime = Date.now()
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  try {
    // Get body for manual trigger with brokerageId
    let targetBrokerageId: string | null = null
    try {
      const body = await request.json()
      if (body.brokerageId) {
        targetBrokerageId = body.brokerageId
      }
    } catch {
      // No body or invalid JSON - run for all brokerages
    }

    // Get active services to check
    let servicesQuery = supabase.from("service_status").select("*")
    if (targetBrokerageId) {
      servicesQuery = servicesQuery.eq("brokerage_id", targetBrokerageId)
    }
    const { data: services, error: servicesError } = await servicesQuery

    if (servicesError) {
      console.error("Error fetching services:", servicesError)
      return NextResponse.json({ error: "Failed to fetch services" }, { status: 500 })
    }

    const results: Array<{
      serviceKey: string
      status: string
      responseTimeMs: number
    }> = []

    // Every write in this cron used to be undestructured. A monitoring job that
    // cannot report its own failed writes is the worst possible place for a
    // swallowed error: it goes on returning 200 while recording nothing, and the
    // surface built on top reports a clean bill of health over an empty table.
    const writeFailures: string[] = []

    // Retired vendors found sitting in the ledger. Reported in the response so
    // a resurrected row is visible rather than silently ignored.
    const skippedDecommissioned: string[] = []

    // Per-provider aggregate across all checked rows (service_status is
    // per-brokerage; the notice proposal is platform-wide, so a provider only
    // counts as platform-down when NO row of it came back healthy this run).
    const criticalProviderRuns = new Map<
      string,
      { name: string | null; down: number; healthy: number; maxConsecutiveFailures: number }
    >()

    // Process each service
    for (const service of services || []) {
      const serviceKey = service.service_key

      // A RETIRED VENDOR IS NOT A SERVICE TO MONITOR. m372 deleted the heygen
      // and vapi rows on the owner's ruling, but a re-seed, a restored backup or
      // a hand-inserted row could put a retired vendor back on this board — and
      // it would poll forever as 'unknown', because a decommissioned vendor by
      // definition has no check function. Permanently-unknown rows sitting next
      // to real ones is what trains an operator to stop reading a health page.
      //
      // The set NAMES the vendor in order to EXCLUDE it, which is the same
      // allowlist-not-ban discipline the vendor-retirement guard enforces
      // everywhere else. Skipped rows are reported, never silently dropped.
      if (DECOMMISSIONED_PROVIDERS.has(serviceKey)) {
        skippedDecommissioned.push(serviceKey)
        continue
      }
      let checkResult: {
        status: RawCheckStatus
        responseTimeMs: number
        errorMessage?: string
        httpStatusCode?: number
      }

      // Check if we have a dedicated check function
      if (SERVICE_CHECKS[serviceKey]) {
        checkResult = await SERVICE_CHECKS[serviceKey].checkFn(supabase as any)
      } else if (INTEGRATION_SERVICES.includes(serviceKey)) {
        // Check brokerage_integrations for this service
        const { data: integration } = await supabase
          .from("brokerage_integrations")
          .select("*")
          .eq("brokerage_id", service.brokerage_id)
          .ilike("provider_name", `%${serviceKey}%`)
          .single()

        if (integration) {
          // Update last_health_check_at
          await supabase
            .from("brokerage_integrations")
            .update({ last_health_check_at: new Date().toISOString() })
            .eq("id", integration.id)

          checkResult = {
            status: integration.status === "active" ? "healthy" : "degraded",
            responseTimeMs: 0,
            errorMessage: integration.last_error || undefined,
          }
        } else {
          // Check integration_credentials
          const { data: creds } = await supabase
            .from("integration_credentials")
            .select("*")
            .eq("brokerage_id", service.brokerage_id)
            .ilike("provider_name", `%${serviceKey}%`)
            .eq("is_active", true)
            .single()

          if (creds) {
            checkResult = { status: "healthy", responseTimeMs: 0 }
          } else {
            checkResult = {
              status: "unknown",
              responseTimeMs: 0,
              errorMessage: "Not configured",
            }
          }
        }
      } else {
        // Unknown service - mark as unknown
        checkResult = {
          status: "unknown",
          responseTimeMs: 0,
          errorMessage: "No health check configured",
        }
      }

      // Insert health check record. Destructured: this insert used to swallow
      // its error, and the value it most often carries ('unknown') was refused
      // by the ledger's CHECK constraint until m371 — so every unconfigured
      // service wrote nothing and reported nothing.
      const { error: ledgerError } = await supabase.from("system_health_checks").insert({
        brokerage_id: service.brokerage_id,
        service_key: serviceKey,
        service_name: service.service_name,
        service_category: service.service_category,
        status: checkResult.status,
        response_time_ms: checkResult.responseTimeMs,
        http_status_code: checkResult.httpStatusCode || null,
        error_message: checkResult.errorMessage || null,
        checked_at: new Date().toISOString(),
      })
      if (ledgerError) {
        writeFailures.push(`system_health_checks[${serviceKey}]: ${ledgerError.message}`)
      }

      // Update service_status — the ROLLUP, whose vocabulary is narrower than
      // the ledger's, so the raw outcome is mapped rather than passed through.
      const updateData: Record<string, unknown> = {
        current_status: rollupStatus(checkResult.status),
        response_time_ms: checkResult.responseTimeMs,
        last_checked_at: new Date().toISOString(),
        error_message: checkResult.errorMessage || null,
        updated_at: new Date().toISOString(),
      }

      if (checkResult.status === "healthy") {
        updateData.consecutive_failures = 0
        updateData.last_healthy_at = new Date().toISOString()
      } else if (checkResult.status === "down") {
        updateData.consecutive_failures = (service.consecutive_failures || 0) + 1
      }

      // Track platform-critical providers for the status-notice proposal hook.
      if (service.is_critical === true) {
        const agg = criticalProviderRuns.get(serviceKey) ?? {
          name: service.service_name ?? null,
          down: 0,
          healthy: 0,
          maxConsecutiveFailures: 0,
        }
        if (checkResult.status === "down") {
          agg.down += 1
          agg.maxConsecutiveFailures = Math.max(
            agg.maxConsecutiveFailures,
            Number(updateData.consecutive_failures ?? service.consecutive_failures ?? 0),
          )
        } else if (checkResult.status === "healthy") {
          agg.healthy += 1
        }
        criticalProviderRuns.set(serviceKey, agg)
      }

      const { error: rollupError } = await supabase
        .from("service_status")
        .update(updateData)
        .eq("id", service.id)
      if (rollupError) {
        writeFailures.push(`service_status[${serviceKey}]: ${rollupError.message}`)
      }

      results.push({
        serviceKey,
        status: checkResult.status,
        responseTimeMs: checkResult.responseTimeMs,
      })
    }

    // Update health_check_history for today
    const today = new Date().toISOString().split("T")[0]
    const brokerageIds = [...new Set((services || []).map((s) => s.brokerage_id))]

    for (const brokerageId of brokerageIds) {
      const brokerageServices = (services || []).filter(
        (s) => s.brokerage_id === brokerageId
      )
      for (const service of brokerageServices) {
        // Get today's checks for this service.
        //
        // .eq("brokerage_id", null) is NOT a null match — PostgREST renders it
        // as `brokerage_id=eq.null`, which is SQL `= NULL` and matches nothing.
        // service_status is seeded entirely with brokerage_id IS NULL (all 15
        // rows today are platform-level), so this read returned an empty set for
        // every service and the rollup below was computed over nothing.
        let todayQuery = supabase
          .from("system_health_checks")
          .select("status, response_time_ms")
          .eq("service_key", service.service_key)
          .gte("checked_at", `${today}T00:00:00Z`)
        todayQuery = brokerageId === null
          ? todayQuery.is("brokerage_id", null)
          : todayQuery.eq("brokerage_id", brokerageId)
        const { data: todayChecks, error: todayError } = await todayQuery
        if (todayError) {
          writeFailures.push(`system_health_checks read[${service.service_key}]: ${todayError.message}`)
          continue
        }

        const totalChecks = todayChecks?.length || 0

        // NO CHECKS MEANS NO CLAIM. This used to default uptime_pct to 100 when
        // totalChecks was 0 — a service nobody has ever checked reported a
        // perfect day, which is the same "green over an absence" failure the
        // /dashboard/system surface had. Write nothing instead; the reader
        // already renders a missing snapshot as unknown.
        if (totalChecks === 0) continue

        const successfulChecks =
          todayChecks?.filter((c) => c.status === "healthy").length || 0
        // Anything that is not affirmatively healthy or degraded counts as a
        // failure — down, timeout, error and unknown alike. Counting only
        // "down" left four of six raw outcomes in neither column.
        const failedChecks =
          todayChecks?.filter((c) => c.status !== "healthy" && c.status !== "degraded").length || 0
        const uptimePct = (successfulChecks / totalChecks) * 100
        const avgResponseMs =
          totalChecks > 0
            ? Math.round(
                (todayChecks?.reduce((a, c) => a + (c.response_time_ms || 0), 0) || 0) /
                  totalChecks
              )
            : 0

        // Upsert health_check_history — same null-match correction as above,
        // and maybeSingle() because "no snapshot yet today" is the normal case
        // and .single() turns it into an error row.
        let existingQuery = supabase
          .from("health_check_history")
          .select("id")
          .eq("service_key", service.service_key)
          .eq("snapshot_date", today)
        existingQuery = brokerageId === null
          ? existingQuery.is("brokerage_id", null)
          : existingQuery.eq("brokerage_id", brokerageId)
        const { data: existing, error: existingError } = await existingQuery.maybeSingle()
        if (existingError) {
          writeFailures.push(`health_check_history read[${service.service_key}]: ${existingError.message}`)
          continue
        }

        if (existing) {
          const { error: histUpdateError } = await supabase
            .from("health_check_history")
            .update({
              uptime_pct: uptimePct,
              total_checks: totalChecks,
              failed_checks: failedChecks,
              avg_response_ms: avgResponseMs,
            })
            .eq("id", existing.id)
          if (histUpdateError) {
            writeFailures.push(`health_check_history[${service.service_key}]: ${histUpdateError.message}`)
          }
        } else {
          const { error: histInsertError } = await supabase.from("health_check_history").insert({
            brokerage_id: brokerageId,
            service_key: service.service_key,
            snapshot_date: today,
            uptime_pct: uptimePct,
            total_checks: totalChecks,
            failed_checks: failedChecks,
            avg_response_ms: avgResponseMs,
            incidents: 0,
          })
          if (histInsertError) {
            writeFailures.push(`health_check_history[${service.service_key}]: ${histInsertError.message}`)
          }
        }
      }
    }

    // PROVIDER-DOWN → STATUS-NOTICE PROPOSAL / RECOVERY-WITHDRAWAL.
    // Best-effort: the notice hook never fails the health check itself.
    try {
      const { proposeStatusNotice, withdrawProposedStatusNotice, composeProviderDownNotice } =
        await import("@/lib/platform/status-notice")
      for (const [serviceKey, agg] of criticalProviderRuns) {
        if (agg.down > 0 && agg.healthy === 0 && agg.maxConsecutiveFailures >= CONSECUTIVE_DOWN_THRESHOLD) {
          // Platform-critical provider down 2+ checks in a row → PROPOSE a
          // prefilled tenant notice (superadmin publishes; never automatic).
          const draft = composeProviderDownNotice(serviceKey, agg.name, agg.maxConsecutiveFailures)
          const { stored } = await proposeStatusNotice(supabase as any, {
            provider: serviceKey,
            severity: draft.severity,
            message: draft.message,
            reason: draft.reason,
          })
          if (stored) {
            console.log(
              `[health-check] proposed tenant status notice for "${serviceKey}" — ${draft.reason}; awaiting superadmin publish/dismiss`,
            )
          }
        } else if (agg.healthy > 0 && agg.down === 0) {
          // Provider recovered → withdraw an UNPUBLISHED proposal only.
          // A published notice is staff-owned and never auto-cleared.
          await withdrawProposedStatusNotice(supabase as any, serviceKey)
        }
      }
    } catch (err) {
      console.error("[health-check] status-notice proposal hook failed (health check unaffected):", err)
    }

    const durationMs = Date.now() - startTime

    // A HEALTH CHECK THAT COULD NOT RECORD ITS FINDINGS DID NOT SUCCEED.
    // This used to log status "completed" and return 200 regardless, so a run
    // whose every write was refused was indistinguishable from a clean one —
    // and cron_health_snapshot, which reads this ledger, would have called the
    // job healthy while the tables it feeds stayed empty.
    const wroteNothing = writeFailures.length > 0
    const { error: runLogError } = await supabase.from("cron_execution_logs").insert({
      // DELIBERATELY UNTENANTED (allow-listed in the tenant-stamp guard). This
      // run polls `service_status` for EVERY brokerage — `services` is unfiltered
      // unless a manual trigger names one — and `results` / `writeFailures`
      // aggregate across all of them. The per-brokerage findings are the
      // `system_health_checks` rows above, each stamped with the service row's own
      // `brokerage_id`; this row is the sweep, and the sweep belongs to nobody.
      // Readable on the two no-predicate platform readers of this ledger
      // (pl-truth-engine:getCronHealth, scraping:loadScrapingDiagnostics).
      brokerage_id: null,
      cron_path: "/api/cron/health-check",
      cron_name: "System Health Check",
      status: wroteNothing ? "failed" : "completed",
      duration_ms: durationMs,
      records_processed: results.length,
      ...(wroteNothing
        ? { error_message: `${writeFailures.length} write(s) refused: ${writeFailures.slice(0, 5).join("; ")}` }
        : {}),
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      metadata: { results, writeFailures, skippedDecommissioned },
    })
    // A monitoring job whose OWN run record was refused reported a clean tick
    // over a write that never landed — the same "green over an absence" this
    // route already fixed for `service_status` and `health_check_history`.
    if (runLogError) {
      console.error("[health-check] cron_execution_logs write refused:", runLogError.message)
    }

    return NextResponse.json({
      success: !wroteNothing,
      servicesChecked: results.length,
      durationMs,
      results,
      ...(wroteNothing ? { writeFailures } : {}),
      ...(skippedDecommissioned.length ? { skippedDecommissioned } : {}),
    })
  } catch (error) {
    const durationMs = Date.now() - startTime
    console.error("Health check cron failed:", error)

    // Log failure.
    //
    // THE OUTER CATCH OF A PLATFORM-WIDE SWEEP — the wave-23 class exactly, and
    // allow-listed for the same reason. Nothing here can attribute the failure to
    // a tenant: it fires before any service row is known (a refused
    // `service_status` read reaches this path), so there is no record to resolve
    // a brokerage through and inventing one would report a platform outage as one
    // brokerage's problem.
    const { error: failureLogError } = await supabase.from("cron_execution_logs").insert({
      brokerage_id: null,
      cron_path: "/api/cron/health-check",
      cron_name: "System Health Check",
      status: "failed",
      duration_ms: durationMs,
      error_message: error instanceof Error ? error.message : "Unknown error",
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
    })
    if (failureLogError) {
      console.error("[health-check] failure cron_execution_logs write refused:", failureLogError.message)
    }

    return NextResponse.json(
      { error: "Health check failed", message: error instanceof Error ? error.message : "Unknown" },
      { status: 500 }
    )
  }
}

// Also support GET for manual triggers from dashboard
export async function GET(request: NextRequest) {
  return POST(request)
}
