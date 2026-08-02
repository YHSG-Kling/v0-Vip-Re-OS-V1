import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

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
      let checkResult: {
        status: "healthy" | "degraded" | "down" | "unknown"
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

      // Insert health check record
      await supabase.from("system_health_checks").insert({
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

      // Update service_status
      const updateData: Record<string, unknown> = {
        current_status: checkResult.status,
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

      await supabase
        .from("service_status")
        .update(updateData)
        .eq("id", service.id)

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
        // Get today's checks for this service
        const { data: todayChecks } = await supabase
          .from("system_health_checks")
          .select("status, response_time_ms")
          .eq("brokerage_id", brokerageId)
          .eq("service_key", service.service_key)
          .gte("checked_at", `${today}T00:00:00Z`)

        const totalChecks = todayChecks?.length || 0
        const successfulChecks =
          todayChecks?.filter((c) => c.status === "healthy").length || 0
        const failedChecks =
          todayChecks?.filter((c) => c.status === "down").length || 0
        const uptimePct = totalChecks > 0 ? (successfulChecks / totalChecks) * 100 : 100
        const avgResponseMs =
          totalChecks > 0
            ? Math.round(
                (todayChecks?.reduce((a, c) => a + (c.response_time_ms || 0), 0) || 0) /
                  totalChecks
              )
            : 0

        // Upsert health_check_history
        const { data: existing } = await supabase
          .from("health_check_history")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("service_key", service.service_key)
          .eq("snapshot_date", today)
          .single()

        if (existing) {
          await supabase
            .from("health_check_history")
            .update({
              uptime_pct: uptimePct,
              total_checks: totalChecks,
              failed_checks: failedChecks,
              avg_response_ms: avgResponseMs,
            })
            .eq("id", existing.id)
        } else {
          await supabase.from("health_check_history").insert({
            brokerage_id: brokerageId,
            service_key: service.service_key,
            snapshot_date: today,
            uptime_pct: uptimePct,
            total_checks: totalChecks,
            failed_checks: failedChecks,
            avg_response_ms: avgResponseMs,
            incidents: 0,
          })
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

    // Log cron execution
    await supabase.from("cron_execution_logs").insert({
      cron_path: "/api/cron/health-check",
      cron_name: "System Health Check",
      status: "completed",
      duration_ms: durationMs,
      records_processed: results.length,
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      metadata: { results },
    })

    return NextResponse.json({
      success: true,
      servicesChecked: results.length,
      durationMs,
      results,
    })
  } catch (error) {
    const durationMs = Date.now() - startTime
    console.error("Health check cron failed:", error)

    // Log failure
    await supabase.from("cron_execution_logs").insert({
      cron_path: "/api/cron/health-check",
      cron_name: "System Health Check",
      status: "failed",
      duration_ms: durationMs,
      error_message: error instanceof Error ? error.message : "Unknown error",
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
    })

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
