import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import {
  getProgressDashboard,
} from "@/lib/kernel/education"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const contactId = request.nextUrl.searchParams.get("contactId")

  try {
    if (contactId) {
      const { data: progress } = await supabase
        .from("learning_assignments")
        .select("id, module_id, signal_source, status, viewed_at, completed_at, created_at")
        .eq("contact_id", contactId)
        .eq("brokerage_id", auth.brokerageId)  // always scope to caller's brokerage

      return NextResponse.json({ progress })
    }

    const dashboard = await getProgressDashboard(supabase, { brokerageId: auth.brokerageId })
    return NextResponse.json(dashboard)
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch progress" }, { status: 500 })
  }
}

// TOMBSTONE (§1.3 orphan doctrine — scripts/handler-parity-census.ts,
// 2026-09-11): POST used to live here (action: "assign" | "complete" over
// assignResource/recordCompletion) — zero in-tree callers. The Client
// Learning panel (app/dashboard/education/client-learning-panel.tsx) drives
// both moments through app/actions/education-kernel.ts's
// assignResourceAction / recordCompletionAction instead, which call the SAME
// lib/kernel/education.ts functions this POST wrapped but additionally
// assert tenant ownership of both the contact and the resource
// (assertTenantOwnsAll) before writing — a check this route never had. Two
// spellings of "assign/complete a lesson," and the unreached one was the
// weaker gate.
