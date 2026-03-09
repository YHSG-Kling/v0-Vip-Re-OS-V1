// ============================================================
// SYSTEM: L11-S03 — Provider-Specific Integration Test Route
// VIP Real Estate AI OS — Layer 11
// ============================================================
// POST /api/integrations/test/[provider]
// Auth-gated, tests provider connection using server-side credentials
// Dynamic route version that accepts provider as path param

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { testIntegration, type ProviderName, PROVIDER_METADATA } from "@/lib/onboarding/integration-tester"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider: providerParam } = await params
    const provider = providerParam as ProviderName
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Validate provider
    if (!PROVIDER_METADATA[provider]) {
      return NextResponse.json(
        { error: `Unknown provider: ${provider}` },
        { status: 400 }
      )
    }

    // Parse optional brokerage_id from body (falls back to user's brokerage)
    let brokerageId: string | undefined
    try {
      const body = await request.json().catch(() => ({}))
      brokerageId = body.brokerage_id
    } catch {
      // No body provided
    }

    // Get user's brokerage if not provided
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData?.brokerage_id) {
      return NextResponse.json(
        { error: "User not associated with a brokerage" },
        { status: 400 }
      )
    }

    // Use provided brokerage_id or fall back to user's brokerage
    const targetBrokerageId = brokerageId || userData.brokerage_id

    // Verify user belongs to brokerage
    if (targetBrokerageId !== userData.brokerage_id) {
      return NextResponse.json(
        { error: "Unauthorized: Brokerage mismatch" },
        { status: 403 }
      )
    }

    // Get credentials from database (server-side only)
    const { data: credential } = await supabase
      .from("platform_credentials")
      .select("config")
      .eq("brokerage_id", targetBrokerageId)
      .eq("platform", provider)
      .maybeSingle()

    if (!credential?.config) {
      return NextResponse.json({
        pass: false,
        detail: "No credentials found - please configure first",
        provider,
      })
    }

    const credentials = credential.config as Record<string, string>

    // Test the integration
    console.log(`[L11-IntegrationTest] Testing ${provider} for brokerage ${targetBrokerageId}`)
    const result = await testIntegration(provider, credentials)

    // Update platform_credentials with test result
    await supabase
      .from("platform_credentials")
      .update({
        last_tested_at: new Date().toISOString(),
        test_status: result.pass ? "pass" : "fail",
        updated_at: new Date().toISOString(),
      })
      .eq("brokerage_id", targetBrokerageId)
      .eq("platform", provider)

    // Update brokerage_integrations status
    await supabase
      .from("brokerage_integrations")
      .upsert({
        brokerage_id: targetBrokerageId,
        provider_type: PROVIDER_METADATA[provider].providerType,
        provider_name: provider,
        status: result.pass ? "connected" : "error",
        last_health_check_at: new Date().toISOString(),
        last_error: result.pass ? null : result.detail,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "brokerage_id,provider_name",
      })

    // Fire kernel event based on result
    const kernelEvent = result.pass 
      ? KernelEvent.INTEGRATION_CONNECTED 
      : KernelEvent.INTEGRATION_FAILED

    await processKernelEvent({
      event: kernelEvent,
      brokerageId: targetBrokerageId,
      entityType: "platform_credentials",
      entityId: targetBrokerageId,
      metadata: {
        provider,
        testResult: result.pass ? "pass" : "fail",
        detail: result.detail,
      },
    }).catch(err => {
      console.error("[L11-IntegrationTest] Kernel event failed (non-blocking):", err)
    })

    console.log(`[L11-IntegrationTest] ${provider} test result: ${result.pass ? "PASS" : "FAIL"}`)

    return NextResponse.json({
      pass: result.pass,
      detail: result.detail,
      provider,
    })
  } catch (error) {
    console.error("[L11-IntegrationTest] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
