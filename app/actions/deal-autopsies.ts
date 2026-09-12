"use server"

/**
 * app/actions/deal-autopsies.ts
 *
 * The READ HALF of the deal-autopsy learning lane (lib/kernel/deal-autopsy.ts).
 *
 * The writer is shipped, registry-owned (deal_coordinator) and triggered from
 * closing orchestration on every lost deal — it classifies WHY the deal died
 * (failure_reason + confidence + evidence) and records purchase_price /
 * days_under_contract / deal_type. Its only reader was its own idempotency
 * check: no human ever saw a single observation. This action is the board's
 * loader (app/dashboard/transactions/deals-lost-board.tsx).
 *
 * Pattern (§4, manager-registry): GATE FIRST — session user, brokerage from the
 * SESSION profile (never a parameter) — THEN the service client, scoped to that
 * brokerage. Every read destructures { error } (§3) and a refusal returns as a
 * refusal, never as "no deals lost".
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export interface DealAutopsyObservation {
  id: string
  transactionId: string
  terminalStatus: string | null
  failureReason: string | null
  confidence: number | null
  evidence: string[]
  purchasePrice: number | null
  daysUnderContract: number | null
  dealType: string | null
  observedAt: string | null
  /** From the transactions join; null when the deal row is gone or the
   *  lookup itself failed (see addressLookupError). */
  propertyAddress: string | null
  dealName: string | null
}

export async function getDealAutopsiesAction(): Promise<
  | {
      success: true
      observations: DealAutopsyObservation[]
      /** Non-null when the secondary transactions lookup was refused — the
       *  observations are still real, only the address labels are missing. */
      addressLookupError: string | null
    }
  | { success: false; error: string }
> {
  // ── Gate first ─────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: profile, error: profileErr } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (profileErr) return { success: false, error: profileErr.message }
  if (!profile?.brokerage_id) return { success: false, error: "Your account is not linked to a brokerage yet." }

  // ── Then the service client, tenant-scoped from the session ───────────────
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("deal_autopsy_observations")
    .select(
      "id, transaction_id, terminal_status, failure_reason, confidence, evidence, purchase_price, days_under_contract, deal_type, observed_at, created_at",
    )
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(50)
  if (error) return { success: false, error: error.message }

  const rows = (data ?? []) as Array<Record<string, unknown>>

  // Secondary label lookup — a refusal here does not hide the observations, but
  // it is REPORTED beside them rather than rendering as "address unknown".
  let addressLookupError: string | null = null
  const labelByTxn = new Map<string, { address: string | null; dealName: string | null }>()
  const txnIds = Array.from(new Set(rows.map((r) => r.transaction_id as string).filter(Boolean)))
  if (txnIds.length > 0) {
    const { data: txns, error: txnErr } = await svc
      .from("transactions")
      .select("id, property_address, deal_name")
      .in("id", txnIds)
      .eq("brokerage_id", profile.brokerage_id)
    if (txnErr) {
      addressLookupError = txnErr.message
    } else {
      for (const t of (txns ?? []) as Array<{ id: string; property_address: string | null; deal_name: string | null }>) {
        labelByTxn.set(t.id, { address: t.property_address ?? null, dealName: t.deal_name ?? null })
      }
    }
  }

  return {
    success: true,
    addressLookupError,
    observations: rows.map((r) => {
      const label = labelByTxn.get(r.transaction_id as string)
      return {
        id: r.id as string,
        transactionId: r.transaction_id as string,
        terminalStatus: (r.terminal_status as string | null) ?? null,
        failureReason: (r.failure_reason as string | null) ?? null,
        confidence: r.confidence == null ? null : Number(r.confidence),
        evidence: Array.isArray(r.evidence) ? (r.evidence as string[]) : [],
        purchasePrice: r.purchase_price == null ? null : Number(r.purchase_price),
        daysUnderContract: r.days_under_contract == null ? null : Number(r.days_under_contract),
        dealType: (r.deal_type as string | null) ?? null,
        observedAt: (r.observed_at as string | null) ?? (r.created_at as string | null) ?? null,
        propertyAddress: label?.address ?? null,
        dealName: label?.dealName ?? null,
      }
    }),
  }
}
