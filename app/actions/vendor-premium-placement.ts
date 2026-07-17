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
  vendorDirectoryId: string
  months: number
  priceCents: number
  notes?: string
}): Promise<{ success: boolean; invoiceId?: string; invoiceNumber?: string; error?: string }> {
  const gate = await requirePlacementAdmin()
  if (!gate.ok) return { success: false, error: gate.error }

  const result = await offerPremiumPlacement({
    brokerageId: gate.brokerageId,
    vendorDirectoryId: params.vendorDirectoryId,
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
