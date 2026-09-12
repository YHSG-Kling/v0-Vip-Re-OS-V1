"use server"

// app/actions/admin/referral-earnings.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE RECIPIENT'S HALF of subscriber-referral payouts (owner ruling: "make sure
// referral payouts are posted and received by the recipient"). A tenant whose
// admin/broker referred another subscriber sees the payouts POSTED to their
// brokerage (referral_payouts.recipient_brokerage_id, m573) on their billing
// page and ACKNOWLEDGES receipt — a counted status flip posted → received.
//
// TENANCY (§4): the brokerage comes from the SESSION user's profile, never
// from a parameter — a billing admin can only ever read/acknowledge their own
// tenant's payouts, and the update is additionally scoped to
// recipient_brokerage_id server-side (defence in depth; §3 counted).
// Gate: the same finance-admin predicate the billing page draws
// (isBrokerageFinanceAdmin). Fail closed — no profile / no brokerage = refuse.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import {
  listReferralEarningsForBrokerage,
  markReferralPayoutReceived,
  type ReferralEarningRow,
} from "@/lib/platform/referral-payouts"
import { revalidatePath } from "next/cache"

async function requireTenantFinanceAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) return { ok: false, error: "Unauthorized" }
  if (!isBrokerageFinanceAdmin({ user_type: (profile as any).user_type ?? "" })) {
    return { ok: false, error: "Forbidden — billing admins only" }
  }
  return { ok: true, userId: user.id, brokerageId: (profile as any).brokerage_id as string }
}

// (No type re-exports here: `"use server"` files expose every export as an HTTP
// endpoint and Next requires them all async — consumers take ReferralEarningRow
// from lib/platform/referral-payouts directly.)

/** The session tenant's referral earnings (posted + received payouts). */
export async function getReferralEarningsAction(): Promise<
  | { ok: true; rows: ReferralEarningRow[]; unavailable: boolean }
  | { ok: false; error: string }
> {
  const auth = await requireTenantFinanceAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  return listReferralEarningsForBrokerage(auth.brokerageId, svc)
}

/** Acknowledge a payout POSTED to the session tenant (posted → received). Counted. */
export async function acknowledgeReferralPayoutAction(input: { payoutId: string }): Promise<
  { ok: boolean; error?: string }
> {
  const auth = await requireTenantFinanceAdmin()
  if (!auth.ok) return auth
  if (!input.payoutId) return { ok: false, error: "payoutId required" }
  const svc = createServiceClient()
  const result = await markReferralPayoutReceived(svc, {
    payoutId: input.payoutId,
    brokerageId: auth.brokerageId,
    userId: auth.userId,
  })
  if (!result.ok) return result
  revalidatePath("/dashboard/admin/billing")
  return { ok: true }
}
