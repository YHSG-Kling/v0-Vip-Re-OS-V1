// app/api/onboarding/license/route.ts
// ============================================================
// SYSTEM: L11-S01 — Agent License Intake API Routes
// VIP Real Estate AI OS — Layer 11
// ============================================================
// GET endpoint for fetching license status and contract polling.

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { getAgentLicenseStatus, getContractStatus } from "@/app/actions/onboarding/license"

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const action = searchParams.get("action")

    // Action: Get contract status (for polling)
    if (action === "contract_status") {
      const contractId = searchParams.get("contract_id")
      if (!contractId) {
        return NextResponse.json({ error: "Missing contract_id parameter" }, { status: 400 })
      }

      const result = await getContractStatus(contractId)
      if (result.error) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }

      return NextResponse.json({
        status: result.status,
        signed_at: result.signedAt,
      })
    }

    // Default: Get full license status - resolve agent ID properly
    const agentId = searchParams.get("agent_id") || await resolveAgentId(supabase, user.id)
    if (!agentId) {
      return NextResponse.json({ error: "Agent profile not found" }, { status: 403 })
    }
    const result = await getAgentLicenseStatus(agentId)

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json(result.data)
  } catch (error) {
    console.error("[L11-License] API error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
