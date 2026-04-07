// app/api/esign/status/[transactionId]/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Live e-sign signature status endpoint.
// Used by EsignStatusTracker for SWR polling.
// Auth: session required. brokerage_id resolved server-side.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getEsignStatus } from "@/lib/kernel/forms"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ transactionId: string }> }
) {
  try {
    const { transactionId } = await params

    if (!transactionId) {
      return NextResponse.json({ error: "transactionId is required" }, { status: 400 })
    }

    // Resolve session
    const supabase = await createClient()
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser()

    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Resolve brokerage_id from agent record
    const { data: agent } = await supabase
      .from("agents")
      .select("brokerage_id")
      .eq("user_id", user.id)
      .maybeSingle()

    if (!agent?.brokerage_id) {
      return NextResponse.json({ error: "Agent record not found" }, { status: 403 })
    }

    const result = await getEsignStatus({
      brokerage_id:            agent.brokerage_id,
      external_transaction_id: transactionId,
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json({ success: true, status: result.data }, { status: 200 })
  } catch (error: any) {
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
