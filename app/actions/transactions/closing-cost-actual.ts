"use server"

// THE WRITER for cost_breakdown_tracking.actual_amount (wave 46, 2026-09-09).
// The closing-cost card (app/dashboard/transactions/[id]/transaction-detail-client.tsx)
// reads actual_amount beside estimated_amount, but nothing ever wrote it — the
// opposite-missing census filed it as a read with no writer. The estimate is
// AI-generated at contract; the ACTUAL is what the settlement statement says, and
// the coordinator records it line by line as the statement lands. Tenant comes
// from the session (§4): the row must belong to the caller's brokerage or the
// UPDATE matches nothing, and a zero-row match is reported, never swallowed (§3).
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function recordClosingCostActualAction(input: {
  itemId: string
  actualAmount: number | null
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.itemId) return { ok: false, error: "itemId is required" }
  if (input.actualAmount !== null && !(Number.isFinite(input.actualAmount) && input.actualAmount >= 0)) {
    return { ok: false, error: "actualAmount must be a non-negative number or null" }
  }

  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: profile, error: profileError } = await session
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (profileError) return { ok: false, error: profileError.message }
  const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (!brokerageId) return { ok: false, error: "No brokerage on this session" }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("cost_breakdown_tracking")
    .update({
      actual_amount: input.actualAmount,
      status: input.actualAmount === null ? "estimated" : "actual",
    })
    .eq("id", input.itemId)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: "Closing-cost line not found in your brokerage" }
  return { ok: true }
}
