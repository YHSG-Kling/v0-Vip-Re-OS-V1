// ============================================================
// SYSTEM: L11-S03 — Integration Test API Route
// VIP Real Estate AI OS — Layer 11
// ============================================================
// POST /api/onboarding/integrations/test
// Auth-gated, tests provider connection using server-side credentials

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { testIntegration, type ProviderName, PROVIDER_METADATA } from "@/lib/onboarding/integration-tester"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Parse request body
    const body = await request.json()
    const { provider, brokerage_id } = body as { 
      provider: ProviderName
      brokerage_id: string 
    }

    if (!provider || !brokerage_id) {
      return NextResponse.json(
        { error: "provider and brokerage_id are required" },
        { status: 400 }
      )
    }

    // Validate provider
    if (!PROVIDER_METADATA[provider]) {
      return NextResponse.json(
        { error: `Unknown provider: ${provider}` },
        { status: 400 }
      )
    }

    // Verify user belongs to brokerage
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData || userData.brokerage_id !== brokerage_id) {
      return NextResponse.json(
        { error: "Unauthorized: Brokerage mismatch" },
        { status: 403 }
      )
    }

    // Get credentials from database (server-side only)
    const { data: credential } = await supabase
      .from("platform_credentials")
      .select("config")
      .eq("brokerage_id", brokerage_id)
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
    console.log(`[L11-IntegrationTest] Testing ${provider} for brokerage ${brokerage_id}`)
    const result = await testIntegration(provider, credentials)

    // Update platform_credentials
    await supabase
      .from("platform_credentials")
      .update({
        last_tested_at: new Date().toISOString(),
        test_status: result.pass ? "pass" : "fail",
        updated_at: new Date().toISOString(),
      })
      .eq("brokerage_id", brokerage_id)
      .eq("platform", provider)

    // Update brokerage_integrations
    await supabase
      .from("brokerage_integrations")
      .upsert({
        brokerage_id: brokerage_id,
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
    if (result.pass) {
      await processKernelEvent({
        event: KernelEvent.INTEGRATION_CONNECTED,
        brokerageId: brokerage_id,
        entityType: "platform_credentials",
        entityId: brokerage_id,
      }).catch(err => {
        console.error("[L11-IntegrationTest] Kernel event failed (non-blocking):", err)
      })
    } else {
      await processKernelEvent({
        event: KernelEvent.INTEGRATION_FAILED,
        brokerageId: brokerage_id,
        entityType: "platform_credentials",
        entityId: brokerage_id,
      }).catch(err => {
        console.error("[L11-IntegrationTest] Kernel event failed (non-blocking):", err)
      })
    }

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
