import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { createClient } from "@/lib/supabase/server"
import { collectError, type CollectErrorParams } from "@/lib/errors/collect-error"
import { classifyError } from "@/lib/errors/error-classifier"

/** Constant-time equality; unequal lengths are a mismatch, never an exception (the app/api/workflow/trigger shape). */
function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

/** A signed-in seat may file this many reports per minute (the door writes service-role rows for every one). */
const SESSION_REPORTS_PER_MINUTE = 60

/**
 * POST /api/errors/collect
 * Central error intake endpoint
 * Accepts error reports from any part of the app
 *
 * WAVE 155 (lane 155R29) — THE CREDENTIAL DECIDES THE TENANT (CLAUDE.md §4). Two callers reach this door, and they are not
 * equally trusted:
 *   · the SERVICE path (`x-internal-api-secret` = INTERNAL_API_SECRET, now compared timing-safe): an out-of-process reporter
 *     that holds the platform secret — it names the tenant the error belongs to, as before;
 *   · the SESSION path (a signed-in browser): the tenant and the agent are the SESSION's. Before this, a signed-in seat could
 *     file automation_errors / error_stack_traces under ANY brokerage (and any agent) it named in the body — another tenant's
 *     error dashboard, self-heal queue and escalations. A body brokerageId naming another tenant is now refused; the session's
 *     tenant is stamped. The session path is also capped per seat (collectError writes with the service client).
 */
export async function POST(request: NextRequest) {
  try {
    // Check for INTERNAL_API_SECRET or authenticated user
    const internalSecret = request.headers.get("x-internal-api-secret")
    const expectedSecret = process.env.INTERNAL_API_SECRET

    let isAuthorized = false
    let sessionTenant: { userId: string; brokerageId: string; agentId: string | null } | null = null

    if (internalSecret && expectedSecret && secretsMatch(internalSecret, expectedSecret)) {
      isAuthorized = true
    } else {
      // Check for authenticated user
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { getAgentContext } = await import("@/lib/identity/get-agent-context")
        const ctx = await getAgentContext()
        // A session with no tenant has no tenant to file under — refused, never filed under a body-named one (fail closed).
        if (!ctx.isAuthenticated || !ctx.brokerageId) {
          return NextResponse.json({ error: "Your account is not linked to a brokerage" }, { status: 403 })
        }
        sessionTenant = { userId: user.id, brokerageId: ctx.brokerageId, agentId: ctx.agentId ?? null }
        isAuthorized = true
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    if (sessionTenant) {
      const { checkPublicRateLimit } = await import("@/lib/security/public-rate-limit")
      const cap = checkPublicRateLimit("errors-collect", sessionTenant.userId, { limit: SESSION_REPORTS_PER_MINUTE, windowMs: 60_000 })
      if (!cap.allowed) {
        return NextResponse.json({ error: "Too many error reports — try again shortly" }, { status: 429, headers: { "retry-after": String(cap.retryAfterSeconds) } })
      }
    }

    const body = await request.json()

    if (sessionTenant) {
      const { decideClaimedTenant } = await import("@/lib/platform/acting-context")
      const claim = decideClaimedTenant({ actingBrokerageId: sessionTenant.brokerageId, claimedBrokerageId: body?.brokerageId ?? null })
      if (!claim.ok) {
        return NextResponse.json({ error: "Forbidden: an error report is filed under your own brokerage only" }, { status: 403 })
      }
    }

    const params: CollectErrorParams = {
      workflowName: body.workflowName,
      errorMessage: body.errorMessage,
      stack: body.stack,
      severity: body.severity,
      context: body.context,
      // Session path: the SESSION's tenant and agent, never the body's. Service path: the reporter's (it holds the secret).
      brokerageId: sessionTenant ? sessionTenant.brokerageId : body.brokerageId,
      agentId: sessionTenant ? (sessionTenant.agentId ?? undefined) : body.agentId,
      leadId: body.leadId,
      fileInfo: body.fileInfo,
      errorType: body.errorType,
    }

    // Validate required fields
    if (!params.workflowName || !params.errorMessage) {
      return NextResponse.json(
        { error: "Missing required fields: workflowName and errorMessage" },
        { status: 400 }
      )
    }

    const errorId = await collectError(params)

    if (!errorId) {
      return NextResponse.json(
        { error: "Failed to collect error" },
        { status: 500 }
      )
    }

    // Get classification for response
    // The stack is not handed to the classifier: it never read one, and
    // collectError() above has already parsed it into the stack-trace row.
    // See the tombstone at lib/errors/error-classifier.ts:54.
    const classification = classifyError(
      params.errorMessage,
      params.workflowName
    )

    return NextResponse.json({
      errorId,
      severity: params.severity || classification.severity,
      isRetryable: classification.isRetryable,
      category: classification.category,
    })
  } catch (err) {
    console.error("[API /errors/collect] Error:", err)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
