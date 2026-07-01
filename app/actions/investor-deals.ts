"use server"

/**
 * Investor Off-Market Deal Finder — agent-facing actions (Shopping Agent domain).
 *   - findInvestorDealsAction({ contactId })    — match a qualified investor buyer's buy-box to our
 *                                                 scraped OFF-MARKET / motivated-seller inventory
 *   - getInvestorDealMatchAction({ contactId }) — read the persisted match for display
 *
 * Only for contact_type='investor' (regular buyers are matched to MLS inventory by the retail matchers).
 * Nothing auto-sends — the ranked off-market deals are intelligence the agent reviews before acting.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"
import { runInvestorOffMarketMatch, getInvestorDealMatch } from "@/lib/buyer-search/investor-offmarket-runner"

async function resolveBrokerageId(authUserId: string): Promise<string> {
  const svc = createServiceClient()
  const { data: userRow } = await svc.from("users").select("brokerage_id").eq("id", authUserId).maybeSingle()
  if (userRow?.brokerage_id) return userRow.brokerage_id as string
  const { data: uraRow } = await svc.from("user_role_assignments").select("brokerage_id").eq("user_id", authUserId).limit(1).maybeSingle()
  return (uraRow?.brokerage_id as string) ?? ""
}

async function authAndScope(contactId: string) {
  if (!isValidUUID(contactId)) return { brokerageId: "", error: "Invalid contact id" as const }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { brokerageId: "", error: "Unauthorized" as const }
  const brokerageId = await resolveBrokerageId(user.id)
  if (!brokerageId) return { brokerageId: "", error: "No brokerage for user" as const }
  return { brokerageId, error: null }
}

export async function findInvestorDealsAction(params: {
  contactId: string
}): Promise<{ success: boolean; reason?: string; matchCount?: number; qualifiedCount?: number; error?: string }> {
  const { brokerageId, error } = await authAndScope(params.contactId)
  if (!brokerageId) return { success: false, error: error ?? undefined }

  const result = await runInvestorOffMarketMatch(createServiceClient(), { brokerageId, contactId: params.contactId })
  revalidatePath(`/crm/contacts/${params.contactId}`)

  if (!result.ok) {
    const why: Record<string, string> = {
      not_investor: "Off-market deal matching is for investor buyers. Set this contact's type to Investor to use it.",
      no_box: "This investor has no saved buy-box yet. Capture their criteria (target markets, price) first.",
      no_geography: "The investor's buy-box has no target markets — add cities or ZIP codes to match on.",
      no_inventory: "No off-market properties in the investor's markets yet. New matches appear as we scrape more.",
      contact_not_found: "Contact not found in your brokerage.",
    }
    return { success: false, reason: result.reason, error: why[result.reason] ?? "No match produced." }
  }
  return { success: true, reason: result.reason, matchCount: result.matchCount, qualifiedCount: result.qualifiedCount }
}

export async function getInvestorDealMatchAction(params: {
  contactId: string
}): Promise<{ success: boolean; match?: any; error?: string }> {
  const { brokerageId, error } = await authAndScope(params.contactId)
  if (!brokerageId) return { success: false, error: error ?? undefined }
  const match = await getInvestorDealMatch(createServiceClient(), { contactId: params.contactId, brokerageId })
  return { success: true, match }
}
