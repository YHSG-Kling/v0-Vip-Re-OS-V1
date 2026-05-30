import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { supabaseService } from "@/services/supabaseService"

/**
 * Transaction read + patch. Was previously open to the world — anyone could
 * read any transaction by ID and PATCH arbitrary fields on it (the underlying
 * supabaseService uses the admin client which bypasses RLS).
 *
 * Now: requires auth + verifies the transaction belongs to the caller's
 * brokerage before reading or mutating.
 */

async function authorize(id: string) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { ok: false as const, response: auth.response }

  const svc = createServiceClient()
  const { data: tx } = await svc
    .from("transactions")
    .select("brokerage_id")
    .eq("id", id)
    .maybeSingle()
  if (!tx) {
    return { ok: false as const, response: NextResponse.json({ success: false, error: "Transaction not found" }, { status: 404 }) }
  }
  if (tx.brokerage_id !== auth.brokerageId) {
    return { ok: false as const, response: NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 }) }
  }
  return { ok: true as const }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await authorize(id)
  if (!gate.ok) return gate.response

  try {
    const transaction = await supabaseService.getTransactionById(id)
    if (!transaction) {
      return NextResponse.json({ success: false, error: "Transaction not found" }, { status: 404 })
    }
    return NextResponse.json({ success: true, transaction })
  } catch (error: any) {
    console.error("[Transaction Detail API] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gate = await authorize(id)
  if (!gate.ok) return gate.response

  try {
    const updates = await request.json()
    // Block client from rewriting tenant scope on the row.
    delete updates.id
    delete updates.brokerage_id

    const transaction = await supabaseService.updateTransaction(id, updates)
    if (!transaction) {
      return NextResponse.json({ success: false, error: "Failed to update transaction" }, { status: 500 })
    }
    return NextResponse.json({ success: true, transaction })
  } catch (error: any) {
    console.error("[Transaction Update API] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}
