import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { collectError, type CollectErrorParams } from "@/lib/errors/collect-error"
import { classifyError } from "@/lib/errors/error-classifier"

/**
 * POST /api/errors/collect
 * Central error intake endpoint
 * Accepts error reports from any part of the app
 */
export async function POST(request: NextRequest) {
  try {
    // Check for INTERNAL_API_SECRET or authenticated user
    const internalSecret = request.headers.get("x-internal-api-secret")
    const expectedSecret = process.env.INTERNAL_API_SECRET

    let isAuthorized = false

    if (internalSecret && expectedSecret && internalSecret === expectedSecret) {
      isAuthorized = true
    } else {
      // Check for authenticated user
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        isAuthorized = true
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const body = await request.json()

    const params: CollectErrorParams = {
      workflowName: body.workflowName,
      errorMessage: body.errorMessage,
      stack: body.stack,
      severity: body.severity,
      context: body.context,
      brokerageId: body.brokerageId,
      agentId: body.agentId,
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
