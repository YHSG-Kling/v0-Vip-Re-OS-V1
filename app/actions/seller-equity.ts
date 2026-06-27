"use server"

// app/actions/seller-equity.ts
// ─────────────────────────────────────────────────────────────────────────────
// SELLER EQUITY tool — persists the seller's own mortgage balance so their net-proceeds estimate is
// accurate (we never fabricate it). Stored on the real contacts.metadata jsonb (the canonical home
// for buyer/seller self-entered facts), mirroring the commute-destination + notification-preference
// pattern. The math lives in the PURE engine (lib/seller-equity/equity-estimate) so the card can
// recompute live; this action only saves the input.

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

function readMetadata(raw: any): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === "string") { try { return JSON.parse(raw) } catch { return {} } }
  return raw
}

/** Save (or clear) the seller's remaining mortgage balance for an accurate net-proceeds estimate. */
export async function setSellerMortgageBalance(
  contactId: string,
  balance: number | null,
): Promise<{ success: boolean; error?: string }> {
  if (!contactId) return { success: false, error: "Missing contact" }
  if (balance !== null && (!Number.isFinite(balance) || balance < 0)) {
    return { success: false, error: "Enter a valid balance" }
  }
  const supabase = await createClient()
  const { data } = await supabase.from("contacts").select("metadata").eq("id", contactId).maybeSingle()
  const md = readMetadata(data?.metadata)
  const next = { ...md, mortgage_balance: balance === null ? null : Math.round(balance) }
  const { error } = await supabase
    .from("contacts")
    .update({ metadata: next, updated_at: new Date().toISOString() })
    .eq("id", contactId)
  if (error) return { success: false, error: error.message }
  revalidatePath(`/portal/${contactId}/listing`)
  return { success: true }
}
