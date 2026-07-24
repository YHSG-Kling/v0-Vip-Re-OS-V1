// app/api/forms/templates/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Returns available form templates for a given context type.
// Used by FormDraftWorkspace for template selection.
// Query params: context_type (listing|offer|transaction), state (optional)
// Auth: session required. brokerage_id resolved server-side.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { loadAvailableTransactionForms, resolveTransactionFormsProvider } from "@/lib/kernel/forms"
import type { FormContextType } from "@/lib/kernel/forms"

const VALID_CONTEXT_TYPES: FormContextType[] = ["listing", "offer", "transaction"]

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl
    const context_type = searchParams.get("context_type") as FormContextType | null
    const state        = searchParams.get("state") ?? undefined

    if (!context_type || !VALID_CONTEXT_TYPES.includes(context_type)) {
      return NextResponse.json(
        { error: "context_type must be one of: listing, offer, transaction" },
        { status: 400 }
      )
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

    const [result, providerResult] = await Promise.all([
      loadAvailableTransactionForms({
        brokerage_id: agent.brokerage_id,
        context_type,
        state,
      }),
      // The connected e-sign provider (null/not_configured is fine — the loader
      // still returns the standard template library so the UI is never empty).
      resolveTransactionFormsProvider({ brokerage_id: agent.brokerage_id }).catch(() => null),
    ])

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    const provider = providerResult?.success ? (providerResult.data?.provider_name ?? null) : null

    return NextResponse.json(
      { success: true, provider, forms: result.data?.forms ?? [] },
      { status: 200 },
    )
  } catch (error: any) {
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
