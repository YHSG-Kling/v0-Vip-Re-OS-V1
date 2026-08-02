"use server"

// app/actions/vendor-premium-placement.ts
//
// Server Action entry points for premium placement monetization — thin
// wrappers over lib/vendors/premium-placement.ts (all business logic lives
// there). Auth mirrors the vendors-page pattern: getAgentContext + a
// broker/admin/team-lead gate (agents can browse the directory but only
// brokerage leadership sells placement).

import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import {
  offerPremiumPlacement,
  markPlacementPaid,
  ensureDirectoryEntryForVendor,
} from "@/lib/vendors/premium-placement"

const PLACEMENT_ADMIN_ROLES = new Set([
  "admin",
  "broker",
  "broker_admin",
  "superadmin",
  "team_lead",
])

async function requirePlacementAdmin(): Promise<
  | { ok: true; brokerageId: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { ok: false, error: "Unauthorized" }
  }
  if (!PLACEMENT_ADMIN_ROLES.has(ctx.role)) {
    return { ok: false, error: "Forbidden: broker, admin, or team lead only" }
  }
  return { ok: true, brokerageId: ctx.brokerageId }
}

export async function offerPremiumPlacementAction(params: {
  /**
   * A vendors.id — the row the Vendors page actually renders. The action used
   * to demand a vendorDirectoryId, and nothing in the product could produce
   * one: vendor_directory had no INSERT path anywhere in the repo (live count
   * 0), so this entry point was unreachable and the placement feature could
   * never be sold. Callers now pass the bench vendor and the curation row is
   * resolved (created on first sale) here.
   */
  vendorId?: string
  /** Kept for a caller that already holds a curated row. */
  vendorDirectoryId?: string
  months: number
  priceCents: number
  notes?: string
}): Promise<{ success: boolean; invoiceId?: string; invoiceNumber?: string; error?: string }> {
  const gate = await requirePlacementAdmin()
  if (!gate.ok) return { success: false, error: gate.error }

  let directoryId: string | null = params.vendorDirectoryId ?? null
  if (!directoryId) {
    if (!params.vendorId) {
      return { success: false, error: "Pick the vendor this placement is for" }
    }
    const curated = await ensureDirectoryEntryForVendor({
      brokerageId: gate.brokerageId,
      vendorId: params.vendorId,
    })
    // Narrow on the id, not on `error` — the union is discriminated by which
    // field is null, and a check on `error` alone leaves directoryId nullable.
    if (!curated.directoryId) {
      return { success: false, error: curated.error ?? "Could not curate this vendor" }
    }
    directoryId = curated.directoryId
  }

  const result = await offerPremiumPlacement({
    brokerageId: gate.brokerageId,
    vendorDirectoryId: directoryId,
    months: params.months,
    priceCents: params.priceCents,
    notes: params.notes,
  })
  if (result.error) return { success: false, error: result.error }

  revalidatePath("/dashboard/vendors")
  return {
    success: true,
    invoiceId: result.invoiceId ?? undefined,
    invoiceNumber: result.invoiceNumber ?? undefined,
  }
}

export async function markPlacementPaidAction(params: {
  invoiceId: string
  paymentMethod: string
}): Promise<{ success: boolean; placementUntil?: string; error?: string }> {
  const gate = await requirePlacementAdmin()
  if (!gate.ok) return { success: false, error: gate.error }

  const result = await markPlacementPaid({
    brokerageId: gate.brokerageId,
    invoiceId: params.invoiceId,
    paymentMethod: params.paymentMethod,
  })
  if (result.error) return { success: false, error: result.error }

  revalidatePath("/dashboard/vendors")
  return { success: true, placementUntil: result.placementUntil ?? undefined }
}
